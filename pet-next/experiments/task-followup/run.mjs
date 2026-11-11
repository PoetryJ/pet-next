#!/usr/bin/env node
/**
 * R4 实验入口。Node 需要 --experimental-transform-types 才能直接运行上游
 * TypeScript 核心（使用了参数属性），因此这里先自检参数并重开子进程，
 * 保证 `node run.mjs ...` 就能跑，不需要记额外环境变量。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REQUIRED = '--experimental-transform-types'

if (!process.execArgv.includes(REQUIRED)) {
  const child = spawn(process.execPath, [REQUIRED, '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
} else {
  const { main } = await import('./cli/main.ts')
  await main(process.argv.slice(2))
}
