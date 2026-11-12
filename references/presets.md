# 后端 preset

语言只是默认值，最终以 `harness.config.json` 的 `build/artifact/dest` 为准。

## go

| 项 | 值 |
|---|---|
| 检测 | `go.mod` |
| build | `CGO_ENABLED=0 GOOS=linux go build -o .harness/<service> ./<main.go 路径>` |
| artifact | `.harness/<service>` |
| dest | `/app/<service>` |
| main.go 探测 | `apps/<service>/cmd/main.go` → `<service>/cmd/main.go` → `cmd/main.go` → `main.go` |

## node

| 项 | 值 |
|---|---|
| 检测 | `package.json` |
| build | `npm ci && npm run build --if-present` |
| artifact | `dist` |
| dest | `/app` |

若项目用 pnpm/yarn，把 `build` 改成对应命令。

## python

| 项 | 值 |
|---|---|
| 检测 | `requirements.txt` / `pyproject.toml` |
| build | `pip install -r requirements.txt --target .harness/deps`（无 requirements 时 `python -m compileall -q .`） |
| artifact | `.harness/deps` |
| dest | `/app` |

## java

| 项 | 值 |
|---|---|
| 检测 | `pom.xml` / `build.gradle` |
| build | `mvn -q -DskipTests package` 或 `./gradlew build -x test` |
| artifact | `target` |
| dest | `/app` |

## unknown

只检测到 Dockerfile 时，`build/artifact` 留空，`init` 会把它们放进 `missing`，必须人工填写。

## 容器与端口

- `container` 优先从 `docker ps` 按服务名匹配。
- `port` 优先取 `docker ps` 的宿主机映射；否则用 Dockerfile `EXPOSE` + `28000` 推断。
- 推断不唯一时留在 `missing`，不要猜。
