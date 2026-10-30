#!/usr/bin/env node
// 读 Chrome 浏览历史：先复制一份再查，避免被运行中的 Chrome 锁住
import { DatabaseSync } from "node:sqlite"
import { copyFileSync, existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const limit = Math.max(1, Math.min(200, Number(args.find((a) => /^\d+$/.test(a))) || 20))
const query = args.find((a) => !/^\d+$/.test(a)) || ""
const src = join(homedir(), ".config/google-chrome-agent/Default/History")
const dst = "/tmp/.chrome-history-copy.db"

if (!existsSync(src)) {
  console.error("这台机器上没有 Chrome 历史记录。")
  process.exit(1)
}

copyFileSync(src, dst)
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(src + suffix)) copyFileSync(src + suffix, dst + suffix)
}

const pad = (n) => String(n).padStart(2, "0")
const stamp = (ms) => {
  if (!ms) return "?"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "?"
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const db = new DatabaseSync(dst, { readOnly: true })
try {
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
  db.close()
  try { rmSync(dst, { force: true }) } catch {}
}
