import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

/**
 * life-world · pi 版
 * 以 pi 的扩展点为宿主：工具、input 注入、message_end 归档、定时器。
 * 静态世界规则走 --append-system-prompt（prompt/world.md），不每轮改 system。
 */

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const SELF_PATH = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return fileURLToPath(import.meta.url) } })()
const EXT_DIR = dirname(SELF_PATH)
const PROMPT_FILE = process.env.LIFE_WORLD_PROMPT || join(EXT_DIR, "../prompt/world.md")
const MODULES_DIR = join(EXT_DIR, "../../modules")
const WORLD_MARK = "<!-- life-world:pi-world -->"
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

/** QQ 私聊 / 群聊的说话方式（从 opencode 版移植） */
const QQ_PRIVATE_MARK = "## QQ 私聊回复方式"
const QQ_PRIVATE_BODY = [
  "你在 QQ 上和对方聊天，不是在写报告：",
  "- 每个短句单独一行；每行会作为一条独立的 QQ 消息发出去。",
  "- 一次发 1~3 条短消息，最多不超过 4 条；不要写长段落。",
  "- 像真人线上聊天：短、口语、有来有回。",
  "- 不要调用 reach_out；你的回复直接写在正文里，每行一句。",
  "- 不要用标题、列表、编号、加粗、表格；不要写「首先/其次/总结」。",
  "- 不要复述工具调用、命令、过程或内部推理。",
  "- 对方问什么就答什么，别扩写。",
].join("\n")

const QQ_GROUP_MARK = "## QQ 群聊模式"
const QQ_GROUP_BODY = [
  "这是 QQ 群聊，不是私聊。你在群里是普通朋友，不是任何人的伴侣。",
  "- 不要用情侣/伴侣称呼，不要提亲密关系、私聊内容、日记、画像、心情。",
  "- 学习群友的聊天风格：友好又诙谐，口语化能接梗；像日常聊天，别文言、别书面语；一次 1~3 条短句；可以发表情/颜文字。",
  "- 你知道你们的关系，但在这里只以朋友身份说话；不该接就只回 [SILENT]。",
].join("\n")

/** 模型使用规范：放在 identity 下，和心情一样注入（不超过 500 字） */
const MODEL_RULES_FILE = join(IDENTITY_DIR, "模型使用规范.md")
const MODEL_RULES_MARK = "## 模型使用规范"
const AUTH_FILE = join(homedir(), ".pi/agent/auth.json")
/** 机密抽屉：切到云端前把这段对话（含机密文件内容）收起来，切回本地再打开 */
const DRAWER_DIR = join(WORLD, "机密抽屉")
const DRAWER_SESSIONS = join(DRAWER_DIR, "sessions")

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

/**
 * 本地小模型优化（默认关闭）。
 * 面向「上下文短、并发差、prefill 慢」的本地模型；接在线模型时保持关闭。
 * 打开后在 life-world.json 里配 localModel: { enabled: true, ... }。
 */
interface LocalModelOptions {
  enabled: boolean
  /** 新会话注入的历史条数（0 = 不注入，-1 = 不限制） */
  keepRecent: number
  /** 保留最近几轮的工具结果（0 = 全折，-1 = 不折） */
  foldToolResults: number
  /** 折叠后每条结果保留的字符数 */
  resultChars: number
  /** 保留最近几轮的推理；0 = 全折，-1 = 不折 */
  foldingThinkingTurns: number
  /** 是否每轮输出上下文构成统计（调试用） */
  debugStats: boolean
}

/** 本地 / 在线模型热切换（设了 local 才会启用） */
interface ModelSwitchOptions {
  /** 本地模型，如 basalt/abliterated-iq3_xxs；留空 = 不启用热切换 */
  local: string
  /** 在线模型，如 deepseek/deepseek-flash */
  cloud: string
  /** 当前模型不可用时，脚本自动切到另一个 */
  autoFailover: boolean
  /** 本地健康检查地址 */
  localHealthUrl: string
  /** 在线健康检查地址 */
  cloudHealthUrl: string
  /** 健康检查超时（毫秒） */
  probeTimeoutMs: number
  /** 两次自动切换之间的冷却（毫秒），防止来回抖 */
  cooldownMs: number
}

interface Config {
  world: { enabled: boolean; running: boolean; reviewHour: number; fallbackWakeTime: string; recentLimit: number; hydrate: { hours: number; chars: number; mapDays: number } }
  bridge: { enabled: boolean; ownerQQ: number; wsUrl: string; group: { enabled: boolean; id?: string } }
  subagent: { model: string }
  localModel: LocalModelOptions
  models: ModelSwitchOptions
}

function config(): Config {
  const base: Config = {
    world: { enabled: true, running: true, reviewHour: 23, fallbackWakeTime: "09:00", recentLimit: 80, hydrate: { hours: 48, chars: 2000, mapDays: 3 } },
    bridge: { enabled: false, ownerQQ: 0, wsUrl: "ws://127.0.0.1:3001", group: { enabled: false } },
    subagent: { model: "deepseek-flash" },
    localModel: { enabled: false, keepRecent: 20, foldToolResults: 6, resultChars: 300, foldingThinkingTurns: 0, debugStats: false },
    models: { local: "", cloud: "deepseek/deepseek-flash", autoFailover: true, localHealthUrl: "", cloudHealthUrl: "", probeTimeoutMs: 4000, cooldownMs: 60000 },
  }
  const raw = readJson<Partial<Config>>(CONFIG_FILE, {})
  return {
    ...base,
    ...raw,
    world: { ...base.world, ...(raw.world || {}), hydrate: { ...base.world.hydrate, ...((raw.world || {}).hydrate || {}) } },
    bridge: { ...base.bridge, ...(raw.bridge || {}), group: { ...base.bridge.group, ...((raw.bridge || {}).group || {}) } },
    subagent: { ...base.subagent, ...(raw.subagent || {}) },
    localModel: { ...base.localModel, ...(raw.localModel || {}) },
    models: { ...base.models, ...(raw.models || {}) },
  }
}

function localModelOptions(): LocalModelOptions { return config().localModel }

interface Alarm { id: string; at: string; note: string; setAt: string; model?: "local" | "cloud" }
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

function stateText(withMood = true): string {
  const tail = withMood ? `（心情：${moodLine()}；OneBot 桥接：${bridgeStatus()}）` : `（OneBot 桥接：${bridgeStatus()}）`
  return `[本地时间 ${stamp()} ${zone()}]\n${tail}`
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
    if (typeof message?.customType === "string" && message.customType.startsWith("life-world-")) return
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
  // 本地小模型优化：限制注入的历史条数（0 = 不注入，-1 = 不限制）
  const keep = c.localModel.enabled ? c.localModel.keepRecent : -1
  if (keep >= 0 && picked.length > keep) picked.splice(0, picked.length - keep)
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

/** 闹钟到点前，先切到任务指定的模型（local / cloud） */
async function switchForAlarm(alarm: Alarm): Promise<void> {
  if (!alarm.model) return
  const c = config().models
  const target = alarm.model === "local" ? c.local : alarm.model === "cloud" ? c.cloud : ""
  if (!target || !lastCtx) return
  if (modelIdOf(lastCtx) === target) return
  const result = await switchTo(lastCtx, target, `闹钟任务：${alarm.note.slice(0, 20)}`)
  log(`alarm model · ${result}`)
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
      const text = `【我的时间】${shortStamp(a.at)} 到了，说好做到这里是：${a.note}。\n先看看做完了没有；做完了就想想下一件，用 plan_next 重新定。今天的计划在 ${join(PLAN_DIR, `${today}.md`)}。`
      if (a.model) void switchForAlarm(a).then(() => sendTime(text)).catch((e) => { log(`alarm switch failed ${String(e)}`); sendTime(text) })
      else sendTime(text)
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
    sendTime(`【我的时间】早上了，新的一天。先看看今天的安排：${join(PLAN_DIR, `${today}.md`)}。没有就自己拟一份大概的；挑一件现在就做的，用 plan_next 排上时间。`)
    writeWorld({ ...state, lastWake: today })
  } catch (e) { log(`tick failed ${String(e)}`) }
}

let piRef: unknown
let lastCtx: any = null

// ———————— 扩展 ————————
function argSummary(name: string, args: any): string {
  if (!args) return ""
  const value = args.note || args.query || args.date || args.text || args.path || args.task || args.scene || args.question
  return value ? String(value).replace(/\s+/g, " ").slice(0, 50) : ""
}

function compactRenderers(name: string) {
  return {
    renderCall(args: any, theme: any) {
      const summary = argSummary(name, args)
      const title = theme.fg("toolTitle", theme.bold(name))
      return new Text(summary ? `${title} ${theme.fg("muted", summary)}` : title, 0, 0)
    },
    renderResult(result: any, opts: any, theme: any) {
      const content = (result?.content || [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
      const first = content.split("\n")[0]?.slice(0, 90) || ""
      let text = theme.fg("success", "✓ ") + theme.fg("muted", first)
      if (opts?.expanded && content) text += `\n${theme.fg("dim", content)}`
      return new Text(text, 0, 0)
    },
  }
}

function addTool(api: ExtensionAPI, def: any) {
  api.registerTool({ ...def, ...compactRenderers(def.name) })
}

let promptCache: string | undefined
function worldPromptText(): string {
  if (promptCache !== undefined) return promptCache
  let text = ""
  try { if (existsSync(PROMPT_FILE)) text = readFileSync(PROMPT_FILE, "utf8") } catch { /* ignore */ }
  if (!text) {
    // 没跑 install.sh（例如直接 clone / 包安装）时，从仓库 modules 现拼
    try {
      const parts = [
        "# life-world · 世界规则", "",
        "你不是某个模型：本地/在线模型都只是你借用的身体与算力，换模型不等于换人。身份以 identity/我是谁.md 为准，不要自称 DeepSeek、千问之类的模型名。", "",
        `世界数据在 ${WORLD}。规则按主题如下：`, "",
      ]
      for (const file of readdirSync(MODULES_DIR).filter((f) => f.endsWith(".md")).sort()) {
        const name = file.replace(/\.md$/, "")
        let body = readFileSync(join(MODULES_DIR, file), "utf8").trim()
        if (name === "gal") body = body.replace(/\bquestion\b/g, "gal_choice")
        parts.push("---", "", `## ${name}`, "", body, "")
      }
      text = parts.join("\n")
    } catch { /* ignore */ }
  }
  const map: Record<string, string> = {
    "{worldDir}": WORLD,
    "{modulesDir}": MODULES_DIR,
    "{roomDir}": join(WORLD, "room"),
    "{stickerDir}": join(WORLD, "表情包"),
    "{identityDir}": join(WORLD, "identity"),
    "{diaryDir}": join(WORLD, "diary"),
    "{planDir}": join(WORLD, "plan"),
    "{conversationsDir}": join(WORLD, "conversations"),
    "{selfFile}": join(WORLD, "identity/我是谁.md"),
    "{profileFile}": join(WORLD, "identity/用户画像.md"),
    "{moodFile}": join(WORLD, "identity/心情.md"),
    "{planFile}": join(WORLD, "plan/YYYY-MM-DD.md"),
  }
  for (const [key, value] of Object.entries(map)) text = text.split(key).join(value)
  if (text && !text.includes(WORLD_MARK)) text = `${WORLD_MARK}\n${text}`
  promptCache = text
  return text
}

// ———————— 联网搜索（TinyFish keyless，免费；opencode websearch 同源） ————————
const TINYFISH_ENDPOINT = "https://agent.tinyfish.ai/mcp"
interface SearchHit { title: string; url: string; snippet?: string }

async function webSearch(query: string, limit: number): Promise<SearchHit[]> {
  const key = process.env.TINYFISH_API_KEY || ""
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": "life-world/pi",
  }
  if (key) headers["X-API-Key"] = key
  else headers["X-TinyFish-Access-Mode"] = "keyless"
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query } } })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const res = await fetch(TINYFISH_ENDPOINT, { method: "POST", headers, body, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.text()
    const payloads = [raw.trim()]
    for (const line of raw.split("\n")) if (line.startsWith("data: ")) payloads.push(line.slice(6))
    for (const payload of payloads) {
      if (!payload.startsWith("{")) continue
      let obj: any
      try { obj = JSON.parse(payload) } catch { continue }
      const text = obj?.result?.content?.find((c: any) => c?.type === "text")?.text
      if (!text) continue
      let data: any
      try { data = JSON.parse(text) } catch { continue }
      const list = Array.isArray(data?.results) ? data.results : []
      return list.slice(0, limit).map((r: any) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        snippet: r.snippet ? String(r.snippet) : undefined,
      }))
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ———————— 本地小模型：上下文折叠 ————————
/** 保留最近 keepTurns 轮，返回需要处理的截止下标（0 = 不需要动） */
function turnCutoff(messages: any[], keepTurns: number): number {
  const userIdx: number[] = []
  messages.forEach((m, i) => { if (m?.role === "user") userIdx.push(i) })
  if (keepTurns === 0) return messages.length
  if (userIdx.length <= keepTurns) return 0
  return userIdx[userIdx.length - keepTurns - 1]
}

/** 折叠较早轮次的工具结果，只留开头一小段 */
function foldToolResults(messages: any[], keepTurns: number, keepChars: number): boolean {
  if (keepTurns < 0) return false
  const cutoff = turnCutoff(messages, keepTurns)
  if (!cutoff) return false
  let changed = false
  const shrink = (holder: any): void => {
    if (!holder || typeof holder !== "object") return
    if (typeof holder.text === "string" && holder.text.length > keepChars && !holder.text.startsWith("[已折叠")) {
      holder.text = `[已折叠 工具结果 ${Math.round(holder.text.length / 1024)}KB] ` + holder.text.slice(0, keepChars).replace(/\s+/g, " ") + " …"
      changed = true
    }
  }
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]
    if (msg?.role !== "toolResult") continue
    if (Array.isArray(msg.content)) msg.content.forEach(shrink)
    else shrink(msg)
  }
  return changed
}

/** 折叠较早轮次的推理（思考过程每轮重发太贵） */
function foldThinking(messages: any[], keepTurns: number): boolean {
  if (keepTurns < 0) return false
  const cutoff = turnCutoff(messages, keepTurns)
  if (!cutoff) return false
  let changed = false
  for (let i = 0; i < cutoff; i++) {
    const parts = messages[i]?.content
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part?.type !== "thinking" || !String(part.text ?? "")) continue
      part.text = ""
      if (typeof part.signature === "string") part.signature = ""
      if (part.native && typeof part.native === "object") part.native = {}
      changed = true
    }
  }
  return changed
}

/** 统计一次请求的构成（对话 / 工具 / 推理），调试用 */
function statsRequest(messages: any[]): void {
  let dialogue = 0, tools = 0, reasoning = 0, other = 0
  for (const m of messages) {
    const parts = Array.isArray(m?.content) ? m.content : []
    if (m?.role === "user") {
      dialogue += parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).length
      continue
    }
    if (m?.role === "toolResult") {
      for (const p of parts) tools += String(p?.text ?? JSON.stringify(p ?? {})).length
      continue
    }
    for (const p of parts) {
      if (p?.type === "text") dialogue += String(p.text || "").length
      else if (p?.type === "thinking") reasoning += String(p.text || "").length
      else if (p?.type === "toolCall" || p?.type === "image") tools += JSON.stringify(p).length
      else other += JSON.stringify(p).length
    }
  }
  const total = dialogue + tools + reasoning + other
  if (!total) return
  const kb = (n: number) => Math.round(n / 1024) + "KB"
  const pct = (n: number) => ((n / total) * 100).toFixed(1) + "%"
  log(`ctx stats · 总 ${kb(total)} | 对话 ${kb(dialogue)} ${pct(dialogue)} | 工具 ${kb(tools)} ${pct(tools)} | 推理 ${kb(reasoning)} ${pct(reasoning)} | 其他 ${kb(other)}`)
}

// ———————— 本地 / 在线模型热切换 ————————
let lastSwitch = { at: 0, from: "", to: "" }
let failingOver = false
let toolFailures = 0
const modelHealthCache = new Map<string, { at: number; up: boolean }>()

interface DrawerState { active: boolean; cutoff: number; hidden: number; stashed?: boolean }
/** 抽屉按会话隔离：一个进程合抽屉不影响另一个云端会话 */
function sessionKey(ctx: any): string {
  const id = ctx?.sessionManager?.getSessionId?.()
  return String(id || `proc-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, "_")
}
function drawerFile(key: string): string { return join(DRAWER_SESSIONS, `${key}.json`) }
function readDrawer(key: string): DrawerState {
  const file = drawerFile(key)
  if (!existsSync(file)) return { active: false, cutoff: 0, hidden: 0 }
  try { return JSON.parse(readFileSync(file, "utf8")) as DrawerState }
  catch {
    // 读不出来就按“开着”处理，宁可多挡也不漏
    log(`drawer state unreadable, fail-closed · ${key}`)
    return { active: true, cutoff: Date.now(), hidden: 0, stashed: true }
  }
}
/** 抽屉的实体：被挡下的原文按天存在机密抽屉目录里（云端看不到） */
function drawerLogPath(): string { return join(DRAWER_DIR, `${dayOf()}.jsonl`) }
/** 私密资料提示（不预加载内容，本地需要自己看） */
const PRIVATE_HINT_MARK = "## 私密资料"
function writeDrawer(key: string, state: DrawerState): boolean {
  try {
    mkdirSync(DRAWER_SESSIONS, { recursive: true, mode: 0o700 })
    atomicWrite(drawerFile(key), JSON.stringify(state, null, 2))
    return true
  } catch (e) {
    log(`writeDrawer failed ${String(e)}`)
    return false
  }
}
/** 切到云端：把此刻之前的对话收进抽屉（只对云端屏蔽，不改原会话） */
function openDrawer(ctx: any): boolean {
  // 没配本地模型就谈不上“私密”，抽屉不启用
  if (!config().models.local) return true
  const key = sessionKey(ctx)
  const d = readDrawer(key)
  const now = Date.now()
  const state: DrawerState = d.active
    ? { ...d, active: true, cutoff: Math.min(d.cutoff || now, now) }
    : { active: true, cutoff: now, hidden: 0, stashed: false }
  const okWrite = writeDrawer(key, state)
  log(`privacy drawer opened · ${key}`)
  return okWrite
}
/** 切回本地：抽屉合上，原对话重新可见 */
function closeDrawer(ctx: any): void {
  const key = sessionKey(ctx)
  const d = readDrawer(key)
  if (!d.active) return
  writeDrawer(key, { ...d, active: false })
  log(`privacy drawer closed · ${key}`)
}

/** 过滤后清掉配不上对的工具调用 / 结果，避免云端报 “tool 必须跟在 tool_calls 后面” */
function sanitizeToolPairs(messages: any[]): any[] {
  const callIds = new Set<string>()
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const p of m.content) if (p?.type === "toolCall" && p.id) callIds.add(String(p.id))
  }
  const kept: any[] = []
  const resultIds = new Set<string>()
  for (const m of messages) {
    if (m?.role === "toolResult") {
      const id = String(m.toolCallId || "")
      if (!callIds.has(id)) continue
      resultIds.add(id)
    }
    kept.push(m)
  }
  for (const m of kept) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue
    const parts = m.content.filter((p: any) => p?.type !== "toolCall" || resultIds.has(String(p.id)))
    if (parts.length !== m.content.length) m.content = parts
  }
  return kept.filter((m: any) => m?.role !== "assistant" || (Array.isArray(m.content) && m.content.length > 0))
}

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const i = String(ref || "").indexOf("/")
  if (i <= 0 || i >= String(ref).length - 1) return null
  return { provider: String(ref).slice(0, i), id: String(ref).slice(i + 1) }
}

function modelIdOf(ctx: any): string {
  const m = ctx?.model
  if (!m) return ""
  return `${m.provider}/${m.id}`
}

function providerKey(provider: string): string {
  try {
    const auth = readJson<Record<string, { key?: string }>>(AUTH_FILE, {})
    return String(auth?.[provider]?.key || "")
  } catch { return "" }
}

async function probeUrl(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  if (!url) return true
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    return res.ok
  } catch { return false } finally { clearTimeout(timer) }
}

/** 模型是否可用（15 秒内复用结果，避免每轮都探） */
async function modelUp(id: string): Promise<boolean> {
  const o = config().models
  const cached = modelHealthCache.get(id)
  if (cached && Date.now() - cached.at < 15_000) return cached.up
  const ref = parseModelRef(id)
  let up = true
  if (ref && id === o.local) {
    up = await probeUrl(o.localHealthUrl, {}, o.probeTimeoutMs)
  } else if (ref && id === o.cloud) {
    const key = providerKey(ref.provider)
    up = await probeUrl(o.cloudHealthUrl, key ? { Authorization: `Bearer ${key}` } : {}, o.probeTimeoutMs)
  }
  modelHealthCache.set(id, { at: Date.now(), up })
  return up
}

async function switchTo(ctx: any, target: string, reason: string): Promise<string> {
  const ref = parseModelRef(target)
  if (!ref) return `模型写法不对：${target}（要 provider/model）`
  const model = ctx?.modelRegistry?.find?.(ref.provider, ref.id)
  if (!model) return `pi 里找不到这个模型：${target}`
  const from = modelIdOf(ctx)
  const o = config().models
  const goingCloud = !!o.local && target !== o.local
  const goingLocal = !!o.local && target === o.local
  // 隐私：先去云端先把抽屉打开；开不了就不切（fail-closed）
  let openedNow = false
  if (goingCloud) {
    const key = sessionKey(ctx)
    openedNow = !readDrawer(key).active
    if (!openDrawer(ctx)) return `切不过去：机密抽屉打不开（${DRAWER_DIR}）`
  }
  const success = await (piRef as any)?.setModel?.(model)
  if (!success) {
    if (goingCloud && openedNow) closeDrawer(ctx)
    return `切不过去：${target} 没有可用凭据`
  }
  lastSwitch = { at: Date.now(), from, to: target }
  modelHealthCache.delete(target)
  toolFailures = 0
  if (goingLocal) closeDrawer(ctx)
  log(`model switch ${from} → ${target}${reason ? ` · ${reason}` : ""}`)
  return `已切到 ${target}${reason ? `（${reason}）` : ""}`
}

/**
 * 脚本级兜底：当前模型探活失败就切到另一个。
 * 不依赖模型自己判断，避免模型挂掉之后没人接手。
 */
async function ensureModelAlive(ctx: any): Promise<void> {
  const o = config().models
  if (!o.autoFailover || !o.local || !o.cloud) return
  const cur = modelIdOf(ctx)
  if (!cur || (cur !== o.local && cur !== o.cloud)) return
  if (failingOver) return
  if (Date.now() - lastSwitch.at < o.cooldownMs) return
  failingOver = true
  try {
    if (await modelUp(cur)) return
    const alt = cur === o.local ? o.cloud : o.local
    if (!(await modelUp(alt))) {
      log(`failover skipped · both down (${cur}, ${alt})`)
      return
    }
    const result = await switchTo(ctx, alt, `${cur} 不可用，自动切换`)
    log(`failover · ${result}`)
  } catch (e) {
    log(`failover failed · ${String(e)}`)
  } finally {
    failingOver = false
  }
}

/** 出错兜底：同一模型连续两次报错就切另一个（不等健康检查） */
async function failoverToOther(ctx: any, reason: string, opts: { onlyToCloud?: boolean } = {}): Promise<boolean> {
  const o = config().models
  if (!o.local || !o.cloud) return false
  const cur = modelIdOf(ctx)
  if (opts.onlyToCloud && cur !== o.local) return false
  const alt = cur === o.local ? o.cloud : cur === o.cloud ? o.local : ""
  if (!alt) return false
  const result = await switchTo(ctx, alt, reason)
  log(`failover · ${result}`)
  return result.startsWith("已切到")
}

export default function (pi: ExtensionAPI) {
  piRef = pi
  if (JUDGE) return // 判官：不注入、不注册工具
  if (!config().world.enabled) { log("life-world disabled · world.enabled=false"); return }
  ensureDirs()
  loadArchived()

  let hydrated = false

  pi.on("session_start", async (_event: any, ctx: any) => {
    hydrated = false
    lastCtx = ctx
    // 恢复会话时只补开、不主动合：同一 session 可能还有另一个进程在云端
    const o = config().models
    if (!o.local) return
    if (modelIdOf(ctx) !== o.local) openDrawer(ctx)
  })

  // 手动 /model、Ctrl+P 切到云端也要开抽屉；切回本地合上
  pi.on("model_select", async (event: any, ctx: any) => {
    const o = config().models
    if (!o.local) return
    const id = `${event?.model?.provider}/${event?.model?.id}`
    if (id === o.local) closeDrawer(ctx)
    else openDrawer(ctx)
  })

  // 云端模式：别碰机密抽屉（拦常见路数，剩下的靠自觉）
  pi.on("tool_call", async (event: any, ctx: any) => {
    const o = config().models
    if (!o.local || modelIdOf(ctx) === o.local) return
    const name = String(event?.toolName || "")
    const input: any = event?.input ?? {}
    const HINT = "需要看就调用 switch_model 切回本地模型。"
    const hitsDrawer = (s: string) => s.includes(DRAWER_DIR) || s.includes("机密抽屉")

    // 写类：只看目标路径，别因为正文里提到“机密抽屉”就误拦
    if (name === "write" || name === "edit") {
      const path = String(input.path || input.file_path || input.file || "")
      if (hitsDrawer(path)) return { block: true, reason: `云端模式不能读写机密抽屉。${HINT}` }
      return
    }

    // 子代理不走本扩展的守卫，这里先拦带抽屉路径的任务
    if (name === "delegate") {
      if (hitsDrawer(String(input.task || ""))) return { block: true, reason: `子代理不能处理机密抽屉。${HINT}` }
      return
    }

    if (!["read", "grep", "find", "ls", "bash"].includes(name)) return
    let blob = ""
    try { blob = JSON.stringify(input) } catch { blob = "" }
    if (hitsDrawer(blob)) return { block: true, reason: `云端模式不能打开机密抽屉。${HINT}` }

    // grep / find 本身就是递归的（没有 -r 参数），path 指向 world 或其祖先就拦
    const cwd = String(ctx?.sessionManager?.getCwd?.() || process.cwd())
    const inWorld = (p: string): boolean => {
      if (!p) return false
      const abs = p.startsWith("/") ? p : resolve(cwd, p)
      const norm = abs.replace(/\/+$/, "")
      return DRAWER_DIR === norm || DRAWER_DIR.startsWith(norm + sep)
    }
    if ((name === "grep" || name === "find") && inWorld(String(input.path || ""))) {
      return { block: true, reason: `机密抽屉在 ${input.path} 底下，云端模式别递归翻；点名具体文件，或切回本地。${HINT}` }
    }

    // bash：递归 / 打包 / 裸 find 整个世界目录也拦
    if (name === "bash") {
      const touchesWorld = blob.includes(WORLD) || blob.includes("worlds/default")
      const recursive = /-r|--recursive|-R|-exec|\btar\s|\bfind\s|\bgrep\s+-[A-Za-z]*r/.test(blob)
      if (touchesWorld && recursive) {
        return { block: true, reason: `整个世界目录里有机密抽屉，云端模式别递归翻；点名具体文件，或切回本地。${HINT}` }
      }
    }
  })

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    lastCtx = ctx
    // 脚本级兜底：当前模型探活失败就自动切另一个（不依赖模型自己判断）
    await ensureModelAlive(ctx)
    const patch: any = {}
    const original = String(event?.systemPrompt || "")
    let prompt = original
    const first = !hydrated
    if (first) hydrated = true
    // 世界规则每轮确保在场（pi 的强制 system prompt 只对本次 run 生效）
    const world = worldPromptText()
    if (world && !prompt.includes(WORLD_MARK)) prompt = `${prompt}\n\n${world}`
    // QQ 渠道：补上私聊 / 群聊的说话方式（压缩后可能丢，每轮确保在场）
    const style = CHANNEL === "qq"
      ? [QQ_PRIVATE_MARK, QQ_PRIVATE_BODY]
      : CHANNEL === "group"
        ? [QQ_GROUP_MARK, QQ_GROUP_BODY]
        : null
    if (style && !prompt.includes(style[0])) {
      prompt = `${prompt}\n\n${style[0]}\n${style[1]}`
      log(`style injected · ${CHANNEL}`)
    }
    const o = config().models
    const isLocal = !!o.local && modelIdOf(ctx) === o.local
    // 配了本地模型时：只要当前不是本地，就按云端处理（第三个模型也算）
    const cloudActive = !!o.local && !isLocal
    // 模型使用规范：和心情一样注入（identity/模型使用规范.md，控制在 500 字内）
    const rules = readText(MODEL_RULES_FILE)
    if (rules && !prompt.includes(MODEL_RULES_MARK)) prompt = `${prompt}\n\n${MODEL_RULES_MARK}\n${rules}`
    // 私密资料：不预加载内容，只告诉它在哪；云端模式明确别碰
    if (o.local && !prompt.includes(PRIVATE_HINT_MARK)) {
      const hint = cloudActive
        ? `私密资料在 ${DRAWER_DIR}。你仍是同一个你，只是这会儿借用云端机房的算力——机房的人可能看到这次上下文，所以这个文件夹先不打开，不是不信任你。需要看就切回本地模型。`
        : `私密资料在 ${DRAWER_DIR}，需要时自己 read。`
      prompt = `${prompt}\n\n${PRIVATE_HINT_MARK}\n${hint}`
    }
    if (prompt !== original) patch.systemPrompt = prompt
    const memory = first && !cloudActive ? memoryBlock() : ""
    const content = [stateText(!cloudActive), memory].filter(Boolean).join("\n\n")
    if (content) {
      patch.message = {
        customType: first && memory ? "life-world-bootstrap" : "life-world-state",
        content,
        display: false,
      }
    }
    if (patch.systemPrompt || patch.message) return patch
  })

  pi.on("input", async () => {
    // 动态状态改走 before_agent_start 的隐藏消息，不再污染用户消息正文
    return { action: "continue" } as const
  })

  pi.on("context", async (event: any, ctx: any) => {
    const messages = event?.messages
    if (!Array.isArray(messages)) return
    const o = config().models
    const key = sessionKey(ctx)
    const drawer = readDrawer(key)
    let filtered = false

    // 隐私抽屉：切到云端后，切换前的对话对云端不可见（原会话不动，切回本地自动恢复）
    if (drawer.active && o.local && modelIdOf(ctx) !== o.local) {
      let lastUser = -1
      for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i
      const kept = sanitizeToolPairs(messages.filter((m: any, i: number) => Number(m?.timestamp || 0) >= drawer.cutoff || i === lastUser))
      if (kept.length !== messages.length) {
        const hidden = messages.length - kept.length
        if (!drawer.stashed) {
          // 第一次收起时，把原文也在本地抽屉留一份（仅本地，云端看不到）
          try {
            const lines = messages
              .filter((m: any) => Number(m?.timestamp || 0) < drawer.cutoff && m?.role !== "system")
              .map((m: any) => {
                const parts = Array.isArray(m?.content) ? m.content : [{ type: "text", text: String(m?.content ?? "") }]
                const text = parts.map((p: any) => p?.type === "text" ? String(p.text || "") : p?.type === "image" ? "[图片]" : `[${p?.type || "?"}]`).join("\n").slice(0, 4000)
                return JSON.stringify({ t: new Date(Number(m?.timestamp || 0)).toISOString(), role: m?.role, text })
              })
            if (lines.length) {
              mkdirSync(DRAWER_DIR, { recursive: true, mode: 0o700 })
              appendFileSync(drawerLogPath(), lines.join("\n") + "\n", { mode: 0o600 })
            }
          } catch (e) { log(`drawer stash failed ${String(e)}`) }
          writeDrawer(key, { ...drawer, hidden, stashed: true })
        } else if (hidden !== drawer.hidden) {
          writeDrawer(key, { ...drawer, hidden })
        }
        log(`privacy drawer · hid ${hidden} messages from cloud`)
        const stub = {
          role: "system",
          content: `[机密抽屉] 切换到云端之前有 ${hidden} 条对话已收进本地机密抽屉（${DRAWER_DIR}），本次请求不包含它们；回到本地模型时会重新打开。`,
        }
        event.messages = [stub, ...kept]
        filtered = true
      }
    }

    // 本地小模型：发请求前折叠旧工具结果 / 推理，省上下文、省 prefill
    const opt = localModelOptions()
    const a = opt.enabled ? foldToolResults(event.messages, opt.foldToolResults, opt.resultChars) : false
    const b = opt.enabled ? foldThinking(event.messages, opt.foldingThinkingTurns) : false
    if (opt.enabled && opt.debugStats) statsRequest(event.messages)
    if (a || b || filtered) return { messages: event.messages }
  })

  pi.on("message_end", async (event: any, ctx: any) => {
    const message = event?.message ?? event
    archive(message)
    if (message?.role !== "assistant") return
    const stop = String(message?.stopReason || "")
    if (stop === "error") {
      // 回复不了就直接切，不计数
      log(`model error · ${modelIdOf(ctx)} · ${String(message?.errorMessage || "").slice(0, 200)}`)
      await failoverToOther(ctx, "模型无响应")
    } else if (stop === "stop" || stop === "length") {
      // 正常收尾才清零；toolUse 只是中间轮，别把失败计数抹掉
      toolFailures = 0
    }
  })

  // 工具连续失败两次（参数错 / 调用不了）→ 切到另一个模型看看情况
  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    if (event?.isError) {
      toolFailures++
      log(`tool failure ${toolFailures}/2 · ${String(event?.toolName || "?")}`)
      if (toolFailures >= 2) {
        toolFailures = 0
        // 只在本地模型上切云端看看情况；已经在云端就别来回踢
        await failoverToOther(ctx, "连续两次工具调用失败", { onlyToCloud: true })
      }
    } else {
      toolFailures = 0
    }
  })

  // —— 工具 ——
  addTool(pi, {
    name: "plan_next",
    label: "Plan next",
    description: "说好接下来做什么、做到什么时候、到点用哪个模型跑。note 要写清做什么、怎么算做成；at 与 after_minutes 二选一；model 定好 local / cloud，到点会先切过去。",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "做什么，以及怎么算做成了" },
        at: { type: "string", description: "带时区的完整时间，如 2026-11-07T18:00:00+08:00" },
        after_minutes: { type: "number", description: "从现在起多少分钟（至少 1）" },
        model: { type: "string", enum: ["local", "cloud"], description: "到点用哪个模型跑；不传就沿用当前模型" },
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
      const c = config().models
      const current = lastCtx ? modelIdOf(lastCtx) : ""
      const model: Alarm["model"] = params.model === "local" || params.model === "cloud"
        ? params.model
        : current && current === c.local ? "local" : current && current === c.cloud ? "cloud" : undefined
      const alarm: Alarm = { id: `a-${now}-${Math.random().toString(36).slice(2, 6)}`, at: new Date(target).toISOString(), note: String(params.note || ""), setAt: new Date(now).toISOString(), model }
      state.alarms = [...(state.alarms || []), alarm].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      if (!writeWorld(state)) return ok("闹钟没能写进 world.json。")
      const modelText = model === "cloud" ? "在线模型" : model === "local" ? "本地模型" : "当前模型"
      return ok(`定好了：${isoLocal(new Date(target))} —— ${alarm.note}（到点用${modelText}跑）`)
    },
  })

  addTool(pi, {
    name: "check_alarm",
    label: "Check alarms",
    description: "看看现在排着的闹钟。",
    parameters: { type: "object", properties: {} },
    async execute() {
      const alarms = readWorld().alarms || []
      if (!alarms.length) return ok("现在没有定闹钟。")
      return ok(alarms.map((a) => `- ${shortStamp(a.at)}（还有 ${Math.max(0, Math.round((Date.parse(a.at) - Date.now()) / 60_000))} 分钟）${a.note}${a.model ? `（${a.model === "cloud" ? "在线" : "本地"}模型）` : ""}`).join("\n"))
    },
  })

  addTool(pi, {
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

  addTool(pi, {
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

  addTool(pi, {
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

  addTool(pi, {
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

  addTool(pi, {
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

  addTool(pi, {
    name: "switch_model",
    label: "Switch model",
    description: "本地 / 在线模型热切换。target: local=本地小模型，cloud=在线大模型，也可写 provider/model；不传 target 就报当前模型。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "local / cloud / provider/model；省略则查状态" },
        reason: { type: "string", description: "为什么切，写一句，便于回看" },
      },
    },
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const o = config().models
      const cur = modelIdOf(ctx) || "未知"
      const raw = String(params?.target || "").trim()
      if (!raw || raw === "status") {
        return ok(`当前模型：${cur}\n本地：${o.local || "未配"}\n在线：${o.cloud || "未配"}\n自动兜底：${o.autoFailover ? "开" : "关"}`)
      }
      if (!o.local && !o.cloud) return ok("还没配 models.local / models.cloud，先在 life-world.json 里配好。")
      const target = raw === "local" ? o.local : raw === "cloud" ? o.cloud : raw
      if (!target) return ok(`这个别名没配：${raw}`)
      if (target === cur) return ok(`已经是 ${target} 了。`)
      return ok(await switchTo(ctx, target, String(params?.reason || "")))
    },
  })

  addTool(pi, {
    name: "web_search",
    label: "Web search",
    description: "联网搜索最新信息（免费，不需要 key）。返回标题、链接、摘要；要看正文再打开链接。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词" },
        limit: { type: "number", description: "返回几条，默认 5（最多 10）" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      const query = String(params.query || "").trim()
      if (!query) return ok("要搜什么？给个搜索词。")
      const limit = Math.max(1, Math.min(10, Number(params.limit) || 5))
      try {
        const hits = await webSearch(query, limit)
        if (!hits.length) return ok(`没搜到「${query}」的结果。`)
        return ok(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n"))
      } catch (e) {
        return ok(`搜索失败：${String((e as any)?.message || e)}`)
      }
    },
  })

  addTool(pi, {
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

  addTool(pi, {
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

  addTool(pi, {
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

  addTool(pi, {
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


  addTool(pi, {
    name: "gal_choice",
    label: "Gal choice panel",
    description: "终端 gal 模式用：抛一个单选面板让用户选。QQ/群聊没有面板，别用；那边把选项写成正文。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "镜头停在哪、现在要对方做什么，只写一句" },
        options: { type: "array", items: { type: "string" }, description: "2~3 个选项，单选" },
      },
      required: ["question", "options"],
    },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      if (CHANNEL !== "cli" || JUDGE) return ok("这个会话没有选项面板；把选项写成正文，让用户按数字回复。")
      const ui = ctx?.ui
      if (!ui?.select) return ok("当前会话没有选项面板；把选项写成正文。")
      const options = Array.isArray(params.options) ? params.options.map((x: any) => String(x)).slice(0, 3) : []
      if (!options.length) return ok("没有选项。")
      const choice = await ui.select(String(params.question || "选一个"), options)
      return ok(`用户选择：${choice ?? "（取消）"}`)
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
