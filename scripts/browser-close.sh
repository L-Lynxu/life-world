#!/bin/bash
# 关掉带调试口开起来的那个 Chrome 实例。
# 只按调试口参数匹配进程，不碰用户自己平时开着的 Chrome。
PORT="${1:-9222}"
# 带上边界：9222 不能顺带命中 92220
pkill -f -- "--remote-debugging-port=${PORT}([[:space:]]|$)" 2>/dev/null
sleep 1
if curl -s -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "还在跑（可能不是用 browser-open.sh 起的？调试口 ${PORT} 仍有响应）"
  exit 1
else
  echo "关掉了"
fi
