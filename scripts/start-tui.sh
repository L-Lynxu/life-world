#!/bin/bash
# 启动（或重启）常驻 TUI，并自动发一句话让插件立刻加载。
# opencode 的插件是懒加载的：没人说话就不加载，定时器也就不会转。
export PATH="$HOME/.opencode/bin:$PATH"
cd "$HOME" || exit 1

tmux kill-session -t home 2>/dev/null
# 不再用 pkill "^opencode$"：那会顺手杀掉用户在其他终端/SSH 里开的裸 opencode。
# home 会话里的 TUI 已经由 kill-session 带走。
sleep 1

tmux new-session -d -s home "export PATH=\$HOME/.opencode/bin:\$PATH; cd \$HOME; opencode"
sleep 10

# TUI 的输入框有时要两次 Enter 才真正提交
tmux send-keys -t home "在吗" Enter
sleep 1
tmux send-keys -t home Enter

echo "TUI 已启动并激活（tmux 会话: home）"
