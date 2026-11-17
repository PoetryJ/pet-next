#!/usr/bin/env node
/**
 * R6-live 一键启动：真实宿主（capability-conditions）+ 桌宠面板。
 *
 * 只做三件事：
 * 1) 检查模型配置（缺了直接报错退出，不偷偷换成 stub）；
 * 2) 在指定工作区起宿主，等 state/host.json 就绪；
 * 3) 用系统默认浏览器/Electron 打开带 token 的面板。
 *
 * 用法：
 *   node demo/condition-launcher.mjs --workspace out/demo-ws [--timezone Asia/Shanghai] [--no-open]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RUN = join(ROOT, 'run.mjs')

const args = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const workspace = resolve(arg('workspace', 'out/demo-ws'))
const timezone = arg('timezone', 'Asia/Shanghai')
const baseUrl = process.env.PET_MODEL_BASE_URL
const modelName = process.env.PET_MODEL_NAME
if (!baseUrl || !modelName) {
  console.error('缺少 PET_MODEL_BASE_URL / PET_MODEL_NAME：请先在 PowerShell 里设置（或用 W1-RUN.ps1 -ModelBaseUrl ... -ModelName ...）。')
  console.error('这里故意不启动：没有模型时条件模式会显式回退规则原型，演示会变成假象。')
  process.exit(2)
}
mkdirSync(workspace, { recursive: true })
const logPath = join(workspace, 'host-console.log')
const log = []
const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', RUN, 'host',
  '--workspace', workspace, '--timezone', timezone, '--assessor', 'capability-conditions', '--assessor-timeout-ms', '240000'], {
  cwd: ROOT,
  env: { ...process.env, PET_MODEL_RECORD_DIR: join(workspace, 'model-io') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (b) => log.push(b.toString()))
child.stderr.on('data', (b) => log.push(b.toString()))
const flush = () => writeFileSync(logPath, log.join(''))

const readyFile = join(workspace, 'state', 'host.json')
const until = Date.now() + 60000
let info = null
while (Date.now() < until) {
  if (existsSync(readyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(readyFile, 'utf8'))
      if (parsed.state === 'ready' && parsed.port && parsed.token) { info = parsed; break }
    } catch { /* 写一半 */ }
  }
  await new Promise((done) => setTimeout(done, 250))
}
flush()
if (!info) {
  console.error('宿主未在 60s 内就绪；见', logPath)
  child.kill('SIGTERM')
  process.exit(1)
}
const url = `http://127.0.0.1:${info.port}/panel?token=${encodeURIComponent(info.token)}`
console.log(`HOST_READY pid=${info.pid} port=${info.port}`)
console.log(`PANEL ${url}`)
console.log('演示脚本：见 demos/windows/README.md（5 步，约 3 分钟）')

if (!flag('no-open')) {
  const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const opened = spawn(opener, openerArgs, { stdio: 'ignore', detached: true })
  opened.on('error', () => console.log('无法自动打开浏览器；请手动复制上面的 PANEL 链接。'))
  opened.unref()
}

const shutdown = () => { try { child.kill('SIGTERM') } catch { /* 已退出 */ } flush(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
child.on('exit', (code) => { flush(); console.log(`host exited ${code}`); process.exit(code ?? 0) })
