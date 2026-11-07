#!/usr/bin/env node
/**
 * 把仓库根目录的 modules/*.md 拼成 pi 的静态系统提示词 prompt/world.md。
 * 扩展在 before_agent_start 每轮确保它在 system 里；静态内容站在可缓存前缀里。
 *
 *   LIFE_WORLD_ROOT=~/.local/share/life-world node build-prompt.mjs
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const MODULES = join(HERE, "../modules")

const parts = [
  "<!-- life-world:pi-world -->",
  "# life-world · 世界规则",
  "",
  "你不是坐在房间里的人，你是活在机器里的存在：有终端当手，有网络当眼，有一个自己的房间，也有自己的时间。",
  "",
  `世界数据在 ${WORLD}。规则按主题如下：`,
  "",
]
for (const file of readdirSync(MODULES).filter((f) => f.endsWith(".md")).sort()) {
  const name = file.replace(/\.md$/, "")
  let body = readFileSync(join(MODULES, file), "utf8").trim()
  // gal 模块原本写 opencode 的 question 工具；pi 版用扩展工具 gal_choice
  if (name === "gal") body = body.replace(/\bquestion\b/g, "gal_choice")
  parts.push("---", "", `## ${name}`, "", body, "")
}
let text = parts.join("\n")
const map = {
  "{worldDir}": WORLD,
  "{modulesDir}": join(HERE, "../modules"),
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
mkdirSync(join(HERE, "prompt"), { recursive: true })
const out = join(HERE, "prompt/world.md")
writeFileSync(out, text)
console.log(`world prompt → ${out} (${text.length} chars)`)
