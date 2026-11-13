/**
 * R5.1 B：服务合作停止（真实子进程 + 本地 IPC，RealClock）。
 *
 * - 正控：IPC 停止请求 → 同一 PID 回执、state=stopped、service.stop 日志、DB 关闭、exit 0 无 signal。
 * - 负控：收到停止请求后异常退出（注入 exit 43，无回执）→ 停止门判失败。
 * - 强杀/null+SIGTERM 不能被判为正常停止。
 * - 无 IPC 的命令行运行保持 R5 行为（有界完成 exit 0）。
 * 工作区放在含中文和空格的临时目录。
 *
 * @module pet-next/experiments/task-followup/tests/r5-1-service-stop
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EXPERIMENT_ROOT } from '../paths.ts'
import { evaluateStop, startServiceProcess } from '../service/stop-client.ts'
import type { StopResult } from '../service/stop-client.ts'

const RUN = join(EXPERIMENT_ROOT, 'run.mjs')
const ARGS = ['--timezone', 'UTC', '--interval-ms', '100', '--max-minutes', '1']

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'R5.1 停止 测试 '))
}

test('R5.1 合作停止正控：IPC 请求 → 同一 PID 回执 + state=stopped + 日志 + exit 0', async () => {
  const ws = workspace()
  try {
    const started = Date.now()
    const svc = startServiceProcess({ runPath: RUN, workspace: ws, args: ARGS })
    assert.equal(await svc.waitForRunning(), true, svc.output())
    const result = await svc.stop()
    const gate = evaluateStop(result)
    assert.deepEqual(gate.problems, [], JSON.stringify(result, null, 2))
    assert.equal(gate.ok, true)
    assert.deepEqual(result.exit, { code: 0, signal: null })
    assert.equal(result.forcedKill, false)
    assert.equal(result.receipt?.pid, svc.child.pid)
    assert.equal(result.receipt?.requestId, result.requestId)
    const meta = JSON.parse(readFileSync(join(ws, 'state', 'service.json'), 'utf8'))
    assert.equal(meta.pid, svc.child.pid)
    assert.equal(meta.state, 'stopped')
    assert.equal(meta.reason, 'ipc:stop')
    assert.ok(Date.now() - started < 30_000, 'stopped well before the bounded max-minutes limit')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R5.1 合作停止负控：收到停止请求后异常退出（无回执）必须判失败', async () => {
  const ws = workspace()
  try {
    const svc = startServiceProcess({ runPath: RUN, workspace: ws, args: ARGS, env: { ...process.env, PET_FOLLOWUP_CRASH_AT: 'service_stop' } })
    assert.equal(await svc.waitForRunning(), true, svc.output())
    const result = await svc.stop()
    const gate = evaluateStop(result)
    assert.equal(gate.ok, false)
    assert.equal(result.exit?.code, 43)
    assert.equal(result.receipt, null)
    assert.ok(gate.problems.includes('missing stop receipt'), gate.problems.join('; '))
    assert.ok(gate.problems.some((problem) => problem.startsWith('exit code 43')), gate.problems.join('; '))
    assert.notEqual(result.serviceJson?.state, 'stopped')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R5.1 停止门不接受 null/SIGTERM 或超时强杀', () => {
  const base: StopResult = {
    pid: 1234,
    argv: [],
    requestId: 'stop-1234',
    requestedAt: '2026-11-13T00:00:00.000Z',
    requestSent: true,
    exit: { code: 0, signal: null },
    exitObservedAt: '2026-11-13T00:00:01.000Z',
    forcedKill: false,
    receipt: { type: 'pet-followup:service-stopped', pid: 1234, requestId: 'stop-1234', reason: 'ipc:stop', state: 'stopped', dbClosed: true, stoppedAt: '2026-11-13T00:00:01.000Z' },
    serviceJson: { pid: 1234, state: 'stopped', reason: 'ipc:stop', stopRequestId: 'stop-1234' },
    logTail: [
      { event: 'service.start', pid: 1234 },
      { event: 'service.stop_request', pid: 1234, requestId: 'stop-1234' },
      { event: 'service.stop', reason: 'ipc:stop', requestId: 'stop-1234' },
    ],
  }
  assert.equal(evaluateStop(base).ok, true, 'synthetic well-formed stop passes')
  assert.equal(evaluateStop({ ...base, exit: { code: null, signal: 'SIGTERM' } }).ok, false)
  assert.equal(evaluateStop({ ...base, forcedKill: true }).ok, false)
  assert.equal(evaluateStop({ ...base, receipt: { ...base.receipt!, pid: 999 } }).ok, false)
  assert.equal(evaluateStop({ ...base, receipt: null }).ok, false)
  assert.equal(evaluateStop({ ...base, serviceJson: { ...base.serviceJson, state: 'running' } }).ok, false)
  assert.equal(evaluateStop({ ...base, requestSent: false }).ok, false)
  assert.equal(evaluateStop({ ...base, logTail: base.logTail.slice(0, 1) }).ok, false)
})

test('R5.1 无 IPC 的命令行运行保持 R5 行为：有界完成 exit 0', () => {
  const ws = workspace()
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings', RUN, 'serve', '--scheduler', '--workspace', ws, '--timezone', 'UTC', '--interval-ms', '50', '--max-iterations', '2'],
      { encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
    const meta = JSON.parse(readFileSync(join(ws, 'state', 'service.json'), 'utf8'))
    assert.equal(meta.state, 'stopped')
    assert.equal(meta.reason, 'max_iterations')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
