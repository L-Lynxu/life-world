import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

/**
 * life-world · pi 版
 * 以 pi 的扩展点为宿主：工具、input 注入、message_end 归档、定时器。
 * 静态世界规则走 --append-system-prompt（prompt/world.md），不每轮改 system。
 */

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const CONV_DIR = join(WORLD, "conversations")
const DIARY_DIR = join(WORLD, "diary")
const PLAN_DIR = join(WORLD, "plan")
const IDENTITY_DIR = join(WORLD, "identity")
const SELF_FILE = join(IDENTITY_DIR, "我是谁.md")
const PROFILE_FILE = join(IDENTITY_DIR, "用户画像.md")
const MOOD_FILE = join(IDENTITY_DIR, "心情.md")
const ROOM_DIR = join(WORLD, "room")
const STICKER_DIR = join(WORLD, "表情包")
const VOICE_DIR = join(WORLD, "语音")
const TMP_DIR = join(WORLD, "tmp")
const OUTBOX_DIR = join(WORLD, "outbox")
const WORLD_FILE = join(WORLD, "world.json")
const CONFIG_FILE = join(ROOT, "life-world.json")
const BRIDGE_STATE = join(ROOT, "qq-bridge-state.json")
const LOG_FILE = join(ROOT, "debug.log")
const KAOMOJI_FILE = process.env.LIFE_WORLD_KAOMOJI || join(ROOT, "pi-kaomoji.json")
const TIMER_LOCK = join(WORLD, ".pi-timer.lock")
const ROLE = process.env.LIFE_WORLD_ROLE || "cli"
const CHANNEL = process.env.LIFE_WORLD_CHANNEL || "cli"
const JUDGE = process.env.LIFE_WORLD_JUDGE === "1"
const GROUP_ID = process.env.LIFE_WORLD_GROUP_ID || ""
const DEPTH = Number(process.env.LIFE_WORLD_DEPTH || 0)

function log(text: string): void {
  try {
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 })
  } catch { /* ignore */ }
}

function atomicWrite(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  renameSync(tmp, path)
}

function pad(n: number): string { return String(n).padStart(2, "0") }
function zone(): string { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" } }
function dayOf(d = new Date()): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const a = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}
function stamp(d = new Date()): string { return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
function shortStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readText(path: string): string { try { return existsSync(path) ? readFileSync(path, "utf8").trim() : "" } catch { return "" } }
function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, "utf8")) as T } catch { return fallback } }

function ensureDirs(): void {
  for (const dir of [CONV_DIR, DIARY_DIR, PLAN_DIR, IDENTITY_DIR, ROOM_DIR, STICKER_DIR, VOICE_DIR, TMP_DIR, OUTBOX_DIR]) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
  }
}

interface Config {
  world: { enabled: boolean; running: boolean; reviewHour: number; fallbackWakeTime: string; recentLimit: number; hydrate: { hours: number; chars: number; mapDays: number } }
  bridge: { enabled: boolean; ownerQQ: number; wsUrl: string; group: { enabled: boolean; id?: string } }
  subagent: { model: string }
}

function config(): Config {
  const base: Config = {
    world: { enabled: true, running: true, reviewHour: 23, fallbackWakeTime: "09:00", recentLimit: 80, hydrate: { hours: 48, chars: 2000, mapDays: 3 } },
    bridge: { enabled: false, ownerQQ: 0, wsUrl: "ws://127.0.0.1:3001", group: { enabled: false } },
    subagent: { model: "deepseek-flash" },
  }
  const raw = readJson<Partial<Config>>(CONFIG_FILE, {})
  return {
    ...base,
    ...raw,
    world: { ...base.world, ...(raw.world || {}), hydrate: { ...base.world.hydrate, ...((raw.world || {}).hydrate || {}) } },
    bridge: { ...base.bridge, ...(raw.bridge || {}), group: { ...base.bridge.group, ...((raw.bridge || {}).group || {}) } },
    subagent: { ...base.subagent, ...(raw.subagent || {}) },
  }
}

interface Alarm { id: string; at: string; note: string; setAt: string }
interface WorldState { running?: boolean; alarms?: Alarm[]; lastReview?: string; lastWake?: string }
function readWorld(): WorldState { return readJson<WorldState>(WORLD_FILE, { running: true, alarms: [] }) }
function writeWorld(state: WorldState): boolean {
  try { atomicWrite(WORLD_FILE, JSON.stringify({ ...state, alarms: state.alarms || [] }, null, 2)); return true } catch (e) { log(`writeWorld failed ${String(e)}`); return false }
}

function bridgeStatus(): string {
  const c = config().bridge
  if (!c.enabled) return "已关闭"
  const s = readJson<{ lastSeen?: string }>(BRIDGE_STATE, {})
  const ms = s.lastSeen ? Date.parse(s.lastSeen) : 0
  return Number.isFinite(ms) && Date.now() - ms < 90_000 ? "在线" : "桥接未运行"
}

function moodLine(): string {
  const raw = readText(MOOD_FILE)
  if (!raw) return "无"
  for (const line of raw.split("\n")) {
    const t = line.replace(/^[-*\s#]+/, "").trim()
    if (t && !t.startsWith(">") && !t.startsWith("当前状态")) return t.slice(0, 80)
  }
  return "无"
}

function inputPrefix(): string {
  return `[本地时间 ${stamp()} ${zone()}]\n（心情：${moodLine()}；OneBot 桥接：${bridgeStatus()}）\n`
}

// ———————— 归档 / 记忆 ————————
interface Record_ { id: string; t: string; role: "user" | "assistant"; text: string }
let archived = new Set<string>()

function loadArchived(): void {
  archived = new Set()
  try {
    if (!existsSync(CONV_DIR)) return
    for (const f of readdirSync(CONV_DIR).filter((x) => x.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(CONV_DIR, f), "utf8").split("\n")) {
        if (!line.trim()) continue
        try { const r = JSON.parse(line) as Record_; if (r?.id) archived.add(r.id) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function cleanUserText(text: string): string {
  return text
    .replace(/^\[本地时间 [^\]]*\]\s*/, "")
    .split("\n")
    .filter((line) => !line.startsWith("（心情：") && !line.startsWith("（OneBot 桥接："))
    .join("\n")
    .trim()
}

function isAfterglow(text: string): boolean {
  return cleanUserText(text).startsWith("【余波】")
}

function archive(message: any): void {
  try {
    const role = message?.role
    if (role !== "user" && role !== "assistant") return
    let text = messageText(message).trim()
    if (!text) return
    if (role === "user") {
      if (isAfterglow(text)) return
      text = cleanUserText(text)
    }
    if (!text) return
    const t = new Date(message?.timestamp || Date.now()).toISOString()
    const id = String(message?.id || createHash("sha1").update(`${role}|${t}|${text}`).digest("hex"))
    if (archived.has(id)) return
    archived.add(id)
    mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(join(CONV_DIR, `${dayOf(new Date(t))}.jsonl`), `${JSON.stringify({ id, t, role, text })}\n`, { mode: 0o600 })
  } catch (e) { log(`archive failed ${String(e)}`) }
}

function messageText(message: any): string {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n")
  }
  return ""
}

function allRecords(): Record_[] {
  const out: Record_[] = []
  try {
    if (!existsSync(CONV_DIR)) return out
    const files = readdirSync(CONV_DIR).filter((f) => f.endsWith(".jsonl")).sort()
    for (const f of files) {
      for (const line of readFileSync(join(CONV_DIR, f), "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as Record_
          if (r && typeof r.t === "string" && typeof r.text === "string" && (r.role === "user" || r.role === "assistant")) out.push(r)
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  const order: string[] = []
  const byId = new Map<string, Record_>()
  for (const r of out) {
    if (!r.id) continue
    if (!byId.has(r.id)) order.push(r.id)
    byId.set(r.id, r)
  }
  return order.map((id) => byId.get(id) as Record_)
}

function diaryTitle(day: string): string {
  const raw = readText(join(DIARY_DIR, `${day}.md`))
  for (const line of raw.split("\n")) {
    const t = line.replace(/^[#>\s-]+/, "").trim()
    if (t) return t.slice(0, 40)
  }
  return ""
}

function memoryBlock(): string {
  const c = config()
  const h = c.world.hydrate
  const all = allRecords()
  const cutoff = Date.now() - h.hours * 3_600_000
  const recent = all.filter((r) => Date.parse(r.t) >= cutoff)
  const picked: Record_[] = []
  let total = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const cost = recent[i].text.length + 24
    if (total + cost > h.chars) break
    picked.unshift(recent[i]); total += cost
  }
  const lines = picked.map((r) => `[${shortStamp(r.t)}] ${r.role === "user" ? "对方" : "我"}：${r.text}`)
  const map: string[] = []
  for (let i = h.mapDays - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const day = dayOf(d)
    const n = all.filter((r) => dayOf(new Date(r.t)) === day).length
    const title = diaryTitle(day)
    if (n === 0 && !title) continue
    map.push(`- ${day} · ${n > 0 ? `${n} 句` : "没有对话"}${title ? ` · 《${title}》` : ""}`)
  }
  const self = readText(SELF_FILE)
  const parts = [
    "## 我的记忆",
    `最近 ${h.hours} 小时的原话（来自以前的窗口）：`,
    lines.length ? lines.join("\n") : "（最近没有对话）",
  ]
  if (map.length) parts.push("## 记忆地图", map.join("\n"))
  if (self) parts.push("## 我是谁", self)
  return parts.join("\n\n")
}

// ———————— 检索 ————————
function bigrams(text: string): string[] {
  const clean = text.replace(/[^\p{Script=Han}\p{N}a-zA-Z]/gu, "").toLowerCase()
  const out: string[] = []
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2))
  return out
}
function queryParts(q: string) {
  const phrase = q.trim().slice(0, 200)
  const tokens = phrase.split(/\s+/).filter(Boolean).slice(0, 8)
  return { tokens, bigrams: [...new Set(tokens.flatMap(bigrams))].slice(0, 64), phrase }
}
function score(text: string, q: ReturnType<typeof queryParts>): number {
  const lower = text.toLowerCase()
  let exact = 0
  for (const t of q.tokens) if (lower.includes(t.toLowerCase())) exact++
  let ratio = 0
  if (q.bigrams.length) {
    let hit = 0
    for (const b of q.bigrams) if (lower.includes(b)) hit++
    ratio = hit / q.bigrams.length
  }
  if (exact === 0 && ratio < 0.6) return 0
  return exact * 4 + (q.phrase && lower.includes(q.phrase.toLowerCase()) ? 6 : 0) + ratio * 4
}
function snippet(text: string, q: ReturnType<typeof queryParts>, width = 80): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of q.tokens) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i }
  if (at < 0) for (const b of q.bigrams) { const i = lower.indexOf(b); if (i >= 0 && (at < 0 || i < at)) at = i }
  if (at < 0) at = 0
  const s = Math.max(0, at - width), e = Math.min(text.length, at + width)
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`
}
function searchChat(query: string, from: string | undefined, to: string | undefined, role: string, limit: number, context: number): string[] {
  const q = queryParts(query)
  const all = allRecords()
  const hits: Array<{ i: number; score: number; at: number }> = []
  all.forEach((r, i) => {
    if (role !== "any" && r.role !== role) return
    const d = dayOf(new Date(r.t))
    if (from && d < from) return
    if (to && d > to) return
    const s = score(r.text, q)
    if (s > 0) hits.push({ i, score: s, at: Date.parse(r.t) || 0 })
  })
  hits.sort((a, b) => b.score - a.score || b.at - a.at)
  const lines: string[] = []
  for (const h of hits.slice(0, limit)) {
    for (let i = Math.max(0, h.i - context); i <= Math.min(all.length - 1, h.i + context); i++) {
      const r = all[i]
      const body = i === h.i ? snippet(r.text, q) : r.text.slice(0, 120)
      lines.push(`${i === h.i ? "▶" : " "} [${shortStamp(r.t)} ${r.role === "user" ? "对方" : "我"}] ${body}`)
    }
    lines.push("")
  }
  return lines.length ? lines : []
}
function walk(dir: string, out: string[] = []): string[] {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(md|txt)$/i.test(e.name)) out.push(p)
    }
  } catch { /* ignore */ }
  return out
}
function searchFiles(dirs: string[], query: string, limit: number): string[] {
  const q = queryParts(query)
  const lines: string[] = []
  for (const file of dirs.flatMap((d) => walk(d))) {
    let content = ""
    try { content = readFileSync(file, "utf8") } catch { continue }
    content.split("\n").forEach((line, i) => {
      if (lines.length >= limit) return
      if (line.trim() && score(line, q) > 0) lines.push(`[${basename(file)}:${i + 1}] ${snippet(line, q, 60)}`)
    })
    if (lines.length >= limit) break
  }
  return lines
}

// ———————— 颜文字 ————————
const KAOMOJI_MAP: Record<string, string[]> = {
  撒娇: ["amaeru", "ichaicha"], 害羞: ["hazukashii", "shy", "tereru"], 开心: ["smile", "happy", "yorokobu", "nikkori", "niconico"],
  大笑: ["ehehe", "uhuhu", "waai", "yeay", "yatta", "ahaha"], 得意: ["doya", "ehhen", "fufufu"],
  生气: ["angry", "okoru", "punpun", "iraira", "funsu", "gununu"], 赌气: ["suneru", "tsuntsun", "fuman", "punpun"],
  不爽: ["mukatsuku", "jitome", "shikametsura", "shirome"], 难过: ["sad", "kanashii", "shonbori", "sabishii"],
  哭: ["cry", "uruuru", "nakiwarai"], 爱: ["love", "kyun", "dokidoki", "meromero", "zukyun", "heart"],
  亲亲: ["chu", "kiss", "peropero"], 抱抱: ["hug", "gyu", "dakitsuku", "nadenade", "nakayoshi"],
  无语: ["yareyare", "akireru", "oteage", "chin"], 失望: ["gakkari", "dame", "muri", "konwaku", "komaru"],
  惊讶: ["surprise", "shock", "kyaa", "pokaan"], 疑惑: ["gimon", "hatena", "wakaranai", "nandato"],
  睡觉: ["nemui", "suyaa", "neru", "good-night"], 吃: ["taberu", "mogumogu", "gokugoku", "delicious"],
  玩: ["game", "utau", "karaoke", "dance"], 加油: ["ganbaru", "fight", "ouen", "genki"],
  道歉: ["sorry", "sumimasen", "moushiwakenai", "ayamaru", "dogeza"], 感谢: ["thanks", "arigatou", "azasu", "orei"],
  招呼: ["aisatsu", "ohayou", "konbanwa", "hai", "yoroshiku"], 再见: ["byebye", "sayounara", "matane"],
  思考: ["kangaeru", "nayamu", "jii", "naruhodo"], 眨眼: ["wink", "kirakira", "pikapika", "star", "nagareboshi"],
  捣蛋: ["tobokeru", "hengao", "tehepero", "bishi", "waruikao", "nigawarai"], 慌乱: ["awateru", "aseru", "kinchou", "sowasowa"],
  累: ["tired", "otsukaresama", "shindoi", "mendokusai"], 冷: ["samui"], 热: ["atsui"], 下雨: ["ame"], 下雪: ["yuki"],
  钱: ["okane"], 烟花: ["hanabi", "matsuri"], 鼓掌: ["applause", "pachipachi", "banzai", "waai"],
  胜利: ["peace", "goo", "banzai"], 点头: ["ok", "nodding", "yoshiyoshi", "naruhodo"], 逃跑: ["nigeru", "kakureru"],
}
let kaoCache: Record<string, string[]> | undefined
function kaomoji(): Record<string, string[]> {
  if (kaoCache) return kaoCache
  try { kaoCache = JSON.parse(readFileSync(KAOMOJI_FILE, "utf8")) } catch { kaoCache = {} }
  return kaoCache || {}
}
function pick<T>(list: T[], n: number): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a.slice(0, n)
}

function ok(text: string) { return { content: [{ type: "text" as const, text }] } }
function groupBlocked(tool: string): boolean { return CHANNEL === "group" || JUDGE }

function mediaTypeOf(path: string, kind?: string): "image" | "voice" | "file" {
  if (kind === "image" || kind === "voice" || kind === "file") return kind
  const ext = (path.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] || "").toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "image"
  if ([".mp3", ".wav", ".silk", ".amr", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) return "voice"
  return "file"
}

function delegate(task: string, model?: string): Promise<string> {
  return new Promise((resolvePromise) => {
    if (DEPTH >= 1) { resolvePromise("子代理不能再开子代理。"); return }
    const m = model || config().subagent.model || "deepseek-flash"
    const system = "你是一个被主 agent 调用的子代理。只完成给定的任务，输出可直接使用的结果；不要闲聊，不要调用 reach_out，不要开新的子代理。"
    const args = ["-p", "--model", m, "--no-session", "--no-skills", "--no-extensions", "--no-context-files", "--system-prompt", system, task]
    const child = spawn(process.env.PI_BIN || "pi", args, { env: { ...process.env, LIFE_WORLD_DEPTH: String(DEPTH + 1), LIFE_WORLD_ROLE: "subagent" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } resolvePromise("子代理超时（180 秒）。") }, 180_000)
    child.stdout.on("data", (d) => { out += String(d) })
    child.stderr.on("data", (d) => { err += String(d) })
    child.on("error", (e) => { clearTimeout(timer); resolvePromise(`子代理启动失败：${String(e)}`) })
    child.on("close", (code) => {
      clearTimeout(timer)
      const text = out.trim()
      if (code === 0 && text) resolvePromise(text)
      else resolvePromise(`子代理失败（exit ${code}）：${(err || out).trim().slice(0, 500)}`)
    })
  })
}

// ———————— 定时器 ————————
function acquireTimerLock(): boolean {
  try {
    if (existsSync(TIMER_LOCK)) {
      const pid = Number(readFileSync(TIMER_LOCK, "utf8").trim())
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false } catch { /* dead */ }
      }
    }
    writeFileSync(TIMER_LOCK, String(process.pid))
    return true
  } catch { return false }
}

function sendTime(text: string): void {
  try {
    ;(piRef as any)?.sendMessage?.({ customType: "life-world-time", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" })
    log(`sendTime ${text.slice(0, 60)}`)
  } catch (e) { log(`sendTime failed ${String(e)}`) }
}

function tick(): void {
  try {
    const c = config()
    if (!c.world.enabled || !c.world.running) return
    const state = readWorld()
    const now = new Date()
    const today = dayOf(now)
    const hour = now.getHours()
    // 每日回顾
    if (hour >= c.world.reviewHour && state.lastReview !== today) {
      sendTime(`【每日回顾】${today} 快过完了，回头看看今天。今天的聊天记录在 ${CONV_DIR}，日记在 ${DIARY_DIR}。写日记、更新「我是谁」、更新用户画像、清理到期心情。`)
      writeWorld({ ...state, lastReview: today })
      return
    }
    // 到点闹钟
    const due = (state.alarms || []).filter((a) => Number.isFinite(Date.parse(a.at)) && Date.parse(a.at) <= Date.now())
    for (const a of due) {
      sendTime(`【我的时间】${shortStamp(a.at)} 到了，说好做到这里是：${a.note}。\n先看看做完了没有；做完了就想想下一件，用 tools.plan_next 重新定。今天的计划在 ${join(PLAN_DIR, `${today}.md`)}。`)
      const fresh = readWorld()
      fresh.alarms = (fresh.alarms || []).filter((x) => x.id !== a.id)
      fresh.lastWake = today
      writeWorld(fresh)
    }
    if (due.length) return
    // 早上兜底
    if (state.lastWake === today) return
    if (hour >= c.world.reviewHour) return
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const planned = (state.alarms || []).some((a) => { const t = Date.parse(a.at); return Number.isFinite(t) && t >= dayStart && t <= dayStart + 86_400_000 })
    if (planned) return
    const [fh, fm] = c.world.fallbackWakeTime.split(":").map((x) => Number(x) || 0)
    const mins = hour * 60 + now.getMinutes()
    if (mins < fh * 60 + fm || mins >= fh * 60 + fm + 240) return
    sendTime(`【我的时间】早上了，新的一天。先看看今天的安排：${join(PLAN_DIR, `${today}.md`)}。没有就自己拟一份大概的；挑一件现在就做的，用 tools.plan_next 排上时间。`)
    writeWorld({ ...state, lastWake: today })
  } catch (e) { log(`tick failed ${String(e)}`) }
}

let piRef: unknown

// ———————— 扩展 ————————
export default function (pi: ExtensionAPI) {
  piRef = pi
  if (JUDGE) return // 判官：不注入、不注册工具
  ensureDirs()
  loadArchived()

  let hydrated = false

  pi.on("before_agent_start", async (event: any) => {
    if (hydrated) return
    if (event?.messageType === "custom") return
    hydrated = true
    const memory = memoryBlock()
    if (!memory) return
    return { message: { customType: "life-world-memory", content: memory, display: false } }
  })

  pi.on("input", async (event: any) => {
    if (event?.source === "extension") return { action: "continue" } as const
    const text = String(event?.text || "")
    if (!text.trim() || text.startsWith("[本地时间 ")) return { action: "continue" } as const
    return { action: "transform", text: `${inputPrefix()}${text}` } as const
  })

  pi.on("message_end", async (event: any) => {
    const message = event?.message ?? event
    archive(message)
  })

  // —— 工具 ——
  pi.registerTool({
    name: "plan_next",
    label: "Plan next",
    description: "说好接下来做什么、做到什么时候。到点会提醒。note 要写清做什么、怎么算做成；at 与 after_minutes 二选一。",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "做什么，以及怎么算做成了" },
        at: { type: "string", description: "带时区的完整时间，如 2026-11-07T18:00:00+08:00" },
        after_minutes: { type: "number", description: "从现在起多少分钟（至少 1）" },
      },
      required: ["note"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE) return ok("判官会话不能定闹钟。")
      if (CHANNEL === "group") return ok("群聊里不能定闹钟。")
      const now = Date.now()
      const target = typeof params.after_minutes === "number" ? now + params.after_minutes * 60_000 : Date.parse(String(params.at || ""))
      if (!Number.isFinite(target) || target < now + 60_000) return ok("时间不对：至少定在 1 分钟之后，at 要带时区。")
      const state = readWorld()
      const alarm: Alarm = { id: `a-${now}-${Math.random().toString(36).slice(2, 6)}`, at: new Date(target).toISOString(), note: String(params.note || ""), setAt: new Date(now).toISOString() }
      state.alarms = [...(state.alarms || []), alarm].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      if (!writeWorld(state)) return ok("闹钟没能写进 world.json。")
      return ok(`定好了：${isoLocal(new Date(target))} —— ${alarm.note}`)
    },
  })

  pi.registerTool({
    name: "check_alarm",
    label: "Check alarms",
    description: "看看现在排着的闹钟。",
    parameters: { type: "object", properties: {} },
    async execute() {
      const alarms = readWorld().alarms || []
      if (!alarms.length) return ok("现在没有定闹钟。")
      return ok(alarms.map((a) => `- ${shortStamp(a.at)}（还有 ${Math.max(0, Math.round((Date.parse(a.at) - Date.now()) / 60_000))} 分钟）${a.note}`).join("\n"))
    },
  })

  pi.registerTool({
    name: "cancel_alarm",
    label: "Cancel alarm",
    description: "取消闹钟。传 match 只取消 note 含这个词的；不传全取消。",
    parameters: { type: "object", properties: { match: { type: "string", description: "note 关键词" } } },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能改闹钟。")
      const state = readWorld()
      const all = state.alarms || []
      const match = String(params.match || "").trim()
      state.alarms = match ? all.filter((a) => !a.note.includes(match)) : []
      writeWorld(state)
      return ok(match ? `取消了 note 含「${match}」的闹钟。` : "全取消了。")
    },
  })

  pi.registerTool({
    name: "reach_out",
    label: "Reach out",
    description: "想找对方时用：把一两句话写进 outbox，桥接会送到对方 QQ。桥接关闭/离线时不会送达。",
    parameters: { type: "object", properties: { text: { type: "string", description: "要说的话" } }, required: ["text"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能用 reach_out。")
      const text = String(params.text || "").trim()
      if (!text) return ok("没有话可送。")
      const status = bridgeStatus()
      if (status !== "在线") return ok(`OneBot 桥接${status}，这句话没有送出去。`)
      try {
        mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 })
        appendFileSync(join(OUTBOX_DIR, `${dayOf()}.jsonl`), `${JSON.stringify({ t: new Date().toISOString(), kind: "reach", text, session: "pi" })}\n`, { mode: 0o600 })
      } catch (e) { return ok(`写 outbox 失败：${String(e)}`) }
      return ok("话放出去了，桥接会送到对方 QQ。")
    },
  })

  pi.registerTool({
    name: "send_media",
    label: "Send media",
    description: "主动发图片/语音/文件。path 必须在 room / 表情包 / 语音 / tmp 里；群聊只发图片/语音。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（可相对 world）" },
        text: { type: "string", description: "可选配文" },
        kind: { type: "string", enum: ["image", "voice", "file"], description: "不传按扩展名判断" },
      },
      required: ["path"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE) return ok("判官会话不能发媒体。")
      const raw = String(params.path || "").trim()
      if (!raw) return ok("没有给路径。")
      let real = ""
      try { real = realpathSync(raw.startsWith("/") ? raw : resolve(WORLD, raw)) } catch { return ok(`找不到文件：${raw}`) }
      const dirs = [ROOM_DIR, STICKER_DIR, VOICE_DIR, TMP_DIR].map((d) => { try { return realpathSync(d) } catch { return d } })
      if (!dirs.some((d) => real === d || real.startsWith(d + sep))) return ok("只能发 room / 表情包 / 语音 / tmp 里的文件。")
      const mediaType = mediaTypeOf(real, params.kind)
      if (CHANNEL === "group") {
        if (mediaType === "file") return ok("群聊不发文件。")
        if (!real.startsWith(realpathSync(STICKER_DIR) + sep) && !real.startsWith(realpathSync(VOICE_DIR) + sep)) return ok("群聊只能从 表情包/语音 里发。")
      }
      const target = CHANNEL === "group" ? { kind: "group", id: GROUP_ID } : { kind: "private" }
      try {
        mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 })
        appendFileSync(join(OUTBOX_DIR, `${dayOf()}.jsonl`), `${JSON.stringify({ t: new Date().toISOString(), kind: "media", path: real, name: basename(real), mediaType, text: String(params.text || "").trim(), session: "pi", target })}\n`, { mode: 0o600 })
      } catch (e) { return ok(`写 outbox 失败：${String(e)}`) }
      return ok(`已经交给桥接：${basename(real)}。投递结果未知。`)
    },
  })

  pi.registerTool({
    name: "group_chat",
    label: "Toggle group chat",
    description: "开关 QQ 群聊（写 life-world.json 的 bridge.group.enabled，桥接实时读取）。",
    parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能开关群聊。")
      try {
        const raw = readJson<any>(CONFIG_FILE, {})
        raw.bridge = raw.bridge || {}
        raw.bridge.group = raw.bridge.group || {}
        raw.bridge.group.enabled = params.enabled === true
        atomicWrite(CONFIG_FILE, JSON.stringify(raw, null, 2))
      } catch (e) { return ok(`写配置失败：${String(e)}`) }
      return ok(`QQ 群聊已${params.enabled === true ? "开启" : "关闭"}。`)
    },
  })

  pi.registerTool({
    name: "kaomoji",
    label: "Kaomoji",
    description: "按场景取几条颜文字。不传 scene 就列出可用场景。",
    parameters: { type: "object", properties: { scene: { type: "string" }, count: { type: "number" }, remember: { type: "boolean" } } },
    async execute(_id: string, params: any) {
      if (JUDGE) return ok("判官不能取颜文字。")
      const data = kaomoji()
      const scene = String(params.scene || "").trim()
      if (!scene) return ok(`可用场景：${Object.keys(KAOMOJI_MAP).join("、")}`)
      const cats = Object.prototype.hasOwnProperty.call(KAOMOJI_MAP, scene) ? KAOMOJI_MAP[scene] : [scene]
      const pool = new Set<string>()
      for (const c of cats) for (const x of data[c] || []) pool.add(x)
      const list = [...pool]
      if (!list.length) return ok(`没有「${scene}」的颜文字。`)
      const picked = pick(list, Math.max(1, Math.min(20, Number(params.count) || 3)))
      if (params.remember) {
        try {
          const file = join(ROOM_DIR, "颜文字.md")
          appendFileSync(file, (existsSync(file) ? "" : "# 我喜欢的颜文字\n\n") + picked.map((x) => `- ${x}  （${scene}）`).join("\n") + "\n")
        } catch { /* ignore */ }
      }
      return ok(picked.join("\n"))
    },
  })

  pi.registerTool({
    name: "memory_search",
    label: "Memory search",
    description: "翻以前的记忆：对话原文、日记、房间笔记。支持时间范围、角色、前后文。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        role: { type: "string", enum: ["any", "user", "assistant"] },
        scope: { type: "string", enum: ["chat", "diary", "notes", "all"] },
        limit: { type: "number" }, context: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能翻记忆。")
      const query = String(params.query || "").trim()
      if (!query) return ok("要搜什么？")
      const limit = Math.max(1, Math.min(30, Number(params.limit) || 8))
      const context = Math.max(0, Math.min(3, Number(params.context) ?? 1))
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(params.from || "")) ? String(params.from) : undefined
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(params.to || "")) ? String(params.to) : undefined
      const role = params.role === "user" || params.role === "assistant" ? params.role : "any"
      const scope = ["chat", "diary", "notes", "all"].includes(String(params.scope)) ? String(params.scope) : "chat"
      const out: string[] = []
      if (scope === "chat" || scope === "all") {
        const lines = searchChat(query, from, to, role, limit, context)
        if (lines.length) out.push("—— 对话 ——", ...lines)
      }
      if (scope === "diary" || scope === "all") {
        const lines = searchFiles([DIARY_DIR], query, limit)
        if (lines.length) out.push("—— 日记 ——", ...lines)
      }
      if (scope === "notes" || scope === "all") {
        const lines = searchFiles([ROOM_DIR], query, limit)
        if (lines.length) out.push("—— 房间笔记 ——", ...lines)
      }
      return ok(out.length ? out.join("\n") : `没有找到「${query}」。`)
    },
  })

  pi.registerTool({
    name: "memory_day",
    label: "Memory day",
    description: "回看某一天的对话和日记（YYYY-MM-DD）。",
    parameters: { type: "object", properties: { date: { type: "string" }, max_chars: { type: "number" } }, required: ["date"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能翻记忆。")
      const date = String(params.date || "")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ok("日期要写成 YYYY-MM-DD。")
      const maxChars = Math.max(500, Math.min(30_000, Number(params.max_chars) || 6000))
      const records = allRecords().filter((r) => dayOf(new Date(r.t)) === date)
      const diary = readText(join(DIARY_DIR, `${date}.md`))
      if (!records.length && !diary) return ok(`${date} 没有对话，也没有日记。`)
      const parts = [`【${date}】对话 ${records.length} 句`]
      let total = 0
      for (const r of records) {
        const line = `[${shortStamp(r.t)}] ${r.role === "user" ? "对方" : "我"}：${r.text}`
        if (total + line.length > maxChars) { parts.push("（后面还有，超出字数上限）"); break }
        parts.push(line); total += line.length
      }
      if (diary) parts.push("—— 日记 ——", diary.slice(0, Math.max(0, maxChars - total)))
      return ok(parts.join("\n"))
    },
  })

  pi.registerTool({
    name: "memory_timeline",
    label: "Memory timeline",
    description: "看一段时间每天聊了多少、开头说了什么。默认最近 7 天。",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能翻记忆。")
      const today = dayOf()
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(params.from || "")) ? String(params.from) : dayOf(new Date(Date.now() - 6 * 86_400_000))
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(params.to || "")) ? String(params.to) : today
      if (from > to) return ok("起始日期比结束日期还晚。")
      const records = allRecords()
      const lines: string[] = []
      const cursor = new Date(`${from}T00:00:00`)
      while (dayOf(cursor) <= to) {
        const day = dayOf(cursor)
        const dayRecords = records.filter((r) => dayOf(new Date(r.t)) === day)
        const first = dayRecords.find((r) => r.role === "user")
        const title = diaryTitle(day)
        const bits = [dayRecords.length ? `${dayRecords.length} 句` : "没有对话"]
        if (title) bits.push(`《${title}》`)
        if (first) bits.push(`开头：${first.text.slice(0, 60).replace(/\s+/g, " ")}`)
        lines.push(`- ${day} · ${bits.join(" · ")}`)
        cursor.setDate(cursor.getDate() + 1)
      }
      return ok(lines.join("\n"))
    },
  })

  pi.registerTool({
    name: "delegate",
    label: "Delegate subagent",
    description: "把一个耗时/并发的任务交给独立 pi 子进程（隔离上下文）。零第三方扩展，最多一层。",
    parameters: { type: "object", properties: { task: { type: "string", description: "完整任务、输入和验收标准" }, model: { type: "string", description: "可选模型，默认 deepseek-flash" } }, required: ["task"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能用子代理。")
      const text = await delegate(String(params.task || ""), params.model ? String(params.model) : undefined)
      return ok(text)
    },
  })

  // 定时器只在 home 角色跑；QQ/群聊/子代理进程不跑，避免重复
  if (ROLE === "home") {
    if (acquireTimerLock()) {
      const t = setInterval(tick, 30_000)
      ;(t as any).unref?.()
      log(`pi timer started role=${ROLE}`)
      process.on("exit", () => { try { if (readText(TIMER_LOCK) === String(process.pid)) writeFileSync(TIMER_LOCK, "") } catch { /* ignore */ } })
    } else {
      log("pi timer skipped (lock held)")
    }
  }
}
