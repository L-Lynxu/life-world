# kaomoji.json

`kaomoji` 工具使用的颜文字库：顶层是「分类 → 颜文字数组」。

## 来源

| 项 | 值 |
|---|---|
| npm 包 | `kaomoji-collection`（**MIT**） |
| 上游 | [kaomojiya.org](https://www.kaomojiya.org)（顔文字屋） |
| 版本 | 见同目录 `kaomoji.meta.json` 的 `version` 字段 |
| 处理 | 去掉日文假名、解码 HTML 实体、长度 ≤ 40、分类内去重 |

## 更新

```bash
node ~/.local/share/life-world/bin/kaomoji-update.mjs          # 有新版才更新
node ~/.local/share/life-world/bin/kaomoji-update.mjs --check  # 只看有没有新版
node ~/.local/share/life-world/bin/kaomoji-update.mjs --force  # 版本没变也重建
```

零依赖：只用 Node 内置的 `fetch` / `zlib`，不需要 npm 或 npx。网络不通 npm 官方源时，可加 `--registry https://registry.npmmirror.com` 换镜像。

更新后会写 `kaomoji.meta.json`（版本、来源、条数、更新时间）。插件每次调用工具时比对文件修改时间，**改完自动生效，不用重启**。

>`scripts/kaomoji-update.mjs` 与插件用的是同一套过滤口径；用当前版本 1.0.0 重新生成，输出与本目录的 `kaomoji.json` **逐字节一致**。
