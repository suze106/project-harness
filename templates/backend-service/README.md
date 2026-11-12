# deploy（本地增量部署）

本目录由 `project-harness` 生成，仅本机使用。

```bash
node scripts/deploy.mjs <service> --check   # 只打印计划
node scripts/deploy.mjs <service>           # build → docker cp → restart → health
node scripts/deploy.mjs <service> --logs    # 看容器日志
```

配置在项目根 `harness.config.json` 的 `services[]`：

| 字段 | 说明 |
|---|---|
| `preset` | `go/node/python/java/unknown`，只影响默认值 |
| `container` | 运行中的容器名 |
| `build` | 构建命令，可为空 |
| `artifact` | 构建产物（文件或目录），相对项目根 |
| `dest` | 容器内目标路径 |
| `port` / `health` | 宿主机端口与健康检查 URL |

日常联调优先用它，只有验证 Dockerfile/镜像本身时才 `docker build`。
