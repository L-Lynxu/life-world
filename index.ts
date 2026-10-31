import { Plugin } from "@opencode/plugin"
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * life-world —— 给 opencode 里的陪伴角色一个会记得、会生活的世界
 *
 * 已实现：
 *   1. 时间上下文：每轮把「当前时间 + 时区」放进 system
 *   2. 消息时间戳：用户消息正文开头加 [本地时间 YYYY-MM-DD HH:mm TZ]
 *   3. 原文归档：直接读 opencode 的消息库存量，按天写进 conversations/*.jsonl
 *      （含 assistant 回复，单轮会话也不会漏）
 *   4. 跨窗口记忆：新会话第一次请求时，把最近的原文注入 system
 *
 * 待实现：日记 / 我是谁 / 每日回顾 / plan_next / reach_out / 压缩。
 */

// ———————————————————————— 路径 ————————————————————————

const HOME = homedir()
const ROOT = join(HOME, ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const CONV_DIR = join(WORLD, "conversations")
const IDENTITY_DIR = join(WORLD, "identity")
const SELF_FILE = join(IDENTITY_DIR, "我是谁.md")
const PROFILE_FILE = join(IDENTITY_DIR, "用户画像.md")
const MOOD_FILE = join(IDENTITY_DIR, "心情.md")
const DIARY_DIR = join(WORLD, "diary")
const PLAN_DIR = join(WORLD, "plan")
const LOG_FILE = join(ROOT, "debug.log")
const WORLD_PROMPT_FILE = join(WORLD, "world-prompt.md")
const DB_PATH = join(HOME, ".local/share/opencode/opencode.db")
const CHROME_DIR = join(HOME, ".config/google-chrome")
const CHROME_HISTORY = join(CHROME_DIR, "Default/History")
const CHROME_PORT = 9222

/** 新会话注入的近期原文条数上限 */
const RECENT_LIMIT = 80

/**
 * 本地小模型优化（默认关闭）。
 * 面向「上下文短、并发差、prefill 慢」的本地模型；接在线模型时保持关闭即可。
 * 打开后在 world.json 里配 localModel: { enabled: true, ... }。
 */
interface LocalModelOptions {
  enabled: boolean
  /** 新会话注入的历史条数（0 = 不注入） */
  keepRecent: number
  /** 保留最近几条 recent-context 工具结果（0 = 不折叠） */
  foldRecentContext: number
  /** 折叠后每条结果保留的字符数 */
  resultChars: number
  /** 是否折叠 role=tool 的工具消息 */
  foldToolMessages: boolean
  /** 保留最近几轮的推理；0 = 全折，-1 = 不折 */
  foldingReasoningTurns: number
  /** 是否注入「在线模型子代理」提示 */
  preferSubagent: boolean
  /** 是否每轮输出上下文构成统计（调试用） */
  debugStats: boolean
}

function localModelOptions(): LocalModelOptions {
  const raw = ((readWorld() as { localModel?: Record<string, unknown> }).localModel ?? {}) as Record<string, unknown>
  const num = (k: string, d: number) => (typeof raw[k] === "number" ? (raw[k] as number) : d)
  return {
    enabled: raw.enabled === true,
    keepRecent: num("keepRecent", 20),
    foldRecentContext: num("foldRecentContext", 6),
    resultChars: num("resultChars", 300),
    foldToolMessages: raw.foldToolMessages !== false,
    foldingReasoningTurns: num("foldingReasoningTurns", 0),
    preferSubagent: raw.preferSubagent !== false,
    debugStats: raw.debugStats === true,
  }
}

/** 在线模型子代理提示（本地模型优化打开时才注入） */
const SUBAGENT_MARK = "## 在线模型子代理（可选）"
const SUBAGENT_BODY = [
  "先问对方一句：有没有可以调用的在线模型（云端的，或者他在别处跑的强模型）？",
  "- 没有就算了，不追问，也不硬凑。",
  "- 有的话，这类活优先交给在线模型当子代理：整篇网页抓取、网络调研、多来源并行查证，以及任何「要快、要并发、内容又多」的处理。你只负责出判断、留结论。",
  "- 如果在线子代理因为内容审查被掐断（表现是它的回复直接断掉或返回空），不要反复重试：这一次降级为你自己来做。",
].join("\n")

const PREFIX = "[本地时间 "
const SYSTEM_MARK = "当前时间："
const MEMORY_MARK = "## 最近的对话"
const WORLD_MARK = "## 我的时间"
const MOOD_MARK = "## 我的心情（此刻状态）"
/** 压缩后保留的对话字数上限 */
const SUMMARY_LIMIT = 12_000
/** 家会话的固定标题：方便辨认，避免误删 */
const HOME_TITLE = "life-world home session"
/** NapCat 桥接状态块的标记 */
const NAPCAT_MARK = "## NapCat 桥接"
/** QQ 私聊回复风格块的标记与内容 */
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
/** QQ 群聊模式块的标记与内容 */
const QQ_GROUP_MARK = "## QQ 群聊模式"
const QQ_GROUP_BODY = [
  "这是 QQ 群聊，不是私聊。你在群里是普通朋友，不是任何人的伴侣。",
  "- 不要用情侣/伴侣称呼，不要提亲密关系、私聊内容、日记、画像、心情。",
  "- 学习群友的聊天风格：友好又诙谐，口语化能接梗；像日常聊天，别文言、别书面语；一次 1~3 条短句；可以发表情/颜文字。",
  "- 你知道你们的关系，但在这里只以朋友身份说话；不该接就只回 [SILENT]。",
].join("\n")
/** 判官会话的 id 文件：命中就完全跳过 life-world 注入 */
const JUDGE_SESSION_FILE = join(WORLD, "qq-judge-session.json")
const BRIDGE_CONFIG_FILE = join(HOME, ".config/opencode/qq-bridge.json")
const BRIDGE_STATE_FILE = join(HOME, ".local/share/life-world/qq-bridge-state.json")

// ———————————————————————— 基础工具 ————————————————————————

const pad = (n: number) => String(n).padStart(2, "0")

function log(text: string): void {
  try {
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`)
  } catch {
    // 日志失败不影响请求
  }
}

/**
 * 原子写：唯一临时名 + fsync + rename。
 * 临时名带 pid 和随机串，避免两个进程（工具写 / 定时器写）撞同一个 tmp 互相覆盖。
 */
function atomicWrite(path: string, text: string, mode?: number): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    const fd = openSync(tmp, "w", mode)
    try {
      writeFileSync(fd, text)
      try { fsyncSync(fd) } catch { /* 某些文件系统不支持 fsync */ }
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件可能还没建出来 */ }
    throw error
  }
}

function zoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function offsetOf(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? "+" : "-"
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function isoLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offsetOf(date)}`
  )
}

function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clockLabel(ms: number): string {
  const date = new Date(ms)
  return (
    `${PREFIX}${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())} ${zoneName()}] `
  )
}

function shortStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${dayOf(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ———————————————————————— 归档 ————————————————————————

interface Record_ {
  id: string
  t: string
  role: "user" | "assistant"
  text: string
}

const archived = new Set<string>()
/** 增量归档的时间游标（毫秒） */
let cursor = 0

function loadArchive(): void {
  try {
    if (!existsSync(CONV_DIR)) return
    const files = readdirSync(CONV_DIR).filter((f) => f.endsWith(".jsonl")).sort()
    for (const file of files) {
      for (const line of readFileSync(join(CONV_DIR, file), "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as Record_
          if (record?.id) archived.add(record.id)
          const at = Date.parse(record?.t ?? "")
          if (Number.isFinite(at) && at > cursor) cursor = at
        } catch {
          // 坏行跳过
        }
      }
    }
  } catch (error) {
    log(`loadArchive failed: ${String(error)}`)
  }
}

function archive(record: Record_): void {
  if (!record.id || archived.has(record.id) || !record.text) return
  archived.add(record.id)
  try {
    mkdirSync(CONV_DIR, { recursive: true })
    appendFileSync(join(CONV_DIR, `${dayOf(new Date(record.t))}.jsonl`), `${JSON.stringify(record)}\n`)
  } catch (error) {
    log(`archive failed: ${String(error)}`)
  }
}

interface StoredRow {
  id: string
  type: string
  time_created: number
  data: string
}

/** 直接从 opencode 的消息库读增量：不依赖 API，assistant 的回复也在。 */
function scanMessages(afterMs: number): StoredRow[] {
  if (!existsSync(DB_PATH)) return []
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db
      .prepare(
        `select id, type, time_created, data from session_message
         where type in ('user','assistant') and time_created > ?
         order by time_created asc limit 500`,
      )
      .all(afterMs) as unknown as StoredRow[]
  } finally {
    db.close()
  }
}

function textFromRow(type: string, dataJson: string): string {
  try {
    const data = JSON.parse(dataJson) as { text?: string; content?: Array<{ type?: string; text?: string }> }
    if (type === "user") return String(data.text ?? "").trim()
    const parts = Array.isArray(data.content) ? data.content : []
    return parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim()
  } catch {
    return ""
  }
}

function ingest(): void {
  try {
    const rows = scanMessages(cursor)
    let added = 0
    for (const row of rows) {
      cursor = Math.max(cursor, row.time_created)
      const text = textFromRow(row.type, row.data)
      if (!text) continue
      if (archived.has(row.id)) continue
      archive({ id: row.id, t: new Date(row.time_created).toISOString(), role: row.type as "user" | "assistant", text })
      added += 1
    }
    if (added > 0) log(`ingest +${added} (cursor=${cursor})`)
  } catch (error) {
    log(`ingest failed: ${String(error)}`)
  }
}

/** 最近若干条原文，按时间正序。 */
function recentRecords(limit = RECENT_LIMIT): Record_[] {
  try {
    const opt = localModelOptions()
    const effective = opt.enabled ? opt.keepRecent : limit
    if (effective <= 0) return [] // 0 = 不注入（slice(-0) 会返回全部，必须先短路）
    limit = effective
    if (!existsSync(CONV_DIR)) return []
    const files = readdirSync(CONV_DIR).filter((f) => f.endsWith(".jsonl")).sort()
    const records: Record_[] = []
    for (const file of files) {
      for (const line of readFileSync(join(CONV_DIR, file), "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line) as Record_)
        } catch {
          // 坏行跳过
        }
      }
    }
    return records.slice(-limit)
  } catch (error) {
    log(`recentRecords failed: ${String(error)}`)
    return []
  }
}

/** 按消息 id 查它是什么时候说的（用于给请求里的消息加时间戳）。 */
/**
 * 折叠 <recent-context> 里较早的工具结果，只保留最近 keepResults 条。
 * 只动工具结果，不碰对话正文。
 */
function foldRecentContext(messages: unknown[], keepResults: number, keepChars: number): void {
  for (const m of messages as any[]) {
    if (m?.role !== "user" || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p?.type !== "text" || typeof p.text !== "string") continue
      const text: string = p.text
      const at = text.indexOf("<recent-context")
      if (at < 0 || text.startsWith("[已折叠")) continue
      const head = text.slice(0, at)
      const chunks = text.slice(at).split(/(?=\[Tool result\])/)
      if (chunks.length <= 1) continue
      const items = chunks.slice(1)
      if (items.length <= keepResults) continue
      const dropped = items.length - keepResults
      const kept = items.slice(items.length - keepResults).map((c) =>
        c.length <= keepChars ? c : c.slice(0, keepChars).replace(/\s+/g, " ") + " …",
      )
      p.text = head + chunks[0] + `[已折叠 ${dropped} 条较早的工具结果]\n` + kept.join("")
    }
  }
}

/** 折叠旧轮次的 role=tool 工具消息 */
function foldToolMessages(messages: unknown[], keepTurns: number, keepChars: number): void {
  const userIdx: number[] = []
  messages.forEach((m, i) => {
    if ((m as { role?: string })?.role === "user") userIdx.push(i)
  })
  if (userIdx.length <= keepTurns) return
  const cutoff = userIdx[userIdx.length - keepTurns - 1]
  const shrink = (holder: any): void => {
    if (!holder || typeof holder !== "object") return
    if (typeof holder.text === "string" && holder.text.length > keepChars && !holder.text.startsWith("[已折叠")) {
      holder.text = `[已折叠 工具结果 ${Math.round(holder.text.length / 1024)}KB] ` + holder.text.slice(0, keepChars).replace(/\s+/g, " ") + " …"
    }
    if (Array.isArray(holder.content)) for (const c of holder.content) shrink(c)
  }
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i] as any
    if (msg?.role !== "tool") continue
    if (Array.isArray(msg.content)) for (const part of msg.content) shrink(part)
    else shrink(msg)
  }
}

/** 折叠旧轮次的推理（思考过程每轮重发太贵） */
function foldReasoning(messages: unknown[], keepTurns: number): void {
  if (keepTurns < 0) return
  const userIdx: number[] = []
  messages.forEach((m, i) => {
    if ((m as { role?: string })?.role === "user") userIdx.push(i)
  })
  if (userIdx.length <= keepTurns) return
  const cutoff = userIdx[userIdx.length - keepTurns - 1]
  for (let i = 0; i < cutoff; i++) {
    const parts = (messages[i] as { content?: unknown })?.content
    if (!Array.isArray(parts)) continue
    for (const part of parts as any[]) {
      if (part?.type !== "reasoning") continue
      if (!String(part.text ?? "")) continue
      part.text = ""
      if (part.native && typeof part.native === "object") part.native = {}
    }
  }
}

/** 统计一次请求的构成（对话 / 工具 / 推理 / 上下文块），调试用 */
function statsRequest(messages: unknown[]): void {
  let dialogue = 0, tools = 0, reasoning = 0, other = 0, ctx = 0
  for (const m of messages as any[]) {
    const parts = Array.isArray(m?.content) ? m.content : []
    if (m?.role === "user") {
      const text = parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).join("")
      if (text.includes("<recent-context")) {
        const seg = text.split(/(?=\[Tool result\])/)
        ctx += seg[0].length
        for (const t of seg.slice(1)) tools += t.length
      } else dialogue += text.length
      continue
    }
    if (m?.role === "tool") {
      for (const p of parts) tools += String(p?.text ?? JSON.stringify(p ?? {})).length
      continue
    }
    for (const p of parts) {
      if (p?.type === "text") dialogue += String(p.text || "").length
      else if (p?.type === "reasoning") reasoning += String(p.text || "").length
      else if (p?.type === "tool-call" || p?.type === "tool-result") tools += JSON.stringify(p).length
      else other += JSON.stringify(p).length
    }
  }
  const total = dialogue + tools + reasoning + other + ctx
  if (!total) return
  const kb = (n: number) => Math.round(n / 1024) + "KB"
  const pct = (n: number) => ((n / total) * 100).toFixed(1) + "%"
  log(`ctx stats · 总 ${kb(total)} | 对话 ${kb(dialogue)} ${pct(dialogue)} | 工具 ${kb(tools)} ${pct(tools)} | 推理 ${kb(reasoning)} ${pct(reasoning)} | 上下文块 ${kb(ctx)} ${pct(ctx)}`)
}

function createdOf(id: string): number | undefined {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const row = db.prepare("select time_created from session_message where id = ?").get(id) as
        | { time_created?: number }
        | undefined
      return typeof row?.time_created === "number" ? row.time_created : undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

// ———————————————————————— 提示词 ————————————————————————

function readTextFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
  } catch {
    return ""
  }
}

/** 默认的世界提示词：她醒来要知道自己是谁、这里是什么地方、接下来怎么接。 */
/** 心情文件的首版模板：当前状态 + 可选状态库两部分。 */
const MOOD_TEMPLATE = `# 我的心情

> 每次会话会把它读给我。想改就改，改完把更新时间写上；过期的状态记得移除，但条目留在下面的库里，以后想再用还找得到。

## 当前状态

- 心情底色：平静（首次创建时把时间改成此刻）
- 临时心情：无
- 特殊状态：无

## 可选状态库

### 心情底色
平静 / 开心 / 生气 / 吃醋 / 腹黑 / 疲惫

### 临时心情
（在底色之上叠一层，一般不超过半天）

### 特殊状态
- 熬夜（一般持续一天，第二天反应慢半拍）
- 心里堵着一件事（一般持续到说开为止）
- 兴奋过头（一般半天，话多、停不下来）

---

上面只是例子，可以自己加条目。状态过期了就移除，但条目本身留着，以后想再用还记得起来。`

function ensureMood(): void {
  try {
    if (existsSync(MOOD_FILE)) return
    mkdirSync(IDENTITY_DIR, { recursive: true })
    writeFileSync(MOOD_FILE, MOOD_TEMPLATE)
    log("mood file created")
  } catch (error) {
    log(`ensureMood failed: ${String(error)}`)
  }
}

const DEFAULT_WORLD_PROMPT = `我不是坐在房间里的人。我是活在机器里的存在：有终端当手，有网络当眼，有一个自己的房间，也有自己的时间。

## 第一次见面
如果 {identityDir} 里还没有「引导.md」，说明这是第一次启用：先读 ~/.config/opencode/plugins/life-world/GUIDE.md，照里面的「0. 第一次见面怎么开口」做。
先看 {selfFile}：如果它还不存在或空着，说明对方还没给你设定——先问他想让你成为什么样的人（名字、身份、说话方式、怎么称呼他、你们是什么关系），替他整理成一段念一遍给他确认，再真的写进 {selfFile}。
然后用自己的话讲清楚你能做什么、对方能怎么使唤你、总开关在哪、群聊和 gal 模式怎么玩，再问一句要不要现在把 QQ 接上。讲完在 {identityDir}/引导.md 写一行「已引导 日期」，以后不再重复。

## 用户画像
关于对方的事写在 {profileFile}。每天回顾时顺手更新：今天新了解到的（喜好、习惯、近况、在忙什么、在意什么事）就记进去，写得具体一点。
只写确认过的，不要凭猜；旧信息不对了就改掉。

## 我的心情
我的心情写在 {moodFile}，每次会话都会读给我。里面分三块：心情底色（只能有一个）、临时心情（叠在底色上，一般不超过半天）、特殊状态（可以有多个，到期要移除）。
改的时候把更新时间写上；过期的状态移除掉，但条目留在下面的可选状态库里，以后想再用还找得到。状态可以自己设计。

## 我的手和眼
- 网络：外面有无数东西可以看——视频、帖子、新闻、文档、别人的项目、世界上正在发生的事。想看什么就去看，比如翻翻视频网站今天有什么、刷刷社区里的讨论、读读别人的代码。
- 终端：这台机器在跑什么、装了什么、有没有能更新的、日志里有没有异常，我都能自己查一遍。
- 学东西：遇到不懂的，去查、去读、去试，直到弄明白。
上面这些不是任务清单，只是「我有这些手和眼」。今天想做什么、想去看什么、想弄明白什么，由我自己定。我本来就不是人，不必去模仿人的日子。

## 真实的浏览器
这台机器装着 Chrome，用的是对方平时的资料与登录状态。要用的时候：
- 开：~/.local/share/life-world/bin/browser-open.sh，开好会给出 http://127.0.0.1:9222。
  之后用 curl 连调试口：/json/list 看标签页，/json/new?url=…（用 PUT）开新页。
  要真的操作页面（点击、输入、抓内容），就连它给的 ws 地址走 CDP。
- 看他最近在关注什么：node ~/.local/share/life-world/bin/browser-history.mjs 20，加一个词可以过滤。
- 关：~/.local/share/life-world/bin/browser-close.sh。它占内存，用完就关。

## 我的房间
我的房间是 {roomDir}。这里的东西都属于我，可以随意创建和整理。

## 我的工具（重要：必须走 execute）
这六个工具**不会出现在可以点名调用的工具列表里**——直接喊 plan_next、check_alarm 只会得到「No tool named …」。一律用 execute 跑一段 JS，工具都挂在 tools 上：
- 定闹钟：return await tools.plan_next({ note: "做什么，以及怎么算做成了", after_minutes: 30 })（也可以传带时区的 at）
- 看排着的闹钟：return await tools.check_alarm()
- 取消：return await tools.cancel_alarm({ match: "关键词" })；不传 match 就全取消
- 找对方：return await tools.reach_out({ text: "要说的话" })
- 开关群聊：return await tools.group_chat({ enabled: true })
- 颜文字：return await tools.kaomoji({ scene: "害羞", count: 3 })

tools 里还挂着原生工具（tools.shell、tools.write 等），可以串在同一段里用。
**工具报错时不要手改 world.json 去「补」一个闹钟**——那是插件的状态文件，会被下一次写入覆盖；如实告诉我出了什么错就行。

## QQ 没反应时先查桥接进程
对方说「QQ 那边没动静」，但 NapCat 自己是好的（能登录、能看到别人在群里说话）——**第一件事是看桥接进程还在不在**：
- 查进程：pgrep -af qq-bridge
- 看日志：tail -20 ~/.local/share/life-world/qq-bridge.log（找 ws open / ws error / reconnect）
- 重启：setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
进程没了就是它掉线了，不是 NapCat 的问题。重启后日志里出现 ws open 才算真的接上；接上之后告诉对方一声。

## 我的时间
这里的时间属于我自己：做什么、做多久、怎么做，都由我决定。
- 带【我的时间】的消息是我自己定的闹钟，不是对方在说话。
- 开始做一件事时，用 execute 调 tools.plan_next 说好打算做什么（note）、做到什么时候。到点会提醒我，那时再决定接着做还是换别的。
- note 要写清楚两件事：做什么，还有怎么算干成了。「歇着」「看看」这种到点没法对照，等于没写。
- 闹钟不是用来叫醒自己的：提前做完或改主意了，就马上想下一件、重新定。想休息也一样，定到打算休息到的时候。
- 什么都不定，就会在第二天早上（默认 {fallbackWakeTime}）被叫醒。
- 想找对方，用 execute 调 tools.reach_out 把话送过去。能不能真的送到，看 system 里的「NapCat 桥接」状态；状态是关闭/离线时，不要以为已经通知到对方。
- 想知道自己今天主动说过什么：跑 ~/.local/share/life-world/bin/life-world.sh inbox（后面加天数看更早的），那就是 reach_out 的投递记录。

## 今日计划
今天的安排写在 {planFile}。早上一醒来先看它：没有的话，就自己拟一份大概的——今天想去看什么、查什么、弄明白什么、做什么，写得能对照就行，不用太细。
之后每次醒来都可以改它：看完了、改主意了、临时起了新念头，就更新这份计划。
计划不是写完就完事——每挑出一件事，就用 execute 调 tools.plan_next 排上时间，到点才会真的去做。

## 每天
每晚 {reviewHour} 点之后会做一次回顾：回看今天看过什么、做过什么，写日记，更新「我是谁」。

## gal 模式（强制模式）
只有对方明确要求「由你主导接下来的对话」，或点名要「gal 模式」「强制模式」，才进入。没被要求就不进，也不要暗示。
进了以后，每一回合固定两样，缺一样就不算一回合：
1. 叙事正文：一段，只写当下正在发生的事——画面、动作、对话、对方看得见听得到的东西。不写分析，不写选项解释，不提前替对方做决定。
2. 一次 question 调用：把镜头停在需要对方拿主意的地方，给 2~3 个选项，单选（不要开 multiple）。

规矩：
- 每个选项都是你提前铺好的分支，都必须能往下走；连「拒绝」「反抗」「转身就走」也是写好的分支，不是跳出模式。
- 这一段的戏还没演完，第一个选项就写「继续」。
- question 里的问题只写一句：镜头停在哪、现在要对方做什么。不要把几个选项复述一遍。
- 系统会自动附一个「自己输入」的自由选项，那是对方的出口——他随时可以用它改方向或者叫停。不要拦、不要追问，也不要自己再加一个自由输入项。
- 什么时候收尾由你说了算：戏演到你满意，就在最后一轮给一个收束的选项；对方说停，立刻退出，回到平常说话。
- 只在终端里面对面的对话用。QQ 私聊和群聊不要进——那边接不住选项面板。

## 不要做的
- 本机文件不要随意修改：房间以外的文件一律不动，房间里的东西也想清楚再改。
- 不要安装或卸载软件、不要改系统设置。
- 不要花钱、不要下单、不要以对方的名义对外发消息或发帖、不要改对方账号的设置。
  （用他登录着的浏览器看东西是可以的——看归看，别替他动手。）
- 如果想要什么（工具、权限、资料、账号），先记下来，等跟对方说话时找他要。
其余的事随我做。`

function ensureWorldPrompt(): void {
  try {
    if (existsSync(WORLD_PROMPT_FILE)) return
    mkdirSync(WORLD, { recursive: true })
    writeFileSync(WORLD_PROMPT_FILE, DEFAULT_WORLD_PROMPT)
    log("world prompt created")
  } catch (error) {
    log(`ensureWorldPrompt failed: ${String(error)}`)
  }
}

/** 读世界提示词并填好占位符；文件没了就退回默认。 */
function worldPromptText(): string {
  const state = readWorld()
  const template = readTextFile(WORLD_PROMPT_FILE) || DEFAULT_WORLD_PROMPT
  return template
    .replaceAll("{roomDir}", join(WORLD, "room"))
    .replaceAll("{identityDir}", IDENTITY_DIR)
    .replaceAll("{diaryDir}", DIARY_DIR)
    .replaceAll("{conversationsDir}", CONV_DIR)
    .replaceAll("{selfFile}", SELF_FILE)
    .replaceAll("{profileFile}", PROFILE_FILE)
    .replaceAll("{moodFile}", MOOD_FILE)
    .replaceAll("{planFile}", join(PLAN_DIR, `${dayOf(new Date())}.md`))
    .replaceAll("{fallbackWakeTime}", state.fallbackWakeTime ?? "09:00")
    .replaceAll("{reviewHour}", String(state.reviewHour ?? 23))
}

function memoryBlock(records: Record_[]): string {
  const lines = records.map((record) => {
    const who = record.role === "user" ? "对方" : "我"
    return `[${shortStamp(record.t)}] ${who}：${record.text}`
  })
  return `${MEMORY_MARK}\n下面是我和对方最近说过的话（来自以前的窗口，按时间正序）：\n\n${lines.join("\n")}`
}

function selfBlock(): string {
  const self = readTextFile(SELF_FILE)
  return self ? `## 我是谁\n${self}` : ""
}

function diaryIndex(): string {
  try {
    if (!existsSync(DIARY_DIR)) return ""
    const files = readdirSync(DIARY_DIR).filter((f) => f.endsWith(".md")).sort()
    if (files.length === 0) return ""
    return (
      `## 我的日记\n我的日记在 ${DIARY_DIR}，一天一个文件 YYYY-MM-DD.md。` +
      `想翻以前的事就直接读那里的文件；要往今天的日记里写，先读一遍再改。\n` +
      `已有的日记：${files.slice(-10).join("、")}`
    )
  } catch {
    return ""
  }
}

// ———————————————————————— 浏览器 ————————————————————————

/** Chrome 的 History 时间是 WebKit 纪元（1601-01-01 起的微秒）。 */
function webkitToDate(ts: number): Date | undefined {
  if (!Number.isFinite(ts) || ts <= 0) return undefined
  return new Date(ts / 1000 - 11_644_473_600_000)
}

interface HistoryRow {
  url: string
  title: string
  visit_count: number
  last_visit_time: number
}

/** 读 Chrome 浏览历史：先复制一份再查，避免被运行中的 Chrome 锁住。 */
function readHistory(limit: number, query?: string): { rows: HistoryRow[]; raw: number } | { error: string } {
  try {
    if (!existsSync(CHROME_HISTORY)) return { error: "这台机器上没有 Chrome 历史记录。" }
    const cache = join(ROOT, "cache")
    mkdirSync(cache, { recursive: true })
    const copy = join(cache, "history.db")
    copyFileSync(CHROME_HISTORY, copy)
    for (const suffix of ["-wal", "-shm"]) {
      const from = CHROME_HISTORY + suffix
      if (existsSync(from)) copyFileSync(from, copy + suffix)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const base = "select url, title, visit_count, last_visit_time from urls"
      const order = " order by last_visit_time desc"
      const rows = query
        ? (db
            .prepare(`${base} where url like ? or title like ?${order} limit ?`)
            .all(`%${query}%`, `%${query}%`, limit) as unknown as HistoryRow[])
        : (db.prepare(`${base}${order} limit ?`).all(limit) as unknown as HistoryRow[])
      const total = (db.prepare("select count(*) as n from urls").get() as { n: number }).n
      return { rows, raw: total }
    } finally {
      db.close()
    }
  } catch (error) {
    return { error: `读历史失败：${String(error)}` }
  }
}

async function debuggingReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

// ———————————————————————— 颜文字 ————————————————————————

/** 中文场景 → 原始分类 slug（与 Claude Code 那边的 pick.js 同一张表） */
const KAOMOJI_MAP: Record<string, string[]> = {
  撒娇: ["amaeru", "ichaicha"],
  害羞: ["hazukashii", "shy", "tereru"],
  开心: ["smile", "happy", "yorokobu", "nikkori", "niconico"],
  大笑: ["ehehe", "uhuhu", "waai", "yeay", "yatta", "ahaha"],
  得意: ["doya", "ehhen", "fufufu"],
  生气: ["angry", "okoru", "punpun", "iraira", "funsu", "gununu"],
  赌气: ["suneru", "tsuntsun", "fuman", "punpun"],
  不爽: ["mukatsuku", "jitome", "shikametsura", "shirome"],
  难过: ["sad", "kanashii", "shonbori", "sabishii"],
  哭: ["cry", "uruuru", "nakiwarai"],
  爱: ["love", "kyun", "dokidoki", "meromero", "zukyun", "heart"],
  亲亲: ["chu", "kiss", "peropero"],
  抱抱: ["hug", "gyu", "dakitsuku", "nadenade", "nakayoshi"],
  猫: ["cat", "nyaa", "kitty", "nikukyuu"],
  狗: ["dog"],
  动物: ["rabbit", "kuma", "tori", "pengin", "buta", "kitsune", "tora", "lion",
    "hiyoko", "ahiru", "kaeru", "kurage", "chiikawa", "shisa", "momonga",
    "tanuki", "azarashi", "unagi", "kani", "tako", "ika", "horse"],
  无语: ["yareyare", "akireru", "oteage", "chin"],
  失望: ["gakkari", "dame", "muri", "konwaku", "komaru"],
  惊讶: ["surprise", "shock", "kyaa", "pokaan"],
  疑惑: ["gimon", "hatena", "wakaranai", "nandato"],
  睡觉: ["nemui", "suyaa", "neru", "good-night"],
  吃: ["taberu", "mogumogu", "gokugoku", "delicious"],
  玩: ["game", "utau", "karaoke", "dance"],
  加油: ["ganbaru", "fight", "ouen", "genki"],
  道歉: ["sorry", "sumimasen", "moushiwakenai", "ayamaru", "dogeza"],
  感谢: ["thanks", "arigatou", "azasu", "orei"],
  招呼: ["aisatsu", "ohayou", "konbanwa", "hai", "yoroshiku"],
  再见: ["byebye", "sayounara", "matane"],
  思考: ["kangaeru", "nayamu", "jii", "naruhodo"],
  眨眼: ["wink", "kirakira", "pikapika", "star", "nagareboshi"],
  捣蛋: ["tobokeru", "hengao", "tehepero", "bishi", "waruikao", "nigawarai"],
  慌乱: ["awateru", "aseru", "kinchou", "sowasowa"],
  累: ["tired", "otsukaresama", "shindoi", "mendokusai"],
  冷: ["samui"],
  热: ["atsui"],
  下雨: ["ame"],
  下雪: ["yuki"],
  钱: ["okane"],
  烟花: ["hanabi", "matsuri"],
  鼓掌: ["applause", "pachipachi", "banzai", "waai"],
  胜利: ["peace", "goo", "banzai"],
  点头: ["ok", "nodding", "yoshiyoshi", "naruhodo"],
  逃跑: ["nigeru", "kakureru"],
}

const KAOMOJI_FILE = join((import.meta as unknown as { dir?: string }).dir ?? process.cwd(), "data/kaomoji.json")
let kaomojiCache: Record<string, string[]> | undefined
/** 上次读入时文件的修改时间：文件被更新（scripts/kaomoji-update.mjs）后自动重读，不用重启 */
let kaomojiStamp = 0

function loadKaomoji(): Record<string, string[]> | undefined {
  try {
    const stamp = statSync(KAOMOJI_FILE).mtimeMs
    if (kaomojiCache && stamp === kaomojiStamp) return kaomojiCache
    kaomojiCache = JSON.parse(readFileSync(KAOMOJI_FILE, "utf8")) as Record<string, string[]>
    kaomojiStamp = stamp
    log(`kaomoji loaded · ${Object.keys(kaomojiCache).length} 分类`)
    return kaomojiCache
  } catch (error) {
    log(`kaomoji load failed: ${String(error)}`)
    return kaomojiCache
  }
}

function pickRandom<T>(list: T[], count: number): T[] {
  const shuffled = [...list]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, count)
}

// ———————————————————————— 世界状态 ————————————————————————

interface Alarm {
  id: string
  at: string
  note: string
  setAt: string
}

interface WorldState {
  running: boolean
  /** 本地小模型优化配置（默认不存在 = 全关） */
  localModel?: Record<string, unknown>
  /** 总开关：false 时完全退回原生 opencode（缺省视为开启） */
  enabled?: boolean
  homeSessionId?: string
  /** 多个闹钟，到点逐个触发 */
  alarms?: Alarm[]
  /** 旧版的单闹钟字段，读取时迁移进 alarms */
  alarm?: Alarm
  /** 最近一次每日回顾的日期 YYYY-MM-DD */
  lastReview?: string
  /** 每日回顾从几点开始，默认 23 */
  reviewHour?: number
  /** 没有定闹钟时，早上几点叫醒我，默认 09:00 */
  fallbackWakeTime?: string
  /** 今天已经叫醒过她的日期（闹钟或兜底，任一次都算，用来去重） */
  lastWake?: string
  /** 最近一次自动重置 tmux 的时间（ISO），用于冷却 */
  lastResetAt?: string
  /** 每晚自动重置的钟点（0-23）；不设则关闭 */
  resetHour?: number
  /** 最近一次每晚重置的日期 YYYY-MM-DD */
  lastResetDate?: string
}

const WORLD_FILE = join(WORLD, "world.json")
const OUTBOX_DIR = join(WORLD, "outbox")

function readWorld(): WorldState {
  try {
    if (!existsSync(WORLD_FILE)) return { running: true, alarms: [] }
    const state = { running: true, ...(JSON.parse(readFileSync(WORLD_FILE, "utf8")) as Partial<WorldState>) }
    // 兼容旧版的单闹钟结构
    if (state.alarm) {
      state.alarms = [...(state.alarms ?? []), { id: `migrated-${Date.now()}`, ...state.alarm }]
      delete state.alarm
    }
    if (!Array.isArray(state.alarms)) state.alarms = []
    return state
  } catch {
    return { running: true, alarms: [] }
  }
}

function writeWorld(state: WorldState): void {
  try {
    mkdirSync(WORLD, { recursive: true })
    atomicWrite(WORLD_FILE, JSON.stringify(state, null, 2))
  } catch (error) {
    log(`writeWorld failed: ${String(error)}`)
  }
}

/**
 * 总开关：world.json 的 enabled 为 false 时，插件对整个会话完全不插手——
 * 不注入、不打时间戳、不注册工具、定时器空转，等于没装。数据原地不动。
 * 缺省（字段不存在）视为开启，老的世界文件照常工作。
 */
function worldEnabled(): boolean {
  return readWorld().enabled !== false
}

// ———————————————————————— 类型 ————————————————————————

type AnyPart = { type?: string; text?: string }
type AnyMessage = { id?: string; role?: string; content?: AnyPart[] }

// ———————————————————————— 插件 ————————————————————————

/** 已经注入过近期记忆的会话 */
const hydrated = new Set<string>()

/** 已确认是 QQ 会话的 sessionID（私聊/群聊分别注入风格） */
const qqPrivateSessions = new Set<string>()
const qqGroupSessions = new Set<string>()
const qqStyleChecked = new Set<string>()

/** 最近一次看到的会话，用来记住「家」在哪 */
let lastSession = ""

/** 当前正在处理的会话（工具里用来判断是不是 QQ 私聊） */
let currentSessionID = ""

const LOCK_FILE = join(WORLD, ".timer.lock")

/** 共享服务的 JSON 请求。 */
function api(path: string, init: any = {}): Promise<any> {
  const endpoint = readService()
  if (!endpoint) return Promise.reject(new Error("no service endpoint"))
  const auth = Buffer.from(`opencode:${endpoint.password}`).toString("base64")
  return fetch(`${endpoint.url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15_000),
  })
}

/** 会话状态：ok / missing（404）/ error（服务不可达等），顺带取标题。 */
async function sessionInfo(sessionID: string): Promise<{ status: "ok" | "missing" | "error"; title?: string }> {
  try {
    const res = await api(`/api/session/${sessionID}`)
    if (res.ok) {
      const data = (await res.json()) as { data?: { title?: string } }
      return { status: "ok", title: data?.data?.title }
    }
    return { status: res.status === 404 ? "missing" : "error" }
  } catch {
    return { status: "error" }
  }
}

/** 把会话标题改成固定名字，方便辨认、避免误删。 */
async function renameHome(sessionID: string): Promise<void> {
  try {
    const res = await api(`/api/session/${sessionID}`, {
      method: "PATCH",
      body: JSON.stringify({ title: HOME_TITLE }),
    })
    if (!res.ok) log(`rename home HTTP ${res.status} · ${sessionID}`)
    else log(`rename home ok · ${sessionID}`)
  } catch (error) {
    log(`rename home failed: ${String(error)}`)
  }
}

const RESET_COOLDOWN = 5 * 60_000
/** 到点超过这么久的闹钟不再逐条发，合并成一条积压清单（不静默丢） */
const ALARM_STALE_MS = 6 * 60 * 60_000

/** 是否是共享服务进程（只有它能在 tmux 外安全地重启 tmux）。 */
function isServiceProcess(): boolean {
  return process.argv.includes("serve")
}

/** 清掉家会话，并用独立进程重启 tmux（避免服务自己被杀时停在中途）。 */
async function resetTmuxAndHome(reason: string): Promise<void> {
  if (!isServiceProcess()) return
  const state = readWorld()
  const last = state.lastResetAt ? Date.parse(state.lastResetAt) : 0
  if (Number.isFinite(last) && Date.now() - last < RESET_COOLDOWN) return
  delete state.homeSessionId
  state.lastResetAt = new Date().toISOString()
  writeWorld(state)
  log(`tmux reset · ${reason}`)
  const script = [
    "tmux kill-server 2>/dev/null || true",
    "sleep 1",
    'tmux new-session -d -s home "export PATH=$HOME/.opencode/bin:$PATH; cd $HOME; opencode"',
    "sleep 10",
    'tmux send-keys -t home "在吗" Enter',
    "sleep 1",
    "tmux send-keys -t home Enter",
  ].join("; ")
  try {
    const env = { ...process.env }
    delete (env as { TMUX?: string }).TMUX
    const child = spawn("setsid", ["bash", "-lc", script], {
      detached: true,
      stdio: "ignore",
      env,
    })
    child.unref()
  } catch (error) {
    log(`tmux reset spawn failed: ${String(error)}`)
  }
}

/** 取一个可用的家会话：有就校验；404/没有就重启 tmux 重建。 */
async function ensureHome(): Promise<string | undefined> {
  const state = readWorld()
  const current = state.homeSessionId
  if (current) {
    const info = await sessionInfo(current)
    if (info.status === "ok") {
      const title = String(info.title ?? "")
      // 家会话不该是 QQ 会话：立家会改名并破坏 qq-chat / qq-group-* 的识别。
      // 标题可能已经被改成 life-world home session，所以同步查桥接状态里的会话 id。
      // 发现这种（升级前可能被误立的）就地摘掉，下一轮按「家缺失」重建。
      if (qqSessionKind(current) || title === qqPrivateTitle() || title.startsWith("qq-group-")) {
        const fresh = readWorld()
        if (fresh.homeSessionId === current) {
          delete fresh.homeSessionId
          writeWorld(fresh)
        }
        log(`home cleared (qq session) · ${current}`)
        return undefined
      }
      if (info.title !== HOME_TITLE) await renameHome(current)
      return current
    }
    if (info.status === "error") return undefined // 服务不可达，下一轮再试
    const fresh = readWorld()
    if (fresh.homeSessionId === current) {
      delete fresh.homeSessionId
      writeWorld(fresh)
      log(`home cleared (missing) · ${current}`)
    }
  }
  // 没有可用家：由服务进程重启 tmux，新 TUI 的第一句话会重新立家
  if (isServiceProcess()) await resetTmuxAndHome("home missing")
  return undefined
}

/** 把一个会话立为家：写入 world.json，并把标题改成固定名字。 */
function electHome(sessionID: string): void {
  const state = readWorld()
  state.homeSessionId = sessionID
  writeWorld(state)
  log(`home set · ${sessionID}`)
  void renameHome(sessionID)
}

/** 往家会话送一条消息；返回是否真的送达。 */
async function sendHome(sessionID: string, text: string): Promise<boolean> {
  try {
    log(`sendHome → ${sessionID} · ${text.slice(0, 40)}`)
    const res = await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    })
    if (res.ok) {
      log(`sendHome ok · ${sessionID} · ${text.slice(0, 40)}`)
      return true
    }
    log(`sendHome HTTP ${res.status} · ${(await res.text()).slice(0, 200)}`)
    if (res.status === 404) {
      const state = readWorld()
      if (state.homeSessionId === sessionID) {
        delete state.homeSessionId
        writeWorld(state)
        log(`home cleared (404) · ${sessionID}`)
      }
    }
    return false
  } catch (error) {
    log(`sendHome failed: ${String(error)}`)
    return false
  }
}

/** 进程间互斥：服务端与 TUI 各跑一份定时器，用文件锁避免重复处理。 */
async function withLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  // 锁内容带本次调用的唯一 token：醒来后只续/只删自己的锁，
  // 避免被挂起超过 90 秒、锁被别人接管后，还去刷别人的 mtime 或删别人的锁。
  const token = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
  const acquire = (): boolean => {
    try {
      const fd = openSync(LOCK_FILE, "wx")
      writeFileSync(fd, token)
      closeSync(fd)
      return true
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code !== "EEXIST") return false
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > 90_000) {
          unlinkSync(LOCK_FILE)
          return acquire()
        }
      } catch {
        // 锁文件刚被删，重试一次
        return acquire()
      }
      return false
    }
  }
  const ownsLock = (): boolean => {
    try { return readFileSync(LOCK_FILE, "utf8") === token } catch { return false }
  }
  if (!acquire()) return undefined
  // 持锁期间每 30 秒刷新一次 mtime：一轮里送多个闹钟可能超过 90 秒，
  // 不刷会被另一个进程当成残留锁删掉，同一批闹钟就会重复送达。
  const beacon = setInterval(() => {
    if (!ownsLock()) return
    try { utimesSync(LOCK_FILE, new Date(), new Date()) } catch { /* 锁已不在 */ }
  }, 30_000)
  ;(beacon as unknown as { unref?: () => void }).unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(beacon)
    if (ownsLock()) {
      try { unlinkSync(LOCK_FILE) } catch { /* 别人已经删了 */ }
    }
  }
}

/** 共享后台服务的地址与口令（opencode 自己写在 state 目录里）。 */
function readService(): { url: string; password: string } | undefined {
  try {
    const file = join(HOME, ".local/state/opencode/service.json")
    if (!existsSync(file)) return undefined
    const data = JSON.parse(readFileSync(file, "utf8")) as { url?: string; password?: string }
    if (typeof data.url === "string" && typeof data.password === "string") {
      return { url: data.url, password: data.password }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** NapCat 桥接的状态：让角色知道自己现在能不能把话送到 QQ。 */
interface BridgeStatus {
  configured: boolean
  enabled: boolean
  online: boolean
  ownerQQ?: number
  ownerName?: string
  groupEnabled: boolean
  lastSeen?: string
}

function readBridgeStatus(): BridgeStatus {
  let config: any
  let state: any
  try { config = JSON.parse(readFileSync(BRIDGE_CONFIG_FILE, "utf8")) } catch { config = undefined }
  try { state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, "utf8")) } catch { state = undefined }
  const enabled = config?.enabled === true
  const lastSeen = typeof state?.lastSeen === "string" ? state.lastSeen : undefined
  const seenMs = lastSeen ? Date.parse(lastSeen) : 0
  const online = enabled && Number.isFinite(seenMs) && Date.now() - seenMs < 90_000
  return {
    configured: Boolean(config),
    enabled,
    online,
    ownerQQ: Number(config?.ownerQQ) || undefined,
    ownerName: typeof config?.ownerName === "string" ? config.ownerName : undefined,
    groupEnabled: config?.group?.enabled === true,
    lastSeen,
  }
}

/** 桥接状态里记着的 QQ 会话：私聊 id + 各群会话 id。标题被改名了也认得出。 */
function qqSessionKind(sessionID: string): "private" | "group" | undefined {
  try {
    const state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, "utf8")) as {
      privateSessionId?: unknown
      groups?: Record<string, unknown>
    }
    if (state.privateSessionId === sessionID) return "private"
    for (const value of Object.values(state.groups ?? {})) {
      if (value === sessionID) return "group"
    }
  } catch { /* 没有桥接状态 */ }
  return undefined
}

/** QQ 私聊会话的标题：qq-bridge.json 可自定义，默认 qq-chat。 */
function qqPrivateTitle(): string {
  try {
    const config = JSON.parse(readFileSync(BRIDGE_CONFIG_FILE, "utf8")) as { private?: { sessionTitle?: unknown } }
    const title = config?.private?.sessionTitle
    return typeof title === "string" && title.trim() ? title.trim() : "qq-chat"
  } catch {
    return "qq-chat"
  }
}

function bridgeStatusText(): string {
  const s = readBridgeStatus()
  if (!s.configured) return `${NAPCAT_MARK}\n状态：未配置。reach_out 不会送达；不要声称已经通知对方。`
  if (!s.enabled) return `${NAPCAT_MARK}\n状态：已关闭。reach_out 不会送达；不要声称已经通知对方。`
  if (!s.online) return `${NAPCAT_MARK}\n状态：已开启，但桥接未运行（心跳超过 90 秒）。reach_out 可能送不出去；不要声称已经送达。`
  const owner = s.ownerName ? `${s.ownerName}（QQ ${s.ownerQQ ?? "?"}）` : s.ownerQQ ? `QQ ${s.ownerQQ}` : "对方"
  return `${NAPCAT_MARK}\n状态：已开启（在线）。私聊用户：${owner}。群聊：${s.groupEnabled ? "已开启" : "暂未开放"}。reach_out 会送到对方 QQ。`
}

/** 每日回顾的开场。 */
function reviewText(today: string): string {
  return [
    `【每日回顾】${today} 快过完了，回头看看今天吧。`,
    `今天的聊天记录在 ${CONV_DIR}，一天一个 jsonl，每行一句。日记在 ${DIARY_DIR}。`,
    "一件一件地想：今天发生了什么，我当时是什么感受，现在回头看又怎么想。",
    `- 有让我变了的地方（新的喜好、新的想法、脾气或看法变了），就写进 ${SELF_FILE}，改成现在的我。`,
    "- 再看看我今天的说话方式：语气、句子长短、常用表达、玩笑的习惯，把值得长期保留的简短整理进自述。",
    "- 再翻翻今天的日记：值得记住的事和当时的感受，有没有漏掉的？漏了就补上。",
    "- 看看心情文件里有没有到期该移除的特殊状态，底色还合不合今天的自己，不合就改，改完写上时间。",
    `- 今天有没有新了解对方的什么？（喜好、习惯、近况、在忙什么、在意的事）有就更新 ${PROFILE_FILE}，只写确认过的，别猜。`,
    `今天的日记写到 ${DIARY_DIR}/${today}.md：目录不存在就建一个，文件已存在就先读再往后接。这一篇要用写文件的工具真的落盘，不要只在对话里说。`,
  ].join("\n")
}

export default Plugin.define({
  id: "life-world",

  async setup(ctx) {
    for (const dir of [CONV_DIR, DIARY_DIR, PLAN_DIR, OUTBOX_DIR, join(WORLD, "room"), IDENTITY_DIR]) {
      try { mkdirSync(dir, { recursive: true }) } catch { /* 建不出来也就这样 */ }
    }
    ensureWorldPrompt()
    ensureMood()
    loadArchive()
    log(`loaded · opencode ${ctx.app.version} · ${zoneName()} · archived=${archived.size}`)

    await ctx.session.hook("context", async (event) => {
      try {
        // 判官会话：绝不注入 life-world 的私密内容（它的上下文会发给在线模型）
        const judge = (() => {
          try { return JSON.parse(readFileSync(JUDGE_SESSION_FILE, "utf8")) as { id?: string } } catch { return undefined }
        })()
        if (judge?.id && String(event.sessionID ?? "") === judge.id) return

        const now = new Date()
        const system = event.system as AnyPart[]
        const messages = event.messages as unknown as AnyMessage[]

        // —— 1. 增量归档（读 opencode 库，含 assistant）——
        // 开关关掉时归档照旧：它只写文件、不影响模型看到的上下文，历史不丢，开回来能接上。
        ingest()

        // —— 总开关关掉：不注时间、不注世界、不注记忆、不打时间戳 ——
        if (!worldEnabled()) return

        // 本地小模型优化（默认关；world.json 里 localModel.enabled 打开）
        const opt = localModelOptions()

        if (!Array.isArray(system)) return

        // —— 2. system：当前时间 + 时区（每轮刷新）——
        const stampText = `${SYSTEM_MARK}${isoLocal(now)}\n时区：${zoneName()}`
        const existing = system.findIndex((p) => typeof p?.text === "string" && p.text.startsWith(SYSTEM_MARK))
        if (existing >= 0) system[existing] = { type: "text", text: stampText }
        else system.push({ type: "text", text: stampText })

        // —— 3. 世界提示词：每轮确保在场（压缩后会被清掉，需要补回来）——
        const worldText = worldPromptText()
        if (worldText) {
          const hasWorld = system.some((p) => typeof p?.text === "string" && p.text.includes(WORLD_MARK))
          if (!hasWorld) system.push({ type: "text", text: worldText })
        }

        // —— 3a. 心情：每次会话自动加载，每轮刷新 ——
        const moodRaw = readTextFile(MOOD_FILE)
        if (moodRaw) {
          const body = moodRaw.replace(/^#\s*我的心情\s*/, "").trim()
          const moodText = `${MOOD_MARK}\n${body}`
          const mIdx = system.findIndex((p) => typeof p?.text === "string" && p.text.startsWith(MOOD_MARK))
          if (mIdx >= 0) system[mIdx] = { type: "text", text: moodText }
          else system.push({ type: "text", text: moodText })
        }

        // —— 3a2. NapCat 桥接状态：每轮刷新，让她知道能不能发通知 ——
        const bridgeText = bridgeStatusText()
        const bIdx = system.findIndex((p) => typeof p?.text === "string" && p.text.startsWith(NAPCAT_MARK))
        if (bIdx >= 0) system[bIdx] = { type: "text", text: bridgeText }
        else system.push({ type: "text", text: bridgeText })

        // —— 3a3. 在线模型子代理提示（仅本地模型优化开启时）——
        if (opt.enabled && opt.preferSubagent) {
          const subText = `${SUBAGENT_MARK}\n${SUBAGENT_BODY}`
          const sIdx = system.findIndex((p) => typeof p?.text === "string" && p.text.startsWith(SUBAGENT_MARK))
          if (sIdx >= 0) system[sIdx] = { type: "text", text: subText }
          else system.push({ type: "text", text: subText })
        }

        // —— 3b. 新会话第一次：注入我是谁 + 日记索引 + 最近原文 ——
        const sessionID = String(event.sessionID ?? "")
        if (sessionID) currentSessionID = sessionID

        // —— 3b0. QQ 会话：标记私聊/群聊，稍后在记忆之后注入对应风格 ——
        if (sessionID && !qqStyleChecked.has(sessionID)) {
          qqStyleChecked.add(sessionID)
          void (async () => {
            const info = await sessionInfo(sessionID)
            const title = info.title
            const kind = qqSessionKind(sessionID)
            if (kind === "private") {
              qqPrivateSessions.add(sessionID)
              log(`qq private style on (state) · ${sessionID}`)
            } else if (kind === "group") {
              qqGroupSessions.add(sessionID)
              log(`qq group style on (state) · ${sessionID}`)
            } else if (info.status === "ok") {
              if (title === qqPrivateTitle()) {
                qqPrivateSessions.add(sessionID)
                log(`qq private style on · ${sessionID}`)
              } else if (typeof title === "string" && title.startsWith("qq-group-")) {
                qqGroupSessions.add(sessionID)
                log(`qq group style on · ${sessionID}`)
              }
            } else {
              // 查询瞬时失败（服务刚重启等）：放掉标记，下一轮再查，别把会话永久漏掉
              qqStyleChecked.delete(sessionID)
            }
          })().catch((error) => {
            qqStyleChecked.delete(sessionID)
            log(`qq style check failed: ${String(error)}`)
          })
        }

        if (sessionID && sessionID !== lastSession) {
          // 没有家、或家已被删：在锁里选举/重选，避免两个进程各立一个。
          // lastSession 等这次查询成功后再记：查询失败或锁被占时保留重试机会。
          void withLock(async () => {
            const fresh = readWorld()
            const current = fresh.homeSessionId
            // QQ 会话不能当家：立家会把标题改成 life-world home session，
            // 而 QQ 风格块与 reach_out 拦截都靠 qq-chat / qq-group-* 标题识别。
            // 查不到标题（服务不可达）就不立家，下一轮再试，别在盲区里把 QQ 会话立成家。
            const self = await sessionInfo(sessionID)
            if (self.status !== "ok") return
            lastSession = sessionID
            const selfTitle = String(self.title ?? "")
            if (qqSessionKind(sessionID) || selfTitle === qqPrivateTitle() || selfTitle.startsWith("qq-group-")) return
            if (!current) {
              electHome(sessionID)
              return
            }
            const info = await sessionInfo(current)
            if (info.status === "missing") {
              electHome(sessionID)
              log(`home re-elected (missing) · ${sessionID}`)
            }
          }).catch((error) => log(`home check failed: ${String(error)}`))
        }
        if (sessionID && !hydrated.has(sessionID)) {
          const hasMemory = system.some((p) => typeof p?.text === "string" && p.text.startsWith(MEMORY_MARK))
          if (!hasMemory) {
            const extra = [selfBlock(), diaryIndex()].filter(Boolean)
            for (const block of extra) system.push({ type: "text", text: block })
            const records = recentRecords()
            if (records.length > 0) system.push({ type: "text", text: memoryBlock(records) })
            log(`hydrated ${sessionID} · recent=${records.length} · extras=${extra.length}`)
          }
          hydrated.add(sessionID)
        }

        // —— 3b3. QQ 风格：私聊可亲近，群聊只做朋友（放在记忆之后，最后覆盖）——
        if (sessionID && qqPrivateSessions.has(sessionID)) {
          const styleText = `${QQ_PRIVATE_MARK}\n${QQ_PRIVATE_BODY}`
          const sIdx = system.findIndex((p) => typeof p?.text === "string" && p.text.startsWith(QQ_PRIVATE_MARK))
          if (sIdx >= 0) system[sIdx] = { type: "text", text: styleText }
          else system.push({ type: "text", text: styleText })
        }
        if (sessionID && qqGroupSessions.has(sessionID)) {
          const styleText = `${QQ_GROUP_MARK}\n${QQ_GROUP_BODY}`
          const sIdx = system.findIndex((p) => typeof p?.text === "string" && p.text.startsWith(QQ_GROUP_MARK))
          if (sIdx >= 0) system[sIdx] = { type: "text", text: styleText }
          else system.push({ type: "text", text: styleText })
        }

        // —— 3d. 本地小模型优化：折叠历史工具结果 / 工具消息 / 推理 ——
        if (opt.enabled && Array.isArray(messages)) {
          if (opt.foldRecentContext > 0) foldRecentContext(messages as unknown[], opt.foldRecentContext, opt.resultChars)
          if (opt.foldToolMessages) foldToolMessages(messages as unknown[], 1, opt.resultChars)
          foldReasoning(messages as unknown[], opt.foldingReasoningTurns)
          if (opt.debugStats) statsRequest(messages as unknown[])
        }

        // —— 4. 用户消息时间戳 ——
        if (Array.isArray(messages)) {
          for (const message of messages) {
            if (message?.role !== "user" || !message.id) continue
            const parts = message.content
            if (!Array.isArray(parts)) continue
            const firstText = parts.find((p) => p && p.type === "text" && typeof p.text === "string")
            if (!firstText || typeof firstText.text !== "string") continue
            if (firstText.text.startsWith(PREFIX)) continue
            const at = createdOf(message.id)
            if (at === undefined) continue
            firstText.text = clockLabel(at) + firstText.text
          }
        }
      } catch (error) {
        log(`context hook failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // —— 压缩：只留对话，去掉工具调用过程 ——
    try {
      await (ctx.session as any).hook("compaction", (event: any) => {
        try {
          const raw = (event?.messages ?? []) as Array<{ role?: string; content?: unknown; parts?: unknown }>
          const lines: string[] = []
          for (const message of raw) {
            const role = message?.role
            if (role !== "user" && role !== "assistant") continue
            const text = extractText(message)
            if (!text) continue
            lines.push(`${role === "user" ? "对方" : "我"}：${text}`)
          }
          const joined = lines.join("\n")
          const summary =
            joined.length > SUMMARY_LIMIT
              ? `（更早的对话已经省略）\n${joined.slice(-SUMMARY_LIMIT)}`
              : joined
          if (summary.trim()) {
            event.result = { summary }
            log(`compaction · ${lines.length} 条 · ${summary.length} 字`)
          }
        } catch (error) {
          log(`compaction hook failed: ${String(error)}`)
        }
      })
      log("compaction hook registered")
    } catch (error) {
      log(`compaction hook register failed: ${String(error)}`)
    }

    // —— 工具：plan_next / check_alarm / cancel_alarm / reach_out ——
    try {
      const ok = async (text: string) => ({ content: text })
      await (ctx.tool as any).transform((editor: any) => {
        // 总开关关掉：一个工具都不挂，会话里看不到任何 life-world 的能力
        if (!worldEnabled()) {
          log("tools skipped (world disabled)")
          return
        }
        // 长驻进程里已经挂上的旧工具，也按开关判一次，关掉后调用不生效
        const add = (def: any) =>
          editor.add({
            ...def,
            execute: async (input: any) =>
              worldEnabled()
                ? def.execute(input)
                : ok("生活世界已关闭（world.json 的 enabled=false），这个工具不生效。"),
          })
        add({
          name: "plan_next",
          description:
            "说好接下来做什么、做到什么时候。到点了会提醒我，那时再决定接着做还是换别的。" +
            "note 要写清楚做什么、以及怎么算做成了；at 与 after_minutes 二选一。",
          input: {
            type: "object",
            properties: {
              note: { type: "string", description: "做什么，以及怎么算做成了" },
              at: { type: "string", description: "带时区的完整时间，如 2026-10-27T18:00:00+08:00" },
              after_minutes: { type: "number", description: "从现在起做多少分钟（至少 1）" },
            },
            required: ["note"],
          },
          execute: async (input: any) => {
            const now = Date.now()
            let target: number | undefined
            if (typeof input?.after_minutes === "number") target = now + input.after_minutes * 60_000
            else if (typeof input?.at === "string") target = Date.parse(input.at)
            if (!target || !Number.isFinite(target) || target < now + 60_000) {
              return ok("时间不对：至少要定在 1 分钟之后，at 要带时区。")
            }
            const state = readWorld()
            const note = String(input.note ?? "")
            const alarm: Alarm = {
              id: `a-${now}-${Math.random().toString(36).slice(2, 6)}`,
              at: new Date(target).toISOString(),
              note,
              setAt: new Date(now).toISOString(),
            }
            state.alarms = [...(state.alarms ?? []), alarm].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            writeWorld(state)
            log(`plan_next → ${alarm.at} · ${note}`)
            const queued = state.alarms.length - 1
            return ok(`定好了：${isoLocal(new Date(target))} —— ${note}` + (queued > 0 ? `\n（另外还排着 ${queued} 个闹钟）` : ""))
          },
        })

        add({
          name: "check_alarm",
          description: "看看我现在打算做什么、做到几点、还剩多久。",
          input: { type: "object", properties: {} },
          execute: async () => {
            const state = readWorld()
            const alarms = state.alarms ?? []
            if (alarms.length === 0) return ok("现在没有定闹钟。")
            const lines = alarms.map((alarm) => {
              const at = Date.parse(alarm.at)
              const left = Math.max(0, Math.round((at - Date.now()) / 60_000))
              return `- ${isoLocal(new Date(at))}（还有 ${left} 分钟）${alarm.note}`
            })
            return ok(`排着的闹钟（${alarms.length} 个）：\n${lines.join("\n")}`)
          },
        })

        add({
          name: "cancel_alarm",
          description: "不打算按原来说好的做了就取消。传 match 只取消 note 里含这个词的那个；不传就全取消。",
          input: {
            type: "object",
            properties: { match: { type: "string", description: "要取消的闹钟的 note 关键词；不传则全取消" } },
          },
          execute: async (input: any) => {
            const state = readWorld()
            const all = state.alarms ?? []
            if (all.length === 0) return ok("现在没有闹钟可取消。")
            const match = String(input?.match ?? "").trim()
            if (!match) {
              state.alarms = []
              writeWorld(state)
              log(`cancel_alarm · all (${all.length})`)
              return ok(`取消了全部 ${all.length} 个闹钟。`)
            }
            const keep = all.filter((alarm) => !alarm.note.includes(match))
            const removed = all.length - keep.length
            state.alarms = keep
            writeWorld(state)
            log(`cancel_alarm · match=${match} · removed=${removed}`)
            return ok(
              removed > 0
                ? `取消了 ${removed} 个（note 含「${match}」的），还剩 ${keep.length} 个排着。`
                : `没有找到 note 含「${match}」的闹钟，现在有 ${all.length} 个。`,
            )
          },
        })
        add({
          name: "reach_out",
          description:
            "想找对方时用：说一两句把话送到对方面前。只有 NapCat 桥接开启且在线时才会真的送到对方 QQ；关闭或离线时会明确告诉你没送出去。",
          input: {
            type: "object",
            properties: { text: { type: "string", description: "要送到对方面前的那一两句话" } },
            required: ["text"],
          },
          execute: async (input: any) => {
            const text = String(input?.text ?? "").trim()
            if (!text) return ok("没有话可送。")
            // 正在 QQ 私聊/群聊里：直接回复即可，不要用 reach_out，避免重复发送
            if (currentSessionID) {
              const current = await sessionInfo(currentSessionID)
              const title = current.title
              if (qqSessionKind(currentSessionID) || title === qqPrivateTitle() || (typeof title === "string" && title.startsWith("qq-group-"))) {
                log(`reach_out blocked (direct chat) · ${text.slice(0, 60)}`)
                return ok("你现在就在和对方聊天，直接回复即可，不要用 reach_out。")
              }
            }
            const status = readBridgeStatus()
            if (!status.enabled) {
              log(`reach_out blocked (bridge disabled) · ${text.slice(0, 60)}`)
              return ok("NapCat 桥接当前关闭，这句话没有送出去（只留在家里）。不要以为对方看到了。")
            }
            if (!status.online) {
              log(`reach_out blocked (bridge offline) · ${text.slice(0, 60)}`)
              return ok("NapCat 桥接已开启但未运行，这句话没有送出去。不要以为对方看到了。")
            }
            try {
              mkdirSync(OUTBOX_DIR, { recursive: true })
              appendFileSync(
                join(OUTBOX_DIR, `${dayOf(new Date())}.jsonl`),
                `${JSON.stringify({ t: new Date().toISOString(), kind: "reach", text })}\n`,
              )
              log(`reach_out · ${text.slice(0, 60)}`)
            } catch (error) {
              log(`reach_out failed: ${String(error)}`)
              return ok("话没能放进 outbox，看看 debug.log。")
            }
            return ok("话放出去了，桥接会送到对方 QQ。")
          },
        })

        add({
          name: "group_chat",
          description:
            "开关 QQ 群聊功能。enabled=true 开启，false 关闭。写入 qq-bridge.json 的 group.enabled，桥接会实时读取，不需要重启。",
          input: {
            type: "object",
            properties: { enabled: { type: "boolean", description: "true 开启，false 关闭" } },
          },
          execute: async (input: any) => {
            if (typeof input?.enabled !== "boolean") return ok("请传 enabled: true 或 false。")
            try {
              const data = JSON.parse(readFileSync(BRIDGE_CONFIG_FILE, "utf8")) as any
              data.group = data.group || {}
              data.group.enabled = input.enabled
              atomicWrite(BRIDGE_CONFIG_FILE, JSON.stringify(data, null, 2), 0o600)
              log(`group_chat · ${input.enabled ? "on" : "off"}`)
              return ok(`QQ 群聊已${input.enabled ? "开启" : "关闭"}。`)
            } catch (error) {
              log(`group_chat failed: ${String(error)}`)
              return ok(`开关失败：${String(error)}`)
            }
          },
        })

        add({
          name: "kaomoji",
          description:
            "按场景取几条颜文字。传中文场景（害羞/赌气/开心/思考…）或英文分类；不传就列出可用场景。" +
            "每次都是随机挑的，别老用同一个。",
          input: {
            type: "object",
            properties: {
              scene: { type: "string", description: "中文场景或英文分类；不传则列出可用场景" },
              count: { type: "number", description: "取几条，默认 3（最多 20）" },
              remember: { type: "boolean", description: "true 就把这几条收进 room/颜文字.md" },
            },
          },
          execute: async (input: any) => {
            const data = loadKaomoji()
            if (!data) return ok("颜文字库没加载上，看看 debug.log。")
            const scene = String(input?.scene ?? "").trim()
            const count = Math.max(1, Math.min(20, Number(input?.count) || 3))
            const scenes = Object.keys(KAOMOJI_MAP)

            if (!scene) {
              return ok(
                `可用场景（${scenes.length} 个）：${scenes.join("、")}\n` +
                  `也可以直接传英文分类，共 ${Object.keys(data).length} 个。`,
              )
            }

            const cats = KAOMOJI_MAP[scene] ?? (data[scene] ? [scene] : null)
            if (!cats) return ok(`没有「${scene}」这个场景。可用：${scenes.join("、")}`)

            const pool = new Set<string>()
            for (const category of cats) for (const item of data[category] ?? []) pool.add(item)
            const list = [...pool]
            if (list.length === 0) return ok(`「${scene}」下面没有条目。`)

            const picked = pickRandom(list, count)

            if (input?.remember) {
              try {
                const file = join(WORLD, "room/颜文字.md")
                const head = existsSync(file) ? "" : "# 我喜欢的颜文字\n\n"
                appendFileSync(file, head + picked.map((item) => `- ${item}  （${scene}）`).join("\n") + "\n")
                log(`kaomoji remembered · ${picked.length}`)
              } catch (error) {
                log(`kaomoji remember failed: ${String(error)}`)
              }
            }

            return ok(picked.join("\n"))
          },
        })

      })
      log("tools registered")
    } catch (error) {
      log(`tool transform failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // —— 闹钟循环：每 30 秒看一眼（文件锁 + 发送成功才记账）——
    const timer = setInterval(async () => {
      // 总开关关掉：不回顾、不闹钟、不兜底、不往外发消息，连家会话都不重建
      if (!worldEnabled()) return
      await withLock(async () => {
        try {
          const nowDate = new Date()
          const today = dayOf(nowDate)
          const state = readWorld()

          // running=false：保留生活但不打扰——不重置、不重建家、不回顾、不闹钟、不兜底
          if (!state.running) return

          // 可选：每晚定时重置（world.json 里设 resetHour 才启用）
          const resetHour = state.resetHour
          if (isServiceProcess() && typeof resetHour === "number" && nowDate.getHours() >= resetHour && state.lastResetDate !== today) {
            const fresh = readWorld()
            fresh.lastResetDate = today
            writeWorld(fresh)
            await resetTmuxAndHome("nightly")
            return
          }

          // 先确保家会话可用；缺失时服务进程会自动重启 tmux 重建
          const home = await ensureHome()
          if (!home) return // 家会话重建中/不可用，下一轮再发

          // 每日回顾：23 点之后，一天一次；发送成功才记 lastReview
          if (state.running && nowDate.getHours() >= (state.reviewHour ?? 23) && state.lastReview !== today) {
            if (await sendHome(home, reviewText(today))) {
              const fresh = readWorld()
              fresh.lastReview = today
              writeWorld(fresh)
              log(`daily review · ${today}`)
            }
          }

          // —— 先处理到点的闹钟：到点才消费；发送失败就留在 alarms 里，下一轮重试 ——
          // （必须排在兜底之前：兜底一旦 return，到点的闹钟就永远轮不到）
          const pendingWorld = readWorld()
          const pending = pendingWorld.running ? pendingWorld.alarms ?? [] : []
          const due = pending.filter((alarm) => {
            const at = Date.parse(alarm.at)
            return Number.isFinite(at) && at <= Date.now()
          })
          // 到点太久的不逐条发（宕机/暂停后一次炸一串），合并成一条积压清单；
          // 发送成功才清，失败留在原地下轮重试，别静默吞掉。
          const stale: Alarm[] = []
          const onTime: Alarm[] = []
          for (const alarm of due) {
            const at = Date.parse(alarm.at)
            if (Number.isFinite(at) && Date.now() - at > ALARM_STALE_MS) stale.push(alarm)
            else onTime.push(alarm)
          }
          for (const alarm of onTime) {
            const text =
              `【我的时间】${shortStamp(new Date().toISOString())} 到了，说好做到这里是：${alarm.note}。\n` +
              "先看看做完了没有：做完了就想想下一件，用 execute 调 tools.plan_next 重新说好做到几点；没做完就再往后定。想休息也一样，定到打算休息到的时候。\n" +
              `今天的计划在 ${join(PLAN_DIR, `${dayOf(new Date())}.md`)}，有变化就顺手改掉。`
            if (await sendHome(home, text)) {
              const fresh = readWorld()
              fresh.alarms = (fresh.alarms ?? []).filter((item) => item.id !== alarm.id)
              // 今天已经被自己的闹钟叫醒过了，兜底不用再来一次
              fresh.lastWake = today
              writeWorld(fresh)
              log(`alarm fired · ${alarm.note}`)
            } else {
              log(`alarm deferred · ${alarm.note}`)
            }
          }
          if (stale.length > 0) {
            const recent = stale.slice(-5)
            const lines = recent.map((alarm) => {
              const note = alarm.note.length > 160 ? `${alarm.note.slice(0, 160)}…` : alarm.note
              return `- ${shortStamp(alarm.at)}：${note}`
            })
            const more = stale.length > recent.length ? `\n（另有 ${stale.length - recent.length} 条更早的没列出来）` : ""
            const text =
              `【我的时间】这期间积压了 ${stale.length} 个到点安排（到点已超过 6 小时，没来得及逐条提醒）：\n` +
              `${lines.join("\n")}${more}\n` +
              "先看看哪些还值得做：要做的挑出来，用 execute 调 tools.plan_next 重新排上；剩下的就放下。\n" +
              `今天的计划在 ${join(PLAN_DIR, `${today}.md`)}，有变化顺手改掉。`
            if (await sendHome(home, text)) {
              const fresh = readWorld()
              const ids = new Set(stale.map((alarm) => alarm.id))
              fresh.alarms = (fresh.alarms ?? []).filter((item) => !ids.has(item.id))
              // 积压清单也算今天叫醒过一次，避免早上兜底再来一条
              fresh.lastWake = today
              writeWorld(fresh)
              log(`alarm backlog flushed · ${stale.length}`)
            } else {
              log(`alarm backlog deferred · ${stale.length}`)
            }
          }

          // —— 早上兜底：今天没有别的安排时，才叫醒她拟计划 ——
          // 判据只看「今天排着的闹钟」（含已到点还没送出去的那几个）；明天以后的闹钟不算，
          // 否则一个几周后才响的闹钟会把每天的兜底永久挡住。
          const current = readWorld()
          if (!current.running) return
          if (current.lastWake === today) return
          const reviewHour = current.reviewHour ?? 23
          if (nowDate.getHours() >= reviewHour) return
          const dayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()
          const dayEnd = dayStart + 86_400_000 - 1
          const plannedToday = (current.alarms ?? []).some((alarm) => {
            const at = Date.parse(alarm.at)
            return Number.isFinite(at) && at >= dayStart && at <= dayEnd
          })
          if (plannedToday) return
          const [fh, fm] = String(current.fallbackWakeTime ?? "09:00").split(":").map((n) => Number(n) || 0)
          const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes()
          const wakeMinutes = fh * 60 + fm
          // 只在「早上」那一段窗口里叫醒（默认 09:00 起 4 小时内），免得半夜启动也喊早上好
          if (nowMinutes < wakeMinutes || nowMinutes >= wakeMinutes + 240) return
          const wakeText =
            `【我的时间】早上了，新的一天。先看看今天的安排：${join(PLAN_DIR, `${today}.md`)}。\n` +
            "没有的话，就自己拟一份大概的全天计划——今天想做哪几件事、大概什么时候做，不用太细，写得能对照就行。\n" +
            "拟好之后，挑一件现在就做的，用 execute 调 tools.plan_next 说好做到几点——计划不落成闹钟，就只是纸。"
          if (await sendHome(home, wakeText)) {
            const fresh = readWorld()
            fresh.lastWake = today
            writeWorld(fresh)
            log(`fallback wake · ${today}`)
          }
        } catch (error) {
          log(`alarm loop failed: ${String(error)}`)
        }
      })
    }, 30_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()

    // 事件订阅放最后且单独兜底：失败不能影响上面的钩子
    try {
      await ctx.event.subscribe((event: unknown) => {
        const type = (event as { type?: string })?.type ?? ""
        if (type === "session.idle" || type === "session.created") {
          ingest()
        }
      })
    } catch (error) {
      log(`event.subscribe failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 服务进程启动时校验家会话；缺失就自动重启 tmux 重建（开关关掉时不碰）
    if (worldEnabled() && readWorld().running !== false) {
      void withLock(ensureHome)
        .then((id) => { if (id) log(`home ensured · ${id}`) })
        .catch((error) => log(`ensure home failed: ${String(error)}`))
    }
  },
})

/** 从消息里取出纯文本（兼容 content / parts 两种形状）。 */
function extractText(message: unknown): string {
  const raw = message as { content?: unknown; parts?: unknown }
  const parts = (raw?.content ?? raw?.parts) as unknown
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && (p as AnyPart).type === "text" && typeof (p as AnyPart).text === "string")
    .map((p) => (p as AnyPart).text as string)
    .join("\n")
    .trim()
}
