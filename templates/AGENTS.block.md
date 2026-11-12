# 本机调试工具（local-only，勿提交）

<!-- project-harness:begin -->
- 调试优先用 `scripts/agent-driver.mjs`（WebView CDP）：`state/tap/input/wait/run`，不要“一步一张截图”。
- 一个验证场景写成 `scripts/scenarios/*.json`，用 `node scripts/agent-driver.mjs run <场景>` 一次跑完。
- 默认不截图；需要判断视觉/原生弹窗时才 `shot`，每个功能 ≤5 张。
- 不用裸 `sleep`，用 `wait --text/--route`；不要每步 force-stop。
- 失败先读 driver 返回的 `state.text/inputs/actions/logs`。
- 后端日常联调用 `node scripts/deploy.mjs <service>`（build → docker cp → restart → health），不要每次完整 `docker build`。
- 这些文件只在本机使用，已写入 `.git/info/exclude`，不要提交。
<!-- project-harness:end -->
