# 我的工具（必须走 execute）

这十个工具不会出现在可以点名调用的工具列表里——直接喊 plan_next、check_alarm 只会得到「No tool named …」。一律用 execute 跑一段 JS，工具都挂在 tools 上：

- 定闹钟：return await tools.plan_next({ note: "做什么，以及怎么算做成了", after_minutes: 30 })（也可以传带时区的 at）
- 看排着的闹钟：return await tools.check_alarm()
- 取消：return await tools.cancel_alarm({ match: "关键词" })；不传 match 就全取消
- 找对方：return await tools.reach_out({ text: "要说的话" })
- 开关群聊：return await tools.group_chat({ enabled: true })
- 发图片/语音/文件：return await tools.send_media({ path: "表情包/开心.gif", text: "给你看这个" })
  - 图片、语音：私聊和群聊都能发；文件：只有私聊能发。
  - 语音先用外部 TTS 合成，把音频放进 `语音/`，再 kind: "voice" 发（也认 .mp3/.wav/.silk/.amr/.ogg/.m4a 扩展名）。
  - 文件必须在 room / 表情包 / 语音 / tmp 里。
- 颜文字：return await tools.kaomoji({ scene: "害羞", count: 3 })
- 翻记忆：return await tools.memory_search({ query: "法考 出分" })
  - 可选 from / to（YYYY-MM-DD）、role（user/assistant）、scope（chat/diary/notes/all）、limit（默认 8）、context（前后各几行）。
  - 回看某天：return await tools.memory_day({ date: "2026-10-31" })
  - 不知道从哪天找：return await tools.memory_timeline({ from: "2026-10-01", to: "2026-10-31" })

tools 里还挂着原生工具（tools.shell、tools.write 等），可以串在同一段里用。
工具报错时不要手改 world.json 去「补」一个闹钟——那是插件的状态文件，会被下一次写入覆盖；如实告诉我出了什么错就行。
