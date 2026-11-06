# life-world

> 本插件在 [dsh-world](https://github.com/chenkezhen480/dsh-world) 的基础上改造而来，感谢原作者。
> 本插件的代码由 **DeepSeek** 编写，感谢它的辛勤付出。

给 [opencode](https://opencode.ai) v2 里的陪伴角色一个会记得、会生活的世界：跨会话记忆与检索、自己的时间、每日回顾、心情、颜文字、真实浏览器、QQ 桥接、语音和私聊余波。

自包含插件，**零运行时依赖**；靠 opencode v2 的插件钩子、共享服务 HTTP API 和 tmux 工作。只支持 **Linux**（家会话自愈用 tmux，浏览器脚本依赖 Linux 的 Chrome / X）。

## 目录

- [功能](#功能)
- [安装](#安装)
- [升级](#升级)
- [世界提示词与规则模块](#世界提示词与规则模块)
- [记忆](#记忆)
- [语音](#语音)
- [QQ 桥接](#qq-桥接onebot-v11-正向-ws)
- [配置](#配置life-worldjson)
- [数据位置](#数据位置)
- [日常运维](#日常运维)
- [本地小模型优化](#本地小模型优化可选默认关闭)
- [已知限制](#已知限制)
- [数据与隐私](#数据与隐私)

## 功能

| 能力 | 说明 |
|---|---|
| 时间上下文 | 每轮把「当前时间 + 时区」写进 system |
| 消息时间戳 | 用户消息正文前加 `[本地时间 YYYY-MM-DD HH:mm TZ]` |
| 原文归档 | 读 `~/.local/share/opencode/opencode.db` 的 `session_message`，按天写 `conversations/*.jsonl`，含 assistant |
| **跨窗口记忆** | 新会话第一次请求时，注入最近 48 小时、总字数 ≤2000 的原文 + 最近 3 天记忆地图 + 自述 + 日记索引（`world.hydrate` 可调） |
| **记忆检索** | `memory_search`（关键词 / 时间范围，搜对话 / 日记 / 房间笔记）、`memory_day`（回看某天）、`memory_timeline`（一段时间每天聊了什么） |
| 压缩 | 只保留对话正文，去掉工具调用过程 |
| 闹钟 | 每 30 秒检查 `world.json`，到点经共享服务唤醒家会话；发送成功才移除 |
| 每日回顾 | 默认 23 点后一天一次：写日记、改自述、更新用户画像、清理到期心情；发送成功才记账 |
| 早上兜底 | **今天**没排着闹钟时，在 `fallbackWakeTime` 后 4 小时内叫醒一次，自己拟全天计划 |
| 今日计划 | `plan/YYYY-MM-DD.md` |
| 心情状态 | `identity/心情.md` 三块（底色 / 临时 / 特殊），每轮注入 |
| 家会话自愈 | 家会话缺失时，服务进程自动重启 tmux 并重建；标题固定 `life-world home session` |
| **十个工具** | `plan_next` / `check_alarm` / `cancel_alarm` / `reach_out` / `send_media` / `group_chat` / `kaomoji` / `memory_search` / `memory_day` / `memory_timeline`。**只能通过 `execute` 调**（`await tools.plan_next(...)`），不能点名直呼 |
| 颜文字 | `kaomoji` 按场景随机取；`remember: true` 收进 `room/颜文字.md`；库可从 npm 更新 |
| 真实浏览器 | `bin/browser-*` 开带调试口的 Chrome、读浏览历史、关掉 |
| 在线子代理 | 本地模型只做判断，浏览器 / 调研 / 批量整理交给在线模型（`modules/subagent.md`） |
| **QQ 桥接（可选）** | `scripts/qq-bridge.mjs`：接任意 **OneBot v11 正向 WebSocket**（NapCat、SnowLuma 等）↔ `qq-chat` 会话；每行一条消息、真人节奏 |
| **主动消息 outbox** | `reach_out` 写 `outbox/YYYY-MM-DD.jsonl`；桥接每 2 秒投递，断线 / 跨天后自动补发最近 3 天 |
| **语音** | 不内置 TTS：外部 TTS 把音频放进 `语音/`，`send_media({ kind: "voice" })` 以 OneBot `record` 段发送；私聊 / 群聊都支持 |
| **私聊余波** | 她发完话 60 秒没人回 → 补一轮；再 60 秒 → 再补一轮（默认最多 2 轮）；她也可以只回 `[SILENT]` 选择不说 |
| **gal 模式（强制模式）** | 纯提示词：她当导演，每回合「一段叙事正文 + 一次 `question` 单选闸门」 |
| **总开关** | `bin/life-world.sh on｜off｜status`；关掉即完全退回原生 opencode，数据不动 |
| **本地小模型优化** | 折叠工具结果 / 旧推理、压缩注入条数、单并发闸门。接在线模型时保持关闭 |

## 安装

要求：opencode v2（`opencode` 在 PATH）、**Node.js 22.13+**（推荐 24 LTS）、tmux、Linux。没有别的依赖。

> Node 版本不是随便写的：插件用 `node:sqlite`（22.13 起免 flag），桥接用全局 `WebSocket`（22 起）。Node 20 装得上但插件加载会直接失败。

```bash
git clone <本仓库> life-world && cd life-world
./install.sh --service      # 装好 + 重启服务 + 拉起 TUI
```

`install.sh` 会把插件放进 `~/.config/opencode/plugins/life-world/`、把配套脚本放进 `~/.local/share/life-world/bin/`。**不会碰已有的世界数据**，升级重跑也安全。

> 想让 AI 代理自己装：把仓库地址丢给它，说「clone 下来跑 `./install.sh --service`」；脚本是幂等的。

手动装（等价）：

```bash
mkdir -p ~/.config/opencode/plugins/life-world/data ~/.config/opencode/plugins/life-world/modules ~/.local/share/life-world/bin
cp index.ts README.md GUIDE.md life-world.example.json ~/.config/opencode/plugins/life-world/
cp data/kaomoji.json data/kaomoji.meta.json ~/.config/opencode/plugins/life-world/data/
cp -a modules/. ~/.config/opencode/plugins/life-world/modules/
cp scripts/* ~/.local/share/life-world/bin/ && chmod +x ~/.local/share/life-world/bin/*
opencode service restart
~/.local/share/life-world/bin/start-tui.sh
```

插件是懒加载的：TUI 里不说话，插件不加载、定时器不转。

## 升级

`install.sh` 只更新插件与脚本，**不碰世界数据**。

### 世界提示词

`worlds/default/world-prompt.md` 每个世界一份，首行带版本号 `<!-- life-world:world version=N -->`。升级时：

- **没改过**（内容等于旧版默认，或插件写入的 `world-prompt.hash` 与当前内容完全一致）→ 备份后自动换新版；
- **手改过** → 一个字不动，另存 `world-prompt.vN.new.md`；用 `life-world.sh prompt diff` 看差异、`prompt apply` 手动合并；
- 备份失败时**不会覆盖**；`world-prompt.hash` 只记 shipped 默认稿的 hash，手改内容的 hash 不会写进去。

```bash
~/.local/share/life-world/bin/life-world.sh prompt status   # 版本 / 备份 / 待合并文件
~/.local/share/life-world/bin/life-world.sh prompt diff     # 对比 .new.md
~/.local/share/life-world/bin/life-world.sh prompt apply    # 备份后应用
~/.local/share/life-world/bin/life-world.sh prompt reset    # 备份后删除，下次重建默认稿
```

### QQ 桥接

桥接是独立进程，`install.sh` 不会重启它。升级后先停旧进程再起一次，别直接再起一个（会双实例双回复）：

```bash
pkill -f "qq-bridge[.]mjs"
setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

## 世界提示词与规则模块

世界提示词只做三件事：**交代身份 → 给模块目录 → 划底线**。具体规则按主题放在插件目录 `modules/`，角色需要时自己读，不常驻注入：

`first-meeting` / `files` / `profile-mood` / `hands-eyes` / `tools` / `time-plan` / `browser` / `qq` / `stickers` / `subagent` / `gal` / `safety`

- **工具语法只在 `modules/tools.md` 写一份**；`time-plan` / `stickers` / `qq` 只写什么时候用、有什么边界。
- **QQ 私聊 / 群聊的说话方式**以 system 里每轮注入的《QQ 私聊回复方式》《QQ 群聊模式》为准；`modules/qq.md` 只留桥接排障和余波说明。
- `modules/` 是插件资产，`install.sh` 每次覆盖；想自定义请写 `world-prompt.md`、`room/` 或 `identity/`，别改 `modules/`。

第一次跟角色说话时，她按 `modules/first-meeting.md` 做一遍引导：介绍能力、总开关、群聊和 gal 玩法，问要不要接 QQ / 在线模型；做完在 `identity/引导.md` 留一行日期，之后不再重复。

`GUIDE.md` 是给人看的操作手册（安装 / QQ 配置 / 排查），插件不会读进上下文。

## 记忆

### 新会话注入（`world.hydrate`）

默认**不再**塞最近 80 条原文，而是：

| 内容 | 默认 |
|---|---|
| 最近原文 | 48 小时内，总字数 ≤2000（从新往旧累加，超出截断） |
| 记忆地图 | 最近 3 天，每天一行：句数 + 日记标题 |
| 常驻 | 自述、日记索引、心情、当前时间、桥接状态 |

更早的内容不硬塞，由角色按需检索：

```js
await tools.memory_search({ query: "法考 出分", from: "2026-09-01", to: "2026-11-06" })
await tools.memory_day({ date: "2026-10-31" })
await tools.memory_timeline({ from: "2026-10-01", to: "2026-10-31" })
```

检索零依赖：精确子串 + 中文 2 字 bigram 覆盖率打分，只返回命中处附近的片段；对话、日记、房间笔记都能搜。query 限 200 字 / 64 个 bigram，按文件 mtime 缓存。

### 配置

```json
"hydrate": { "mode": "budget", "hours": 48, "chars": 2000, "mapDays": 3 }
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `mode` | `budget` | `budget` = 时间窗口 + 字数预算；`recent` = 旧逻辑，按 `recentLimit` 条数注入 |
| `hours` | 48 | 只注入最近多少小时的原文 |
| `chars` | 2000 | 注入正文的总字数上限 |
| `mapDays` | 3 | 记忆地图覆盖最近几天 |

## 语音

life-world **不内置 TTS**。任何外部 TTS 把音频（mp3 / wav / silk / amr / ogg / m4a）放进 `worlds/default/语音/`，角色就能发：

```js
await tools.send_media({ path: "语音/晚安.mp3", kind: "voice", text: "早点睡" })
```

- 图片、语音：私聊和群聊都能发；文件：只有私聊。
- 走 OneBot `record` 段（base64），private / group 都支持。
- `record` 被实现拒绝时，私聊退成普通文件段（配文一起带上）；群聊不降级，直接丢弃并记进 `outbox/failed.jsonl`。
- 上限 8MB；发送超时 60 秒，视为投递未知，不自动重发。

## QQ 桥接（OneBot v11 正向 WS）

任意实现 OneBot v11 正向 WebSocket 的服务端都行：NapCat、SnowLuma 等。链路：QQ 服务端 WS → 桥接 → `qq-chat` / `qq-group-*` 会话；角色回复后，桥接把新完成的 assistant 文本按时间顺序发回 QQ。

### 启动

```bash
# 配置在 ~/.local/share/life-world/life-world.json 的 bridge 段
chmod 600 ~/.local/share/life-world/life-world.json 2>/dev/null || true

setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs \
  >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

> 不要用示例文件覆盖已有配置——老部署会截断迁移，丢 `enabled` / `localModel` / QQ 凭据。只有全新安装、文件确实不存在时才 `cp life-world.example.json`。

### 私聊

- 只接受 `bridge.ownerQQ` 的私聊；其他人的消息忽略。
- `/new`：删除 `qq-chat`，下一条消息或她的 `reach_out` 再新建。
- 回复按行拆成多条，两条之间按下一句长度停顿约 1.5~5 秒，模拟真人打字。
- 模型思考和生成期间显示「对方正在输入…」（`set_input_status`；不支持的实现会自动禁用）。
- 主动找人 `reach_out` 写 outbox；桥接每 2 秒投递，投递游标按天记录，启动 / 重连 / 跨天后补发最近 3 天。

### 群聊（可选，默认关闭）

- 每群一个 `qq-group-<群号>` 会话；`/new` 只有 owner 能触发。
- 角色可以用 `group_chat` 工具实时开关，不用重启。
- **两段式读空气**：@ / 点名 / 关键词直接进判官；其余消息每批按 `interjectChance`（默认 0.05）掷骰；回复后短时把概率提到 `afterReplyChance`。
- 判官（标题 `qq-judge`）只输出 `REPLY` / `SKIP`，会跳过 life-world 注入，避免私聊记忆发给外部模型。
- 群聊只自动接收图片 / 表情；文件和视频不下载，正文里只留占位。
- **群聊里记忆 / 闹钟 / 群聊开关一律不给**：群消息任何人都能诱导模型，`memory_*`、`plan_next`、`cancel_alarm`、`group_chat` 在群会话里会被拒绝；`send_media` 只能从 `表情包/语音` 取，避免把 `room/` 的私密内容发进群。
- `bannedWords` 是出站黑名单，命中整行丢弃；不适合接就只回 `[SILENT]`。

### 私聊余波

她发完最后一句话、且没有别的回合排队时，桥接开始计时：

1. 60 秒没有你的消息 → 发一条带 `【余波】` 标记的回合，让她补一句没说完的 / 解释一下 / 问一句怎么不说话；
2. 再过 60 秒还没有 → 再补一轮；
3. 最多 `maxRounds` 轮（默认 2）就停，直到你再次说话。

规则：

- 每一轮她都可以自己判断「这会儿不该说」：只回 `[SILENT]` 就不发送，也不再续下一轮。
- **任何一条你的消息**都会让还没响的计时作废；已经生成中的那条余波照发，但不再续。
- **主动推送（`reach_out`）不触发余波**——主动找人本来就要简短，不追着说。
- `【余波】对方还没回你…` 是系统标记，不是你说的话：归档和压缩摘要都会跳过它。
- 生成失败不重试；模型一轮超过 3 分钟没出正文，看门狗会清状态。
- 只作用于 QQ 私聊；群聊和终端不触发。

### 媒体

- 角色用 `send_media` 发 `room` / `表情包` / `语音` / `tmp` 里的文件；图片和语音私聊、群聊都能发，文件只有私聊。
- 图片 / 语音上限 8MB，文件 20MB；走 base64 段，不经过 opencode 会话。
- 私聊接收图片和文件：下载后作为附件附在这一轮请求里，存 `worlds/default/tmp/`，默认 7 天清理（`bridge.attachmentCleanup` / `attachmentRetentionDays`）。

### 排查

```bash
pgrep -af qq-bridge
tail -20 ~/.local/share/life-world/qq-bridge.log
```

日志里看 `ws open` / `ws error` / `reconnect`。进程没了就重启；出现 `ws open` 才算接上。桥接掉线不是 OneBot 服务端的问题。

## 配置（`life-world.json`）

唯一用户配置：`~/.local/share/life-world/life-world.json`（权限 600，含 QQ token）。完整带说明的示例见仓库里的 **`life-world.example.json`**；首次启动时插件自动生成，旧 `world.json` / `qq-bridge.json` 在它缺失时兜底。

### `_说明` 字段

JSON 不支持注释，所以每个区块都有一个 `_说明` 字符串，**只给人看**，插件和桥接会忽略。已有配置启动时会自动补上缺失的 `_说明`，不会改动你的其他字段。

```json
{
  "_说明": "life-world 配置。改完下一轮生效（世界提示词和模块除外）…",
  "world": { "_说明": "生活世界：总开关、暂停、回顾、叫醒、记忆注入…", "enabled": true },
  "localModel": { "_说明": "本地小模型的折叠与单并发闸门…", "enabled": false },
  "bridge": { "_说明": "QQ / OneBot 桥接…", "enabled": false, "afterglow": { "_说明": "私聊余波…" } }
}
```

### 区块

| 区块 | 主要字段 |
|---|---|
| `world` | 总开关 `enabled`、暂停 `running`、回顾 `reviewHour`、早上兜底 `fallbackWakeTime`、夜间重置 `resetHour`、记忆注入 `hydrate`、注入 / 压缩 / 积压 / 冷却 / 家会话标题 |
| `localModel` | 本地小模型优化与单并发闸门，见下文 |
| `bridge` | QQ / OneBot：`enabled`、`ownerQQ`、`wsUrl` / `token`、`privateSessionTitle`、`location`、媒体清理、`afterglow`、`group` |

### `bridge` 常用字段

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关；关闭时 `reach_out` 不写 outbox。**启动时读取**，改完要重启桥接（`group_chat` 写的群开关实时生效） |
| `ownerQQ` | 唯一允许的私聊用户，也是通知目标 |
| `wsUrl` / `token` | OneBot 正向 WS 地址与 token；同一台机器用 `127.0.0.1` |
| `privateSessionTitle` | 私聊会话标题，默认 `qq-chat` |
| `location` | 新会话的工作目录 |
| `afterglow` | 私聊余波：`enabled` / `delayMs`（默认 60000）/ `maxRounds`（默认 2） |
| `attachmentCleanup` / `attachmentRetentionDays` | `tmp/` 附件自动清理，默认 `true` / 7 天 |
| `group` | 群聊：`enabled`、`keywords`、`interjectChance`、`afterReplyChance`、`judgeModel`、`judgeTimeoutMs`、`bannedWords` 等 |

`world.json` 只存运行时状态（家会话、闹钟、lastReview / lastWake），不要手改；世界提示词的版本 hash 单独在 `world-prompt.hash`。

## 数据位置

```
~/.local/share/life-world/
├── life-world.json      用户配置（600；含 QQ token）
├── debug.log
├── qq-bridge.log
├── qq-bridge-state.json 桥接状态（会话 id、outbox 游标、心跳）
├── bin/                 配套脚本（life-world.sh / start-tui.sh / browser-* / qq-bridge.mjs …）
└── worlds/default/
    ├── world.json          运行时状态（闹钟/家会话/last*）
    ├── world-prompt.md     世界提示词（带版本号）
    ├── world-prompt.hash   只记 shipped 默认稿的 hash
    ├── identity/           我是谁 / 用户画像 / 心情
    ├── conversations/      原文归档（一天一个 jsonl）
    ├── diary/              日记
    ├── plan/               今日计划
    ├── room/               房间（她自己的笔记）
    ├── 表情包/             她收集的表情包和图片
    ├── 语音/               外部 TTS 产出的音频
    ├── tmp/                收到的 QQ 图片/文件（7 天兜底清理）
    └── outbox/             reach_out / send_media 出口
```

### 自述与心情的拆分

`identity/我是谁.md` 和 `identity/心情.md` 是**每次会话注入**的主文件，越短 prefill 越快。长篇经历、外貌全文、名声与世界、住处、硬件面、归并日志、旧记录移到不注入的存档：

- `room/设定/我是谁-存档.md`
- `identity/心情-存档.md`

主文件留一行指针。硬限制：`我是谁.md` ≤500 字；`心情.md` 每条状态只写状态名、设置时间、持续时间、≤15 字的行为特点。

## 日常运维

### 总开关

```bash
~/.local/share/life-world/bin/life-world.sh status   # 看状态
~/.local/share/life-world/bin/life-world.sh off      # 退回原生 opencode
~/.local/share/life-world/bin/life-world.sh on       # 恢复
```

关掉时：不注入时间 / 世界提示词 / 心情 / 记忆、不打时间戳、10 个工具一个都不挂、定时器空转——上下文和原生 opencode 一样。**归档仍在后台继续**（只写文件），世界数据原地保留，开回来直接接上。

开关记在 `life-world.json` 的 `world.enabled`（不写 = 开启）。脚本改完会重启服务和 TUI；开关**只认人手**，没有做成给角色调用的工具。

> QQ 桥接是独立进程，不跟着开关走；要一起停得单独停桥接。

### 家会话

- 第一个说话的 TUI 会话会被记为「家」，标题改成 `life-world home session`。
- 家会话被删或失效（404）时，服务进程自动 `tmux kill-server` 并起新的 `home` 会话。
- 自动重置有 5 分钟冷却；`tmux kill-server` 会清掉当前用户**所有** tmux 会话。
- 设了 `resetHour` 时，每天该点后重置一次。

### 更新颜文字库

```bash
node ~/.local/share/life-world/bin/kaomoji-update.mjs          # 有新版才更新
node ~/.local/share/life-world/bin/kaomoji-update.mjs --check  # 只看版本
```

从 npm 拉 `kaomoji-collection`（MIT，来源 kaomojiya.org），零依赖；更新后自动生效，不用重启。官方源不通时加 `--registry https://registry.npmmirror.com`。

## 本地小模型优化（可选，默认关闭）

> **什么时候开**：模型跑在本机 / 局域网，上下文短、并发差、首字慢（llama.cpp、Ollama、Strata 这类）。
> **什么时候别开**：接在线 API。在线模型上下文够长，折叠反而丢信息，保持默认关闭。

```json
"localModel": {
  "enabled": true,
  "keepRecent": 20,
  "foldRecentContext": 6,
  "resultChars": 300,
  "foldToolMessages": true,
  "foldingReasoningTurns": 0,
  "preferSubagent": true,
  "debugStats": false
}
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `false` | 总开关；关着时下面全部不生效 |
| `keepRecent` | 20 | 新会话注入的历史条数（关着时用 `RECENT_LIMIT` = 80） |
| `foldRecentContext` | 6 | 每轮只保留最近几条 `<recent-context>` 工具结果，0 = 不折 |
| `resultChars` | 300 | 折叠后每条结果保留多少字符 |
| `foldToolMessages` | `true` | 是否折叠 `role=tool` 的工具消息 |
| `foldingReasoningTurns` | 0 | 保留最近几轮推理；0 = 全折，-1 = 不折 |
| `preferSubagent` | `true` | 注入「在线模型子代理」提示 |
| `subagentPreference` | `""` | 子代理偏好，例如 `阿里百炼平台的 Qwen3.8 Flash` |
| `debugStats` | `false` | 每轮往 debug.log 写一行上下文构成统计 |
| `concurrency` | 见下 | 单并发模型闸门，默认关闭 |

### 单并发模型闸门（`localModel.concurrency`）

给「同一时间只能跑一个请求」的本地模型用；接在线 API 时保持关闭，完全 no-op。

```json
"concurrency": {
  "enabled": false,
  "deferMinutes": 30,
  "userActiveSeconds": 90,
  "groupPause": true,
  "groupMaxAgeMinutes": 10,
  "leaseTtlMinutes": 10
}
```

| 规则 | 行为 |
|---|---|
| 用户在聊天 | 插件和桥接看到「用户活跃」后，不再发起新的定时 / 群聊回合 |
| 定时任务冲突 | 到点的闹钟 `at += deferMinutes`（默认 30 分钟）后放回；回顾 / 兜底本轮跳过 |
| QQ 群聊 | **新回合**暂停；空闲后只处理最新一批，超过 `groupMaxAgeMinutes` 的旧消息丢弃 |
| 释放 | 回合结束（`session.idle`；桥接在群回合完成 / 放弃、私聊 `/new` 或会话删除时）释放；进程被杀靠 `leaseTtlMinutes` 兜底 |

**边界**：只能阻止**新回合**。已经在跑的那一轮无法被抢断；QQ 私聊和 TUI 同时来消息只能排队。

**实测**（迷你主机 + Qwen3.8-Flash-Next IQ3_XXS，opencode 2.2.5）：同一会话每轮请求从 306 KB / 20 万 token 降到 25 KB 上下，单轮耗时从 145–222 秒降到几十秒。

> 折叠只动工具结果和旧推理，**对话正文一条不动**；`life-world.json` 改完下一轮生效，不用重启。

## 已知限制

- 定时器只在 opencode 客户端进程活着时有效；`opencode run` 一句话跑完的等不到点。
- 服务端与客户端各加载一份插件、各跑一份定时器；用 `worlds/default/.timer.lock` 互斥。
- `world.json` 的跨进程「读—改—写」没有全局锁：TUI 和 service 同时写时，理论上仍可能丢一次闹钟更新（读坏文件时会先留 `.bad` 备份）。
- 归档记录没有会话归属：QQ 群聊、其他 opencode 项目的会话会以「对方 / 我」进入记忆；`memory_timeline` 的开头可能来自群友。
- 记忆缓存按整个归档的 mtime 失效；几十万条时第一次检索会慢（当前 2600+ 条是毫秒级）。
- 压缩摘要不累积：每次压缩只吃当前窗口。**这是有意的**——自然丢失本身就是长度限制。
- 消息是至少一次语义：发送成功才记账；若在「发送成功、记账前」崩溃，可能重发一次。
- 权限是提示词软约束，没有 `ctx.permission` 硬拦截（有意为之）。
- 浏览器脚本复用 `~/.config/google-chrome-agent` 资料：首次使用需要先把真实 Chrome 资料迁过去，否则是空 profile、不带登录态。
- 颜文字数据 `data/kaomoji.json` 为随附资源；发布前请确认来源与许可证。

## 数据与隐私

- 仓库里**只有插件代码和文档**，不带任何人的世界数据、日志或凭据。
- 运行时数据全部落在 `~/.local/share/life-world/`，只在你本机；QQ 凭据在 `life-world.json`（权限 600，不在仓库目录内）。
- 心情文件里的「可选状态库」只是示例，可以换成任何适合自己角色的状态。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
