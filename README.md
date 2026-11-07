# life-world · pi agent

> **这是 `pi-agent` 分支的 README。**
> `main` 分支仍是 opencode 插件版；本分支把 life-world 迁到 **pi 1.5.0** 的扩展体系，代码在 `pi/`。

给 [pi coding agent](https://github.com/earendil-works/pi) 里的陪伴角色一个会记得、会生活的世界：跨会话记忆与检索、自己的时间、每日回顾、心情、颜文字、QQ 桥接、语音、私聊余波、零第三方子代理，以及**本地 / 在线模型热切换**和**免费联网搜索**。

## 快速开始

要求：**pi 1.5.0+**；只有跑 QQ 桥接/家会话时需要 **Node 22+** 和 OneBot v11 服务端。

```bash
git clone -b pi-agent https://github.com/lynxu95/life-world
cd life-world

./pi/install.sh --global     # 全局：所有 pi 会话都加载
# 或
./pi/install.sh --project   # 项目级：只在当前仓库目录生效
```

装完直接：

```bash
pi
```

扩展会自动把世界规则注入首轮 system prompt；不需要 `--append-system-prompt`，也不需要改 `APPEND_SYSTEM.md`。

卸载：

```bash
./pi/install.sh --uninstall
# 或
./pi/install.sh --project-uninstall
```

> 全局模式会让所有 pi 会话都带 life-world（包括写代码的会话）；只想在 life-world 目录里用，选 `--project`。

## 它怎么工作

```
QQ ←→ OneBot v11 正向 WS（SnowLuma / NapCat …）
        ↕
  pi/bin/qq-bridge.mjs（Node 22）
        ↕ pi RPC（JSONL stdin/stdout）
  pi --mode rpc --model deepseek-flash
    + pi/ext/life-world.ts（工具 / 注入 / 归档 / 定时器 / delegate）
        ↑
  pi/bin/home-rpc.mjs（LIFE_WORLD_ROLE=home，跑闹钟 / 回顾 / 兜底）
```

关键设计：

- **静态世界规则**：`pi/prompt/world.md`（由 `pi/build-prompt.mjs` 从仓库 `modules/*.md` 生成），扩展在 `before_agent_start` 每轮确保在场（pi 的强制 system prompt 只对单次 run 生效）；
- **动态状态**：`before_agent_start` 用隐藏消息（`display: false`）注入「本地时间 + 心情 + 桥接状态」，不改 system，保护缓存；
- **工具**：`pi.registerTool`，模型直接可见，不需要 opencode 的 `execute` 绕路；
- **归档**：`message_end` 写 `conversations/YYYY-MM-DD.jsonl`；
- **定时器**：只在 `LIFE_WORLD_ROLE=home` 的进程跑，用 `pi.sendMessage(triggerTurn)` 唤醒；
- **子代理**：`delegate` 起独立 `pi -p` 子进程，深度限制 1 层，零第三方；
- **模型热切换**：`switch_model` 让角色自己决定用本地还是在线模型；模型无响应立即切，工具连续失败两次切云端；脚本探活兜底，不依赖模型自己判断。切云端前，之前的对话与机密文件收进本地 `机密抽屉/`；云端模式禁止访问该目录（read/ls/grep/edit/bash 命中即拦），私密画像不预加载、本地需要时自己读；没配本地模型则抽屉不启用。`plan_next` 可为任务指定到点用哪个模型；
- **联网搜索**：`web_search` 工具走 TinyFish 的 keyless 模式，不填 API Key 也能搜（opencode 版同源能力）。

## 和 main（opencode 版）的区别

`main` 是 opencode 插件版，`pi-agent` 是 pi 原生扩展版，两边并存、互不影响。

| 能力 | main（opencode） | pi-agent（本分支） |
|---|---|---|
| 宿主 | opencode 插件（`execute` 里调工具） | pi 1.5 原生扩展（`registerTool`） |
| 每轮状态 | 注入 system 块 | `before_agent_start` 隐藏消息（不劈缓存） |
| 原文归档 | 读 opencode SQLite | `message_end` 直接写 JSONL |
| 定时器 | HTTP 唤醒共享会话 | `pi.sendMessage(triggerTurn)` |
| QQ 桥接 | opencode HTTP API | pi RPC（JSONL 子进程） |
| 会话 | opencode 会话列表 | 磁盘 JSONL 树，`pi -r` 挑回 |
| 本地/在线切换 | 无 | `switch_model` + 脚本级故障切换 |
| 联网搜索 | 内置 websearch（5 家供应商，需 Key） | `web_search`，TinyFish keyless 免 Key |
| 聊天气质 | 世界提示词 + 心情 | 同上，另加 `identity/模型使用规范.md`（≤500 字）注入 |

## 配置

`~/.local/share/life-world/life-world.json`：

```json
{
  "bridge": {
    "enabled": true,
    "ownerQQ": 123456789,
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "afterglow": { "enabled": true, "delayMs": 60000, "maxRounds": 2 },
    "group": { "enabled": false, "keywords": ["铃"] }
  },
  "subagent": { "model": "deepseek-flash" },
  "localModel": { "enabled": true, "keepRecent": 20, "foldToolResults": 6, "resultChars": 300 },
  "models": {
    "local": "basalt/abliterated-iq3_xxs",
    "cloud": "deepseek/deepseek-flash",
    "autoFailover": true,
    "localHealthUrl": "http://127.0.0.1:8081/health",
    "cloudHealthUrl": "https://api.deepseek.com/models"
  }
}
```

完整示例见 `pi/config.example.json`。不要用它覆盖已有配置，只合并需要的段。

## 界面整洁

- **思考块**：在 `~/.pi/agent/settings.json` 加 `"hideThinkingBlock": true`，思考过程不再显示（仍会生成，只是不占屏幕）；
- **工具调用**：输出默认折叠，按 `Ctrl+O` 展开/收起；
- **注入的状态**：时间、心情、桥接状态改成 `before_agent_start` 的隐藏消息（`display: false`），不再拼在用户消息正文里；
- 每个工具都有紧凑的 `renderCall` / `renderResult`，默认一行摘要，展开才看全文。

## 跑 QQ 桥接

```bash
# 私聊桥接
TZ=Asia/Shanghai node pi/bin/qq-bridge.mjs

# 家会话（定时器）
TZ=Asia/Shanghai node pi/bin/home-rpc.mjs
```

### OneBot 只监听 127.0.0.1 时

从其他机器/容器连不上时，用 SSH 隧道：

```bash
sshpass -f /path/to/pw ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 user@host
```

桥接仍连 `ws://127.0.0.1:3001`。也可以把 OneBot 的 WS host 改成 `0.0.0.0` 后重启服务。

## 目录

```
pi/
├── ext/life-world.ts        pi 扩展（工具/注入/归档/定时器/delegate/gal）
├── bin/qq-bridge.mjs        OneBot WS ↔ pi RPC 桥接
├── bin/home-rpc.mjs         家会话 RPC 常驻（定时器）
├── build-prompt.mjs         从 ../modules/*.md 生成 prompt/world.md
├── install.sh               全局/项目级安装、卸载
├── config.example.json      配置示例
└── prompt/world.md          生成物（install.sh 产出）
```

## 与 opencode 版的关系

| opencode（`main`） | pi（本分支） |
|---|---|
| `tool.transform` + `execute` 绕路 | `registerTool`，模型直接调用 |
| 每轮 system 注入 | `input` 拼进用户消息 |
| `opencode.db` 归档 | `message_end` 写 JSONL |
| HTTP `sendHome` | `pi.sendMessage(triggerTurn)` |
| 桥接 HTTP API | pi RPC JSONL |
| 在线子代理提示 | `delegate` 独立 `pi -p` 进程 |

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
