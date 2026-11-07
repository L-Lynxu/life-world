#!/usr/bin/env node
/**
 * life-world · pi home session (RPC 常驻，跑定时器)
 *
 * 用途：测试/部署时给「家会话」一个不带 TUI 的常驻进程。
 * 扩展在 LIFE_WORLD_ROLE=home 下每 30 秒检查闹钟/回顾/兜底，并通过
 * pi.sendMessage(triggerTurn) 唤醒自己；这里把 assistant 文本打到日志。
 *
 * 用法：
 *   TZ=Asia/Shanghai node home-rpc.mjs
 *   TEST_MS=90000 node home-rpc.mjs    # 测试时自动退出
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const LOG = join(ROOT, "home-rpc.log")
const HERE = dirname(fileURLToPath(import.meta.url))
const PI = process.env.PI_BIN || "pi"
const EXT = process.env.LIFE_WORLD_EXT || join(HERE, "../ext/life-world.ts")
const MODEL = process.env.LIFE_WORLD_MODEL || "deepseek-flash"
const TZ = process.env.TZ || "Asia/Shanghai"
const SESSION_DIR = join(ROOT, "pi-sessions")
mkdirSync(SESSION_DIR, { recursive: true })

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`
  try { appendFileSync(LOG, line + "\n", { mode: 0o600 }) } catch { /* ignore */ }
  if (process.stdout.isTTY) console.log(line)
}

const args = ["--mode", "rpc", "--model", MODEL, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions", "-e", EXT, "--session-dir", SESSION_DIR, "--name", "home"]
const child = spawn(PI, args, {
  env: { ...process.env, TZ, LIFE_WORLD_ROOT: ROOT, LIFE_WORLD_ROLE: "home", LIFE_WORLD_CHANNEL: "cli" },
  stdio: ["pipe", "pipe", "pipe"],
})
log("home rpc start", child.pid)
let buf = ""
child.stdout.on("data", (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "")
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === "message_end" && msg.message?.role === "assistant") {
      const text = (msg.message.content || []).filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim()
      if (text) log("assistant", text.slice(0, 300))
    } else if (msg.type === "agent_settled") {
      log("agent settled")
    }
  }
})
child.stderr.on("data", (d) => log("stderr", String(d).slice(0, 300)))
child.on("exit", (code) => { log("home rpc exit", code); process.exit(code || 0) })
process.on("exit", () => { try { child.kill("SIGTERM") } catch { /* ignore */ } })
if (process.env.TEST_MS) setTimeout(() => { log("test done"); process.exit(0) }, Number(process.env.TEST_MS))
