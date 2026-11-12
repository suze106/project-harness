---
name: Project Harness
description: 为一个新项目初始化本机专用的调试/构建/部署工具：WebView CDP 驱动、场景脚本、APK 构建、后端增量部署。全部 local-only，不提交团队仓库。
---

# Project Harness

给当前项目生成一套“这个项目专属”的本地工具，产物与 metabot_robot 那套一致，但配置按项目自动检测。

## 什么时候用

- 新项目要接自动调试：模拟器/真机 + App 页面验证。
- 新后端要接增量部署：本地编译 → docker cp → restart。
- 已有项目想补齐 `state/tap/wait/run` 场景化调试。

## 两个适配器

| 适配器 | 适用 | 产物 |
|---|---|---|
| `app-webview` | uni-app / H5 / WebView App | `scripts/agent-driver.mjs`、`scripts/scenarios/smoke.json`、可选 `build-apk.sh` + Android 壳 |
| `backend-service` | 任意语言的后端（Docker 运行） | `scripts/deploy.mjs`、`harness.config.json` |

后端语言只是 preset：`go / node / python / java / unknown`，部署契约相同。

## 工作流

在项目根目录（或包含多个仓库的工作区根目录）执行：

本文件里的 `scripts/...`、`templates/...` 都相对本 skill 目录。skill 加载时会给出它的 base directory，下文用 `$SKILL_DIR` 代指，命令都在目标项目根目录执行：

```bash
# 1. 只读检测
node "$SKILL_DIR/scripts/detect.mjs"

# 2. 看计划，不写文件
node "$SKILL_DIR/scripts/init.mjs" --dry-run

# 3. 生成
node "$SKILL_DIR/scripts/init.mjs"
```

`detect.mjs` 输出 `projects[]` 和 `missing[]`。只问 `missing` 里的值，不猜：

- App：`package`（Android 包名）
- 后端：`container`、`port`、`build`、`artifact`

补齐后重跑 `init.mjs`，已存在的文件默认跳过，配置按字段合并。要更新已生成的脚本/模板用 `--force`（配置仍按字段合并，不会丢你手填的值）。

`--force` 也不会覆盖团队已跟踪的文件：`AGENTS.md`、`scripts/README.md` 这类已被跟踪的文件一律跳过，并在 `needs` 里提示手动合并。

## 验证

App：

```bash
node scripts/agent-driver.mjs setup
node scripts/agent-driver.mjs run scripts/scenarios/smoke.json
```

后端：

```bash
node scripts/deploy.mjs <service> --check
node scripts/deploy.mjs <service>          # 真实部署
node scripts/deploy.mjs <service> --logs
```

`--check` 只打印计划，不 build、不碰容器。想验证脚本本身而不动真实服务时，用一次性容器：

```bash
docker run -d --name harness-deploy-test alpine sleep 300
node scripts/deploy.mjs <service> --config /tmp/test.json   # 该配置里 container 指向测试容器
docker rm -f harness-deploy-test
```

## local-only 规则（强制）

- 所有生成物写入项目仓库的 `.git/info/exclude`，`git status` 看不到，`git add -A` 也不会带上。
- 不修改团队已跟踪的文件；`AGENTS.md` 已跟踪时只提示手动追加，不自动改。
- 不自动 commit、不 push。
- Skill 本身留在 skill 源目录（本机是 `~/agent-skills/`），不进业务仓库。

## 配置

项目根 `harness.config.json`，详见 `references/config-schema.md`。
预设命令见 `references/presets.md`。

## 维护这个 skill

改 `scripts/lib.mjs` / `scripts/init.mjs` 后跑一次 `node "$SKILL_DIR/scripts/selftest.mjs"`。它造假仓库做断言，不连设备也不碰容器。

## 边界

- App 适配器只覆盖 WebView；原生选图/相机/推送/崩溃仍用 adb/logcat。
- 后端适配器默认 Docker 容器模式；进程直跑（systemd/pm2）暂不支持。
- 检测不到的关键值会留在 `missing`，不要瞎填。
