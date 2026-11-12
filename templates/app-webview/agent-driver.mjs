#!/usr/bin/env node
/**
 * agent-driver.mjs — 用 WebView CDP 驱动 Android App 的轻量工具（零依赖，Node 18+）。
 *
 * 目标：把「adb 点一下 → 截一张图 → 模型看一眼」换成
 *       「一次调用跑完一个场景 → 只返回几十行文本」。
 *
 * 常用命令：
 *   node scripts/agent-driver.mjs state
 *   node scripts/agent-driver.mjs tap --text 我的
 *   node scripts/agent-driver.mjs input --placeholder 请输入手机号 --value 13800000000
 *   node scripts/agent-driver.mjs wait --text 首页 --timeout 8
 *   node scripts/agent-driver.mjs shot --name 01_home --width 360
 *   node scripts/agent-driver.mjs run scripts/scenarios/smoke.json
 *
 * 说明：
 * - 优先输出 DOM 文本/路由，不要截图；截图只在需要判断视觉时用。
 * - 所有命令输出一行 JSON，退出码 0=成功，1=断言失败，2=环境错误。
 * - 设备默认 10.58.148.151:5555，可用 --serial 或 ANDROID_SERIAL 覆盖。
 * - App 包名/端口在 harness.config.json 中配置，--package/--port 可覆盖。
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HELP = `agent-driver.mjs — WebView CDP 驱动

命令:
  setup                        检查设备/唤醒/建立 CDP 转发
  launch [--stop]              启动 App 并等待 WebView
  state [--text-limit N]       输出路由/可见文字/输入框/可点元素/错误
  tap --text T [--index N]     按文字点击（真实触摸）
  tap --selector S             按 CSS 选择器点击
  tap --xy X,Y                 按坐标点击
  input (--placeholder T | --label T | --selector S) --value V [--submit]
  wait (--text T | --route R | --gone T) [--timeout 8]
  shot [--name N] [--dir D] [--width 360] [--quality 60]
  scroll [--dy 400]            向下滚动（负值向上）
  back                         返回
  key --name Enter             发送按键
  eval --expr '...'            在页面执行 JS
  logs [--clear]               控制台/异常/网络错误
  logcat [--lines 80]          adb logcat 中与 App/Chromium 相关的最近日志
  run <scenario.json>          一次跑完一个场景

全局参数:
  --serial IP:PORT   默认 harness.config.json 或 ANDROID_SERIAL
  --package NAME     默认 harness.config.json
  --port N           CDP 本地端口，默认 harness.config.json
  --config FILE      指定配置，默认 ./harness.config.json
  --out DIR          截图根目录，默认 <cwd>/screen/<app>/<dir>
  --help
`

// ---------------------------------------------------------------------------
// 参数与配置
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    if (key === 'help' || key === 'stop' || key === 'submit' || key === 'clear' || key === 'check') {
      out[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i++
  }
  return out
}

function loadConfig() {
  const candidates = [
    args.config && path.resolve(process.cwd(), args.config),
    path.resolve(process.cwd(), 'harness.config.json'),
    path.resolve(process.cwd(), 'scripts/agent-driver.json'),
  ].filter(Boolean)
  const file = candidates.find((f) => fs.existsSync(f))
  if (!file) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`读取 ${file} 失败: ${err.message}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
if (!command || args.help) {
  console.log(HELP)
  process.exit(command ? 0 : 2)
}

const cfg = loadConfig()
const serial = args.serial || process.env.ANDROID_SERIAL || cfg.serial || firstDevice() || '127.0.0.1:5555'
const port = Number(args.port || cfg.port || 9222)
const textLimit = Number(args['text-limit'] || 2000)
const appName = cfg.app || path.basename(process.cwd())

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function fail(message, code = 2) {
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(code)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function adb(argv, opts = {}) {
  try {
    return execFileSync('adb', ['-s', serial, ...argv], {
      encoding: 'utf8',
      timeout: opts.timeout || 15000,
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    if (opts.ignoreError) return ''
    const stderr = (err.stderr || '').toString().trim()
    throw new Error(`adb ${argv.join(' ')} 失败: ${stderr || err.message}`)
  }
}

function adbQuiet(argv) {
  return adb(argv, { stdio: 'ignore', ignoreError: true })
}

function resolvePackage() {
  if (args.package) return args.package
  if (cfg.package) return cfg.package
  const out = adb(['shell', 'pm', 'list', 'packages', '-3'], { ignoreError: true })
  const packages = out
    .split(/\r?\n/)
    .map((line) => line.replace(/^package:/, '').trim())
    .filter(Boolean)
  const candidates = packages.filter((p) => /sunshine|chaoyang|metabot|care|family|member|staff/i.test(p))
  if (candidates.length === 1) return candidates[0]
  throw new Error(
    `无法确定 App 包名，请在 harness.config.json 配置 package。已安装: ${packages.join(', ') || '(空)'}`,
  )
}

const pkg = command === 'logcat' ? null : resolvePackage()

function deviceOnline() {
  const out = adb(['devices'], { ignoreError: true })
  return out
    .split(/\r?\n/)
    .slice(1)
    .some((line) => line.startsWith(serial) && /\bdevice\b/.test(line))
}

function ensureDevice() {
  if (deviceOnline()) return
  adbQuiet(['connect', serial])
  if (!deviceOnline()) throw new Error(`设备未连接: ${serial}。先确认模拟器已启动，或 adb connect ${serial}`)
}

function ensureForward() {
  const pid = adb(['shell', 'pidof', pkg], { ignoreError: true }).trim()
  if (!pid) throw new Error(`App 未运行: ${pkg}。先执行 launch`)
  adbQuiet(['forward', '--remove', `tcp:${port}`])
  adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`])
  return pid
}

function repoRoot() {
  let dir = process.cwd()
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
}

function defaultOutDir(dirName) {
  const sub = dirName || `driver_${today()}`
  if (cfg.out) return path.resolve(process.cwd(), cfg.out, sub)
  return path.resolve(process.cwd(), 'screen', appName, sub)
}

function firstDevice() {
  try {
    const out = execFileSync('adb', ['devices'], { encoding: 'utf8', timeout: 5000 })
    const line = out.split(/\r?\n/).slice(1).find((l) => /\bdevice\b/.test(l))
    return line ? line.split(/\s+/)[0] : ''
  } catch {
    return ''
  }
}

function today() {
  const d = new Date()
  const yy = String(d.getFullYear()).slice(2)
  return `${yy}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.logs = []
    this.networkUrls = new Map()
    this.closed = false
  }

  async connect(timeout = 15000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`)
        const list = await res.json()
        const page = list.find((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''))
        if (page && page.webSocketDebuggerUrl) {
          await this._open(page.webSocketDebuggerUrl)
          return page
        }
      } catch {
        // 继续重试
      }
      await sleep(300)
    }
    throw new Error(`找不到 WebView CDP 页面（端口 ${port}）。确认 App 已启动且 setWebContentsDebuggingEnabled(true)`)
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('CDP WebSocket 连接失败'))
      }
      ws.onclose = () => {
        this.closed = true
        for (const { reject: rj, timer: t } of this.pending.values()) {
          clearTimeout(t)
          rj(new Error('CDP 连接已关闭'))
        }
        this.pending.clear()
      }
      ws.onmessage = (event) => this._onMessage(event.data)
    })
  }

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      clearTimeout(timer)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'}`))
      else resolve(msg.result || {})
      return
    }
    if (!msg.method) return
    this.events.push(msg)
    const params = msg.params || {}
    switch (msg.method) {
      case 'Runtime.consoleAPICalled': {
        const text = (params.args || [])
          .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
          .join(' ')
        this._pushLog({ type: `console.${params.type}`, text: String(text).slice(0, 500) })
        break
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {}
        this._pushLog({
          type: 'exception',
          text: `${d.text || ''} ${d.exception?.description || ''}`.trim().slice(0, 800),
        })
        break
      }
      case 'Log.entryAdded': {
        const e = params.entry || {}
        this._pushLog({ type: `log.${e.level}`, text: String(e.text || '').slice(0, 500) })
        break
      }
      case 'Network.requestWillBeSent': {
        const r = params.request || {}
        this.networkUrls.set(params.requestId, r.url)
        break
      }
      case 'Network.loadingFailed': {
        const url = this.networkUrls.get(params.requestId) || ''
        this._pushLog({
          type: 'network.failed',
          text: `${params.errorText || 'failed'} ${url}`.slice(0, 500),
        })
        break
      }
      case 'Network.responseReceived': {
        const r = params.response || {}
        if (r.status >= 400) {
          this._pushLog({ type: `http.${r.status}`, text: r.url || '' })
        }
        break
      }
      default:
        break
    }
  }

  _pushLog(entry) {
    if (this.logs.length > 300) this.logs.shift()
    this.logs.push({ t: Date.now(), ...entry })
  }

  send(method, params = {}, timeout = 8000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 调用超时: ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async enable() {
    await Promise.all([
      this.send('Runtime.enable').catch(() => {}),
      this.send('Log.enable').catch(() => {}),
      this.send('Network.enable').catch(() => {}),
    ])
    await this.evaluate(`(() => {
      if (window.__agent && window.__agent.v === 1) return 'ok'
      window.__agent = { v: 1, errors: [] }
      window.addEventListener('error', (e) => {
        window.__agent.errors.push(String(e.message || e.error || 'error').slice(0, 300))
        if (window.__agent.errors.length > 50) window.__agent.errors.shift()
      })
      window.addEventListener('unhandledrejection', (e) => {
        window.__agent.errors.push(String(e.reason || 'rejection').slice(0, 300))
      })
      return 'ok'
    })()`).catch(() => {})
  }

  async evaluate(expression, { awaitPromise = true, userGesture = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture,
    })
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(`页面 JS 异常: ${d.text || ''} ${d.exception?.description || ''}`.trim())
    }
    return res.result?.value
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
  }
}

async function connect() {
  ensureDevice()
  ensureForward()
  const cdp = new CDP()
  await cdp.connect()
  await cdp.enable()
  return cdp
}

// ---------------------------------------------------------------------------
// 页面查询脚本
// ---------------------------------------------------------------------------

const HELPERS = `
  const __vis = (e) => {
    const s = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0
  };
  const __rect = (e) => {
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  };
  const __ownText = (e) => [...e.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.trim())
    .filter(Boolean)
    .join(' ');
  const __depth = (e) => { let d = 0; while (e.parentElement) { d++; e = e.parentElement; } return d };
  const __area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height };
  const __clickable = (e) => {
    let n = e;
    let d = 0;
    while (n && d < 4) {
      const c = typeof n.className === 'string' ? n.className : '';
      if (
        ['BUTTON', 'A', 'UNI-BUTTON'].includes(n.tagName) ||
        /btn|button|tabbar|nav|cell|item|action|link|clickable/i.test(c) ||
        n.getAttribute?.('role') === 'button' ||
        typeof n.onclick === 'function'
      ) return true;
      n = n.parentElement;
      d++;
    }
    return false;
  };
  const __clean = (s) => String(s || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\\s+/g, ' ').trim();
`

function stateExpression(limit) {
  return `(() => {${HELPERS}
    const all = [...document.querySelectorAll('body *')].filter(__vis)
    const inputs = all
      .filter((e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        type: e.type || '',
        placeholder: e.getAttribute('placeholder') || '',
        value: e.type === 'password' ? '***' : String(e.value || '').slice(0, 60),
        ...__rect(e),
      }))
    const actions = []
    const seen = new Set()
    for (const e of all) {
      const text = __clean(__ownText(e) || (e.getAttribute('aria-label') || ''))
      if (!text || text.length > 24) continue
      if (!__clickable(e)) continue
      const key = text + '|' + JSON.stringify(__rect(e))
      if (seen.has(key)) continue
      seen.add(key)
      actions.push({ text, tag: e.tagName.toLowerCase(), ...__rect(e) })
      if (actions.length >= 30) break
    }
    return {
      url: location.href,
      hash: location.hash,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      text: __clean(document.body.innerText).slice(0, ${limit}),
      inputs,
      actions,
      pageErrors: (window.__agent?.errors || []).slice(-10),
    }
  })()`
}

function tapExpression(text, index, exact) {
  return `(() => {${HELPERS}
    const all = [...document.querySelectorAll('body *')].filter(__vis)
    const matches = all.filter((e) => {
      const t = __clean(__ownText(e) || (e.getAttribute('aria-label') || ''))
      if (!t) return false
      return ${exact ? 't === ' : 't.includes('}${JSON.stringify(text)}${exact ? '' : ')'}
    })
    if (!matches.length) {
      const candidates = [...new Set(all.map((e) => __clean(__ownText(e))).filter(Boolean))].slice(0, 40)
      return { found: false, candidates }
    }
    matches.sort((a, b) => (__clickable(b) ? 1 : 0) - (__clickable(a) ? 1 : 0) || __depth(b) - __depth(a) || __area(a) - __area(b))
    const el = matches[${index}]
    if (!el) return { found: false, message: 'index 越界', count: matches.length }
    const r = el.getBoundingClientRect()
    return {
      found: true,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      text: __clean(__ownText(el)),
      rect: __rect(el),
      count: matches.length,
    }
  })()`
}

function inputExpression({ selector, placeholder, label, value, index }) {
  const idx = Number.isInteger(Number(index)) ? Number(index) : null
  return `(() => {${HELPERS}
    const all = [...document.querySelectorAll('input, textarea, select')].filter(__vis)
    let el = null
    ${selector ? `el = document.querySelector(${JSON.stringify(selector)})` : ''}
    if (!el && ${JSON.stringify(placeholder || '')}) {
      const p = ${JSON.stringify(placeholder || '')}
      el = all.find((e) => (e.getAttribute('placeholder') || '').includes(p))
    }
    if (!el && ${JSON.stringify(label || '')}) {
      const l = ${JSON.stringify(label || '')}
      let best = null
      let bestDepth = 99
      for (const e of all) {
        let n = e
        let d = 0
        while (n && d < 5) {
          if (String(n.innerText || '').includes(l)) {
            if (d < bestDepth) { bestDepth = d; best = e }
            break
          }
          n = n.parentElement
          d++
        }
      }
      el = best
    }
    ${idx !== null ? `if (!el) el = all[${idx}]` : ''}
    if (!el) {
      const candidates = all.map((e) => ({
        placeholder: e.getAttribute('placeholder') || '',
        type: e.type || '',
        ...__rect(e),
      }))
      return { found: false, candidates }
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    el.focus()
    setter.call(el, ${JSON.stringify(String(value ?? ''))})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { found: true, value: el.value, ...__rect(el) }
  })()`
}

function waitExpression({ text, route, gone }) {
  const checks = []
  if (text) checks.push(`String(document.body.innerText || '').includes(${JSON.stringify(text)})`)
  if (route) checks.push(`location.hash.includes(${JSON.stringify(route)})`)
  if (!checks.length) throw new Error('wait 需要 --text 或 --route')
  const expr = checks.join(' || ')
  return `(() => ({ ok: ${gone ? `!(${expr})` : `(${expr})`}, hash: location.hash, text: String(document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) }))()`
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

function compactLogs(logs, limit = 8) {
  const seen = new Set()
  const out = []
  for (const log of logs.slice(-60)) {
    const text = String(log.text || '').slice(0, 180)
    const key = `${log.type}|${text.slice(0, 90)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: log.type, text })
    if (out.length >= limit) break
  }
  return out
}

async function doState(cdp, limit = textLimit) {
  const state = await cdp.evaluate(stateExpression(limit))
  state.logs = compactLogs(cdp.logs)
  return state
}

async function doTap(cdp, { text, selector, xy, index = 0, exact = false }) {
  let point
  if (xy) {
    const [x, y] = String(xy).split(',').map(Number)
    point = { found: true, x, y, text: 'xy' }
  } else if (selector) {
    point = await cdp.evaluate(`(() => {${HELPERS}
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { found: false }
      const r = el.getBoundingClientRect()
      return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || '').slice(0, 40) }
    })()`)
  } else {
    point = await cdp.evaluate(tapExpression(text, index, exact))
  }
  if (!point?.found) return { ok: false, ...point }

  const x = Math.round(point.x)
  const y = Math.round(point.y)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1 }],
  })
  await sleep(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(350)
  const hash = await cdp.evaluate('location.hash')
  return { ok: true, tapped: point.text || text || selector, x, y, hash }
}

async function doInput(cdp, opts) {
  const result = await cdp.evaluate(inputExpression(opts))
  if (!result?.found) return { ok: false, ...result }
  if (opts.submit) {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    await sleep(350)
  }
  return { ok: true, ...result, hash: await cdp.evaluate('location.hash') }
}

async function doWait(cdp, { text, route, gone, timeout = 8 }) {
  const expr = waitExpression({ text, route, gone })
  const deadline = Date.now() + Number(timeout) * 1000
  let last
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expr)
    if (last?.ok) return { ok: true, waitedMs: Number(timeout) * 1000 - (deadline - Date.now()), ...last }
    await sleep(200)
  }
  return { ok: false, timeout, ...(last || {}) }
}

async function doShot(cdp, opts, runCtx) {
  const vp = await cdp.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')
  const width = Number(opts.width || 360)
  const scale = Math.min(1, width / vp.w)
  const res = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: Number(opts.quality || 60),
    clip: { x: 0, y: 0, width: vp.w, height: vp.h, scale },
  })
  const buf = Buffer.from(res.data || '', 'base64')
  const sha = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)
  if (runCtx?.lastShotHash === sha) {
    return { ok: true, unchanged: true, sha, bytes: buf.length }
  }
  if (runCtx) runCtx.lastShotHash = sha
  const dir = opts.out ? path.resolve(opts.out) : defaultOutDir(opts.dir)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${opts.name || `shot_${Date.now()}`}.jpg`
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  return { ok: true, file, bytes: buf.length, width: Math.round(vp.w * scale), height: Math.round(vp.h * scale), sha }
}

async function doScroll(cdp, opts) {
  const vp = await cdp.evaluate('({ w: innerWidth, h: innerHeight })')
  const x = Math.round(Number(opts.x || vp.w / 2))
  const dy = Number(opts.dy || -400)
  const y1 = Math.round(dy < 0 ? Number(opts.y || vp.h * 0.6) : Number(opts.y || vp.h * 0.4))
  const y2 = Math.round(y1 + dy)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: y1, radiusX: 4, radiusY: 4, force: 1 }],
  })
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: Math.round(y1 + ((y2 - y1) * i) / 6), force: 1 }],
    })
    await sleep(30)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
  return { ok: true, hash: await cdp.evaluate('location.hash') }
}

async function doKey(cdp, opts) {
  const map = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Back: { key: 'GoBack', code: 'BrowserBack', windowsVirtualKeyCode: 4 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  }
  const k = map[opts.name || 'Enter']
  if (!k) throw new Error(`不支持的按键: ${opts.name}`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
  await sleep(300)
  return { ok: true, hash: await cdp.evaluate('location.hash') }
}

async function doLogs(cdp, opts) {
  const logs = compactLogs(cdp.logs, 20)
  if (opts.clear) cdp.logs.length = 0
  const pageErrors = await cdp.evaluate('(window.__agent?.errors || []).slice(-20)').catch(() => [])
  return { ok: true, logs, pageErrors }
}

function doLogcat(opts) {
  const lines = Number(opts.lines || 120)
  const out = adb(['logcat', '-d', '-t', String(lines)], { ignoreError: true, timeout: 20000 })
  const filtered = out
    .split(/\r?\n/)
    .filter((line) => /chromium|AndroidRuntime|sunshinecare|CONSOLE|E\/|F\/|FATAL/i.test(line))
    .slice(-40)
  return { ok: true, lines: filtered }
}

async function doLaunch(opts) {
  ensureDevice()
  adbQuiet(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  adbQuiet(['shell', 'wm', 'dismiss-keyguard'])
  if (opts.stop) adbQuiet(['shell', 'am', 'force-stop', pkg])
  adbQuiet(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
  const started = Date.now()
  let pid = ''
  while (Date.now() - started < 15000) {
    pid = adb(['shell', 'pidof', pkg], { ignoreError: true }).trim()
    if (pid) break
    await sleep(300)
  }
  if (!pid) {
    adbQuiet(['shell', 'am', 'start', '-n', `${pkg}/.MainActivity`])
    await sleep(1500)
  }
  const cdp = await connect()
  try {
    if (opts.text || opts.route) {
      await doWait(cdp, { text: opts.text, route: opts.route, timeout: opts.timeout || 15 })
    }
  } catch {
    // 启动后不强制等待某个页面
  }
  const state = await doState(cdp, 800)
  cdp.close()
  return { ok: true, pid, launchMs: Date.now() - started, hash: state.hash, text: state.text.slice(0, 200) }
}

async function doSetup() {
  ensureDevice()
  const pid = ensureForward()
  const cdp = new CDP()
  const page = await cdp.connect()
  await cdp.enable()
  const info = await cdp.evaluate('({ hash: location.hash, title: document.title })')
  cdp.close()
  return { ok: true, serial, package: pkg || undefined, pid, port, page: { url: page.url, title: info.title, hash: info.hash } }
}

// ---------------------------------------------------------------------------
// 场景运行
// ---------------------------------------------------------------------------

function summarizeResult(cmd, r) {
  if (!r) return r
  switch (cmd) {
    case 'state':
      return { hash: r.hash, viewport: r.viewport, inputs: r.inputs?.length || 0, actions: r.actions?.length || 0 }
    case 'tap':
      return { ok: r.ok, tapped: r.tapped, hash: r.hash, count: r.count, candidates: r.candidates?.slice(0, 10) }
    case 'wait':
      return { ok: r.ok, hash: r.hash, waitedMs: r.waitedMs }
    case 'input':
      return { ok: r.ok, value: r.value, hash: r.hash }
    case 'shot':
      return { ok: r.ok, file: r.file, bytes: r.bytes, unchanged: r.unchanged }
    case 'eval':
      return { ok: r.ok, value: r.value }
    case 'assert':
      return r
    default:
      return { ok: r.ok, hash: r.hash }
  }
}

async function doRun(file) {
  if (!file) throw new Error('run 需要场景文件路径')
  const filePath = path.resolve(process.cwd(), file)
  const scenario = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const oldDefaultDir = process.env.AGENT_DRIVER_DIR
  if (scenario.dir) process.env.AGENT_DRIVER_DIR = scenario.dir
  const started = Date.now()
  const runCtx = { lastShotHash: null }
  const timeline = []
  let cdp
  try {
    if (scenario.steps?.some((s) => s.cmd === 'launch')) {
      const launchStep = scenario.steps.shift()
      timeline.push({ step: 'launch', ok: true, ...(await doLaunch({ ...launchStep, ...args })) })
    }
    cdp = await connect()
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      const cmd = step.cmd || Object.keys(step).find((k) => ['tap', 'wait', 'shot', 'input', 'assert', 'scroll', 'back', 'key', 'eval', 'sleep'].includes(k))
      const t0 = Date.now()
      let result
      try {
        switch (cmd) {
          case 'state':
            result = await doState(cdp, step['text-limit'] || textLimit)
            break
          case 'tap': {
            const opts = typeof step.tap === 'object' ? step.tap : step
            result = await doTap(cdp, opts)
            break
          }
          case 'input': {
            const opts = typeof step.input === 'object' ? step.input : step
            result = await doInput(cdp, opts)
            break
          }
          case 'wait':
            result = await doWait(cdp, step)
            break
          case 'shot': {
            const opts = typeof step.shot === 'object' ? step.shot : step
            result = await doShot(cdp, { ...opts, dir: opts.dir || scenario.dir }, runCtx)
            break
          }
          case 'scroll':
            result = await doScroll(cdp, step)
            break
          case 'back':
            await cdp.evaluate('history.back()')
            await sleep(400)
            result = { ok: true, hash: await cdp.evaluate('location.hash') }
            break
          case 'key':
            result = await doKey(cdp, step)
            break
          case 'eval':
            result = { ok: true, value: await cdp.evaluate(step.expr) }
            break
          case 'sleep':
            await sleep(Math.min(Number(step.ms || 500), 2000))
            result = { ok: true, ms: Math.min(Number(step.ms || 500), 2000) }
            break
          case 'assert': {
            const checks = []
            if (step.text) checks.push([`text包含 ${step.text}`, (await cdp.evaluate(`String(document.body.innerText||'').includes(${JSON.stringify(step.text)})`))])
            if (step.route) checks.push([`路由包含 ${step.route}`, (await cdp.evaluate(`location.hash.includes(${JSON.stringify(step.route)})`))])
            if (step.exists) checks.push([`元素存在 ${step.exists}`, (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(step.exists)})`))])
            const failed = checks.filter(([, ok]) => !ok)
            result = { ok: failed.length === 0, checks: checks.map(([name, ok]) => ({ name, ok })) }
            break
          }
          default:
            throw new Error(`未知步骤: ${JSON.stringify(step)}`)
        }
      } catch (err) {
        result = { ok: false, error: err.message }
      }
      timeline.push({ i: i + 1, cmd, ms: Date.now() - t0, ok: result?.ok !== false, result: summarizeResult(cmd, result) })
      if (result?.ok === false && !step.optional) {
        const state = await doState(cdp, 1200).catch(() => null)
        const logs = compactLogs(cdp.logs, 15)
        cdp.close()
        if (oldDefaultDir === undefined) delete process.env.AGENT_DRIVER_DIR
        else process.env.AGENT_DRIVER_DIR = oldDefaultDir
        return {
          ok: false,
          scenario: scenario.name || file,
          failedAt: i + 1,
          failedStep: step,
          elapsedMs: Date.now() - started,
          state,
          logs,
          timeline,
        }
      }
    }
    const state = await doState(cdp, 600)
    cdp.close()
    if (oldDefaultDir === undefined) delete process.env.AGENT_DRIVER_DIR
    else process.env.AGENT_DRIVER_DIR = oldDefaultDir
    return {
      ok: true,
      scenario: scenario.name || file,
      elapsedMs: Date.now() - started,
      steps: timeline.length,
      shots: timeline.filter((s) => s.cmd === 'shot').map((s) => s.result.file).filter(Boolean),
      final: { hash: state.hash, text: state.text.slice(0, 300) },
      timeline,
    }
  } catch (err) {
    cdp?.close()
    throw err
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let cdp
  try {
    switch (command) {
      case 'setup':
        return await doSetup()
      case 'launch':
        return await doLaunch({ ...args, text: args.text, route: args.route })
      case 'state': {
        cdp = await connect()
        return await doState(cdp, Number(args['text-limit'] || textLimit))
      }
      case 'tap': {
        cdp = await connect()
        return await doTap(cdp, {
          text: args.text,
          selector: args.selector,
          xy: args.xy,
          index: Number(args.index || 0),
          exact: args.exact === true,
        })
      }
      case 'input': {
        cdp = await connect()
        return await doInput(cdp, {
          selector: args.selector,
          placeholder: args.placeholder,
          label: args.label,
          value: args.value,
          index: args.index,
          submit: args.submit === true,
        })
      }
      case 'wait': {
        cdp = await connect()
        return await doWait(cdp, {
          text: args.text,
          route: args.route,
          gone: args.gone,
          timeout: args.timeout || 8,
        })
      }
      case 'shot': {
        cdp = await connect()
        return await doShot(cdp, {
          name: args.name,
          dir: args.dir,
          width: args.width,
          quality: args.quality,
          out: args.out,
        })
      }
      case 'scroll': {
        cdp = await connect()
        return await doScroll(cdp, args)
      }
      case 'back': {
        cdp = await connect()
        await cdp.evaluate('history.back()')
        await sleep(400)
        return { ok: true, hash: await cdp.evaluate('location.hash') }
      }
      case 'key': {
        cdp = await connect()
        return await doKey(cdp, args)
      }
      case 'eval': {
        cdp = await connect()
        return { ok: true, value: await cdp.evaluate(args.expr) }
      }
      case 'logs': {
        cdp = await connect()
        return await doLogs(cdp, args)
      }
      case 'logcat':
        return doLogcat(args)
      case 'run':
        return await doRun(args._[1] || args.file)
      default:
        throw new Error(`未知命令: ${command}\n${HELP}`)
    }
  } finally {
    cdp?.close()
  }
}

main()
  .then((result) => {
    console.log(JSON.stringify(result))
    process.exit(result?.ok === false ? 1 : 0)
  })
  .catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err.message }))
    process.exit(2)
  })