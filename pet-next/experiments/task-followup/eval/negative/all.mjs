#!/usr/bin/env node
/**
 * 负控 harness：每个控制都在独立子进程里跑。
 * 期望每个子进程 exit 1 且输出 verdict=detected；否则说明负控被掩盖。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const controls = ['drop-goal', 'forge-completion', 'stale-revision', 'duplicate-effect', 'quiet-config']
let failures = 0
const rows = []
for (const name of controls) {
  const child = spawnSync(process.execPath, [join(HERE, 'one.mjs'), name], { encoding: 'utf8', env: process.env })
  const detected = child.status === 1 && child.stdout.includes('verdict=detected')
  rows.push({ name, exit: child.status, detected })
  if (!detected) failures += 1
  process.stdout.write(`${detected ? 'DETECTED' : 'MASKED  '} ${name} exit=${child.status}\n`)
  if (child.stderr) process.stderr.write(child.stderr)
}
process.stdout.write(`${JSON.stringify({ controls: rows, failures }, null, 2)}\n`)
process.exitCode = failures === 0 ? 0 : 1
