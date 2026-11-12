#!/usr/bin/env node
// 识别当前项目/工作区，输出可直接交给 init 的 JSON。只读，不改任何文件。
import path from 'node:path'
import { detectProjects } from './lib.mjs'

const args = process.argv.slice(2)
const cwd = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd())
const result = detectProjects(cwd)

const missing = result.projects.flatMap((p) =>
  p.kind === 'app-webview'
    ? p.needs.map((n) => `${p.app}:${n}`)
    : p.services.filter((s) => s.needs.length).map((s) => `${s.name}:${s.needs.join(',')}`),
)

console.log(JSON.stringify({ ...result, missing }, null, 2))
