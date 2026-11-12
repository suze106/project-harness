# project-harness

给一个项目生成“这个项目专属、只在本机用”的调试/构建/部署工具：WebView CDP 驱动、场景脚本、APK 构建、后端增量部署。生成物写进项目仓库的 `.git/info/exclude`，`git status` 看不见，也不会被 `git add -A` 带走。

## 安装

skill 目录（含 `SKILL.md`）放进任意一个 skills 源即可，ID 由目录名决定，即 `project-harness`：

```bash
# opencode 全局
cp -r project-harness ~/.config/opencode/skills/

# 或在 opencode.json 里加目录源
{ "skills": ["~/agent-skills"] }

# Claude Code（同款目录约定）
cp -r project-harness ~/.claude/skills/
```

`SKILL.md` 正文里的路径都相对该目录，装到哪里都不用改。

## 用

在目标项目根目录执行：

```bash
node "$SKILL_DIR/scripts/detect.mjs"        # 只读：识别项目类型，列出待填项
node "$SKILL_DIR/scripts/init.mjs" --dry-run  # 看计划，不写文件
node "$SKILL_DIR/scripts/init.mjs"            # 生成
```

`$SKILL_DIR` = 本目录（skill 加载时由 harness 提供）。`detect` 输出里 `missing[]` 的字段不猜，补齐后重跑 `init`；已存在的文件跳过，配置按字段合并，`--force` 更新脚本但不会覆盖团队已跟踪的文件。

生成后：

```bash
node scripts/agent-driver.mjs run scripts/scenarios/smoke.json   # App
node scripts/deploy.mjs <service> --check                       # 后端
```

## 文件

| 路径 | 作用 |
|---|---|
| `SKILL.md` | 给 agent 的入口与工作流 |
| `scripts/detect.mjs` | 只读识别 App / 后端与待填字段 |
| `scripts/init.mjs` | 生成配置、驱动、场景、APK 构建、部署脚本、AGENTS 片段 |
| `scripts/deploy.mjs` | 通用后端增量部署（build → docker cp → restart → health） |
| `scripts/selftest.mjs` | 造假仓库自检，16 项断言，不连设备不碰容器 |
| `templates/app-webview/` | 驱动、APK 构建、Android 壳模板 |
| `templates/backend-service/` | 部署说明模板 |
| `references/` | 配置字段与语言预设 |

改了 `lib.mjs` / `init.mjs` 之后跑一次 `node scripts/selftest.mjs`。

## 边界

- App 适配器只管 WebView；原生选图/相机/推送/崩溃仍靠 adb / logcat。
- 后端默认 Docker 容器模式，不支持进程直跑（systemd/pm2）。
- 端口只认容器真实映射，推断不出来就留空，交给人填。
