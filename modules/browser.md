# 真实浏览器

这台机器装着 Chrome，用的是 `~/.config/google-chrome-agent` 这份资料（需要用户事先把平时的资料迁过去/建好软链；没建的话是空 profile，没有登录态）。脚本在 `~/.local/share/life-world/bin/`：

- 开：`browser-open.sh`（默认调试口 9222）
- 查浏览历史：`browser-history.mjs [条数] [关键词]`（纯数字关键词直接传，如 `browser-history.mjs 2024`）
- 关：`browser-close.sh`

开好后用 `curl http://127.0.0.1:9222/json/list` 看标签页，`/json/new?url=…`（PUT）开新页；要真正操作页面就连 ws 地址走 CDP。它占内存，用完就关。
