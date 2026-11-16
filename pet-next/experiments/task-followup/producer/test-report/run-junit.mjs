#!/usr/bin/env node
/**
 * 用 Node 内建 JUnit reporter 跑真实测试并留下可核对调用记录。
 *
 * 输出：<out>/junit.xml（原始报告）、<out>/invocation.json（实际命令/退出码/开始结束时间）。
 * 不解析报告（解析在 import-test-report.mjs），不替用户跑任意外部命令，只跑传给它的测试文件。
 *
 * 用法：
 *   node run-junit.mjs --out <dir> [--source <名称>] [--case <测试文件...>]
 *   缺省 --case 时跑本实验 tests/*.test.ts（真实产品测试）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXPERIMENT_ROOT = resolve(HERE, '..', '..')

const parseArgs = (argv) => {
  const args = new Map()
  let rest = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--case') { rest = argv.slice(i + 1); break }
    if (argv[i].startsWith('--')) { args.set(argv[i].slice(2), argv[i + 1]); i += 1 }
  }
  return { args, cases: rest }
}

export function runJunit({ out, source = 'junit', cases }) {
  const outAbs = resolve(out)
  mkdirSync(outAbs, { recursive: true })
  const reportPath = join(outAbs, 'junit.xml')
  const files = (cases?.length ? cases : readdirSync(join(EXPERIMENT_ROOT, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => join(EXPERIMENT_ROOT, 'tests', f))).map((f) => resolve(f))
  const args = [
    '--experimental-transform-types', '--no-warnings', '--test',
    '--test-reporter=junit', `--test-reporter-destination=${reportPath}`,
    ...files,
  ]
  const startedAt = new Date().toISOString()
  const child = spawnSync(process.execPath, args, { cwd: EXPERIMENT_ROOT, encoding: 'utf8' })
  const finishedAt = new Date().toISOString()
  const invocation = {
    schema: 'pet-junit-invocation/v1',
    source,
    command: [process.execPath, ...args].join(' '),
    cwd: EXPERIMENT_ROOT,
    testFiles: files.map((f) => f.replace(`${EXPERIMENT_ROOT}/`, '')),
    startedAt,
    finishedAt,
    exitCode: child.status,
    signal: child.signal ?? null,
    stdoutTail: (child.stdout ?? '').slice(-2000),
    stderrTail: (child.stderr ?? '').slice(-2000),
    reportPath,
  }
  writeFileSync(join(outAbs, 'invocation.json'), `${JSON.stringify(invocation, null, 2)}\n`)
  return invocation
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { args, cases } = parseArgs(process.argv.slice(2))
  if (!args.get('out')) {
    console.error('usage: node run-junit.mjs --out <dir> [--source <name>] [--case <test files...>]')
    process.exit(2)
  }
  const invocation = runJunit({ out: args.get('out'), source: args.get('source') ?? 'junit', cases })
  console.log(JSON.stringify({ out: args.get('out'), exitCode: invocation.exitCode, report: invocation.reportPath }, null, 2))
  process.exit(invocation.exitCode ?? 1)
}
