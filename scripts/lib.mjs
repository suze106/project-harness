// 共享检测逻辑：识别 uni-app / 后端服务，推断可自动填的配置。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

export function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

export function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'
}

export function appSlug(dir) {
  const base = path.basename(dir).toLowerCase()
  const short = base.replace(/^metabot[-_]app[-_]/, '').replace(/^app[-_]/, '')
  return slug(short)
}

export function projectBaseName(dir) {
  const common = sh('git', ['-C', dir, 'rev-parse', '--git-common-dir'])
  if (!common) return path.basename(dir)
  const abs = path.isAbsolute(common) ? common : path.resolve(dir, common)
  return path.basename(path.dirname(abs))
}

export function firstDevice() {
  const out = sh('adb', ['devices'])
  const line = out.split(/\r?\n/).slice(1).find((l) => /\bdevice\b/.test(l))
  return line ? line.split(/\s+/)[0] : ''
}

export function detectApp(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'))
  const pages = readJson(path.join(dir, 'pages.json'))
  if (!manifest || !pages) return null
  const label = manifest.name || path.basename(dir)
  const repoRoot = sh('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
  const atRepoRoot = repoRoot && path.resolve(repoRoot) === path.resolve(dir)
  const app = appSlug(atRepoRoot ? projectBaseName(dir) : path.basename(dir))
  let pkg = null
  for (const f of ['scripts/AndroidManifest.xml', 'AndroidManifest.xml', 'android/app/src/main/AndroidManifest.xml']) {
    const p = path.join(dir, f)
    if (!isFile(p)) continue
    const m = fs.readFileSync(p, 'utf8').match(/package="([^"]+)"/)
    if (m) { pkg = m[1]; break }
  }
  const hasApk = isFile(path.join(dir, 'scripts/build-apk.sh'))
  return {
    kind: 'app-webview',
    root: dir,
    app,
    label,
    package: pkg,
    serial: process.env.ANDROID_SERIAL || firstDevice() || '127.0.0.1:5555',
    port: 9222,
    out: `./screen/${app}`,
    routePrefix: '#/pages',
    build: { preset: hasApk ? 'uni-app-apk' : 'none' },
    needs: pkg ? [] : ['package'],
  }
}

export function detectPreset(dir, root) {
  let d = dir
  while (d.startsWith(root)) {
    if (isFile(path.join(d, 'go.mod'))) return 'go'
    if (isFile(path.join(d, 'pom.xml')) || isFile(path.join(d, 'build.gradle')) || isFile(path.join(d, 'build.gradle.kts'))) return 'java'
    if (isFile(path.join(d, 'pyproject.toml')) || isFile(path.join(d, 'requirements.txt'))) return 'python'
    if (isFile(path.join(d, 'package.json'))) return 'node'
    if (d === root) break
    d = path.dirname(d)
  }
  return 'unknown'
}

export function findDockerfiles(root, maxDepth = 3) {
  const out = []
  const walk = (dir, depth) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'vendor') continue
      const p = path.join(dir, e.name)
      if (e.isFile() && /^(Dockerfile(\..+)?|.+\.Dockerfile)$/.test(e.name)) out.push(p)
      else if (e.isDirectory() && depth < maxDepth && !/^(deploy|web|docs|tests?|scripts|static)$/.test(e.name)) walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

export function serviceName(file, root) {
  const base = path.basename(file)
  if (base.startsWith('Dockerfile.')) return base.slice('Dockerfile.'.length)
  if (base.endsWith('.Dockerfile')) return base.slice(0, -'.Dockerfile'.length)
  const parent = path.dirname(file)
  return parent === root ? path.basename(root) : path.basename(parent)
}

export function findMainGo(root, service) {
  const candidates = [
    `apps/${service}/cmd/main.go`,
    `${service}/cmd/main.go`,
    `apps/${service}/main.go`,
    `${service}/main.go`,
    'cmd/main.go',
    'main.go',
  ]
  return candidates.find((c) => isFile(path.join(root, c))) || ''
}

export function dockerPs() {
  const out = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'])
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, ports = ''] = line.split('\t')
    const m = ports.match(/(?:0\.0\.0\.0:|\[::\]:)(\d+)->(\d+)\//)
    return { name, hostPort: m ? Number(m[1]) : null, containerPort: m ? Number(m[2]) : null, ports }
  })
}

export function detectBackend(dir) {
  let dockerfiles = findDockerfiles(dir).filter((f) => {
    const b = path.basename(f)
    return !/base/i.test(b) && !/\.(local|dev|test|prod|online|debug|staging)$/i.test(b)
  })
  // 有多个 Dockerfile 时，跳过根目录的通用 Dockerfile
  if (dockerfiles.length > 1) {
    dockerfiles = dockerfiles.filter((f) => path.dirname(f) !== dir || path.basename(f) !== 'Dockerfile')
  }
  if (!dockerfiles.length) {
    const preset = detectPreset(dir, dir)
    if (preset === 'unknown') return null
    dockerfiles.push(path.join(dir, 'Dockerfile'))
  }
  const ps = dockerPs()
  const seen = new Map()
  for (const file of dockerfiles) {
    const name = serviceName(file, dir)
    if (seen.has(name)) continue
    if (/(^|-)(web|frontend|nginx|static|docs?)$/i.test(name)) continue
    const preset = detectPreset(path.dirname(file), dir)
    const mainGo = preset === 'go' ? findMainGo(dir, name) : ''
    const container = ps.find((p) => p.name.includes(name))?.name || null
    const hostPort = ps.find((p) => p.name.includes(name))?.hostPort || null
    // 端口只认 docker ps 的真实映射；猜出来的端口会让健康检查打到别的服务
    const port = hostPort
    const artifact = preset === 'go' ? `.harness/${name}` : preset === 'node' ? 'dist' : preset === 'python' ? '.harness/deps' : preset === 'java' ? 'target' : ''
    const build = preset === 'go' && mainGo
      ? `CGO_ENABLED=0 GOOS=linux go build -o .harness/${name} ./${mainGo}`
      : preset === 'node'
        ? 'npm ci && npm run build --if-present'
        : preset === 'python'
          ? (isFile(path.join(dir, 'requirements.txt')) ? 'pip install -r requirements.txt --target .harness/deps' : 'python -m compileall -q .')
          : preset === 'java'
            ? (isFile(path.join(dir, 'pom.xml')) ? 'mvn -q -DskipTests package' : './gradlew build -x test')
            : ''
    const dest = preset === 'go' ? `/app/${name}` : '/app'
    const needs = []
    if (!container) needs.push('container')
    if (!port) needs.push('port')
    if (!build) needs.push('build')
    if (!artifact) needs.push('artifact')
    seen.set(name, {
      name,
      preset,
      container,
      port,
      health: port ? `http://127.0.0.1:${port}/` : null,
      build,
      artifact,
      dest,
      restart: true,
      ...(isFile(file) ? { dockerfile: path.relative(dir, file) } : {}),
      needs,
    })
  }
  return {
    kind: 'backend-service',
    root: dir,
    services: [...seen.values()],
    needs: [...new Set([...seen.values()].flatMap((s) => s.needs))],
  }
}

export function hasProjectMarkers(dir) {
  if (isFile(path.join(dir, 'manifest.json')) && isFile(path.join(dir, 'pages.json'))) return true
  if (['go.mod', 'package.json', 'requirements.txt', 'pyproject.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts'].some((f) => isFile(path.join(dir, f)))) return true
  try {
    return fs.readdirSync(dir).some((f) => /^(Dockerfile(\..+)?|.+\.Dockerfile)$/.test(f))
  } catch {
    return false
  }
}

export function detectProjects(cwd) {
  const roots = [cwd]
  try {
    for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(cwd, e.name)
      if (hasProjectMarkers(p)) roots.push(p)
    }
  } catch {
    // ignore
  }
  const projects = []
  for (const root of roots) {
    if (!hasProjectMarkers(root)) continue
    const app = detectApp(root)
    if (app) {
      projects.push(app)
      continue
    }
    const backend = detectBackend(root)
    if (backend && backend.services.length) projects.push(backend)
  }
  return { ok: true, cwd, projects }
}
