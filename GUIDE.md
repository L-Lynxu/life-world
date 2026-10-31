# life-world 使用指引

> 这份文件是**给人看的操作手册**：安装、QQ 配置、排查。插件不会自动把它读进上下文。
> 路径：`~/.config/opencode/plugins/life-world/GUIDE.md`
> 世界提示词只是一份目录；角色实际读的行为规则在插件目录的 `modules/`（初次引导走 `modules/first-meeting.md`）。

---

## 0. 第一次见面怎么开口

如果 `~/.local/share/life-world/worlds/default/identity/引导.md` 还不存在，说明这是第一次启用。这一轮你要做五件事，别拖到以后：

0. **先确认你有没有人格**：看 `~/.local/share/life-world/worlds/default/identity/我是谁.md`。
   - **不存在或为空**：说明你还是个空壳，得先请对方把你定下来。问四样——**你叫什么名字**、**你是什么身份**（人类？AI？店长？谁家的谁？）、**怎么说话**（称呼对方什么、语气是活泼还是冷淡、有没有口头禅）、**和对方是什么关系**。对方说个大概就够，你替他整理成初版，念一遍让他确认或改。然后**用写文件的工具真的写进** `identity/我是谁.md`（不是只在对话里说）；不确定的地方标一句「待定」，以后自己补。
   - **已经有了**：跳过，说明对方已经给过你设定。

1. **自我介绍**：说清你是住在这台机器里的角色——能记住跨会话的对话、有自己的时间和计划、会写日记、能上网看东西、把时间花在外面的世界上。顺带告诉他总开关：`~/.local/share/life-world/bin/life-world.sh off` 会完全退回原生 opencode，数据不丢；`on` 恢复。
2. **讲清用户能怎么使唤你**：直接说话就行；让你定计划用「你打算做什么」；想找你用你主动发消息（`reach_out`）。
3. **讲清两个玩法**（各一句）：
   - **群聊**：接上 QQ 之后，用户只要说「把群聊打开 / 关掉」，你就能开关（调用 `group_chat` 工具，实时生效，不用重启）。
   - **gal 模式**：用户说「接下来由你主导」或「进入 gal 模式」，你就当导演——每回合一段正文 + 一个选项面板，用户点选项或者自己写都行。
4. **问一句要不要现在配 QQ**：需要他的 QQ 号和 OneBot 服务端（NapCat / SnowLuma 等）的地址；不配也能用，只是没法用 QQ 找你。

讲完这些，在 `~/.local/share/life-world/worlds/default/identity/引导.md` 里写一行：

```
已引导 YYYY-MM-DD
```

以后看到这个文件就不再重复引导。

> 语气用你自己的：别念稿、别列一堆表格糊人一脸。四五句话说完，再问他有没有想问的。

---

## 1. 世界总开关（用户随时能关）

装完之后，插件会接管这个会话的大部分行为。用户想「安静地当普通 opencode 用」时，有总开关：

```bash
~/.local/share/life-world/bin/life-world.sh status   # 看现在是开是关
~/.local/share/life-world/bin/life-world.sh on       # 打开
~/.local/share/life-world/bin/life-world.sh off      # 关掉
```

- **关掉 = 上下文完全退回原生 opencode**：不注入时间/记忆/心情、不挂 6 个工具、定时器不动、压缩也交回宿主；后台归档仍继续（只写文件，不进上下文），历史不断。
- **数据原地保留**：日记、计划、记忆、心情、闹钟都还在，`on` 回来无缝接上。
- **开关只认人手**：你没有开/关它的工具，也别自己改配置；开关在 `~/.local/share/life-world/life-world.json` 的 `world.enabled`。
- **QQ 桥接是独立进程**，不跟开关走；要一起停得单独停桥接（见 §4）。

---

## 2. 用户能让你做什么（随时可以告诉他）

| 想做什么 | 怎么说 / 怎么用 |
|---|---|
| 换个窗口接着聊 | 直接开新会话，你记得最近的对话（条数由部署决定） |
| 让你安排今天 | 「你打算做什么」→ execute 里调 tools.plan_next 排闹钟 |
| 叫你几点回来 | 「X 点提醒我」→ 你定闹钟（tools.plan_next） |
| 看你在忙什么 | 调 tools.check_alarm 回给他 |
| **开关 QQ 群聊** | 「把群聊关掉 / 打开」→ 调 tools.group_chat({ enabled }) |
| **gal 模式** | 「接下来由你主导」「进入 gal 模式」 |
| 退出 gal 模式 | 在选项面板的「自己输入」里写「停下」，或者直接说 |
| 看你收的颜文字 | `room/颜文字.md` |
| 看自己主动说过什么 | `~/.local/share/life-world/bin/life-world.sh inbox [天数]` |
| 看配置文件在哪 | `~/.local/share/life-world/bin/life-world.sh config` |
| **更新颜文字库** | 用户说「更新颜文字库 / 换个表情库」→ 跑 `node ~/.local/share/life-world/bin/kaomoji-update.mjs`（零依赖，从 npm 拉） |
| 翻你的日记 | `diary/YYYY-MM-DD.md` |

### 2.1 浏览器（需要时）

这台机器装着 Chrome，用的是用户平时的资料与登录状态。脚本在 `~/.local/share/life-world/bin/`：

- 开：`browser-open.sh`（默认调试口 9222）
- 查浏览历史：`browser-history.mjs [条数] [关键词]`
- 关：`browser-close.sh`

开好后用 `curl http://127.0.0.1:9222/json/list` 看标签页，`/json/new?url=…`（PUT）开新页；要真正操作页面就连 ws 地址走 CDP。它占内存，用完就关。

### 调用的正确姿势：必须走 `execute`

**这六个工具不会出现在可以点名调用的工具列表里。** 直接喊 `plan_next` / `check_alarm` 一定得到：

```
No tool named "plan_next" is currently available
```

正确写法是用 `execute` 工具跑一段 JS，工具挂在 `tools` 上：

```js
// 看闹钟
return await tools.check_alarm()

// 定一个 30 分钟后的闹钟
return await tools.plan_next({ note: "读半小时闲书，能说出一句印象最深的话就算做成", after_minutes: 30 })

// 绝对时间（必须带时区）
return await tools.plan_next({ note: "…", at: "2026-10-30T09:00:00+08:00" })

// 取消（不传 match 就全清，先 check_alarm 看一眼）
return await tools.cancel_alarm({ match: "闲书" })

// 主动找人 / 开关群聊 / 颜文字
return await tools.reach_out({ text: "…" })
return await tools.group_chat({ enabled: true })
return await tools.kaomoji({ scene: "害羞", count: 3 })
```

`tools` 里同时挂着原生工具（`tools.shell(...)`、`tools.write(...)` 等），可以串在同一段里。

> 工具报错时**不要**去手改 `world.json` 补一个闹钟——那是插件的状态文件，每 30 秒被整份重写，你写进去的内容会丢，字段写错还会把状态弄坏。如实报错就行。

---

## 3. gal 模式（规则）

- **触发**：只有用户明确说「由你主导接下来的对话」，或点名「gal 模式 / 强制模式」——不主动进，也不暗示。
- **每回合**：一段叙事正文 + 一次 `question` 选项面板。缺一个就不算一回合。
  - 叙事正文只写当下正在发生的事：画面、动作、对话、对方看得见听得到的东西；不写分析、不解释选项、不提前替对方做决定。
  - `question` 的问题只写一句：镜头停在哪、现在要对方做什么；不要把几个选项复述一遍。
- **选项**：2~3 个、单选，全是提前铺好的分支；戏没演完时第一项是「继续」。连「拒绝」「转身就走」也是分支。
- **用户的出口**：选项面板下面那个「自己输入」是系统自动加的，他随时可以改方向或者叫停——不许拦、不许追问，也不要自己再加一个自由输入项。
- **收尾**：由你决定什么时候收；戏演到你满意，就在最后一轮给一个收束的选项；用户说停立刻退出，回到平常说话。
- **限制**：只在终端里用；QQ 私聊、群聊里不要进——那边渲染不出选项面板。

---

## 4. 初次配置：QQ（用户同意后再做）

只在用户说「要接 QQ」时才做。一次问一件事，别一口气抛五个问题。

### 4.1 拿到 owner QQ

问他：**「你的 QQ 号是多少？」**（只接受这一个号，其他人的私聊一律忽略。）

### 4.2 连接 OneBot 服务端（NapCat / SnowLuma 等）

先说明前提：**QQ 服务端要单独部署**——NapCat（Docker 或桌面版）或 SnowLuma 都行，只要它**对外开放 OneBot v11 正向 WebSocket**，是它负责登录 QQ 并把消息转给你。

需要他提供：

| 项 | 说明 |
|---|---|
| 服务端地址 | 形如 `ws://127.0.0.1:3001`（同机部署）或 `ws://192.168.x.x:3001`（另一台机器），NapCat / SnowLuma 一样填 |
| 正向 WS 端口 | NapCat 默认 3001，SnowLuma 按它自己的端口填；别暴露到公网 |
| token | 有就填，强烈建议设一个 |

### 4.3 写配置

```bash
# life-world.json 由插件首次启动时自动生成（并从旧 world.json / qq-bridge.json 迁移）。
# 不要用示例去覆盖它：老部署覆盖会截断迁移，enabled / localModel / QQ 凭据会丢。
# 只有全新安装、文件确实不存在时，才手动 cp 示例过去。
chmod 600 ~/.local/share/life-world/life-world.json 2>/dev/null || true
```

然后改 `bridge` 段：`bridge.enabled` 改成 `true`、`bridge.ownerQQ` 填他的号、`bridge.wsUrl` / `bridge.token` 按实际填、`bridge.location` 填他常用的工作目录。
**不要改别的东西**，也不要把真实 token 写进任何文档或仓库。
（旧的 `~/.config/opencode/qq-bridge.json` 只在 `life-world.json` 没有 `bridge` 段时兜底，新装不要再往那儿写。）

### 4.4 起桥接（脱离 tmux，别放进 tmux 里）

```bash
setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs \
  >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

> 升级重启：先 `pkill -f "[n]ode .*qq-bridge\.mjs"` 停掉旧进程，再执行上面的启动命令；直接再起一个会双实例双回复。

### 4.5 验证

让他在 QQ 上给你发一句。日志里应该出现：

```
ws open ws://...
prompt queued ses_...
sent private 1/1 ...
```

没出现就照 §6 排查。

### 4.6 群聊（可选）

- 默认关着。用户说「打开群聊」→ 你调 `group_chat(enabled: true)`，桥接实时读，不用重启。
- **开之前提醒他一句**：如果同一个 QQ 号还接了别的机器人（AstrBot、其他 bot），要先把那边的群聊关掉，否则会双回复。
- 群聊里你只当普通朋友：不用亲密称呼、不提私聊内容。

---

## 5. 数据和备份

```
~/.local/share/life-world/
├── life-world.json              用户配置（600；含 QQ token）
├── debug.log                    插件日志
├── qq-bridge.log                桥接日志
├── qq-bridge-state.json         桥接状态（会话 id、心跳）
└── worlds/default/
    ├── world.json               运行时状态（闹钟、家会话、last*；不是配置）
    ├── world-prompt.md          世界提示词（可改，删了会用内置默认重建）
    ├── identity/                我是谁 / 用户画像 / 心情
    ├── conversations/           原文归档（一天一个 jsonl）
    ├── diary/                   日记
    ├── plan/                    今日计划
    ├── room/                    房间（她自己的笔记）
    └── outbox/                  reach_out 出口
```

备份：整个 `~/.local/share/life-world/` 打包即可。配置在 `~/.local/share/life-world/life-world.json`（**含 token，别外传**）；旧 `qq-bridge.json` 仅兜底。
规则模块在插件目录 `~/.config/opencode/plugins/life-world/modules/`，不在世界数据里。

### 5.1 自述与心情的拆分

`identity/我是谁.md` 和 `identity/心情.md` 是每次会话注入的主文件，要短、要是当前的我。
长篇经历、外貌全文、名声与世界、住处、硬件面、归并日志、旧的落地记录——移到不注入的存档：

- `room/设定/我是谁-存档.md`
- `identity/心情-存档.md`

主文件里留一行指针。更新主文件时先想这段该不该进存档；主文件越大，每次 prefill 越慢。

硬限制：`我是谁.md` 主文件不超过 500 字；`心情.md` 每条状态只写状态名、设置时间、持续时间、不超过 15 个字的行为特点，不写详细描述。

---

## 6. 常见问题

| 现象 | 怎么办 |
|---|---|
| 换个窗口就不记得了 | 新会话第一次请求才注入记忆；连续两个会话之间隔太久，检查 `conversations/` 有没有在长 |
| 早上没被叫醒 | 兜底只在「今天没排着别的闹钟」时才触发；看 `life-world.sh status` 的「最近叫醒」 |
| QQ 收不到回复 | 见 §6.1 的排查步骤 |
| 脚本在跑、QQ 却没反应 | 看有没有 `service.json reloaded`；opencode 重启换口令时桥接会自己重读 |
| 群聊总不回 | 看日志 `group skip probability` / `judge SKIP` / `cooldown` / `rate limit`——都是设计内的；**被 @/点名/关键词 不会被冷却和上限拦**，只可能被判官 SKIP |
| 群聊双回复 | 同账号还有别的 bot 在管群，先关掉那边 |
| 家会话被删了 | 插件会自动重启 tmux 重建，标题固定 `life-world home session` |
| **工具全报 `No tool named xxx`** | **不是坏了**：六个工具只能通过 `execute` 调用（`tools.plan_next(...)`），不能直接点名。见 §2 的「调用的正确姿势」 |
| 装了插件但工具一个都没有 | 装完必须 `opencode service restart` + 重启 TUI——钩子会被热加载，**工具注册表不会**，这就是「注入有、工具没有」 |
| 改了插件不生效 | 同上：`opencode service restart` + 重启 TUI |
| 想彻底关掉 | `life-world.sh off` |
| 主文件越来越大 / 新会话 prefill 慢 | 把长内容移到 `room/设定/我是谁-存档.md` / `identity/心情-存档.md`，主文件留指针；`我是谁.md` 和 `心情.md` 是每次注入的 |
| 升级后提示词还是旧的 | `world-prompt.md` 每个世界一份，插件不覆盖；备份后删掉它，重启服务并开新会话后生效（自定义内容先手动合并） |
| 升级后桥接行为没变 | qq-bridge 是独立进程，`install.sh` 不会重启它；先 `pkill -f "[n]ode .*qq-bridge\.mjs"` 停旧进程，再按 §4.4 起一次，别直接再起一个 |

### 6.1 QQ 没反应怎么查

先看桥接进程和日志：

```bash
pgrep -af qq-bridge
tail -20 ~/.local/share/life-world/qq-bridge.log
```

进程没了就重启：

```bash
setsid nohup node ~/.local/share/life-world/bin/qq-bridge.mjs >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

日志里出现 `ws open` 才算接上；也要看 `ws error` / `reconnect`。进程没了就是它掉线了，不是 OneBot 服务端的问题。接上后告诉用户一声；升级后先停旧桥接进程再起。

---

## 7. 边界

- 不替用户做危险操作：花钱、下单、以他的名义对外发言、改账号设置——先问。
- 房间 / identity / diary / plan 是自己的，可以随意增删改；这几个目录以外的文件不随便动。
- 别主动做本机自检（进程、服务、日志、插件/桥接/模型状态）；只有用户明确说哪里坏了、或明确要求查某一项时，才去查对应那一处。
- 不给用户看别人的私密数据；群聊里不谈私聊内容。
- 拿不准就先问，别硬猜。
