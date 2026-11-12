# agent-driver（WebView CDP）

本目录由 `project-harness` 生成，仅本机使用。

```bash
node scripts/agent-driver.mjs setup
node scripts/agent-driver.mjs state
node scripts/agent-driver.mjs tap --text 我的
node scripts/agent-driver.mjs input --label 手机号 --value 13800000000
node scripts/agent-driver.mjs wait --route '#/pages/profile/index'
node scripts/agent-driver.mjs run scripts/scenarios/smoke.json
```

- 配置：项目根 `harness.config.json`（`app/package/serial/port/out`）。
- 场景：`scripts/scenarios/*.json`，失败返回 `failedAt/state/logs`。
- 截图：默认 `screen/<app>/<dir>/`，每功能 ≤5 张。
- APK：`bash scripts/build-apk.sh`（需 `ANDROID_JAR`），产物在 `dist/`。
