#!/usr/bin/env node
// 通用后端增量部署：build → docker cp → 替换 → restart → health。
// 语言无关，Go/Node/Python/Java 都走同一套；差异只在 harness.config.json 的 build/artifact。
// 用法：node deploy.mjs [service] [--config FILE] [--check] [--logs] [--no-restart]
//                       [--dest PATH] [--tail N]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'

const args = parse(process.argv.slice(2))
const cfgPath = path.resolve(args.config || 'harness.config.json')
const cfg = readJson(cfgPath)
if (!cfg) fail(`找不到配置: ${cfgPath}`)
const base = path.dirname(cfgPath)
const services = cfg.services || []
const name = args._[0]
const svc = name ? services.find((s) => s.name === name) : services.length === 1 ? services[0] : null
if (!svc) fail(`请指定服务名，可选: ${services.map((s) => s.name).join(', ') || '(空)'}`)

const dest = args.dest || svc.dest || `/app/${svc.name}`
const plan = {
  service: svc.name,
  preset: svc.preset || 'unknown',
  container: svc.container,
  build: svc.build || '(跳过)',
  artifact: svc.artifact ? path.resolve(base, svc.artifact) : '(未配置)',
  dest,
  restart: args['no-restart'] ? false : svc.restart !== false,
  health: svc.health || null,
}

if (args.logs) {
  if (!svc.container) fail(`${svc.name}: 未配置 container`)
  execFileSync('docker', ['logs', '--tail', String(args.tail || 80), svc.container], { stdio: 'inherit' })
  process.exit(0)
}

if (args.check) {
  console.log(JSON.stringify({ ok: true, check: true, plan }, null, 2))
  process.exit(0)
}

if (!svc.container) fail(`${svc.name}: 未配置 container，请先填写 harness.config.json`)

const t0 = Date.now()
const timings = {}
let step = Date.now()

if (svc.build) {
  try {
    execSync(svc.build, { cwd: base, stdio: 'inherit', shell: '/bin/bash' })
  } catch {
    fail(`构建失败: ${svc.build}`)
  }
  timings.buildMs = Date.now() - step
}

const artifact = svc.artifact ? path.resolve(base, svc.artifact) : ''
if (artifact && !fs.existsSync(artifact)) fail(`构建产物不存在: ${artifact}`)
step = Date.now()

if (artifact) {
  const tmp = `${dest}.new`
  try {
    execFileSync('docker', ['exec', svc.container, 'sh', '-c',
      `mkdir -p '${path.posix.dirname(dest)}' && rm -rf '${tmp}'`], { stdio: 'ignore' })
    execFileSync('docker', ['cp', artifact, `${svc.container}:${tmp}`], { stdio: 'inherit' })
    execFileSync('docker', ['exec', svc.container, 'sh', '-c',
      `if [ -d '${tmp}' ]; then rm -rf '${dest}' && mv '${tmp}' '${dest}'; else chmod +x '${tmp}' && mv -f '${tmp}' '${dest}'; fi`], { stdio: 'inherit' })
  } catch (err) {
    fail(`替换 ${svc.container}:${dest} 失败: ${String(err.message).split('\n')[0]}`)
  }
  timings.copyMs = Date.now() - step
}

step = Date.now()
if (plan.restart) {
  try {
    execFileSync('docker', ['restart', svc.container], { stdio: 'ignore' })
  } catch {
    fail(`重启 ${svc.container} 失败`)
  }
  timings.restartMs = Date.now() - step
}

let ready = null
if (svc.health) {
  step = Date.now()
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(svc.health, { signal: AbortSignal.timeout(1500) })
      if (res.status < 500) { ready = res.status; break }
    } catch {
      // retry
    }
    await sleep(300)
  }
  timings.healthMs = Date.now() - step
}

console.log(JSON.stringify({
  ok: ready !== null || !svc.health,
  service: svc.name,
  container: svc.container,
  dest,
  ready,
  elapsedMs: Date.now() - t0,
  timings,
}, null, 2))

function parse(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const k = a.slice(2)
    if (['check', 'logs', 'no-restart'].includes(k)) { out[k] = true; continue }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { out[k] = true; continue }
    out[k] = v; i++
  }
  return out
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(2)
}
