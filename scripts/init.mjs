#!/usr/bin/env node
// 按当前项目生成一套本地调试/部署工具。默认 dry-run 友好、幂等、不覆盖已有配置。
// 用法：node init.mjs [--root DIR] [--config FILE] [--kind app-webview|backend-service]
//                     [--package PKG] [--serial IP:PORT] [--port N] [--container NAME]
//                     [--with-apk|--no-apk] [--force] [--dry-run]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectProjects, readJson, sh, slug } from './lib.mjs'

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = parse(process.argv.slice(2))
const root = path.resolve(args.root || args._[0] || process.cwd())
const dry = !!args['dry-run']
const force = !!args.force
const actions = []
const needs = []

if (args.config) {
  const cfgPath = path.resolve(args.config)
  const cfg = readJson(cfgPath)
  if (!cfg) fail(`无法读取 ${cfgPath}`)
  const projectRoot = path.dirname(cfgPath)
  apply(cfg.kind === 'app-webview' ? [normalizeApp(cfg, projectRoot)] : [normalizeBackend(cfg, projectRoot)])
} else {
  const detected = detectProjects(root).projects.filter((p) => !args.kind || p.kind === args.kind)
  if (!detected.length) fail('未识别到项目。请确认在项目根目录执行，或显式传 --root/--kind。')
  apply(detected)
}

console.log(JSON.stringify({ ok: true, dryRun: dry, root, actions, needs: [...new Set(needs)] }, null, 2))

function parse(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const k = a.slice(2)
    if (['dry-run', 'force', 'with-apk', 'no-apk'].includes(k)) { out[k] = true; continue }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { out[k] = true; continue }
    out[k] = v; i++
  }
  return out
}

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(2)
}

function normalizeApp(cfg, projectRoot) {
  return {
    ...cfg,
    kind: 'app-webview',
    root: projectRoot,
    app: cfg.app || slug(path.basename(projectRoot)),
    label: cfg.label || cfg.app || path.basename(projectRoot),
    needs: [],
  }
}

function normalizeBackend(cfg, projectRoot) {
  return { ...cfg, kind: 'backend-service', root: projectRoot, services: cfg.services || [], needs: [] }
}

function apply(projects) {
  for (const p of projects) {
    if (p.kind === 'app-webview') initApp(p)
    else if (p.kind === 'backend-service') initBackend(p)
  }
}

function isTracked(file) {
  return !!sh('git', ['-C', path.dirname(file), 'ls-files', '--error-unmatch', path.basename(file)])
}

function write(file, content, mode) {
  const rel = path.relative(root, file) || path.basename(file)
  const tracked = isTracked(file)
  if (fs.existsSync(file) && (tracked || !force)) {
    if (tracked && force) needs.push(`${rel} 已被团队跟踪，--force 也跳过，请手动合并`)
    actions.push({ op: 'skip', file: rel, reason: tracked ? 'tracked' : 'exists' })
    return
  }
  if (dry) {
    actions.push({ op: 'write', file: rel })
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode) fs.chmodSync(file, mode)
  actions.push({ op: 'write', file: rel })
}

function copy(file, dest, mode) {
  const rel = path.relative(root, dest) || path.basename(dest)
  const tracked = isTracked(dest)
  if (fs.existsSync(dest) && (tracked || !force)) {
    if (tracked && force) needs.push(`${rel} 已被团队跟踪，--force 也跳过，请手动合并`)
    actions.push({ op: 'skip', file: rel, reason: tracked ? 'tracked' : 'exists' })
    return
  }
  if (dry) {
    actions.push({ op: 'write', file: rel, from: path.relative(SKILL, file) })
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
  if (mode) fs.chmodSync(dest, mode)
  actions.push({ op: 'write', file: rel, from: path.relative(SKILL, file) })
}

function fill(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || v === null || v === '') continue
    if (target[k] === undefined || target[k] === null || target[k] === '') {
      target[k] = v
    } else if (typeof v === 'object' && !Array.isArray(v) && v) {
      target[k] = fill(target[k] && typeof target[k] === 'object' ? target[k] : {}, v)
    }
  }
  return target
}

function saveConfig(projectRoot, cfg) {
  const file = path.join(projectRoot, 'harness.config.json')
  const existing = readJson(file) || {}
  const merged = fill(existing, cfg)
  const rel = path.relative(root, file) || path.basename(file)
  if (dry) {
    actions.push({ op: 'write', file: rel, merged: true })
    return merged
  }
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`)
  actions.push({ op: 'write', file: rel, merged: true })
  return merged
}

function tpl(name, vars) {
  let s = fs.readFileSync(path.join(SKILL, 'templates', name), 'utf8')
  for (const [k, v] of Object.entries(vars)) s = s.split(`__${k}__`).join(String(v))
  return s
}

function initApp(p) {
  const dir = p.root
  const app = p.app || slug(path.basename(dir))
  const pkg = args.package || p.package
  const serial = args.serial || p.serial
  const port = Number(args.port || p.port || 9222)
  if (!pkg) needs.push(`${app}:package`)
  const cfg = {
    version: 1,
    kind: 'app-webview',
    app,
    label: p.label || app,
    package: pkg || '',
    serial,
    port,
    out: p.out || `./screen/${app}`,
    routePrefix: p.routePrefix || '#/pages',
    build: {
      preset: p.build?.preset && p.build.preset !== 'none' ? p.build.preset : (args['no-apk'] ? 'none' : 'uni-app-apk'),
    },
  }
  saveConfig(dir, cfg)

  copy(path.join(SKILL, 'templates/app-webview/agent-driver.mjs'), path.join(dir, 'scripts/agent-driver.mjs'), 0o755)
  write(path.join(dir, 'scripts/scenarios/smoke.json'), `${JSON.stringify({
    name: 'smoke',
    dir: 'smoke',
    steps: [
      { cmd: 'launch', stop: true },
      { cmd: 'sleep', ms: 800 },
      { cmd: 'state' },
      { cmd: 'assert', route: '#/pages' },
      { cmd: 'shot', name: '01_smoke' },
    ],
  }, null, 2)}\n`)

  const withApk = args['with-apk'] || (cfg.build?.preset === 'uni-app-apk' && !args['no-apk'])
  if (withApk && pkg) {
    copy(path.join(SKILL, 'templates/app-webview/gen-icon.cjs'), path.join(dir, 'scripts/gen-icon.cjs'))
    write(path.join(dir, 'scripts/build-apk.sh'), tpl('app-webview/build-apk.sh.tmpl', {
      PACKAGE: pkg, APP_LABEL: cfg.label, SHIM_NAME: `${app}-shim`, OUTPUT: app,
    }), 0o755)
    write(path.join(dir, 'scripts/MainActivity.java'), tpl('app-webview/MainActivity.java.tmpl', { PACKAGE: pkg }))
    write(path.join(dir, 'scripts/AndroidManifest.xml'), tpl('app-webview/AndroidManifest.xml.tmpl', { PACKAGE: pkg, APP_LABEL: cfg.label }))
  } else if (withApk && !pkg) {
    needs.push(`${app}:package (填写后才能生成 APK 构建文件)`)
  }
  copy(path.join(SKILL, 'templates/app-webview/README.md'), path.join(dir, 'scripts/README.md'))
  const createdAgents = ensureAgentsBlock(dir)

  addExcludes(dir, [
    'harness.config.json',
    'screen/',
    'scripts/agent-driver.mjs',
    'scripts/scenarios/',
    'scripts/README.md',
    'scripts/build-apk.sh',
    'scripts/MainActivity.java',
    'scripts/AndroidManifest.xml',
    'scripts/gen-icon.cjs',
    'scripts/debug.keystore',
    '.harness/',
    ...(createdAgents ? ['AGENTS.md'] : []),
  ])
}

function initBackend(p) {
  const dir = p.root
  const single = (p.services || []).length === 1
  if (args.port && !single) needs.push('多服务时 --port 不生效，请逐服务填写 port')
  const services = (p.services || []).map((s) => ({
    ...s,
    container: args.container || s.container,
    port: Number((single && args.port) || s.port) || null,
    needs: undefined,
  }))
  for (const s of services) {
    if (!s.container) needs.push(`${s.name}:container`)
    if (!s.port) needs.push(`${s.name}:port`)
    if (!s.build) needs.push(`${s.name}:build`)
    if (!s.artifact) needs.push(`${s.name}:artifact`)
  }
  // 旧版本会按 EXPOSE 猜端口，可能两个服务指向同一个健康地址
  const merged = saveConfig(dir, { version: 1, kind: 'backend-service', services })
  for (const [i, a] of (merged.services || []).entries()) {
    const clash = (merged.services || []).slice(i + 1).find((b) => b.health && b.health === a.health)
    if (clash) needs.push(`${a.name} 与 ${clash.name} 的 health 相同（${a.health}），请核对 port`)
  }

  copy(path.join(SKILL, 'scripts/deploy.mjs'), path.join(dir, 'scripts/deploy.mjs'), 0o755)
  copy(path.join(SKILL, 'templates/backend-service/README.md'), path.join(dir, 'scripts/README.md'))
  const createdAgents = ensureAgentsBlock(dir)

  addExcludes(dir, ['harness.config.json', 'scripts/deploy.mjs', 'scripts/README.md', '.harness/', ...(createdAgents ? ['AGENTS.md'] : [])])
}

function ensureAgentsBlock(dir) {
  const file = path.join(dir, 'AGENTS.md')
  const block = fs.readFileSync(path.join(SKILL, 'templates/AGENTS.block.md'), 'utf8')
  const marker = 'project-harness:begin'
  const exists = fs.existsSync(file)
  const current = exists ? fs.readFileSync(file, 'utf8') : ''
  if (current.includes(marker)) return false
  if (exists && sh('git', ['-C', dir, 'ls-files', '--error-unmatch', 'AGENTS.md'])) {
    needs.push(`${path.basename(dir)}:AGENTS.md 已被团队跟踪，请手动追加 templates/AGENTS.block.md`)
    return false
  }
  if (dry) {
    actions.push({ op: 'write', file: path.relative(root, file), block: true })
    return !exists
  }
  fs.writeFileSync(file, exists ? `${current.trimEnd()}\n\n${block}` : block)
  actions.push({ op: 'write', file: path.relative(root, file), block: true })
  return !exists
}

function addExcludes(projectRoot, patterns) {
  let ex = sh('git', ['-C', projectRoot, 'rev-parse', '--git-path', 'info/exclude'])
  if (!ex) return
  if (!path.isAbsolute(ex)) ex = path.resolve(projectRoot, ex)
  const marker = '# >>> project-harness (local-only)'
  const current = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''
  if (current.includes(marker)) return
  // 已跟踪文件不能进 exclude，且这些模式是相对各 worktree 根生效的
  const rels = patterns
    .filter((p) => !sh('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', p.replace(/\/$/, '')]))
    .map((p) => p.replace(/^\.\//, ''))
  const block = `\n${marker}\n${rels.join('\n')}\n# <<< project-harness\n`
  if (dry) {
    actions.push({ op: 'exclude', file: path.relative(projectRoot, ex) || ex, patterns: rels })
    return
  }
  fs.appendFileSync(ex, block)
  actions.push({ op: 'exclude', file: path.relative(projectRoot, ex) || ex, patterns: rels })
}
