#!/bin/bash
# life-world pi 安装
#
#   ./pi/install.sh --global      # 全局：所有 pi 会话都加载（默认）
#   ./pi/install.sh --project     # 项目级：只在 life-world 仓库目录生效
#   ./pi/install.sh --uninstall   # 移除全局扩展（世界数据保留）
#   ./pi/install.sh --project-uninstall
#
# 需要：pi 1.5.0+。Node 22+ 只在跑 QQ 桥接/家会话时需要；
# build-prompt 有 node 就用，没有就由扩展运行时从 modules 现拼。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="${LIFE_WORLD_ROOT:-$HOME/.local/share/life-world}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
MODE="${1:---global}"

ensure_world() {
  echo "== 世界目录 =="
  mkdir -p "$ROOT" "$ROOT/worlds/default" "$ROOT/pi-sessions"
  chmod 700 "$ROOT" "$ROOT/worlds/default" 2>/dev/null || true
  cp "$SRC/../data/kaomoji.json" "$ROOT/pi-kaomoji.json"
  echo "  ✓ 颜文字库 → $ROOT/pi-kaomoji.json"
}

build_prompt() {
  if command -v node >/dev/null 2>&1; then
    echo "== 生成静态世界提示词 =="
    LIFE_WORLD_ROOT="$ROOT" node "$SRC/build-prompt.mjs"
  else
    echo "== 跳过 build-prompt（没有 node；扩展会在运行时从 modules 现拼）=="
  fi
}

link_extension() { # $1 = target dir
  local dest="$1"
  mkdir -p "$dest"
  if [ -e "$dest/index.ts" ] && [ ! -L "$dest/index.ts" ]; then
    local bak="$dest/index.ts.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$dest/index.ts" "$bak"
    echo "  · 已有 index.ts 备份到 $bak"
  fi
  ln -sfn "$SRC/ext/life-world.ts" "$dest/index.ts"
  echo "  ✓ 扩展 → $dest/index.ts"
}

case "$MODE" in
  --global)
    ensure_world
    build_prompt
    echo "== 全局扩展 =="
    link_extension "$AGENT_DIR/extensions/life-world"
    cat <<EOF

完成。以后直接敲 \`pi\` 就会带 life-world（扩展会自动注入世界规则）。
⚠ 全局模式会让所有 pi 会话都加载 life-world；只想在仓库目录用，改跑
   ./pi/install.sh --project

QQ 桥接（可选）：
  1. 配置 $ROOT/life-world.json 的 bridge 段（参考 pi/config.example.json）
  2. TZ=Asia/Shanghai node $SRC/bin/qq-bridge.mjs
  3. 家会话定时器：TZ=Asia/Shanghai node $SRC/bin/home-rpc.mjs
EOF
    ;;
  --project)
    ensure_world
    build_prompt
    PROJECT="${LIFE_WORLD_PROJECT:-$(cd "$SRC/.." && pwd)}"
    echo "== 项目级扩展 =="
    link_extension "$PROJECT/.pi/extensions/life-world"
    cat <<EOF

完成。在 $PROJECT 里打开 \`pi\`（首次需要批准项目信任）。
项目级不会影响其他目录的 pi 会话。
EOF
    ;;
  --uninstall)
    rm -f "$AGENT_DIR/extensions/life-world/index.ts"
    echo "已移除全局扩展（世界数据保留在 $ROOT）"
    ;;
  --project-uninstall)
    PROJECT="${LIFE_WORLD_PROJECT:-$(cd "$SRC/.." && pwd)}"
    rm -f "$PROJECT/.pi/extensions/life-world/index.ts"
    echo "已移除项目级扩展（世界数据保留）"
    ;;
  -h|--help)
    echo "用法：./pi/install.sh [--global|--project|--uninstall|--project-uninstall]"
    ;;
  *)
    echo "未知参数：$MODE"
    echo "用法：./pi/install.sh [--global|--project|--uninstall|--project-uninstall]"
    exit 1
    ;;
esac
