/**
 * R5.1 C：R5 负控 harness 在“中文 + 空格”绝对路径下真实执行，并正确传播失败。
 *
 * 在临时目录（名字含中文和空格）复制实验源码，真实跑 r5-eval 产生 raw，再执行 eval/r5/negative/all.mjs：
 * - 6 个独立 --case 各自 exit 1 且最后一行是 DETECTED <同名>；汇总 exit 0。
 * - 未知 case、损坏入口（score.ts 抛错）、缺少 raw 都不能算检出：单 case exit 2/HARNESS_ERROR，汇总非零
 *   （缺 raw：汇总 MASKED 并 exit 1；损坏入口：汇总自身导入失败 exit 2）。
 *
 * @module pet-next/experiments/task-followup/tests/r5-1-negative-harness
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { EXPERIMENT_ROOT } from '../paths.ts'

const CASES = [
  'duplicate-notification',
  'stale-version-send',
  'send-after-cancel',
  'answered-without-visible',
  'missed-due-wake',
  'report-only-count',
]
const SKIP_DIRS = new Set(['out', 'node_modules', 'checkpoints', '.git'])

let base = ''
let copyRoot = ''

function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, filter: (src) => !SKIP_DIRS.has(basename(src)) })
}

function negative(root: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', join(root, 'eval', 'r5', 'negative', 'all.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

function lastLine(stdout: string | null): string {
  return ((stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '').trim()
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'R5.1 负控 中文 路径 '))
  copyRoot = join(base, 'experiments', 'task-followup')
  copyTree(EXPERIMENT_ROOT, copyRoot)
  copyTree(resolve(EXPERIMENT_ROOT, '..', 'memory-consistency'), join(base, 'experiments', 'memory-consistency'))
  const evalRun = spawnSync(process.execPath, [join(copyRoot, 'run.mjs'), 'r5-eval'], { cwd: copyRoot, encoding: 'utf8', timeout: 300_000 })
  assert.equal(evalRun.status, 0, `r5-eval in copy failed\n${evalRun.stdout}\n${evalRun.stderr}`)
  for (const name of ['R5-01b', 'R5-05b', 'R5-06a']) assert.ok(existsSync(join(copyRoot, 'out', 'r5', 'raw', 'P3', `${name}.json`)))
})

after(() => {
  if (base && basename(base).startsWith('R5.1 负控 中文 路径 ')) rmSync(base, { recursive: true, force: true })
})

test('R5.1 负控在中文+空格绝对路径真实执行：路径确实含中文与空格', () => {
  assert.match(copyRoot, /[\u4e00-\u9fff]/)
  assert.match(copyRoot, / /)
})

for (const name of CASES) {
  test(`R5.1 独立负控 --case ${name}：exit 1 + DETECTED 记录`, () => {
    const result = negative(copyRoot, ['--case', name])
    assert.equal(result.signal, null)
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.ok(lastLine(result.stdout).startsWith(`DETECTED ${name} `), result.stdout)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ERR_UNSUPPORTED_ESM_URL_SCHEME|HARNESS_ERROR/)
  })
}

test('R5.1 负控汇总：6 项 DETECTED，汇总 exit 0', () => {
  const result = negative(copyRoot)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  for (const name of CASES) assert.match(result.stdout, new RegExp(`^DETECTED ${name}$`, 'm'))
  assert.match(result.stdout, /negative cases=6 failures=0/)
})

test('R5.1 未知 case 不算检出：exit 2 + HARNESS_ERROR', () => {
  const result = negative(copyRoot, ['--case', 'no-such-case'])
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
  assert.match(lastLine(result.stdout), /^HARNESS_ERROR case /)
  assert.doesNotMatch(result.stdout, /DETECTED/)
})

test('R5.1 缺少 raw（case 运行异常）不算检出，汇总非零', () => {
  const raw = join(copyRoot, 'out', 'r5', 'raw', 'P3', 'R5-06a.json')
  rmSync(raw)
  const single = negative(copyRoot, ['--case', 'send-after-cancel'])
  assert.equal(single.status, 2, `${single.stdout}\n${single.stderr}`)
  assert.match(lastLine(single.stdout), /^HARNESS_ERROR case:send-after-cancel /)
  const summary = negative(copyRoot)
  assert.notEqual(summary.status, 0)
  assert.match(summary.stderr, /MASKED send-after-cancel status=2/)
  assert.match(summary.stdout, /negative cases=6 failures=1/)
})

test('R5.1 损坏入口（score.ts 抛错）失败传播：单 case 与汇总均 exit 2，无 DETECTED', () => {
  writeFileSync(join(copyRoot, 'eval', 'r5', 'score.ts'), "throw new Error('R5.1 deliberately broken entry')\n")
  const single = negative(copyRoot, ['--case', 'duplicate-notification'])
  assert.equal(single.status, 2, `${single.stdout}\n${single.stderr}`)
  assert.match(lastLine(single.stdout), /^HARNESS_ERROR import .*deliberately broken entry/)
  // 汇总进程自身同样导入失败：直接 HARNESS_ERROR 非零退出，不会输出任何 DETECTED。
  const summary = negative(copyRoot)
  assert.equal(summary.status, 2, `${summary.stdout}\n${summary.stderr}`)
  assert.match(lastLine(summary.stdout), /^HARNESS_ERROR import /)
  assert.doesNotMatch(summary.stdout, /^DETECTED/m)
  assert.doesNotMatch(summary.stdout, /failures=0/)
})
