# life-world

> 本插件在 [dsh-world](https://github.com/chenkezhen480/dsh-world) 的基础上改造而来，感谢原作者。
> 本插件的代码由 **DeepSeek** 编写，感谢它的辛勤付出。

给 [opencode](https://opencode.ai) v2 里的陪伴角色一个会记得、会生活的世界：跨会话记忆、自己的时间、每日回顾、心情状态、颜文字和真实浏览器。

这是一个自包含插件：零运行时依赖，靠 opencode v2 的插件钩子、共享服务 HTTP API 和 tmux 工作。

## 功能

| 能力 | 实现 |
|---|---|
| 时间上下文 | 每轮把「当前时间 + 时区」写进 system |
| 消息时间戳 | 用户消息正文前加 `[本地时间 YYYY-MM-DD HH:mm TZ]` |
| 原文归档 | 读 `~/.local/share/opencode/opencode.db` 的 `session_message`，按天写 `conversations/*.jsonl`，含 assistant |
| 跨窗口记忆 | 新会话第一次请求时，注入最近 80 条原文（`RECENT_LIMIT`，优化开关打开时可调低）+ 自述 + 日记索引 |
| 生活线工具 | `plan_next` / `check_alarm` / `cancel_alarm` / `reach_out`（多闹钟，`alarms` 数组）；**只能通过 `execute` 调**（`await tools.plan_next(...)`），不能点名直呼 |
| 闹钟 | 每 30 秒检查 `world.json`，到点经共享服务 HTTP 接口唤醒家会话；发送成功才移除 |
| 每日回顾 | 默认 23 点后一天一次，回看、写日记、改写自述、更新用户画像；发送成功才记账 |
| 世界提示词 | `world-prompt.md`，首次运行生成，可自行改写 |
| 早上兜底 | **今天**没排着闹钟时，在 `fallbackWakeTime` 后 4 小时内叫醒一次，自己拟全天计划（跨天的闹钟不算） |
| 今日计划 | `plan/YYYY-MM-DD.md` |
| 颜文字 | `kaomoji` 工具按场景随机取；`remember: true` 收进 `room/颜文字.md`；库可用 `bin/kaomoji-update.mjs` 从 npm 更新 |
| 心情状态 | `identity/心情.md` 三块（底色 / 临时 / 特殊），每轮注入 |
| **总开关** | `bin/life-world.sh on｜off｜status`；关掉即完全退回原生 opencode，数据不动 |
| **gal 模式（强制模式）** | 纯提示词：她当导演，每回合「一段叙事正文 + 一次 `question` 单选闸门」；只在对方要求由她主导时进入 |
| 家会话自愈 | 家会话缺失时，服务进程自动重启 tmux 并重建；标题固定 `life-world home session` |
| 真实浏览器 | `scripts/browser-*` 开带调试口的 Chrome、读浏览历史、关掉 |
| QQ 桥接（可选） | `scripts/qq-bridge.mjs`：接任意 **OneBot v11 正向 WebSocket**（NapCat、SnowLuma 等）↔ `qq-chat` 会话；每行一条消息、真人节奏；开关状态会注入给角色 |
| **主动消息 outbox** | `reach_out` 写 `outbox/YYYY-MM-DD.jsonl`；桥接每 2 秒投递，**断线/跨天后自动补发最近 3 天未送出的**；`bin/life-world.sh inbox [天数]` 可回看她主动说过什么 |
| 压缩 | 只保留对话正文，去掉工具调用过程 |
| 初次引导 | 首次启用时读 `modules/first-meeting.md`：介绍能力、问要不要接 QQ、引导配置 |
| **本地小模型优化（可选）** | `life-world.json` 的 `localModel`：折叠工具结果/旧推理、压缩注入条数、提示用在线子模型当子代理。**默认关闭** |

## 安装

要求：opencode v2（`opencode` 在 PATH）、**Node.js 22.13+**（推荐 24 LTS）、tmux、Linux。没有别的依赖。

> Node 版本不是随便写的：插件用 `node:sqlite`（22.13 起免 flag），桥接用全局 `WebSocket`（22 起）。Node 20 装得上但插件加载会直接失败。
> 家会话自愈需要 tmux；浏览器脚本依赖 Linux 的 Chrome 与 X 图形会话。

```bash
git clone <本仓库> life-world && cd life-world
./install.sh --service      # 装好 + 重启服务 + 拉起 TUI
```

`install.sh` 会检查依赖、把插件放进 `~/.config/opencode/plugins/life-world/`、把配套脚本放进 `~/.local/share/life-world/bin/`。**不会碰已有的世界数据**，升级重跑也安全。

> 想让 AI 代理自己装：把仓库地址丢给它，说「clone 下来跑 ./install.sh --service」就行——脚本是幂等的，装完会打印下一步。

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

注意：`worlds/default/world-prompt.md` 是每个世界一份，插件不会自动覆盖它。想让角色拿到新版默认提示词，先备份再删掉这个文件（或手动把新段落合并进去）；文件会在下次插件加载时用新默认重建，**重启 opencode 服务并开新会话（或等下一次压缩）后生效**。自定义过的提示词请手动合并，别直接删。

QQ 桥接是独立进程，`install.sh` 不会重启它。**升级后请手动重启 qq-bridge**（若在跑）：先 `pkill -f "qq-bridge[.]mjs"` 停掉旧进程，再按下面的启动命令起一次；不要直接再起一个，会双实例双回复。只重启服务/TUI 时，判官隔离由插件侧兼容旧路径兜底，但桥接自身的其余修复仍要等它重启。

## 规则模块

世界提示词只是一份目录；具体规则按主题放在插件目录的 `modules/`：

`first-meeting` / `files` / `profile-mood` / `hands-eyes` / `tools` / `time-plan` / `browser` / `qq` / `gal` / `safety`。

需要时角色会读对应文件，不常驻注入；`install.sh` 会一并安装。

## 第一次启动

第一次跟角色说话时，她按 `modules/first-meeting.md` 给你做一遍引导：能做什么、怎么使唤她、总开关在哪、群聊和 gal 模式怎么玩，最后问你一句要不要接 QQ。引导做完会在 `identity/引导.md` 留一行日期，之后不再重复。

`GUIDE.md` 是给人看的操作手册（安装 / QQ 配置 / 排查），插件不会自动把它读进上下文；里面的运维步骤请由人来执行。

## 总开关

```bash
~/.local/share/life-world/bin/life-world.sh status   # 看当前状态
~/.local/share/life-world/bin/life-world.sh off      # 退回原生 opencode
~/.local/share/life-world/bin/life-world.sh on       # 恢复
```

关掉时：不注入时间/世界提示词/心情/记忆、不打时间戳、6 个工具一个都不挂、定时器空转——模型看到的上下文和原生 opencode 一样。**归档仍在后台继续**（只写文件、不进上下文），历史不会断；世界数据（日记、计划、记忆、心情、闹钟）原地保留，开回来直接接上。

开关记在 `~/.local/share/life-world/life-world.json` 的 `world.enabled`（不写=开启；旧文件兜底）。脚本改完会重启服务和 TUI：工具与定时器都是进程启动时建的，不重启等于没生效。开关**只认人手**，没有做成给角色调用的工具。

> QQ 桥接是独立进程，不跟着开关走；要一起停得单独停桥接。

## 可选：QQ 桥接（OneBot v11 正向 WS）

`scripts/qq-bridge.mjs` 是一条可选的 QQ 通道：**任意实现了 OneBot v11 正向 WebSocket 的服务端**都可以——NapCat、SnowLuma 等都行，只要它对外开放（正向）WS 服务器，把地址填进配置即可。链路是：QQ 服务端 WS → 桥接 → `qq-chat` 会话；角色回复后，桥接把新完成的 assistant 文本按时间顺序发回 QQ（一次积压多条也不会漏）。

私聊与群聊都已实现；群聊默认关闭。

```bash
# 1. 配置：编辑 ~/.local/share/life-world/life-world.json 的 bridge
#    这个文件由插件首次启动时生成（会从旧 world.json / qq-bridge.json 迁移设置）。
#    不要用示例文件去覆盖它——尤其老部署，覆盖会截断迁移、丢 enabled / localModel / QQ 凭据。
#    只有确认它是全新安装、文件还不存在时，才需要手动 cp life-world.example.json 过去。
chmod 600 ~/.local/share/life-world/life-world.json 2>/dev/null || true
# 填 bridge.ownerQQ、bridge.wsUrl / token、bridge.location；bridge.enabled 改成 true

# 2. 启动（脱离 tmux，避免家会话重置时被 kill-server 带走）
setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs \
  >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

| 字段 | 说明 |
|---|---|
| `bridge.enabled` | 总开关；life-world 会把状态注入 system，关闭时 `reach_out` 不会写 outbox。**桥接在启动时读取它**，运行中改需要重启桥接（`group_chat` 写的群开关是实时读取的） |
| `bridge.ownerQQ` | 唯一允许的私聊用户，也是通知目标 |
| `bridge.wsUrl` / `token` | 正向 WS 地址与 token（NapCat、SnowLuma 等通用）。旧的 `~/.config/opencode/qq-bridge.json` 只在 `life-world.json` 完全没有 `bridge` 段时兜底；正常情况改这里。 |
| `bridge.group.enabled` | 群聊开关，默认 `false`；角色也能用 `group_chat` 工具实时开关 |

- `/new`：删除 `qq-chat`，下一条消息或她的 `reach_out` 再新建。
- **outbox 补发**：投递游标按天记录；桥接启动/重连时会扫最近 3 天，把没送出去的补发（跨天离线也不丢）。
- 回复按行拆成多条：每个短句一条 QQ 消息，两条之间按下一句长度停顿约 1.5~5 秒（加随机抖动），模拟真人打字。
- 若这一轮正文为空、但她调用了 `reach_out`，桥接会把这一轮缓冲的那些行当回复发出去，避免漏回。
- 开关关闭或桥接离线（心跳超过 90 秒）时，角色会看到「reach_out 不会送达」，不会以为已经通知到你。
- `life-world.json` 含凭据（token），权限 600，别外传；旧 `qq-bridge.json` 仅作兜底。

### 群聊（可选）

`group.enabled` 默认 `false`。打开后：

- 群会话标题 `qq-group-<群号>`，每群一个；`/new` 只有 `ownerQQ` 能触发。
- 角色可以用 `group_chat` 工具开关群聊：写 `life-world.json` 的 `bridge.group.enabled`，桥接实时读取，不用重启。
- **保留原人格和记忆**，额外注入「QQ 群聊模式」：把对方当普通朋友，不用情侣/伴侣称呼、不谈亲密关系/私聊内容。
- **两段式读空气**：@/点名/关键词直接进判官；其余消息每批按 `interjectChance`（默认 0.05）掷骰；判官调用 `judgeModel`（默认 `default`，跟随主聊天默认模型），只输出 `REPLY`/`SKIP`。回复后短时把概率提到 `afterReplyChance`。
- 判官会话（标题 `qq-judge`）会跳过 life-world 注入，避免私聊记忆发给外部模型。
- 图片/表情/视频链接只在判官 `REPLY` 后才下载/附给群会话；`SKIP` 不处理。
- 群聊回复按行拆成多条，中间按下一句长度停顿；`bannedWords` 是群聊出站黑名单，命中整行丢弃。

| 字段 | 说明 |
|---|---|
| `enabled` | 群聊总开关，默认 `false` |
| `keywords` | 触发关键词；@/点名也直接触发 |
| `interjectChance` | 非触发消息每批的随机介入概率，默认 `0.05` |
| `judgeModel` | 判官模型；默认 `default` = 主聊天默认模型；也可填 `providerID/modelID` |
| `judgeTimeoutMs` | 判官超时，默认 `60000` 毫秒 |
| `bannedWords` | 群聊出站黑名单，命中整行丢弃 |

## 数据位置

运行时数据全部在 `~/.local/share/life-world/`，**不随仓库分发**；用户配置在 `~/.local/share/life-world/life-world.json`（含 token，600）：

```
~/.local/share/life-world/
├── life-world.json      用户配置（600；含 QQ token）
├── debug.log
├── bin/                 配套脚本（life-world.sh / start-tui.sh / browser-* / qq-bridge.mjs …）
└── worlds/default/
    ├── world.json          运行时状态（闹钟/家会话/last*；不是配置）
    ├── world-prompt.md
    ├── identity/          我是谁 / 用户画像 / 心情
    ├── conversations/     原文归档
    ├── diary/
    ├── plan/
    ├── room/
    └── outbox/
```

### 自述与心情的拆分

`identity/我是谁.md` 和 `identity/心情.md` 是**每次会话注入**的主文件，越短 prefill 越快。
长篇经历、外貌全文、名声与世界、住处、硬件面、归并日志、旧的落地记录——移到不注入的存档：

- `room/设定/我是谁-存档.md`
- `identity/心情-存档.md`

主文件里留一行指针即可；世界提示词里也写了这条规则，角色会自己维护。

硬限制：`我是谁.md` 主文件不超过 500 字；`心情.md` 每条状态只写状态名、设置时间、持续时间、不超过 15 个字的行为特点，不写详细描述。

## 配置（`life-world.json`）

唯一用户配置：`~/.local/share/life-world/life-world.json`（权限 600，含 QQ token）。完整示例见仓库里的 `life-world.example.json`；首次启动时插件会自动生成，旧 `world.json` / `qq-bridge.json` 在它缺失时兜底。

```json
{
  "world": {
    "enabled": true, "running": true, "reviewHour": 23, "fallbackWakeTime": "09:00",
    "resetHour": null, "recentLimit": 80, "summaryLimit": 12000,
    "alarmStaleHours": 6, "resetCooldownMinutes": 5,
    "homeTitle": "life-world home session"
  },
  "localModel": {
    "enabled": false, "keepRecent": 20, "foldRecentContext": 6, "resultChars": 300,
    "foldToolMessages": true, "foldingReasoningTurns": 0, "preferSubagent": true, "debugStats": false,
    "concurrency": { "enabled": false, "deferMinutes": 30, "userActiveSeconds": 90, "groupPause": true, "groupMaxAgeMinutes": 10, "leaseTtlMinutes": 10 }
  },
  "bridge": {
    "enabled": false, "ownerQQ": 0, "ownerName": "", "wsUrl": "ws://127.0.0.1:3001",
    "token": "", "privateSessionTitle": "qq-chat", "location": "",
    "group": { "enabled": false, "keywords": [], "interjectChance": 0.05, "afterReplyChance": 0.8, "probabilityDurationMs": 120000, "judgeModel": "default", "judgeTimeoutMs": 60000, "debounceMs": 10000, "triggerDebounceMs": 1200, "maxBatchWaitMs": 60000, "cooldownMs": 8000, "maxPer10Min": 0, "bannedWords": [] }
  }
}
```

| 区块 | 主要字段 |
|---|---|
| `world` | 总开关 `enabled`、暂停打扰 `running`、回顾 `reviewHour`、早上兜底 `fallbackWakeTime`、夜间重置 `resetHour`、注入/压缩/积压/冷却/家会话标题等 |
| `localModel` | 本地小模型优化，见下文 |
| `bridge` | QQ/OneBot 桥接，见下文 QQ 一节 |

`world.json` 现在只存运行时状态（家会话、闹钟、lastReview/lastWake 等），不要手改；配置只改 `life-world.json`。

## 家会话

- 第一个说话的 TUI 会话会被记为「家」，写入 `world.json`，标题改成 `life-world home session`。
- 家会话被删或失效（404）时，服务进程会自动 `tmux kill-server`、起新的 `home` 会话，新 TUI 的第一句话重新立家。
- 自动重置有 5 分钟冷却；`tmux kill-server` 会清掉当前用户**所有** tmux 会话。
- 设了 `resetHour` 时，每天该点后重置一次（`lastResetDate` 去重）。

## 已知限制

- 定时器只在 opencode 客户端进程活着时有效；`opencode run` 一句话跑完的等不到点。
- 服务端与客户端各加载一份插件、各跑一份定时器；用 `worlds/default/.timer.lock` 互斥。
- 消息是至少一次语义：发送成功才记账；若在「发送成功、记账前」崩溃，可能重发一次。
- 压缩摘要不累积：每次压缩只吃当前窗口。**这是有意的**——自然丢失本身就是长度限制。
- 颜文字数据 `data/kaomoji.json` 为随附资源；发布前请确认其来源与许可证。
- 权限是提示词软约束，没有 `ctx.permission` 硬拦截（有意为之）。
- QQ 桥接私聊 / 群聊都已实现；群聊默认关闭。
- 浏览器脚本复用 `~/.config/google-chrome-agent` 这份资料：首次使用需要先把真实 Chrome 资料迁过去（或按部署 worklog 建软链），否则打开的是空 profile、不带登录态。

## 本地小模型优化（可选，默认关闭）

> **什么时候开**：模型跑在本机 / 局域网，**上下文短、并发差、首字慢**（典型：llama.cpp、Ollama、Strata 这类本地推理）。打开后主对话上下文会明显变瘦，prefill 时间大幅下降。
>
> **什么时候别开**：接的是在线模型（API）。在线模型上下文够长、并发好，这些折叠会丢信息，**保持默认关闭**，按满配置跑即可。

打开方式——在 `~/.local/share/life-world/life-world.json` 的 `localModel` 里改：

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
| `enabled` | `false` | 总开关。关着时下面全部不生效 |
| `keepRecent` | 20 | 新会话注入的历史条数（关着时用 `RECENT_LIMIT` = 80） |
| `foldRecentContext` | 6 | 每轮只保留最近几条 `<recent-context>` 工具结果，0 = 不折 |
| `resultChars` | 300 | 折叠后每条结果保留多少字符 |
| `foldToolMessages` | `true` | 是否折叠 `role=tool` 的工具消息 |
| `foldingReasoningTurns` | 0 | 保留最近几轮的推理；0 = 全折，-1 = 不折 |
| `preferSubagent` | `true` | 注入「在线模型子代理」提示：有在线模型时把抓网页/调研这类重活委托过去 |
| `debugStats` | `false` | 每轮往 debug.log 写一行上下文构成统计（调参用） |
| `concurrency` | 见下 | 单并发模型闸门，默认关闭 |

### 单并发模型闸门（`localModel.concurrency`）

给「同一时间只能跑一个请求」的本地模型用。**接在线 API 时保持默认关闭**，本功能完全 no-op。

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

打开后（且 `localModel.enabled` 也为 true）：

| 规则 | 行为 |
|---|---|
| 用户在聊天 | 插件和桥接看到「用户活跃」后，不再发起新的定时/群聊回合 |
| 定时任务冲突 | 到点的闹钟 `at += deferMinutes`（默认 30 分钟）后放回；回顾/兜底本轮跳过 |
| QQ 群聊 | **新回合**暂停（已经在生成的回复照常投递）；空闲后只处理最新一批，超过 `groupMaxAgeMinutes` 的旧消息丢弃 |
| 释放 | 回合结束（`session.idle`；桥接在群回合完成/放弃、私聊 `/new` 或会话删除时）释放；进程被杀靠 `leaseTtlMinutes` 兜底 |

**边界**：只能阻止**新回合**。已经在跑的那一轮无法被抢断（opencode 的取消接口没有接），用户的请求仍要等它结束；QQ 私聊和 TUI 同时来消息同样只能排队。

**实测**（395 迷你主机 + Qwen3.8-Flash-Next IQ3_XXS，opencode 2.2.5）：同一条会话，每轮请求从 **306 KB / 20 万 token** 降到 **25 KB 上下**，单轮耗时从 145–222 秒降到几十秒。

> 折叠只动工具结果和旧推理，**对话正文一条不动**；`life-world.json` 改完下一轮生效，不用重启。
>
> 另外：`我是谁.md` / `心情.md` 是每次注入的主文件，按「数据位置」里的拆分规则压短，对新会话 prefill 比折叠选项更直接。

## 更新颜文字库

```bash
node ~/.local/share/life-world/bin/kaomoji-update.mjs          # 有新版才更新
node ~/.local/share/life-world/bin/kaomoji-update.mjs --check  # 只看版本
```

从 npm 拉 `kaomoji-collection`（MIT，来源 kaomojiya.org），过滤后写回插件的 `data/kaomoji.json`。**零依赖**：只用 Node 内置 `fetch` / `zlib`，不需要 npm / npx。官方源不通时加 `--registry https://registry.npmmirror.com`。更新后自动生效，不用重启。

## 数据与隐私

- 仓库里**只有插件代码和文档**，不带任何人的世界数据、日志或凭据。
- 运行时数据全部落在 `~/.local/share/life-world/`，只在你本机；QQ 凭据在 `life-world.json`（权限 600，已不在仓库目录内）。
- 心情文件里的「可选状态库」只是一份示例，你可以换成任何适合自己角色的状态。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
