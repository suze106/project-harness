#!/usr/bin/env node
// 检测/初始化的自检：造假项目，断言结果。改 lib.mjs 或 init.mjs 后跑一次。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { detectProjects } from './lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-selftest-'))
const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) })
const mk = (dir, files) => {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
}

// 1) uni-app 仓库：识别成 app，且不再顺带识别成 node 后端
const app = path.join(tmp, 'metabot_app_member')
mk(app, {
  'manifest.json': JSON.stringify({ name: '家属端' }),
  'pages.json': '{}',
  'scripts/AndroidManifest.xml': '<manifest package="com.demo.family"></manifest>',
})
const appProjects = detectProjects(app).projects
check('app: 只识别一个项目', appProjects.length === 1, appProjects.map((p) => p.kind))
check('app: kind=app-webview', appProjects[0]?.kind === 'app-webview')
check('app: 仓库名去前缀', appProjects[0]?.app === 'member', appProjects[0]?.app)
check('app: 包名来自 Manifest', appProjects[0]?.package === 'com.demo.family', appProjects[0]?.package)

// 2) Go 多服务仓库：过滤 base 镜像和根 Dockerfile，端口不猜
const srv = path.join(tmp, 'zz_server')
mk(srv, {
  'go.mod': 'module zz\n',
  'Dockerfile': 'FROM scratch\nEXPOSE 8080\n',
  'Dockerfile.base': 'FROM golang\n',
  'Dockerfile.zz-api.local': 'FROM scratch\n',
  'apps/zz-api/Dockerfile': 'FROM scratch\nEXPOSE 8080\n',
  'apps/zz-api/cmd/main.go': 'package main\nfunc main() {}\n',
})
const srvProjects = detectProjects(srv).projects
const services = srvProjects.filter((p) => p.kind === 'backend-service').flatMap((p) => p.services)
check('server: 只识别一个项目', srvProjects.length === 1, srvProjects.map((p) => p.kind))
check('server: 只保留真实服务', services.map((s) => s.name).join(',') === 'zz-api', services.map((s) => s.name))
check('server: preset=go', services[0]?.preset === 'go')
check('server: build 指向真实 main', /apps\/zz-api\/cmd\/main\.go$/.test(services[0]?.build || ''), services[0]?.build)
check('server: 没有 docker ps 映射就不猜端口', services[0]?.port === null, services[0]?.port)
check('server: 端口缺失去 needs', services[0]?.needs?.includes('port'))

// 3) 空目录：不产生项目
const empty = path.join(tmp, 'empty')
fs.mkdirSync(empty)
check('empty: 无项目', detectProjects(empty).projects.length === 0)

// 4) dry-run 不写文件
execFileSync(process.execPath, [path.join(HERE, 'init.mjs'), '--dry-run', '--root', srv], { stdio: 'ignore' })
check('dry-run: 不生成配置', !fs.existsSync(path.join(srv, 'harness.config.json')))
check('dry-run: 不生成脚本', !fs.existsSync(path.join(srv, 'scripts/deploy.mjs')))

// 5) --force 不覆盖团队已跟踪文件
const readme = path.join(srv, 'scripts/README.md')
mk(srv, { 'scripts/README.md': 'team readme\n' })
const git = (...a) => execFileSync('git', ['-C', srv, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { stdio: 'ignore' })
git('init', '-q')
git('add', '-A')
git('commit', '-qm', 'init')
const out = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'init.mjs'), '--force', '--root', srv], { encoding: 'utf8' }))
check('force: 已跟踪的 README 内容不变', fs.readFileSync(readme, 'utf8') === 'team readme\n')
check('force: 跳过原因写进 needs', out.needs.some((n) => n.includes('scripts/README.md')), out.needs)
check('force: 未跟踪文件照常生成', fs.existsSync(path.join(srv, 'scripts/deploy.mjs')))

const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks, failed }, null, 2))
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
