#!/usr/bin/env node
/**
 * life-world · 颜文字库更新
 *
 * 从 npm 拉最新的 kaomoji-collection，过滤后重写成插件用的 data/kaomoji.json。
 *
 * 零依赖：只用 Node 内置的 fetch / zlib / fs —— 不需要 npm、不需要 npx、不需要装任何包。
 * （npm 包就是个 tar.gz，这里自己解。）
 *
 * 用法：
 *   node kaomoji-update.mjs            # 有新版才更新
 *   node kaomoji-update.mjs --check    # 只看有没有新版，不写文件
 *   node kaomoji-update.mjs --force    # 版本没变也重新生成一遍
 *   node kaomoji-update.mjs --registry https://registry.npmmirror.com   # 换镜像源
 *
 * 数据：上游 kaomoji-collection（MIT，来自 kaomojiya.org）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

const PKG = "kaomoji-collection"
const HOME = homedir()
const DATA_DIR = join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "opencode/plugins/life-world/data")
const DATA_FILE = join(DATA_DIR, "kaomoji.json")
const META_FILE = join(DATA_DIR, "kaomoji.meta.json")

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const REGISTRY = String(opt("--registry", "https://registry.npmjs.org")).replace(/\/+$/, "")
const CHECK_ONLY = flag("--check")
const FORCE = flag("--force")

const say = (...a) => console.log(...a)

// ———————— 与 pick.js / 插件一致的口径 ————————
const unesc = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
   .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
const hasKana = (s) => /[぀-ゟ゠-ヿｦ-ﾟ]/.test(s)
const usable = (s) => {
  const u = unesc(String(s)).trim()
  return u && !hasKana(u) && u.length <= 40 ? u : null
}

function filter(raw) {
  const out = {}
  for (const [category, list] of Object.entries(raw || {})) {
    if (!Array.isArray(list)) continue
    const seen = new Set()
    const keep = []
    for (const item of list) {
      const u = usable(item)
      if (!u || seen.has(u)) continue
      seen.add(u)
      keep.push(u)
    }
    if (keep.length) out[category] = keep
  }
  return out
}

// ———————— 最小 tar 解包（只取一个文件） ————————
function extractFromTar(buf, want) {
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "")
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim()
    const size = parseInt(sizeField || "0", 8) || 0
    const type = header[156]
    const dataStart = off + 512
    const isFile = type === 0 || type === 0x30
    if (isFile && (name === want || name.endsWith("/" + want.split("/").pop()))) {
      return buf.subarray(dataStart, dataStart + size)
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

function readMeta() {
  try { return JSON.parse(readFileSync(META_FILE, "utf8")) } catch { return undefined }
}
function localCount() {
  try {
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8"))
    return { categories: Object.keys(data).length, entries: Object.values(data).reduce((n, v) => n + v.length, 0) }
  } catch { return undefined }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`)
  return res.json()
}

async function main() {
  say(`源：${REGISTRY}/${PKG}`)
  const meta = readMeta()
  const before = localCount()
  if (before) say(`本地：${meta?.version ?? "未知版本"} · ${before.categories} 分类 · ${before.entries} 条`)

  const latest = await fetchJson(`${REGISTRY}/${PKG}/latest`)
  const version = String(latest.version || "")
  if (!version) throw new Error("拿不到版本号")
  say(`npm ：${version}`)

  if (!FORCE && meta?.version === version) {
    say("已是最新版，不用更新。（想强制重建加 --force）")
    return
  }
  if (CHECK_ONLY) {
    say(`有新版：${meta?.version ?? "未知"} → ${version}（去掉 --check 才会真的写）`)
    return
  }

  const tarball = latest.dist?.tarball
  if (!tarball) throw new Error("registry 没给 tarball 地址")
  say(`下载：${tarball}`)
  const res = await fetch(tarball, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const gz = Buffer.from(await res.arrayBuffer())
  const tar = gunzipSync(gz)
  const file = extractFromTar(tar, "package/kaomoji.json")
  if (!file) throw new Error("tar 里没找到 package/kaomoji.json")

  const filtered = filter(JSON.parse(file.toString("utf8")))
  const categories = Object.keys(filtered).length
  const entries = Object.values(filtered).reduce((n, v) => n + v.length, 0)
  if (!categories || !entries) throw new Error("过滤后是空的，先别写")

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DATA_FILE + ".tmp"
  writeFileSync(tmp, JSON.stringify(filtered))
  renameSync(tmp, DATA_FILE)
  writeFileSync(META_FILE + ".tmp", JSON.stringify({
    package: PKG,
    version,
    source: tarball,
    license: "MIT (kaomojiya.org)",
    updated: new Date().toISOString(),
    categories,
    entries,
    filter: "去假名 / 解码 HTML 实体 / 长度≤40 / 分类内去重",
  }, null, 2))
  renameSync(META_FILE + ".tmp", META_FILE)

  say(`写入：${DATA_FILE}（${(statSync(DATA_FILE).size / 1024).toFixed(0)} KB）`)
  say(`结果：${categories} 分类 · ${entries} 条` + (before ? `（原 ${before.categories} / ${before.entries}）` : ""))
  say("插件在下一轮读文件时自动生效（会比对文件修改时间），不用重启。")
}

main().catch((error) => {
  console.error("更新失败：" + (error?.message || error))
  process.exit(1)
})
