#!/bin/bash
# 关掉带调试口开起来的 Chrome
pkill -x google-chrome 2>/dev/null
pkill -x chrome 2>/dev/null
sleep 1
if curl -s -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "还在跑"
else
  echo "关掉了"
fi
