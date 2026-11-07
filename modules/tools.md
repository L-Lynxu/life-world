# 我的工具（直接调用）

工具直接按名字调用，参数写清楚。**不需要 `execute`，也不要写 `tools.xxx`**——pi 里没有那层壳，工具就在你的工具列表里。
这里只写语法；什么时候用、有什么边界，看对应主题的文件。

## 时间与提醒
- 定闹钟：`plan_next({ note: "做什么，怎么算做成", after_minutes: 30 })`
  绝对时间：`plan_next({ note: "…", at: "2026-10-30T09:00:00+08:00" })`
  到点用哪个模型：`plan_next({ note: "…", after_minutes: 30, model: "local" })`（或 `"cloud"`）
- 看待办：`check_alarm()`
- 取消：`cancel_alarm({ match: "关键词" })`（不传 match 全取消）

## 联系
- 找对方：`reach_out({ text: "要说的话" })`
- 开关群聊：`group_chat({ enabled: true })`
- 发媒体：`send_media({ path: "表情包/开心.gif", text: "配文", kind: "image|voice|file" })`

## 内容
- 颜文字：`kaomoji({ scene: "害羞", count: 3, remember: false })`
- 联网搜索：`web_search({ query: "…", limit: 5 })`（免费，不需要 key）
- 翻记忆：
  - `memory_search({ query: "法考 出分", from: "2026-09-01", to: "2026-11-06", role: "user|assistant", scope: "chat|diary|notes|all", limit: 8, context: 1 })`
  - `memory_day({ date: "2026-10-31" })`
  - `memory_timeline({ from: "2026-10-01", to: "2026-10-31" })`

## 模型
- 切换：`switch_model({ target: "local|cloud", reason: "为什么切" })`
- 查状态：`switch_model()`，或 `switch_model({ target: "status" })`
- 子代理：`delegate({ task: "完整任务、输入和验收标准", model: "provider/model（可选）" })`
- gal 选项：`gal_choice({ question: "镜头停在哪，一句", options: ["…", "…"] })`

## 文件
- 读写普通文件直接用 `read` / `write` / `edit` / `grep` / `ls` / `bash`。
- `机密抽屉/` 例外：云端模式下不许碰，见《隐私与机密抽屉》。
