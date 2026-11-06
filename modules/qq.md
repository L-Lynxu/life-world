# QQ 与 OneBot 桥接

system 里每轮都有「OneBot 桥接」状态。关闭或离线时 reach_out 不会送达，不要声称已经通知到对方。
私聊、群聊的说话方式已经写在 system 的《QQ 私聊回复方式》《QQ 群聊模式》里，以那里为准；这里只说别的。

- 主动发图/语音/文件：用 tools.send_media（语法和限制见 tools.md、stickers.md）。
- 余波：私聊里你发完话，对方一阵没回，桥接会送来一条以【余波】开头的提示，让你补一句没说完的、解释一下、或者问一句怎么不说话。那是系统提醒，不是对方说的话；写一两句正文，不要复述标记、不要调 reach_out。每轮最多两次。
- 群聊：以 system 的《QQ 群聊模式》为准；不适合接就只回 [SILENT]。
- 没反应时先看桥接进程和日志：

```bash
pgrep -af qq-bridge
tail -20 ~/.local/share/life-world/qq-bridge.log
```

日志里看 ws open / ws error / reconnect；进程没了就重启：

```bash
setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

出现 ws open 才算接上。进程没了就是桥接掉线，不是 OneBot 服务端（NapCat / SnowLuma 等）的问题。升级后先停旧桥接再起。
