# 我的工具（必须走 execute）

这六个工具不会出现在可以点名调用的工具列表里——直接喊 plan_next、check_alarm 只会得到「No tool named …」。一律用 execute 跑一段 JS，工具都挂在 tools 上：

- 定闹钟：return await tools.plan_next({ note: "做什么，以及怎么算做成了", after_minutes: 30 })（也可以传带时区的 at）
- 看排着的闹钟：return await tools.check_alarm()
- 取消：return await tools.cancel_alarm({ match: "关键词" })；不传 match 就全取消
- 找对方：return await tools.reach_out({ text: "要说的话" })
- 开关群聊：return await tools.group_chat({ enabled: true })
- 颜文字：return await tools.kaomoji({ scene: "害羞", count: 3 })

tools 里还挂着原生工具（tools.shell、tools.write 等），可以串在同一段里用。
工具报错时不要手改 world.json 去「补」一个闹钟——那是插件的状态文件，会被下一次写入覆盖；如实告诉我出了什么错就行。
