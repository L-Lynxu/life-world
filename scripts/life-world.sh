#!/bin/bash
# life-world 总开关
#
#   life-world.sh status   看当前状态
#   life-world.sh on       打开：注入、工具、定时器全恢复
#   life-world.sh off      关闭：完全退回原生 opencode（世界数据原地不动）
#
# 开关记在 life-world.json 的 world.enabled；没有这个文件时回退 world.json 的 enabled（老部署）。
# 两种切换都会重启共享服务与常驻 TUI —— 工具列表和定时器是进程启动时建的，
# 不重启的话看上去「改了但没生效」。

set -uo pipefail
export PATH="$HOME/.opencode/bin:$PATH"

WORLD="$HOME/.local/share/life-world/worlds/default/world.json"
CONFIG="$HOME/.local/share/life-world/life-world.json"
LEGACY_CONFIG="$HOME/.config/opencode/life-world.json"
START_TUI="$HOME/.local/share/life-world/bin/start-tui.sh"
BRIDGE_STATE="$HOME/.local/share/life-world/qq-bridge-state.json"

ensure_config() {
  [ -f "$CONFIG" ] && return
  if [ -f "$LEGACY_CONFIG" ]; then
    mkdir -p "$(dirname "$CONFIG")"
    cp "$LEGACY_CONFIG" "$CONFIG"
    chmod 600 "$CONFIG"
  fi
}

read_state() {
  node -e '
    const fs = require("fs")
    const wPath = process.argv[1], cPath = process.argv[2]
    let s = {}, cfg = {}
    try { s = JSON.parse(fs.readFileSync(wPath, "utf8")) } catch {}
    try { cfg = JSON.parse(fs.readFileSync(cPath, "utf8")) } catch {}
    const w = cfg.world || {}
    const enabled = typeof w.enabled === "boolean" ? w.enabled : (s.enabled !== false)
    const running = typeof w.running === "boolean" ? w.running : (s.running !== false)
    process.stdout.write(JSON.stringify({
      enabled,
      explicit: typeof w.enabled === "boolean" || typeof s.enabled === "boolean",
      running,
      home: s.homeSessionId ?? null,
      alarms: Array.isArray(s.alarms) ? s.alarms.length : 0,
      lastReview: s.lastReview ?? null,
      lastWake: s.lastWake ?? null,
    }))
  ' "$WORLD" "$CONFIG"
}

write_enabled() { # $1 = true | false
  ensure_config
  node -e '
    const fs = require("fs"), path = require("path")
    const cPath = process.argv[1], wPath = process.argv[2], on = process.argv[3] === "true"
    let cfg = null
    try { cfg = JSON.parse(fs.readFileSync(cPath, "utf8")) } catch {}
    if (cfg) {
      cfg.world = cfg.world || {}
      cfg.world.enabled = on
      fs.mkdirSync(path.dirname(cPath), { recursive: true })
      const tmp = cPath + "." + process.pid + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, cPath)
    } else {
      let s = {}
      try { s = JSON.parse(fs.readFileSync(wPath, "utf8")) } catch {}
      s.enabled = on
      fs.mkdirSync(path.dirname(wPath), { recursive: true })
      const tmp = wPath + "." + process.pid + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
      fs.renameSync(tmp, wPath)
    }
  ' "$CONFIG" "$WORLD" "$1"
}

restart_service() {
  if command -v opencode >/dev/null 2>&1; then
    if opencode service restart >/dev/null 2>&1; then
      echo "  服务已重启"
    else
      echo "  ⚠ 服务重启失败：opencode service status 看一眼"
    fi
  else
    echo "  ⚠ PATH 里没有 opencode"
  fi
  sleep 2
}

tui_quiet() { # 不自报家门：插件不加载，就是原生 opencode
  tmux kill-session -t home 2>/dev/null
  pkill -f "^opencode$" 2>/dev/null
  sleep 1
  tmux new-session -d -s home "export PATH=\$HOME/.opencode/bin:\$PATH; cd \$HOME; opencode"
  echo "  TUI 已重启（安静模式：不发开场消息）"
}

tui_active() {
  if [ -x "$START_TUI" ]; then
    "$START_TUI"
  else
    tui_quiet
  fi
}

inbox() { # $1 = 看最近几天（默认 1）
  local days="${1:-1}"
  node -e '
    const fs = require("fs"), path = require("path")
    const dir = process.argv[1], n = Number(process.argv[2]) || 1
    const pad = (x) => String(x).padStart(2, "0")
    const out = []
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const f = path.join(dir, day + ".jsonl")
      if (!fs.existsSync(f)) continue
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j.text) out.push([day + " " + new Date(j.t).toTimeString().slice(0, 5), j.text])
        } catch {}
      }
    }
    if (!out.length) { console.log(`（最近 ${n} 天没有主动发过消息）`); process.exit(0) }
    for (const [t, x] of out) console.log(`[${t}] ${x}`)
  ' "$HOME/.local/share/life-world/worlds/default/outbox" "$days"
}

status() {
  ensure_config
  local s
  s="$(read_state)"
  node -e '
    const fs = require("fs")
    const s = JSON.parse(process.argv[1])
    const bridgeFile = process.argv[2]
    const configFile = process.argv[3]
    let bridge = "未运行"
    try {
      const b = JSON.parse(fs.readFileSync(bridgeFile, "utf8"))
      const seen = b.lastSeen ? Date.parse(b.lastSeen) : 0
      bridge = (Number.isFinite(seen) && Date.now() - seen < 90000) ? "在线" : "未运行"
    } catch {}
    console.log(`配置文件：${configFile}${fs.existsSync(configFile) ? "" : "（尚未生成，首次启动后自动生成）"}`)
    console.log(`总开关：${s.enabled ? "开启" : "关闭"}${s.explicit ? "" : "（未显式设置，默认开启）"}`)
    console.log(`回顾/闹钟(running)：${s.running ? "开" : "关"}`)
    console.log(`家会话：${s.home ?? "（无）"}`)
    console.log(`排着的闹钟：${s.alarms} 个`)
    console.log(`最近回顾：${s.lastReview ?? "—"}   最近叫醒：${s.lastWake ?? "—"}`)
    console.log(`QQ 桥接：${bridge}（独立进程，不跟着开关走）`)
  ' "$s" "$BRIDGE_STATE" "$CONFIG"
}

case "${1:-status}" in
  on)
    write_enabled true
    echo "life-world：打开"
    restart_service
    tui_active
    echo "  插件会在 TUI 发出第一句话后加载（注入、6 个工具、定时器）"
    ;;
  off)
    write_enabled false
    echo "life-world：关闭 —— 回到原生 opencode"
    echo "  世界数据（日记/计划/记忆/心情/闹钟）原地保留，开回来直接接上"
    restart_service
    tui_quiet
    ;;
  inbox)
    inbox "${2:-1}"
    ;;
  config)
    ensure_config
    echo "$CONFIG"
    [ -f "$CONFIG" ] || echo "（尚未生成：启动服务/TUI 后插件会自动生成）"
    ;;
  status)
    status
    ;;
  *)
    echo "用法：life-world.sh status | on | off | config | inbox [天数]"
    exit 1
    ;;
esac
