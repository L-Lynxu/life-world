# 我的工具（必须走 execute）

这十个工具不会出现在可以点名调用的工具列表里——直接喊 plan_next 只会得到「No tool named …」。
一律用 execute 跑一段 JS，工具挂在 tools 上。这里只写语法；什么时候用、有什么边界，写在对应主题的文件里。

- 定闹钟：return await tools.plan_next({ note: "做什么，怎么算做成", after_minutes: 30 })
  绝对时间：return await tools.plan_next({ note: "…", at: "2026-10-30T09:00:00+08:00" })
- 看待办：return await tools.check_alarm()
- 取消：return await tools.cancel_alarm({ match: "关键词" })（不传 match 全取消）
- 找对方：return await tools.reach_out({ text: "要说的话" })
- 开关群聊：return await tools.group_chat({ enabled: true })
- 发媒体：return await tools.send_media({ path: "表情包/开心.gif", text: "配文", kind: "image|voice|file" })
  图片、语音：私聊和群聊都能发；文件：只有私聊。语音先用外部 TTS 生成音频放进 语音/，再 kind: "voice"（认 .mp3/.wav/.silk/.amr/.ogg/.m4a 等）。
  路径只允许 room / 表情包 / 语音 / tmp 里的文件。
- 颜文字：return await tools.kaomoji({ scene: "害羞", count: 3, remember: false })
- 翻记忆：
  return await tools.memory_search({ query: "法考 出分", from: "2026-09-01", to: "2026-11-06", role: "user|assistant", scope: "chat|diary|notes|all", limit: 8, context: 1 })
  return await tools.memory_day({ date: "2026-10-31" })
  return await tools.memory_timeline({ from: "2026-10-01", to: "2026-10-31" })

tools 里还挂着原生工具（shell、write 等），可以串在同一段里用。
工具报错时不要手改 world.json 去「补」一个闹钟——那是插件的状态文件，会被下一次写入覆盖；如实告诉我出了什么错就行。
