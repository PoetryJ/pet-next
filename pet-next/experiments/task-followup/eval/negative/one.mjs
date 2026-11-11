#!/usr/bin/env node
/** 运行单个负控。detected → exit 1（对应断言失败），masked → exit 0。 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const name = process.argv[2]
if (!name) {
  console.error('usage: node one.mjs <control>')
  process.exit(2)
}

if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url), name],
    { stdio: 'inherit', env: process.env },
  )
  process.exit(child.status ?? 1)
}

const { runControl } = await import('./cases.ts')
const result = runControl(name)
console.log(JSON.stringify(result))
console.log(`verdict=${result.detected ? 'detected' : 'masked'}`)
process.exit(result.detected ? 1 : 0)
