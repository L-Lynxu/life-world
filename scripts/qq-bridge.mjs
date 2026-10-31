#!/usr/bin/env node
/**
 * life-world · NapCat QQ bridge (optional)
 *
 * 单向说明：
 *   - 只处理私聊；群聊暂不处理（group.enabled 关闭）。
 *   - 只接受 ownerQQ 的私聊。
 *   - 用户消息 -> qq-chat 会话；她的回复 -> 轮询会话 -> 发回 QQ。
 *   - outbox 里的 reach_out -> QQ。
 *   - 开关状态写在 qq-bridge.json；心跳写进 qq-bridge-state.json，供 life-world 读取。
 *
 * 用法：
 *   node qq-bridge.mjs                启动桥接
 *   node qq-bridge.mjs --test-send [文本]  只发一条测试私聊，然后退出
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const HOME = homedir()
const CONFIG_FILE = join(HOME, ".config/opencode/qq-bridge.json")
const STATE_FILE = join(HOME, ".local/share/life-world/qq-bridge-state.json")
const OUTBOX_DIR = join(HOME, ".local/share/life-world/worlds/default/outbox")
const JUDGE_SESSION_FILE = join(HOME, ".local/share/life-world/qq-judge-session.json")
const JUDGE_DIR = join(HOME, ".local/share/life-world/qq-judge")
const GROUP_TMP_DIR = join(HOME, ".local/share/life-world/tmp")
const LOG_FILE = join(HOME, ".local/share/life-world/qq-bridge.log")
const SERVICE_FILE = join(HOME, ".local/state/opencode/service.json")

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, line + "\n") } catch {}
  if (process.stdout.isTTY) console.log(line)
}
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback }
}
function writeJson(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, file)
  } catch (error) { log("write state failed", String(error)) }
}
const dayOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const config = readJson(CONFIG_FILE, null)
if (!config) { log("config missing", CONFIG_FILE); process.exit(1) }
if (config.enabled !== true) { log("disabled, exit"); process.exit(0) }

let service = readJson(SERVICE_FILE, null)
if (!service?.url || !service?.password) { log("service.json missing", SERVICE_FILE); process.exit(1) }
let auth = "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64")

/**
 * 重读 service.json。
 * opencode 重启时可能换口令或换端口，而桥接是长驻进程——不重读就会一直拿旧口令打过去，
 * 表现是「脚本在跑、QQ 没反应」，还看不出错在哪。这里只在内容真的变了才换。
 */
function reloadService() {
  const fresh = readJson(SERVICE_FILE, null)
  if (!fresh?.url || !fresh?.password) return false
  if (fresh.url === service.url && fresh.password === service.password) return false
  service = fresh
  auth = "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64")
  log("service.json reloaded", service.url)
  return true
}

const ownerQQ = Number(config.ownerQQ)
if (!ownerQQ) { log("ownerQQ missing"); process.exit(1) }
const sessionTitle = config.private?.sessionTitle || "qq-chat"
const location = config.location || HOME
const wsUrl = config.napcat?.wsUrl || "ws://127.0.0.1:3001"
const wsToken = config.napcat?.token || ""

mkdirSync(JUDGE_DIR, { recursive: true })
let state = readJson(STATE_FILE, {})
function saveState() { writeJson(STATE_FILE, state) }

async function api(path, init = {}) {
  const send = () =>
    fetch(service.url + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: auth },
      signal: AbortSignal.timeout(20000),
    })
  try {
    const res = await send()
    // 口令对不上（服务重启换了口令）：重读一次再试
    if (res.status === 401 || res.status === 403) {
      if (!reloadService()) return res
      return await send()
    }
    return res
  } catch (error) {
    // 连不上（服务换端口重启）：重读一次再试，还不行就把原错误抛出去
    if (!reloadService()) throw error
    return await send()
  }
}
async function apiJson(path, init) {
  try {
    const res = await api(path, init)
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = text }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, status: 0, data: String(error) }
  }
}

async function sessionInfo(id) {
  const res = await apiJson(`/api/session/${id}`)
  if (res.ok) return { status: "ok", info: res.data?.data }
  return { status: res.status === 404 ? "missing" : "error" }
}

async function ensurePrivate() {
  if (state.privateSessionId) {
    const info = await sessionInfo(state.privateSessionId)
    if (info.status === "ok") {
      if (state.lastSessionId !== state.privateSessionId) await resetBaseline(state.privateSessionId)
      return state.privateSessionId
    }
    if (info.status === "missing") {
      delete state.privateSessionId
      delete state.lastSessionId
      delete state.lastIdle
      delete state.lastAssistantId
      saveState()
      log("private session missing, recreate")
    } else {
      return undefined
    }
  }
  const res = await apiJson("/api/session", {
    method: "POST",
    body: JSON.stringify({ title: sessionTitle, location: { directory: location } }),
  })
  const id = res.data?.data?.id
  if (!id) { log("create session failed", res.status, JSON.stringify(res.data).slice(0, 200)); return undefined }
  state.privateSessionId = id
  saveState()
  log("created private session", id)
  await resetBaseline(id)
  return id
}

async function resetBaseline(id) {
  state.lastSessionId = id
  const info = await sessionInfo(id)
  state.lastIdle = info.info?.time?.idle || 0
  const msgs = await apiJson(`/api/session/${id}/message`)
  const assistants = Array.isArray(msgs.data?.data) ? msgs.data.data.filter((m) => m?.type === "assistant") : []
  state.lastAssistantId = assistants.length ? assistants[0].id : undefined
  saveState()
}

async function deletePrivate() {
  const id = state.privateSessionId
  if (!id) return
  await api(`/api/session/${id}`, { method: "DELETE" }).catch(() => {})
  delete state.privateSessionId
  delete state.lastSessionId
  delete state.lastIdle
  delete state.lastAssistantId
  runWindow = null
  saveState()
  log("deleted private session", id)
}

// ———————————————————————— NapCat WebSocket ————————————————————————
let ws = null
let wsReady = false
let echoSeq = 0
const pending = new Map()

let reconnectTimer = null
/** 统一的重连入口：连不上、断开、超时都走这里，且同一时间只排一个 */
function scheduleReconnect(reason) {
  if (reconnectTimer) return
  log("reconnect in 5s", reason)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 5000)
}

function connect() {
  const url = wsToken ? `${wsUrl}?access_token=${encodeURIComponent(wsToken)}` : wsUrl
  ws = new WebSocket(url)
  ws.addEventListener("open", () => {
    wsReady = true
    state.lastSeen = new Date().toISOString()
    saveState()
    log("ws open", wsUrl)
  })
  ws.addEventListener("close", () => {
    wsReady = false
    scheduleReconnect("close")
  })
  ws.addEventListener("error", (event) => {
    log("ws error", event?.message || "")
    // 不在这里调 ws.close()：对没建立起来的连接，close() 会同步再触发 error，
    // 每 5 秒一次的重连就会变成每秒上百条错误的风暴。
    // 已经开着的连接出错时，宿主机自己会补一个 close，交给下面的 close 处理器。
    wsReady = false
    scheduleReconnect("error")
  })
  ws.addEventListener("message", (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.echo && pending.has(msg.echo)) {
      const p = pending.get(msg.echo)
      clearTimeout(p.timer)
      pending.delete(msg.echo)
      p.resolve(msg)
      return
    }
    if (msg.post_type === "message" && msg.message_type === "private") {
      handlePrivate(msg).catch((error) => log("handle private failed", String(error)))
    } else if (msg.post_type === "message" && msg.message_type === "group") {
      handleGroup(msg).catch((error) => log("handle group failed", String(error)))
    }
  })
}

function call(action, params) {
  return new Promise((resolve, reject) => {
    if (!wsReady || !ws) return reject(new Error("ws not ready"))
    const echo = `e-${Date.now()}-${++echoSeq}`
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`${action} timeout`)) }, 15000)
    pending.set(echo, { resolve, reject, timer })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}

function textOf(msg) {
  const parts = Array.isArray(msg.message) ? msg.message : []
  return parts.filter((p) => p?.type === "text").map((p) => p?.data?.text || "").join("").trim()
}
function nameOf(msg) {
  return msg.sender?.card || msg.sender?.nickname || String(msg.user_id)
}

// 一次 QQ 私聊运行的时间窗：窗口内产生的 reach_out 不单独发，避免和正式回复重复
let runWindow = null

async function handlePrivate(msg) {
  if (Number(msg.user_id) !== ownerQQ) { log("ignore private from", String(msg.user_id)); return }
  const text = textOf(msg)
  if (!text) { log("ignore empty private"); return }
  if (text.trim() === "/new") {
    await deletePrivate()
    await call("send_private_msg", { user_id: ownerQQ, message: "新对话已开，下一条消息开始新会话。" })
      .catch((error) => log("send /new ack failed", String(error)))
    return
  }
  const id = await ensurePrivate()
  if (!id) return
  const annotated = `[私聊｜${nameOf(msg)}（QQ ${msg.user_id}）] ${text}\n（这是 QQ 私聊。像真人发消息一样：每个短句单独一行，每行会作为一条独立的 QQ 消息发出；一次发 1~3 条，最多 4 条；不要写长段落，不要用标题/列表/编号/加粗，不要复述工具或过程。直接回复即可，不要调用 reach_out。）`
  runWindow = { start: Date.now(), end: 0, reaches: [] }
  const res = await api(`/api/session/${id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: annotated }),
  })
  if (!res.ok) {
    log("prompt failed", res.status, (await res.text()).slice(0, 200))
    return
  }
  log("prompt queued", id)
}

// 每行一条消息；超长行再按标点/长度切，避免一条长墙
function splitMessages(text, limit = 800) {
  const lines = String(text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  const out = []
  for (const line of lines) {
    if (line.length <= limit) { out.push(line); continue }
    let rest = line
    while (rest.length > limit) {
      const marks = ["。", "！", "？", "；", "，"]
      let cut = -1
      for (const mark of marks) cut = Math.max(cut, rest.lastIndexOf(mark, limit))
      cut = cut >= limit * 0.5 ? cut + 1 : limit
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}

async function sendPrivate(text) {
  const messages = splitMessages(text)
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    try {
      await call("send_private_msg", { user_id: ownerQQ, message })
      log(`sent private ${i + 1}/${messages.length}`, message.slice(0, 40))
    } catch (error) {
      log("send private failed", String(error))
      return false
    }
    // 像真人一样：按下一句的长度估算打字时间，短句 1.5~2 秒，长句 2~3 秒，再加随机抖动
    if (i < messages.length - 1) {
      const next = messages[i + 1]
      const wait = 900 + Math.min(3500, next.length * 55) + Math.floor(Math.random() * 600)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  return true
}

// ———————————————————————— 群聊 ————————————————————————
const groupStates = new Map()
const groupRunWindows = new Map()

function groupCfg() {
  // 实时读配置：group_chat 工具改 enabled 后不用重启桥接
  const live = readJson(CONFIG_FILE, config)
  return live.group || {}
}
let lastGroupEnabled = null
function groupEnabled() {
  const enabled = groupCfg().enabled === true
  if (lastGroupEnabled !== null && lastGroupEnabled !== enabled) {
    for (const st of groupStates.values()) {
      st.buffer = []
      if (st.timer) clearTimeout(st.timer)
      st.timer = null
      st.firstAt = 0
    }
    log("group toggled", enabled)
  }
  lastGroupEnabled = enabled
  return enabled
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

function keywordMatch(text) {
  const kws = Array.isArray(groupCfg().keywords) ? groupCfg().keywords : []
  const raw = String(text || "")
  for (const kw of kws) {
    const k = String(kw || "").trim()
    if (!k) continue
    if (/^[a-z0-9]+$/i.test(k)) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRe(k)}([^a-z0-9]|$)`, "i").test(raw)) return true
    } else if (raw.includes(k)) return true
  }
  return false
}
function isAtBot(msg) {
  const parts = Array.isArray(msg.message) ? msg.message : []
  return parts.some((p) => p?.type === "at" && String(p?.data?.qq) === String(msg.self_id))
}
function groupText(msg) {
  const parts = Array.isArray(msg.message) ? msg.message : []
  const out = []
  for (const p of parts) {
    if (p?.type === "text") out.push(p?.data?.text || "")
    else if (p?.type === "image") out.push("[图片]")
    else if (p?.type === "mface") out.push(`[表情]${p?.data?.summary || ""}`)
    else if (p?.type === "video") out.push("[视频]")
  }
  return out.join(" ").trim()
}
function groupMedia(msg) {
  const parts = Array.isArray(msg.message) ? msg.message : []
  const out = []
  for (const p of parts) {
    if (p?.type === "image") out.push({ type: "image", url: p?.data?.url || p?.data?.file || "", summary: "" })
    else if (p?.type === "mface") out.push({ type: "image", url: p?.data?.url || "", summary: p?.data?.summary || "" })
    else if (p?.type === "video") out.push({ type: "video", url: p?.data?.url || p?.data?.file || "", summary: "" })
  }
  return out
}
function getGroupState(groupId) {
  const key = String(groupId)
  let st = groupStates.get(key)
  if (!st) {
    st = { key, buffer: [], timer: null, firstAt: 0, lastReplyAt: 0, replies: [], sessionId: state.groups?.[key] || "", lastIdle: 0, lastAssistantId: "", waitSince: 0, baseSet: false }
    groupStates.set(key, st)
  }
  return st
}
async function resetGroupBaseline(key, id) {
  const st = getGroupState(key)
  st.sessionId = id
  const info = await sessionInfo(id)
  st.lastIdle = info.info?.time?.idle || 0
  st.waitSince = 0
  const msgs = await apiJson(`/api/session/${id}/message`)
  const assistants = Array.isArray(msgs.data?.data) ? msgs.data.data.filter((m) => m?.type === "assistant") : []
  st.lastAssistantId = assistants.length ? assistants[0].id : ""
  // 显式标记「基线已经拍过」：空基线和「还没拍过」不能再靠 lastIdle/lastAssistantId 区分
  st.baseSet = true
}

/**
 * 提问前的水位基线：在把这一批消息送进去之前，先记住会话此刻停在哪。
 * 之后只认这个水位之后的 assistant，免得新群的第一条回复被当成旧消息丢掉。
 */
async function markGroupWatermark(key, id) {
  const st = getGroupState(key)
  const info = await sessionInfo(id)
  const msgs = await apiJson(`/api/session/${id}/message`)
  const assistants = Array.isArray(msgs.data?.data) ? msgs.data.data.filter((m) => m?.type === "assistant") : []
  st.sessionId = id
  st.lastIdle = info.info?.time?.idle || st.lastIdle || 0
  st.lastAssistantId = assistants.length ? assistants[0].id : ""
  st.waitSince = 0
  st.baseSet = true
}
async function ensureGroup(groupId) {
  const key = String(groupId)
  const existing = state.groups?.[key]
  if (existing) {
    const info = await sessionInfo(existing)
    if (info.status === "ok") {
      const st = getGroupState(key)
      // 桥接重启后 groupStates 是空的：先把基线对齐到旧会话，避免把上一轮回复再发一遍
      if (!st.baseSet) await resetGroupBaseline(key, existing)
      return existing
    }
    if (info.status === "missing") { delete state.groups[key]; saveState() }
    else return undefined
  }
  const res = await apiJson("/api/session", {
    method: "POST",
    body: JSON.stringify({ title: `qq-group-${groupId}`, location: { directory: location } }),
  })
  const id = res.data?.data?.id
  if (!id) { log("create group session failed", res.status, JSON.stringify(res.data).slice(0, 200)); return undefined }
  state.groups = state.groups || {}
  state.groups[key] = id
  saveState()
  log("created group session", key, id)
  await resetGroupBaseline(key, id)
  return id
}
async function deleteGroup(groupId) {
  const key = String(groupId)
  const id = state.groups?.[key]
  if (id) await api(`/api/session/${id}`, { method: "DELETE" }).catch(() => {})
  if (state.groups) delete state.groups[key]
  saveState()
  groupStates.delete(key)
  log("deleted group session", key)
}
function timeOf(ms) {
  try { return new Date(ms).toTimeString().slice(0, 5) } catch { return "" }
}
function formatBatch(batch) {
  return batch.map((m) => `[${timeOf(m.at)}] ${m.sender}：${m.text}`).join("\n")
}
async function recordGroupContext(key, batch) {
  const fresh = batch.filter((m) => !m.recorded)
  if (!fresh.length) return
  const id = await ensureGroup(key)
  if (!id) return
  try {
    await api(`/api/session/${id}/synthetic`, {
      method: "POST",
      body: JSON.stringify({ text: `[群聊记录]\n${formatBatch(fresh)}`, description: "group-context", resume: false }),
    })
    fresh.forEach((m) => { m.recorded = true })
    log("group context recorded", key, fresh.length)
  } catch (error) {
    log("group context record failed", String(error))
  }
}
function buildJudgePrompt(groupId, batch) {
  // 判官只看得到正文：@ / 点名的信号必须显式标出来，否则它会把「明着叫它」当成闲聊
  const lines = batch
    .map((m) => `[${timeOf(m.at)}] ${m.sender}（QQ ${m.userId}）：${m.trigger ? "【@ 了 bot / 点名】" : ""}${m.text}`)
    .join("\n")
  return [
    "你是群聊读空气判断器。判断 bot 现在该不该在群里接话。",
    "只输出 REPLY 或 SKIP，不要解释。",
    `群号：${groupId}`,
    "bot 人设：友好又诙谐、口语化能接梗的群友，懂 AI，有分寸。",
    "最近消息：",
    lines,
    "规则：",
    `- 有人 @ bot、点名、或提到关键词（${(groupCfg().keywords || []).join("/")}）→ 倾向 REPLY。`,
    "- 带【@ 了 bot / 点名】标记的消息，是明着在叫 bot：只要不是广告、刷屏或敏感内容，一律 REPLY。",
    "- 别人之间的闲聊、单纯陈述、广告、敏感/隐私话题 → 倾向 SKIP。",
    "- 如果 bot 刚说过话、或这条不需要它接 → SKIP。",
  ].join("\n")
}
async function runJudge(groupId, batch) {
  const cfg = groupCfg()
  const judgeModel = String(cfg.judgeModel || "default")
  let model
  if (judgeModel !== "default" && judgeModel.includes("/")) {
    const [providerID, modelID] = judgeModel.split("/")
    if (providerID && modelID) model = { providerID, id: modelID }
  }
  const body = { title: "qq-judge", location: { directory: JUDGE_DIR } }
  if (model) body.model = model
  log("judge using", model ? judgeModel : "default")
  const res = await apiJson("/api/session", { method: "POST", body: JSON.stringify(body) })
  const sid = res.data?.data?.id
  if (!sid) { log("judge create failed", res.status, JSON.stringify(res.data).slice(0, 160)); return "SKIP" }
  writeJson(JUDGE_SESSION_FILE, { id: sid })
  try {
    await api(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: buildJudgePrompt(groupId, batch) }) })
    const deadline = Date.now() + (cfg.judgeTimeoutMs || 30000)
    while (Date.now() < deadline) {
      await sleep(800)
      const msgs = await apiJson(`/api/session/${sid}/message`)
      const arr = Array.isArray(msgs.data?.data) ? msgs.data.data : []
      const a = arr.find((m) => m?.type === "assistant" && m?.time?.completed)
      if (a) {
        const out = (a.content || []).filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim()
        if (out) {
          const verdict = /REPLY/i.test(out) && !/SKIP/i.test(out) ? "REPLY" : "SKIP"
          log("judge", verdict, out.slice(0, 60))
          return verdict
        }
      }
    }
    log("judge timeout")
    return "SKIP"
  } catch (error) {
    log("judge failed", String(error))
    return "SKIP"
  } finally {
    await api(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {})
    try { unlinkSync(JUDGE_SESSION_FILE) } catch {}
  }
}
async function downloadMedia(media) {
  if (!media?.url || !/^https?:\/\//i.test(media.url)) return undefined
  try {
    const res = await fetch(media.url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (media.url.split("?")[0].match(/\.(png|jpe?g|gif|webp)$/i) || [".jpg"])[0]
    mkdirSync(GROUP_TMP_DIR, { recursive: true })
    const path = join(GROUP_TMP_DIR, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    writeFileSync(path, buf)
    return path
  } catch (error) {
    log("download media failed", String(error))
    return undefined
  }
}
async function buildGroupPrompt(groupId, batch) {
  const lines = formatBatch(batch)
  const files = []
  for (const m of batch) {
    for (const media of m.media || []) {
      if (media.type === "image") {
        const path = await downloadMedia(media)
        if (path) files.push({ uri: `file://${path}`, name: `qq-image-${files.length + 1}` })
      }
    }
  }
  const text = [
    `[群聊｜群号 ${groupId}]`,
    "最近消息：",
    lines,
    "（这是 QQ 群聊。你是群友，不是助理；把对方当普通朋友，不用情侣称呼，不谈亲密关系/私聊内容。学习群友的聊天风格，友好又诙谐，口语化能接梗；像日常聊天，别文言、别书面语；一次 1~3 条；不适合接就只回 [SILENT]。）",
  ].join("\n")
  return { text, files }
}
async function sendGroup(groupId, text) {
  const cfg = groupCfg()
  const banned = Array.isArray(cfg.bannedWords) ? cfg.bannedWords : []
  const messages = splitMessages(text).filter((line) => line.trim() && !/\[SILENT\]/i.test(line))
  let sent = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (banned.some((w) => message.includes(w))) {
      log("group filter blocked", message.slice(0, 40))
      continue
    }
    try {
      await call("send_group_msg", { group_id: Number(groupId), message })
      sent++
      log(`sent group ${i + 1}/${messages.length}`, message.slice(0, 40))
    } catch (error) {
      log("send group failed", String(error))
      return sent > 0
    }
    if (i < messages.length - 1) await sleep(900 + Math.min(3000, message.length * 55) + Math.floor(Math.random() * 600))
  }
  return sent > 0
}
async function processGroup(groupId) {
  const key = String(groupId)
  const st = getGroupState(key)
  st.timer = null
  st.firstAt = 0
  if (!groupEnabled() || st.buffer.length === 0) return
  const cfg = groupCfg()
  const now = Date.now()
  const batch = st.buffer.slice(-15)
  // 硬触发（@/点名/关键词）= 明着叫它：让冷却和条数上限让路，只留判官把关
  const triggered = batch.some((m) => m.trigger)
  const cooldown = cfg.cooldownMs ?? 8000
  const cooling = cooldown > 0 && now - st.lastReplyAt < cooldown
  if (!triggered && cooling) {
    log("group cooldown")
    await recordGroupContext(key, batch)
    return
  }
  // 10 分钟条数上限：默认不限；配成正数才生效
  st.replies = st.replies.filter((t) => now - t < 10 * 60_000)
  const cap = Number(cfg.maxPer10Min ?? 0)
  if (!triggered && cap > 0 && st.replies.length >= cap) {
    log("group rate limit")
    await recordGroupContext(key, batch)
    return
  }
  if (triggered && (cooling || (cap > 0 && st.replies.length >= cap))) {
    log("group trigger bypasses pacing", { cooling, replies: st.replies.length })
  }
  let chance = cfg.interjectChance ?? 0.05
  if (now - st.lastReplyAt < (cfg.probabilityDurationMs || 120000)) chance = cfg.afterReplyChance ?? 0.8
  if (!triggered && Math.random() >= chance) {
    log("group skip probability", chance)
    await recordGroupContext(key, batch)
    return
  }
  const verdict = await runJudge(key, batch)
  if (verdict !== "REPLY") {
    // 被点名还被判官拦下：单独记一笔，方便回头调判官提示词
    if (triggered) log("judge SKIP on triggered batch", { messages: batch.length })
    await recordGroupContext(key, batch)
    return
  }
  const id = await ensureGroup(key)
  if (!id) return
  const { text, files } = await buildGroupPrompt(key, batch)
  st.sessionId = id
  // 提问前先拍水位：这一批送进去之后产生的回复，才算这一次的
  await markGroupWatermark(key, id)
  groupRunWindows.set(key, { start: Date.now(), end: 0 })
  const body = { text }
  if (files.length) body.files = files
  const res = await api(`/api/session/${id}/prompt`, { method: "POST", body: JSON.stringify(body) })
  if (!res.ok) {
    log("group prompt failed", res.status, (await res.text()).slice(0, 200))
    const w = groupRunWindows.get(key); if (w) w.end = Date.now()
    return
  }
  batch.forEach((m) => { m.recorded = true })
  log("group prompt queued", key, id, "files", files.length)
}
async function pollGroups() {
  for (const [key, st] of groupStates) {
    if (!st.sessionId) continue
    try {
      // 只看「基线拍过没有」，不看基线值是否为空——新会话的基线本来就是 0 / ""
      if (!st.baseSet) {
        await resetGroupBaseline(key, st.sessionId)
        continue
      }
      const info = await sessionInfo(st.sessionId)
      if (info.status !== "ok") continue
      const idle = info.info?.time?.idle
      if (!idle || idle === st.lastIdle) continue
      const msgs = await apiJson(`/api/session/${st.sessionId}/message`)
      const arr = Array.isArray(msgs.data?.data) ? msgs.data.data : []
      const a = arr.find((m) => m?.type === "assistant" && m?.time?.completed)
      if (!a) { st.lastIdle = idle; continue }
      if (a.id === st.lastAssistantId) {
        // 新一轮可能还在流式输出：先不推进 idle，等新 assistant 完成；超过 45 秒则放弃
        if (!st.waitSince) st.waitSince = Date.now()
        if (Date.now() - st.waitSince > 45000) {
          st.lastIdle = idle
          st.waitSince = 0
          log("group no new assistant, give up", key)
        }
        continue
      }
      st.waitSince = 0
      const text = (a.content || []).filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim()
      st.lastIdle = idle
      st.lastAssistantId = a.id
      if (text && !/\[SILENT\]/i.test(text)) {
        const ok = await sendGroup(key, text)
        if (ok) {
          st.lastReplyAt = Date.now()
          st.replies.push(Date.now())
        }
      }
      const w = groupRunWindows.get(key)
      if (w && !w.end) w.end = Date.now()
    } catch (error) {
      log("poll group failed", String(error))
    }
  }
}
function scheduleGroup(groupId, trigger) {
  const st = getGroupState(groupId)
  if (!st.firstAt) st.firstAt = Date.now()
  const cfg = groupCfg()
  const base = trigger ? (cfg.triggerDebounceMs ?? 1200) : (cfg.debounceMs ?? 10000)
  const elapsed = Date.now() - st.firstAt
  const maxWait = cfg.maxBatchWaitMs ?? 60000
  const delay = Math.max(0, Math.min(base, maxWait - elapsed))
  clearTimeout(st.timer)
  st.timer = setTimeout(() => processGroup(groupId), delay)
}
async function handleGroup(msg) {
  log("group event", JSON.stringify({ enabled: groupEnabled(), group: msg.group_id, user: msg.user_id, self: msg.self_id, text: groupText(msg).slice(0, 60) }))
  if (!groupEnabled()) return
  if (Number(msg.user_id) === Number(msg.self_id)) return
  const groupId = Number(msg.group_id)
  if (!groupId) return
  const text = groupText(msg)
  if (Number(msg.user_id) === ownerQQ && text.trim() === "/new") {
    await deleteGroup(groupId)
    await call("send_group_msg", { group_id: groupId, message: "新对话已开，下一条消息开始新会话。" }).catch(() => {})
    return
  }
  if (!text) return
  const st = getGroupState(groupId)
  const trigger = isAtBot(msg) || keywordMatch(text)
  st.buffer.push({ sender: nameOf(msg), userId: msg.user_id, text, media: groupMedia(msg), trigger, at: Date.now(), recorded: false })
  if (st.buffer.length > 30) st.buffer.splice(0, st.buffer.length - 30)
  scheduleGroup(groupId, trigger)
}

// ———————————————————————— 轮询她的回复 ————————————————————————
let polling = false
async function pollPrivate() {
  if (polling) return
  polling = true
  try {
    // 不在这里创建会话：/new 之后应该等下一条消息（或她的 reach_out）再建
    if (!state.privateSessionId) return
    const id = state.privateSessionId
    const { status, info } = await sessionInfo(id)
    if (status === "missing") {
      delete state.privateSessionId
      delete state.lastSessionId
      delete state.lastIdle
      delete state.lastAssistantId
      saveState()
      log("private session missing (poll), clear")
      return
    }
    if (status !== "ok") return
    const idle = info?.time?.idle
    if (!idle || idle === state.lastIdle) return
    const res = await apiJson(`/api/session/${id}/message`)
    if (!res.ok || !Array.isArray(res.data?.data)) return
    const assistants = res.data.data.filter((m) => m?.type === "assistant" && m?.time?.completed)
    const last = assistants[0]
    if (!last) return
    if (last.id === state.lastAssistantId) { state.lastIdle = idle; saveState(); return }
    const text = (last.content || [])
      .filter((p) => p?.type === "text" && p?.text)
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text) {
      const ok = await sendPrivate(text)
      if (ok) {
        state.lastIdle = idle
        state.lastAssistantId = last.id
        if (runWindow && !runWindow.end) { runWindow.reaches = []; runWindow.end = Date.now() }
        saveState()
      } else {
        log("reply send failed, will retry")
      }
      return
    }
    // 正文为空：这一轮她可能把话都写进了 reach_out，把缓冲的行当回复发出去
    const buffered = runWindow && !runWindow.end ? [...runWindow.reaches] : []
    if (buffered.length) {
      const ok = await sendPrivate(buffered.join("\n"))
      if (!ok) { log("buffered reply send failed, will retry"); return }
      runWindow.reaches = []
      log("reply from reach_out buffer", buffered.length)
    }
    state.lastIdle = idle
    state.lastAssistantId = last.id
    if (runWindow && !runWindow.end) runWindow.end = Date.now()
    saveState()
  } catch (error) {
    log("poll failed", String(error))
  } finally {
    polling = false
  }
}

// ———————————————————————— outbox -> QQ ————————————————————————
let outboxBusy = false
/** 补发范围：最近几天（跨天离线后也能补上） */
const OUTBOX_DAYS = 3

function outboxFile(day) {
  return join(OUTBOX_DIR, `${day}.jsonl`)
}

/** outbox 游标按天存；兼容旧的 { file, offset } 结构 */
function outboxOffsets() {
  if (!state.outbox || !state.outbox.offsets) {
    const offsets = {}
    const prev = state.outbox || {}
    const day = String(prev.file || "").match(/(\d{4}-\d{2}-\d{2})\.jsonl/)
    if (day) offsets[day[1]] = Number(prev.offset) || 0
    state.outbox = { offsets, since: new Date().toISOString() }
    saveState()
  }
  return state.outbox.offsets
}

function recentDays(n) {
  const out = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push(dayOf(d))
  }
  return out
}

async function pollOutbox() {
  if (outboxBusy) return
  outboxBusy = true
  try {
    // 运行窗口超时：把缓冲的 reach_out 当回复发掉，避免永远卡住
    if (runWindow && !runWindow.end && Date.now() - runWindow.start > 5 * 60_000) {
      const buffered = runWindow.reaches.splice(0)
      runWindow.end = Date.now()
      log("run window timeout, flush reaches", buffered.length)
      if (buffered.length) await sendPrivate(buffered.join("\n"))
    }

    const offsets = outboxOffsets()
    for (const day of recentDays(OUTBOX_DAYS)) {
      const file = outboxFile(day)
      if (!existsSync(file)) continue
      const buf = readFileSync(file)
      let offset = offsets[day]
      if (offset === undefined) {
        if (day === dayOf(new Date())) {
          // 今天的新文件：从头读
          offsets[day] = 0
          saveState()
          continue
        }
        // 更早的文件：只补「升级之后才写进去」的条目，旧内容当作已处理
        const since = Date.parse(state.outbox.since || "") || 0
        const text = buf.toString("utf8")
        let pos = 0
        let firstPos = -1
        for (const line of text.split("\n")) {
          if (line.trim()) {
            try {
              const j = JSON.parse(line)
              const t = Date.parse(j.t || "")
              if (Number.isFinite(t) && t >= since) { firstPos = pos; break }
            } catch { /* 坏行跳过 */ }
          }
          pos += Buffer.byteLength(line + "\n")
        }
        offsets[day] = firstPos >= 0 ? firstPos : buf.length
        saveState()
        log("outbox baseline", day, offsets[day], firstPos >= 0 ? "will catch up" : "skip history")
        continue
      }
      if (buf.length <= offset) continue
      const chunk = buf.subarray(offset).toString("utf8")
      const lines = chunk.split("\n")
      lines.pop() // 最后一段可能是半行，留到下次
      let consumed = 0
      let blocked = false
      for (const line of lines) {
        const bytes = Buffer.byteLength(line + "\n")
        if (!line.trim()) { consumed += bytes; continue }
        let item
        try { item = JSON.parse(line) } catch { consumed += bytes; continue }
        if (item.kind !== "reach" || !item.text) { consumed += bytes; continue }
        // 群聊运行期间产生的 reach_out：不能发到私聊，跳过
        const ts = Date.parse(item.t || "")
        let inGroupRun = false
        for (const w of groupRunWindows.values()) {
          if (Number.isFinite(ts) && ts >= w.start - 2000 && ts <= (w.end || Date.now()) + 2000) { inGroupRun = true; break }
        }
        if (inGroupRun) {
          if (runWindow && !runWindow.end) {
            runWindow.reaches.push(item.text)
            log("buffer reach_out during qq-chat run", item.text.slice(0, 30))
          } else {
            log("suppress reach_out during qq-chat run", item.text.slice(0, 30))
          }
          consumed += bytes
          continue
        }
        const id = await ensurePrivate()
        if (!id) { blocked = true; break }
        await api(`/api/session/${id}/synthetic`, {
          method: "POST",
          body: JSON.stringify({ text: item.text, description: "reach_out", resume: false }),
        }).catch(() => {})
        const ok = await sendPrivate(item.text)
        if (!ok) { blocked = true; break }
        consumed += bytes
      }
      if (consumed > 0) {
        offsets[day] = offset + consumed
        saveState()
        if (day !== dayOf(new Date())) log("outbox catch-up", day, consumed)
      }
      if (blocked) break // 发不出去就停，下次再试（游标没推进的部分会重试）
    }
  } catch (error) {
    log("outbox failed", String(error))
  } finally {
    outboxBusy = false
  }
}

// ———————————————————————— 启动 ————————————————————————
// 心跳：只有 WS 在线时才更新，life-world 以此判断桥接是否真的在跑
setInterval(() => {
  if (wsReady) {
    state.lastSeen = new Date().toISOString()
    saveState()
  } else {
    // 看门狗：断着就每 15 秒提醒一次重连（NapCat 重启、网络恢复后能自己回来）
    scheduleReconnect("watchdog")
  }
}, 15000)

if (process.argv[2] === "--test-send") {
  connect()
  const timer = setInterval(async () => {
    if (!wsReady) return
    clearInterval(timer)
    const text = process.argv[3] || "NapCat 桥接测试：已连接到 QQ。"
    try {
      const ok = await sendPrivate(text)
      log("test send", ok ? "ok" : "failed")
    } catch (error) {
      log("test send failed", String(error))
    }
    setTimeout(() => process.exit(0), 600)
  }, 300)
  setTimeout(() => { log("test send timeout"); process.exit(1) }, 20000)
} else {
  // 首次启动：今天已有 outbox 就跳过历史，没有就从 0 开始
  const todayFile = join(OUTBOX_DIR, `${dayOf()}.jsonl`)
  if (!state.outbox || state.outbox.file !== todayFile) {
    state.outbox = { file: todayFile, offset: existsSync(todayFile) ? statSync(todayFile).size : 0 }
    saveState()
  }
  connect()
  setInterval(pollPrivate, 1500)
  setInterval(pollGroups, 1500)
  setInterval(pollOutbox, 2000)
  log("bridge started", { ownerQQ, sessionTitle, wsUrl, group: config.group?.enabled === true })
}
