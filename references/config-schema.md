# harness.config.json

项目根一份，`version: 1`。App 与后端二选一。

## app-webview

```json
{
  "version": 1,
  "kind": "app-webview",
  "app": "member",
  "label": "阳光养老院家属端",
  "package": "com.sunshinecare.family",
  "serial": "10.58.148.151:5555",
  "port": 9222,
  "out": "./screen/member",
  "routePrefix": "#/pages",
  "build": { "preset": "uni-app-apk" }
}
```

| 字段 | 说明 |
|---|---|
| `app` | 截图目录名 |
| `package` | Android 包名 |
| `serial` | 模拟器/真机地址 |
| `port` | CDP 本地端口；同时跑两个 App 时错开（9222/9223） |
| `out` | 截图根目录，相对项目根 |
| `routePrefix` | 路由前缀，用于 `wait --route` |
| `build.preset` | `uni-app-apk` 或 `none` |

## backend-service

```json
{
  "version": 1,
  "kind": "backend-service",
  "services": [
    {
      "name": "tenant-api",
      "preset": "go",
      "container": "tenant-api-avatar",
      "port": 28082,
      "health": "http://127.0.0.1:28082/api/",
      "build": "CGO_ENABLED=0 GOOS=linux go build -o .harness/tenant-api ./apps/tenant-api/cmd/main.go",
      "artifact": ".harness/tenant-api",
      "dest": "/app/tenant-api",
      "restart": true
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `preset` | `go/node/python/java/unknown`，只影响默认值 |
| `container` | 运行中的容器名 |
| `build` | 构建命令，可为空 |
| `artifact` | 构建产物（文件或目录），相对项目根 |
| `dest` | 容器内目标路径 |
| `port` / `health` | 宿主机端口与健康检查 URL |
| `restart` | 替换后是否重启，默认 true |

## 场景文件

`scripts/scenarios/*.json`：

```json
{
  "name": "smoke",
  "dir": "smoke",
  "steps": [
    { "cmd": "launch", "stop": true },
    { "cmd": "sleep", "ms": 800 },
    { "cmd": "tap", "text": "我的" },
    { "cmd": "wait", "route": "#/pages/profile/index", "timeout": 6 },
    { "cmd": "assert", "text": "我的" },
    { "cmd": "shot", "name": "01_profile" }
  ]
}
```

支持：`launch/state/tap/input/wait/assert/shot/scroll/back/key/eval/sleep`。
失败返回 `failedAt / failedStep / state / logs`，退出码 1；环境错误退出码 2。
