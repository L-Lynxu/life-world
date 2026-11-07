#!/bin/bash
# life-world pi 版安装（只装 pi 侧，不碰 opencode 主分支的插件）
#
#   ./pi/install.sh
#   LIFE_WORLD_ROOT=/path/to/data ./pi/install.sh
#
# 需要：pi 1.5.0+、Node 22+（桥接与 build-prompt 用）。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="${LIFE_WORLD_ROOT:-$HOME/.local/share/life-world}"

command -v pi >/dev/null 2>&1 || { echo "✗ 找不到 pi（1.5.0+）"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ 找不到 node（22+，桥接需要全局 WebSocket）"; exit 1; }

echo "== 准备世界目录 =="
mkdir -p "$ROOT" "$ROOT/worlds/default" "$ROOT/pi-sessions"
chmod 700 "$ROOT" "$ROOT/worlds/default" 2>/dev/null || true
cp "$SRC/../data/kaomoji.json" "$ROOT/pi-kaomoji.json"
echo "  ✓ 颜文字库 → $ROOT/pi-kaomoji.json"

echo "== 生成静态世界提示词 =="
LIFE_WORLD_ROOT="$ROOT" node "$SRC/build-prompt.mjs"

echo "== 完成 =="
cat <<EOF

下一步：
1. 配置 $ROOT/life-world.json 的 bridge 段（参考 pi/config.example.json）
2. 启动桥接：
   TZ=Asia/Shanghai node $SRC/bin/qq-bridge.mjs
3. 家会话（跑闹钟/回顾/兜底）：
   TZ=Asia/Shanghai node $SRC/bin/home-rpc.mjs

SnowLuma/NapCat 若只监听 127.0.0.1，需要在容器/本机做 SSH 隧道，
或把它的 WS host 改成 0.0.0.0 后重启。
EOF
