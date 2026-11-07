# life-world · pi agent

> **这是 `pi-agent` 分支的 README。**
> `main` 分支仍是 opencode 插件版；本分支把 life-world 迁到 **pi 1.5.0** 的扩展体系，代码在 `pi/`。

给 [pi coding agent](https://github.com/earendil-works/pi) 里的陪伴角色一个会记得、会生活的世界：跨会话记忆与检索、自己的时间、每日回顾、心情、颜文字、QQ 桥接、语音、私聊余波和零第三方子代理。

## 状态

**MVP 已在 OrbStack 的 Debian 容器里跑通**（pi 1.5.0 + `deepseek-flash`）：

- 扩展工具：`plan_next` / `check_alarm` / `cancel_alarm` / `reach_out` / `send_media` / `group_chat` / `kaomoji` / `memory_search` / `memory_day` / `memory_timeline` / `delegate` / `gal_choice`
- QQ 私聊端到端、私聊余波、outbox、图片/语音发送、家会话闹钟
- 子代理：`delegate` 起独立 `pi -p` 子进程，零第三方扩展

还没铺开测试：QQ 入站图片/文件、群聊实测、余波并发矩阵、`/new`、语音实际投递、TUI/gal 的完整回归。

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

- **静态世界规则**：`pi/prompt/world.md`（由 `pi/build-prompt.mjs` 从仓库 `modules/*.md` 生成），扩展在 `before_agent_start` 首轮注入一次；
- **动态状态**：`input` 事件把「本地时间 + 心情 + 桥接状态」拼进当前用户消息，不改 system，保护缓存；
- **工具**：`pi.registerTool`，模型直接可见，不需要 opencode 的 `execute` 绕路；
- **归档**：`message_end` 写 `conversations/YYYY-MM-DD.jsonl`；
- **定时器**：只在 `LIFE_WORLD_ROLE=home` 的进程跑，用 `pi.sendMessage(triggerTurn)` 唤醒；
- **子代理**：`delegate` 起独立 `pi -p` 子进程，深度限制 1 层，零第三方。

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
  "subagent": { "model": "deepseek-flash" }
}
```

完整示例见 `pi/config.example.json`。不要用它覆盖已有配置，只合并需要的段。

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

## 已知缺口

- QQ **入站图片/文件**代码已写，未在真实 QQ 回归；
- **群聊**基础版（攒批/判官/冷却/黑名单/群图）未在真实群实测；
- **余波并发矩阵**、`/new`、**语音**实际投递未回归；
- **Prompt 缓存**（静态注入 + 动态 input）未和 opencode 对比；
- **TUI/gal**：`gal_choice` 依赖 `ctx.ui.select`，QQ/RPC 无面板；
- **部署化**：systemd/supervisor、日志轮转、重启恢复未做。

更细的实施记录见 `pi/README.md`；vault 里的评估与 worklog 在 `AI/开发中项目/`。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。
