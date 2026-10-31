#!/usr/bin/env node
// 读 Chrome 浏览历史：先复制一份再查，避免被运行中的 Chrome 锁住
import { DatabaseSync } from "node:sqlite"
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
// 位置参数：第一个参数是纯数字就当条数，其余全当关键词。
// 否则「2024」这种数字关键词会被误当成条数。
let limit = 20
let query = ""
// 第一个参数是纯数字且不超过 200 才当条数；「2024」这种年份关键词仍按关键词查
if (args.length > 0 && /^\d+$/.test(args[0]) && Number(args[0]) <= 200) {
  limit = Math.max(1, Number(args[0]) || 20)
  query = args.slice(1).join(" ").trim()
} else {
  query = args.join(" ").trim()
}

const src = join(homedir(), ".config/google-chrome-agent/Default/History")
if (!existsSync(src)) {
  console.error("这台机器上没有 Chrome 历史记录。")
  process.exit(1)
}

// 每次跑用独立临时目录：并发运行不会互相覆盖，残留的 -wal 也不会串到下一次
const dir = mkdtempSync(join(tmpdir(), "lw-history-"))
const dst = join(dir, "History")
try {
  copyFileSync(src, dst)
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(src + suffix)) copyFileSync(src + suffix, dst + suffix)
  }
} catch (error) {
  // 复制失败也要清掉刚建的临时目录，别留一堆 /tmp/lw-history-*
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  console.error(`复制浏览历史失败：${String(error)}`)
  process.exit(1)
}

const pad = (n) => String(n).padStart(2, "0")
const stamp = (ms) => {
  if (!ms) return "?"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "?"
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

let db
try {
  db = new DatabaseSync(dst, { readOnly: true })
  const base = "select url, title, visit_count, (last_visit_time / 1000 - 11644473600000) as ts from urls"
  const rows = query
    ? db.prepare(`${base} where url like ? or title like ? order by last_visit_time desc limit ?`).all(`%${query}%`, `%${query}%`, limit)
    : db.prepare(`${base} order by last_visit_time desc limit ?`).all(limit)
  const total = db.prepare("select count(*) as n from urls").get().n
  console.log(`共 ${total} 条记录${query ? `，含「${query}」的 ${rows.length} 条` : `，最近 ${rows.length} 条`}：\n`)
  for (const r of rows) {
    console.log(`${stamp(r.ts)}  ${r.title || "(无标题)"}`)
    console.log(`    ${r.url}`)
  }
} finally {
  try { db?.close() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
