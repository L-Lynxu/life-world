#!/bin/bash
# life-world 一键安装
#
#   ./install.sh            装插件本体 + 配套脚本（不碰已有的世界数据）
#   ./install.sh --service  装完顺手重启共享服务并拉起常驻 TUI
#
# 给 AI 代理用：把本仓库 clone 下来，直接跑 ./install.sh 即可。
# 只要 opencode / node 22.13+ / tmux 都在 PATH 里，没有任何别的依赖。

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins/life-world"
WORLD_BIN="$HOME/.local/share/life-world/bin"

echo "== 检查依赖 =="
# opencode 默认装在 ~/.opencode/bin，非登录 shell 里常常不在 PATH
if ! command -v opencode >/dev/null 2>&1 && [ -x "$HOME/.opencode/bin/opencode" ]; then
  export PATH="$HOME/.opencode/bin:$PATH"
fi
missing=0
command -v opencode >/dev/null 2>&1 || { echo "  ✗ 找不到 opencode（先把它加进 PATH）"; missing=1; }
command -v node >/dev/null 2>&1 || { echo "  ✗ 找不到 node（需要 22.13 以上）"; missing=1; }
command -v tmux >/dev/null 2>&1 || { echo "  ✗ 找不到 tmux（常驻 TUI 要用）"; missing=1; }
if [ "$missing" != "0" ]; then
  echo
  echo "依赖不齐，装好再来一遍。"
  exit 1
fi
# 插件用 node:sqlite（22.13 起免 flag），桥接用全局 WebSocket（22 起）。
# Node 20 装完会「看起来成功」，但插件 import 直接失败。
if ! node -e '
  const [a, b] = process.versions.node.split(".").map(Number)
  const ok = a > 23 || (a === 23 && b >= 4) || (a === 22 && b >= 13)
  process.exit(ok ? 0 : 1)
'; then
  echo "  ✗ node 版本太低：$(node -v)，需要 22.13+（推荐 24 LTS）"
  exit 1
fi
echo "  ✓ opencode / node $(node -v) / tmux"

echo
echo "== 安装插件 =="
mkdir -p "$PLUGIN_DIR/data" "$WORLD_BIN"
cp "$SRC/index.ts" "$PLUGIN_DIR/index.ts"
cp "$SRC/README.md" "$PLUGIN_DIR/README.md"
cp "$SRC/GUIDE.md" "$PLUGIN_DIR/GUIDE.md"
cp "$SRC/life-world.example.json" "$PLUGIN_DIR/life-world.example.json"
cp "$SRC/data/kaomoji.json" "$PLUGIN_DIR/data/kaomoji.json"
[ -f "$SRC/data/kaomoji.meta.json" ] && cp "$SRC/data/kaomoji.meta.json" "$PLUGIN_DIR/data/kaomoji.meta.json"
mkdir -p "$PLUGIN_DIR/modules"
cp -a "$SRC/modules/." "$PLUGIN_DIR/modules/"
CONFIG_FILE="$HOME/.local/share/life-world/life-world.json"
# 老版本的设置放在 world.json 里：存在时不要抢先写示例配置，
# 否则 ensureConfig 看到新文件就不再迁移，enabled/localModel 等旧设置会丢。
if [ ! -f "$CONFIG_FILE" ] && [ ! -f "$CONFIG_DIR/life-world.json" ] && [ ! -f "$CONFIG_DIR/qq-bridge.json" ] \
   && [ ! -f "$HOME/.local/share/life-world/worlds/default/world.json" ]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cp "$SRC/life-world.example.json" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "  ✓ 配置示例 → $CONFIG_FILE"
fi
cp "$SRC"/scripts/* "$WORLD_BIN/"
chmod +x "$WORLD_BIN"/*.sh "$WORLD_BIN"/*.mjs 2>/dev/null || true
echo "  ✓ 插件本体 → $PLUGIN_DIR"
echo "  ✓ 配套脚本 → $WORLD_BIN"

echo
echo "== 世界数据 =="
echo "  第一次启动时自动建在 ~/.local/share/life-world/worlds/default/"
echo "  （世界提示词 / 我是谁 / 用户画像 / 心情 / 日记 / 计划 / 房间 / 闹钟）"
echo "  已有的世界不会被覆盖，升级也不会丢东西。"

echo
if [ "${1:-}" = "--service" ]; then
  echo "== 重启服务 + 拉起 TUI =="
  ( export PATH="$HOME/.opencode/bin:$PATH"; opencode service restart || true )
  sleep 2
  "$WORLD_BIN/start-tui.sh" || true
  echo
fi

if pgrep -f "qq-bridge\.mjs" >/dev/null 2>&1; then
  echo "⚠ 检测到 qq-bridge 正在运行：升级后请手动重启它，桥接改动才会生效。"
  echo "  先停旧进程：pkill -f 'qq-bridge[.]mjs'"
  echo "  再按 README/GUIDE 的启动命令起一次；别直接再起一个"
  echo
fi

echo "== 下一步 =="
if [ "${1:-}" != "--service" ]; then
  echo "  opencode service restart     # 必须：让共享服务重新加载插件"
  echo "  $WORLD_BIN/start-tui.sh      # 起常驻 TUI 并自动激活（插件是懒加载的）"
  echo
fi
echo "可选："
echo "  QQ 桥接：等插件首次启动生成 $CONFIG_FILE 后，编辑里面的 bridge 段"
echo "           填 bridge.ownerQQ、bridge.wsUrl / token / location，把 bridge.enabled 改成 true"
echo "  总开关：$WORLD_BIN/life-world.sh status | on | off"
