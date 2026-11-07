#!/usr/bin/env node
/**
 * life-world · pi QQ bridge (MVP)
 *
 * OneBot v11 正向 WS ↔ pi RPC 子进程。
 * - 私聊：owner 消息 -> pi prompt -> assistant 文本 -> QQ
 * - 余波：60 秒没人回 -> 补一拍（最多 2 拍；[SILENT] 不发、不续）
 * - outbox：reach_out / send_media 投递
 * - 群聊：基础版（可选，见 groupCfg）
 *
 * 用法：
 *   node qq-bridge.mjs
 *   node qq-bridge.mjs --test-user "在吗"     # 模拟 owner 发一条私聊，测试用
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const HOME = homedir()
const ROOT = process.env.LIFE_WORLD_ROOT || join(HOME, ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const OUTBOX_DIR = join(WORLD, "outbox")
const TMP_DIR = join(WORLD, "tmp")
const CONFIG_FILE = join(ROOT, "life-world.json")
const STATE_FILE = join(ROOT, "qq-bridge-state.json")
const LOG_FILE = join(ROOT, "qq-bridge.log")
const SESSION_DIR = join(ROOT, "pi-sessions")
const HERE = dirname(fileURLToPath(import.meta.url))
const PI_BIN = process.env.PI_BIN || "pi"
const EXT = process.env.LIFE_WORLD_EXT || join(HERE, "../ext/life-world.ts")
const PROMPT = process.env.LIFE_WORLD_PROMPT || join(HERE, "../prompt/world.md")
const MODEL = process.env.LIFE_WORLD_MODEL || "deepseek-flash"
const TZ = process.env.TZ || "Asia/Shanghai"

function rotate() {
  try { if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch { /* ignore */ }
}
rotate()
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, line + "\n", { mode: 0o600 }) } catch { /* ignore */ }
  if (process.stdout.isTTY) console.log(line)
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) { log("write state failed", String(e)); try { unlinkSync(tmp) } catch { /* ignore */ } }
}
const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const config = readJson(CONFIG_FILE, {})
const bridge = config.bridge || {}
if (bridge.enabled !== true) { log("bridge disabled, exit"); process.exit(0) }
const ownerQQ = Number(bridge.ownerQQ)
if (!ownerQQ) { log("ownerQQ missing, exit"); process.exit(1) }
const wsUrl = bridge.wsUrl || "ws://127.0.0.1:3001"
const wsToken = bridge.token || ""
const afterglowCfg = Object.assign({ enabled: true, delayMs: 60000, maxRounds: 2 }, bridge.afterglow || {})
const groupCfg = Object.assign({ enabled: false }, bridge.group || {})
const TEST_USER = process.argv[2] === "--test-user" ? (process.argv[3] || "在吗") : ""
const TEST_MS = Number(process.env.TEST_MS || 60000)

let state = readJson(STATE_FILE, {})
function saveState() { writeJson(STATE_FILE, state) }
mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 })

// ———————————————— OneBot ————————————————
let ws = null
let wsReady = false
let reconnectTimer = null
let reconnectDelay = 5000
const pending = new Map()
let echoSeq = 0

function scheduleReconnect(reason) {
  if (reconnectTimer) return
  log(`reconnect in ${Math.round(reconnectDelay / 1000)}s`, reason)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, reconnectDelay)
  reconnectDelay = Math.min(60000, reconnectDelay * 2)
}

function connect() {
  const url = wsToken ? `${wsUrl}?access_token=${encodeURIComponent(wsToken)}` : wsUrl
  const previous = ws
  ws = null
  if (previous) { try { previous.close() } catch { /* ignore */ } }
  wsReady = false
  let socket
  try { socket = new WebSocket(url) } catch (e) { log("ws create failed", String(e)); scheduleReconnect("bad wsUrl"); return }
  ws = socket
  socket.addEventListener("open", () => {
    if (ws !== socket) return
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    wsReady = true
    reconnectDelay = 5000
    state.lastSeen = new Date().toISOString()
    saveState()
    log("ws open", wsUrl)
    if (TEST_USER) {
      setTimeout(() => handlePrivate({
        user_id: ownerQQ,
        self_id: 0,
        message: [{ type: "text", data: { text: TEST_USER } }],
        sender: { nickname: "测试" },
      }).catch((e) => log("test user failed", String(e))), 300)
      setTimeout(() => { log("test done"); try { pi.child?.kill("SIGTERM") } catch { /* ignore */ } process.exit(0) }, TEST_MS)
    }
  })
  socket.addEventListener("close", () => { if (ws !== socket) return; wsReady = false; scheduleReconnect("close") })
  socket.addEventListener("error", (e) => { if (ws !== socket) return; wsReady = false; log("ws error", e?.message || ""); scheduleReconnect("error") })
  socket.addEventListener("message", (event) => {
    if (ws !== socket) return
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.echo && pending.has(msg.echo)) {
      const p = pending.get(msg.echo)
      clearTimeout(p.timer)
      pending.delete(msg.echo)
      const failed = msg.status === "failed" || (typeof msg.retcode === "number" && msg.retcode !== 0 && msg.retcode !== 1)
      if (failed) p.reject(new Error(`${msg.status || "failed"} retcode=${msg.retcode ?? "?"}`))
      else p.resolve(msg)
      return
    }
    if (msg.post_type === "message" && msg.message_type === "private") {
      handlePrivate(msg).catch((e) => log("handle private failed", String(e)))
    } else if (msg.post_type === "message" && msg.message_type === "group") {
      handleGroup(msg).catch((e) => log("handle group failed", String(e)))
    }
  })
}

function call(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!wsReady || !ws) return reject(new Error("ws not ready"))
    const echo = `e-${Date.now()}-${++echoSeq}`
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`${action} timeout`)) }, timeoutMs)
    pending.set(echo, { resolve, reject, timer })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}

function messageParts(msg) {
  if (Array.isArray(msg?.message)) return msg.message
  if (typeof msg?.message !== "string") return []
  const parts = []
  const re = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g
  let last = 0, m
  while ((m = re.exec(msg.message))) {
    if (m.index > last) parts.push({ type: "text", data: { text: msg.message.slice(last, m.index) } })
    const data = {}
    for (const kv of m[2].split(",")) { const i = kv.indexOf("="); if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1) }
    parts.push({ type: m[1], data })
    last = m.index + m[0].length
  }
  if (last < msg.message.length) parts.push({ type: "text", data: { text: msg.message.slice(last) } })
  return parts
}
function textOf(msg) { return messageParts(msg).filter((p) => p?.type === "text").map((p) => p?.data?.text || "").join("").trim() }
function nameOf(msg) { return msg.sender?.card || msg.sender?.nickname || String(msg.user_id) }
function splitMessages(text, limit = 800) {
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.length <= limit) { out.push(line); continue }
    let rest = line
    while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit) }
    if (rest) out.push(rest)
  }
  return out
}

const sendChains = new Map()
function enqueueSend(key, fn) {
  const prev = sendChains.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  sendChains.set(key, run.catch(() => {}))
  return run
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function sendPrivate(text) {
  return enqueueSend("private", async () => {
    for (const line of splitMessages(text)) {
      try { await call("send_private_msg", { user_id: ownerQQ, message: line }); log("sent private", line.slice(0, 40)) } catch (e) { log("send private failed", String(e)); return false }
      await sleep(900 + Math.min(2500, line.length * 45))
    }
    return true
  })
}
function sendGroup(groupId, text) {
  return enqueueSend(`group:${groupId}`, async () => {
    for (const line of splitMessages(text)) {
      if (/\[SILENT\]/i.test(line)) continue
      try { await call("send_group_msg", { group_id: Number(groupId), message: line }) } catch (e) { log("send group failed", String(e)); return false }
      await sleep(900 + Math.min(2500, line.length * 45))
    }
    return true
  })
}

// ———————————————— pi RPC ————————————————
class PiSession {
  constructor({ channel = "qq", groupId = "", name = "qq-chat", sessionFile = "" }) {
    this.channel = channel
    this.groupId = groupId
    this.name = name
    this.sessionFile = sessionFile
    this.child = null
    this.buffer = ""
    this.running = false
    this.texts = []
    this.waiters = []
    this.idleWaiters = []
    this.reqId = 0
    this.closed = false
  }
  env() {
    return { ...process.env, TZ, LIFE_WORLD_ROOT: ROOT, LIFE_WORLD_ROLE: this.channel === "qq" ? "qq" : "group", LIFE_WORLD_CHANNEL: this.channel, LIFE_WORLD_GROUP_ID: this.groupId }
  }
  start() {
    if (this.child) return
    const args = ["--mode", "rpc", "--model", MODEL, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions", "-e", EXT, "--append-system-prompt", PROMPT, "--session-dir", SESSION_DIR]
    if (this.sessionFile) args.push("--session", this.sessionFile)
    else args.push("--name", this.name)
    log("pi start", this.name, this.sessionFile || "(new)")
    const child = spawn(PI_BIN, args, { env: this.env(), stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    this.closed = false
    child.on("error", (e) => { log("pi spawn error", String(e)); this.onExit() })
    child.on("exit", (code, signal) => { log("pi exit", this.name, code, signal); this.onExit() })
    child.stderr.on("data", (d) => log("pi stderr", String(d).slice(0, 300)))
    child.stdout.on("data", (d) => this.onData(String(d)))
    this.request("get_state").then((res) => {
      const file = res?.data?.sessionFile
      if (file) { this.sessionFile = file; state.piSessionFile = file; saveState() }
    }).catch(() => {})
  }
  onExit() {
    this.closed = true
    this.child = null
    this.running = false
    this.texts = []
    for (const w of this.waiters.splice(0)) w.reject(new Error("pi exited"))
    if (!this.stopping) setTimeout(() => this.start(), 2000)
  }
  onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "")
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this.onRecord(msg)
    }
  }
  onRecord(msg) {
    if (msg.type === "response" && msg.id && this.pendingResponses?.has(msg.id)) {
      const p = this.pendingResponses.get(msg.id)
      this.pendingResponses.delete(msg.id)
      if (msg.success) p.resolve(msg)
      else p.reject(new Error(msg.error || "command failed"))
      return
    }
    if (msg.type === "message_end") {
      const m = msg.message
      if (m?.role === "assistant") {
        const text = (Array.isArray(m.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : String(m.content || "")).trim()
        if (text) this.texts.push(text)
      }
      return
    }
    if (msg.type === "agent_start") { this.running = true; return }
    if (msg.type === "agent_settled") {
      this.running = false
      const texts = this.texts.splice(0)
      const waiters = this.waiters.splice(0)
      for (const w of waiters) w.resolve(texts)
      const idle = this.idleWaiters.splice(0)
      for (const r of idle) r()
      return
    }
    if (msg.type === "extension_ui_request") {
      // QQ 不渲染面板：直接取消
      this.write({ type: "extension_ui_response", id: msg.id, cancelled: true })
    }
  }
  write(obj) { try { this.child?.stdin.write(JSON.stringify(obj) + "\n") } catch (e) { log("pi write failed", String(e)) } }
  request(type, extra = {}) {
    if (!this.pendingResponses) this.pendingResponses = new Map()
    const id = `r-${++this.reqId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingResponses.delete(id); reject(new Error(`${type} timeout`)) }, 30000)
      this.pendingResponses.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.write({ id, type, ...extra })
    })
  }
  async prompt(text, images = [], timeoutMs = 300000) {
    if (this.closed || !this.child) this.start()
    if (this.running) {
      await new Promise((resolve) => this.idleWaiters.push(resolve))
    }
    this.texts = []
    const wait = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("prompt timeout")) }, timeoutMs)
      this.waiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    })
    const body = { type: "prompt", message: text }
    if (images.length) body.images = images
    this.write(body)
    return wait
  }
  async newSession() {
    this.stopping = true
    try { this.child?.kill("SIGTERM") } catch { /* ignore */ }
    await sleep(800)
    this.stopping = false
    this.sessionFile = ""
    delete state.piSessionFile
    saveState()
    this.start()
  }
}

const pi = new PiSession({ channel: "qq", name: "qq-chat", sessionFile: state.piSessionFile || "" })

// ———————————————— typing ————————————————
let typingTimer = null
function startTyping() {
  if (typingTimer) return
  const ping = () => call("set_input_status", { user_id: ownerQQ, event_type: 1 }).catch(() => {})
  ping()
  typingTimer = setInterval(ping, 4000)
  typingTimer.unref?.()
}
function stopTyping() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null }
  call("set_input_status", { user_id: ownerQQ, event_type: 0 }).catch(() => {})
}

// ———————————————— 余波 ————————————————
const afterglow = { timer: null, round: 0, seq: 0, userSeq: 0 }
function clearAfterglow() { if (afterglow.timer) { clearTimeout(afterglow.timer); afterglow.timer = null } }
function userReturned() { afterglow.userSeq++; afterglow.round = 0; clearAfterglow(); log("userReturned", afterglow.userSeq) }
function armAfterglow(round) {
  if (!afterglowCfg.enabled || afterglowCfg.maxRounds <= 0 || round < 1 || round > afterglowCfg.maxRounds) return
  clearAfterglow()
  afterglow.round = round
  afterglow.seq = afterglow.userSeq
  afterglow.timer = setTimeout(async () => {
    afterglow.timer = null
    log("afterglow fire", round, "seq", afterglow.seq, "userSeq", afterglow.userSeq, "running", pi.running)
    if (afterglow.seq !== afterglow.userSeq || pi.running) return
    try {
      startTyping()
      const texts = await pi.prompt("【余波】对方还没回你，已经过了一会儿。\n不要假装他说话了，也不要重新打招呼。\n如果上一轮还有没说完的、想补一句解释、或者想问一句怎么不说话——现在补一句；一两句就够。\n如果觉得这会儿不该说、没什么要补的，就只回 [SILENT]。\n直接写正文，不要调用 reach_out。")
      stopTyping()
      const text = texts.join("\n").trim()
      if (!text || /^\[SILENT\]$/i.test(text)) { afterglow.round = 0; return }
      await sendPrivate(text)
      if (afterglow.seq === afterglow.userSeq) armAfterglow(round + 1)
    } catch (e) { log("afterglow failed", String(e)); stopTyping() }
  }, Number(afterglowCfg.delayMs) || 60000)
  afterglow.timer.unref?.()
  log("afterglow armed", round, afterglowCfg.delayMs)
}

// ———————————————— 私聊 ————————————————
const privateMediaCache = []
async function handlePrivateNow(msg) {
  if (Number(msg.user_id) !== ownerQQ) return
  userReturned()
  const text = textOf(msg)
  if (!text) return
  if (text.trim() === "/new") {
    await pi.newSession()
    await call("send_private_msg", { user_id: ownerQQ, message: "新对话已开。" }).catch(() => {})
    return
  }
  const annotated = `[私聊｜${nameOf(msg)}（QQ ${msg.user_id}）] ${text}\n（这是 QQ 私聊：按 system 里的规则回复；直接写正文，不要调用 reach_out。）`
  log("private in", text.slice(0, 60))
  startTyping()
  try {
    const texts = await pi.prompt(annotated)
    stopTyping()
    const reply = texts.join("\n").trim()
    if (reply && !/^\[SILENT\]$/i.test(reply)) await sendPrivate(reply)
    if (state.reachBuffer && state.reachBuffer.length) {
      const buffered = state.reachBuffer.splice(0)
      for (const line of buffered) await sendPrivate(line)
      saveState()
    }
    if (afterglowCfg.enabled && afterglowCfg.maxRounds > 0) armAfterglow(1)
  } catch (e) {
    stopTyping()
    log("private prompt failed", String(e))
    await call("send_private_msg", { user_id: ownerQQ, message: "（我这边暂时没接上，稍后再发一次试试）" }).catch(() => {})
  }
}

let privateChain = Promise.resolve()
function handlePrivate(msg) {
  const run = privateChain.then(() => handlePrivateNow(msg)).catch((e) => log("handle private failed", String(e)))
  privateChain = run.catch(() => {})
  return run
}

// ———————————————— 群聊（基础版） ————————————————
const groupSessions = new Map()
const groupBuffers = new Map()
function getGroupSession(groupId) {
  const key = String(groupId)
  let s = groupSessions.get(key)
  if (!s) {
    s = new PiSession({ channel: "group", groupId: key, name: `qq-group-${key}` })
    s.start()
    groupSessions.set(key, s)
  }
  return s
}
function groupTrigger(text) {
  const kws = Array.isArray(groupCfg.keywords) ? groupCfg.keywords : []
  return kws.some((k) => String(k).trim() && text.includes(String(k).trim())) || /@/.test(text) || text.includes("小铃") || text.includes("铃")
}
async function handleGroup(msg) {
  if (!groupCfg.enabled) return
  if (Number(msg.user_id) === Number(msg.self_id)) return
  const groupId = Number(msg.group_id)
  if (!groupId) return
  const text = textOf(msg)
  if (!text) return
  const key = String(groupId)
  const buf = groupBuffers.get(key) || []
  buf.push({ sender: nameOf(msg), text, trigger: groupTrigger(text), at: Date.now() })
  groupBuffers.set(key, buf)
  if (buf.timer) clearTimeout(buf.timer)
  buf.timer = setTimeout(async () => {
    const batch = (groupBuffers.get(key) || []).splice(0)
    if (!batch.length) return
    const triggered = batch.some((m) => m.trigger)
    if (!triggered && Math.random() >= 0.05) return
    const judge = await judgeGroup(key, batch)
    if (judge !== "REPLY") return
    const session = getGroupSession(key)
    const prompt = `[群聊｜群号 ${key}]\n最近消息：\n${batch.map((m) => `${m.sender}：${m.text}`).join("\n")}\n（这是 QQ 群聊：按 system 里的群聊规则回复；不适合接就只回 [SILENT]。）`
    try {
      const texts = await session.prompt(prompt)
      const reply = texts.join("\n").trim()
      if (reply && !/^\[SILENT\]$/i.test(reply)) await sendGroup(key, reply)
    } catch (e) { log("group prompt failed", String(e)) }
  }, 3000)
}
function judgeGroup(groupId, batch) {
  return new Promise((resolve) => {
    const prompt = ["你是群聊读空气判断器。只输出 REPLY 或 SKIP。", `群号：${groupId}`, "最近消息：", ...batch.map((m) => `${m.sender}：${m.trigger ? "【@/点名】" : ""}${m.text}`), "规则：@/点名/关键词倾向 REPLY；闲聊/广告/敏感 SKIP。"].join("\n")
    const child = spawn(PI_BIN, ["-p", "--model", MODEL, "--no-session", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-context-files", "--no-tools", "--system-prompt", "你是群聊读空气判断器，只输出 REPLY 或 SKIP。"], { env: { ...process.env, TZ }, stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } resolve("SKIP") }, 45000)
    child.stdout.on("data", (d) => { out += String(d) })
    child.on("close", () => { clearTimeout(timer); resolve(/REPLY/i.test(out) && !/SKIP/i.test(out) ? "REPLY" : "SKIP") })
    child.on("error", () => { clearTimeout(timer); resolve("SKIP") })
    child.stdin.write(prompt + "\n")
  })
}

// ———————————————— outbox ————————————————
const outboxAttempts = new Map()
function outboxFile(day) { return join(OUTBOX_DIR, `${day}.jsonl`) }
function recentDays(n) { const out = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push(dayOf(d)) } return out }
async function sendOutboxMedia(item) {
  let file = String(item.path || "")
  if (!file || !existsSync(file)) { log("outbox media missing", file); return { ok: false } }
  const real = (() => { try { return realpathSync(file) } catch { return "" } })()
  if (!real) return { ok: false }
  const allowed = [join(WORLD, "room"), join(WORLD, "表情包"), join(WORLD, "语音"), join(WORLD, "tmp")].map((d) => { try { return realpathSync(d) } catch { return d } })
  if (!allowed.some((d) => real === d || real.startsWith(d + sep))) return { ok: false }
  const size = statSync(real).size
  const kind = item.mediaType || (/\.(png|jpe?g|gif|webp|bmp)$/i.test(real) ? "image" : /\.(mp3|wav|silk|amr|ogg|m4a)$/i.test(real) ? "voice" : "file")
  if (kind === "file" && size > 20 * 1024 * 1024) return { ok: false }
  if (kind !== "file" && size > 8 * 1024 * 1024) return { ok: false }
  const b64 = readFileSync(real).toString("base64")
  const target = item.target || { kind: "private" }
  const isGroup = target.kind === "group" && target.id
  if (isGroup && kind === "file") return { ok: false }
  const send = (message) => isGroup ? call("send_group_msg", { group_id: Number(target.id), message }, 60000) : call("send_private_msg", { user_id: ownerQQ, message }, 60000)
  const caption = String(item.text || "").slice(0, 500)
  const segments = []
  if (caption) segments.push({ type: "text", data: { text: caption } })
  if (kind === "image") segments.push({ type: "image", data: { file: `base64://${b64}` } })
  else if (kind === "voice") segments.push({ type: "record", data: { file: `base64://${b64}` } })
  else segments.push({ type: "file", data: { file: `base64://${b64}`, name: item.name || basename(real) } })
  try {
    await send(segments)
    log("sent media", kind, item.name || basename(real), caption.slice(0, 30))
    return { ok: true }
  } catch (e) {
    log("send media failed", String(e))
    return { ok: false, retryable: /ws not ready/i.test(String(e)) }
  }
}
async function pollOutboxNow() {
  const offsets = state.outbox || (state.outbox = { offsets: {}, since: new Date().toISOString() })
  for (const day of recentDays(3)) {
    const file = outboxFile(day)
    if (!existsSync(file)) continue
    const buf = readFileSync(file)
    let offset = offsets.offsets[day]
    if (offset === undefined) { offsets.offsets[day] = day === dayOf() ? 0 : buf.length; saveState(); if (offset === undefined) continue }
    if (buf.length <= offset) continue
    const lines = buf.subarray(offset).toString("utf8").split("\n")
    lines.pop()
    let consumed = 0
    for (const line of lines) {
      const bytes = Buffer.byteLength(line + "\n")
      if (!line.trim()) { consumed += bytes; continue }
      let item
      try { item = JSON.parse(line) } catch { consumed += bytes; continue }
      if (item.kind === "media") {
        const sent = await sendOutboxMedia(item)
        if (sent.ok || !sent.retryable) consumed += bytes
        else break
      } else if (item.kind === "reach" && item.text) {
        if (pi.running) { state.reachBuffer = [...(state.reachBuffer || []), item.text]; consumed += bytes; continue }
        const ok = await sendPrivate(item.text)
        if (ok) consumed += bytes; else break
      } else consumed += bytes
    }
    if (consumed > 0) { offsets.offsets[day] = offset + consumed; saveState() }
  }
}

let outboxBusy = false
async function pollOutbox() {
  if (outboxBusy) return
  outboxBusy = true
  try { await pollOutboxNow() } finally { outboxBusy = false }
}

// ———————————————— 启动 ————————————————
pi.start()
connect()
setInterval(() => { if (wsReady) { state.lastSeen = new Date().toISOString(); saveState() } }, 15000).unref?.()
setInterval(() => { pollOutbox().catch((e) => log("outbox failed", String(e))) }, 2000).unref?.()
setInterval(() => { if (!wsReady && !reconnectTimer) scheduleReconnect("watchdog") }, 15000).unref?.()
log("bridge started", { ownerQQ, wsUrl, model: MODEL, afterglow: afterglowCfg })
process.on("exit", () => { try { pi.child?.kill("SIGTERM") } catch { /* ignore */ } })
