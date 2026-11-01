#!/bin/bash
# 开一个带调试口的 Chrome，用对方平时那份资料与登录状态
PORT="${1:-9222}"
ENDPOINT="http://127.0.0.1:${PORT}/json/version"
# Chrome 不允许在「默认资料目录」上开调试口（按 realpath 判）。
# 所以真实资料放在 google-chrome-agent，~/.config/google-chrome 软链接过去。
PROFILE="$HOME/.config/google-chrome-agent"

# 先看调试口：已经开着就直接返回，不必要求本机还能找到 Chrome 可执行文件
if curl -s -m 2 "$ENDPOINT" >/dev/null 2>&1; then
  echo "已经开着了：http://127.0.0.1:${PORT}"
  exit 0
fi

CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "没找到 Chrome（需要 google-chrome / google-chrome-stable / chromium 在 PATH 里）"
  exit 1
fi

# 如果已经有一个不带调试口的 Chrome 在跑，新命令只会被转交给它，调试口永远开不出来
if pgrep -x google-chrome >/dev/null 2>&1 || pgrep -x chrome >/dev/null 2>&1 || pgrep -x chromium >/dev/null 2>&1; then
  echo "已经有一个 Chrome 开着，但没带调试口。先关掉它再来（不要用 browser-close.sh：它只杀调试口那个实例）。"
  exit 1
fi

# 需要图形会话的显示与授权
for d in 1 0; do
  if [ -S "/tmp/.X11-unix/X${d}" ]; then export DISPLAY=":${d}"; break; fi
done
AUTH=$(ls /run/user/"$(id -u)"/xauth_* 2>/dev/null | head -1)
[ -n "$AUTH" ] && export XAUTHORITY="$AUTH"

rm -f "$PROFILE"/Singleton* 2>/dev/null
nohup "$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  >/tmp/life-world-chrome.log 2>&1 &

for _ in $(seq 1 30); do
  sleep 0.5
  if curl -s -m 1 "$ENDPOINT" >/dev/null 2>&1; then
    echo "开好了：http://127.0.0.1:${PORT}"
    echo "看标签页：curl -s http://127.0.0.1:${PORT}/json/list"
    echo "开新页：curl -X PUT \"http://127.0.0.1:${PORT}/json/new?url=https://example.com\""
    exit 0
  fi
done

echo "没起来，看看 /tmp/life-world-chrome.log"
exit 1
