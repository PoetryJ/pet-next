/**
 * R5 持续唤醒演示（真实时钟，不用 FakeClock）。
 *
 * 关键点：
 * - 服务是独立进程，按 SQLite 里的 dueAt 自己醒；没有浏览器、没有 CLI tick。
 * - 到期只重判当前状态；问题仍要用户在可见后回答，工具仍要新授权。
 * - 重启后到期项补处理一次；取消后不再提醒。
 *
 * 用法：node run.mjs r5-demo [--workspace <dir>]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateBoundedExit, evaluateStop, startServiceProcess } from '../service/stop-client.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RUN = join(ROOT, 'run.mjs')

let failures = 0
function assert(condition, message, evidence) {
  if (condition) {
    console.log(`PASS ${message}`)
    return
  }
  failures += 1
  console.error(`FAIL ${message}`)
  if (evidence !== undefined) console.error(JSON.stringify(evidence, null, 2))
}

function runCli(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [RUN, ...args], { env: { ...process.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code) => {
      let json = null
      try {
        json = JSON.parse(stdout.slice(stdout.indexOf('{')))
      } catch {
        json = null
      }
      resolveRun({ status: code, stdout, stderr, json })
    })
  })
}

function startService(workspace, extra, env) {
  const args = [
    '--timezone',
    'UTC',
    '--min-gap-ms',
    '2000',
    '--reminder-quota',
    '100',
    '--interval-ms',
    '200',
    '--wake-after-ms',
    '2000',
    ...extra,
  ]
  // R5.1：直接带 transform 参数并开本地 IPC 通道（stop-client.ts）；停止走合作停止，不再 SIGTERM。
  const service = startServiceProcess({ runPath: RUN, workspace, args, env: env ?? { ...process.env } })
  return {
    service,
    child: service.child,
    output: service.output,
    waitForRunning: service.waitForRunning,
    waitForExit: service.waitForExit,
    stop: service.stop,
  }
}

function saveEvidence(workspace, name, value) {
  const dir = join(workspace, 'evidence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

function processRecord(svc) {
  return { pid: svc.child.pid, argv: svc.service.argv, exit: svc.service.exited(), messages: svc.service.messages, output: svc.output() }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export async function runR5Demo(workspaceArg) {
  const workspace = resolve(workspaceArg ?? join(ROOT, 'out', 'workspace-r5'))
  if (!workspace.includes('out') && !workspace.startsWith('/tmp/')) {
    throw new Error(`refuse to clean workspace outside out/ or /tmp: ${workspace}`)
  }
  rmSync(workspace, { recursive: true, force: true })
  console.log(`workspace ${workspace}\n`)

  console.log('1) 服务停止时：创建委托、结果不足、问题提出')
  const delegated = await runCli(['delegate', '--workspace', workspace, '--title', 'R5 持续唤醒', '--goal', '结果不足时分析失败样本并给出产物'])
  assert(delegated.status === 0 && delegated.json?.ok, 'delegate persisted', delegated)
  const ticketId = delegated.json.ticketId
  const seeded = await runCli(['seed', '--workspace', workspace, '--experiment', 'E31', '--status', 'partial', '--revision', '1', '--failed', '13', '--passed', '27'])
  assert(seeded.status === 0 && seeded.json?.ok, 'result seeded', seeded)
  const observed = await runCli(['observe', '--workspace', workspace, '--ticket', ticketId, '--experiment', 'E31'])
  assert(Boolean(observed.json?.task?.openAttention), 'question open', observed.json?.task)
  const firstAttention = observed.json.task.openAttention.attentionId

  console.log('\n2) 暂缺输入：回答被输入门拒绝，进入 continuation_pending（不执行工具）')
  const bytes = readFileSync(seeded.json.resultPath)
  rmSync(seeded.json.resultPath)
  const rejected = await runCli(['answer', '--workspace', workspace, '--ticket', ticketId, '--option', 'analyze_failing', '--panel'])
  assert(rejected.status === 0 && rejected.json?.ok, 'answer accepted', rejected)
  assert(rejected.json.task.stage === 'continuation_pending', 'continuation recorded', rejected.json.task)
  assert(rejected.json.task.attempt === 1, 'no new attempt before authorization', rejected.json.task)
  writeFileSync(seeded.json.resultPath, bytes)

  console.log('\n3) 启动服务（真实时钟）：无浏览器、无 CLI tick，自己到期重判')
  const service1 = startService(workspace, ['--max-minutes', '2'])
  let open = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await sleep(250)
    const status = await runCli(['status', '--workspace', workspace, '--ticket', ticketId])
    open = status.json?.openAttention ?? null
    if (open?.deliveredAt) break
  }
  assert(Boolean(open), 'service re-evaluated and opened the continuation question', open)
  assert(String(open?.decisionKey ?? '').startsWith('continuation:'), 'question is bound to current continuation', open)
  assert(Boolean(open?.deliveredAt), 'question was delivered by the service (no CLI tick)', open)
  const jobs1 = await runCli(['jobs', '--workspace', workspace])
  assert(Array.isArray(jobs1.json?.jobs), 'jobs readable', jobs1.json)
  assert(jobs1.json.jobs.every((job) => job.status !== 'scheduled' || job.dueAt >= new Date(Date.now() - 60_000).toISOString()), 'no busy loop in jobs', jobs1.json.jobs)
  const statusAfter1 = await runCli(['status', '--workspace', workspace, '--ticket', ticketId])
  assert(statusAfter1.json.attempt === 1, 'still no attempt before new authorization', statusAfter1.json)
  const serviceMeta = JSON.parse(readFileSync(join(workspace, 'state', 'service.json'), 'utf8'))
  assert(serviceMeta.clock === 'real' && serviceMeta.timezone === 'UTC' && Boolean(serviceMeta.configSha), 'service records real clock/timezone/configSha', serviceMeta)

  console.log('\n4) 停止并重启服务：到期项不重复送达')
  assert(await service1.waitForRunning(), 'service reached running state', service1.output())
  const stop1 = await service1.stop()
  const stopped1 = stop1.exit
  const gate1 = evaluateStop(stop1)
  saveEvidence(workspace, 'service1-stop', { ...stop1, gate: gate1, output: service1.output() })
  console.log(`stop request ${stop1.requestId} -> pid ${stop1.pid} exit ${JSON.stringify(stop1.exit)} receipt ${JSON.stringify(stop1.receipt)}`)
  assert(stopped1?.code === 0, 'service stopped cleanly', stop1)
  assert(gate1.ok, 'cooperative stop: IPC request, same-PID receipt, state=stopped, service.stop logged, DB closed, exit 0 without signal', {
    problems: gate1.problems,
    stop: stop1,
  })
  const before = await runCli(['notifications', '--workspace', workspace, '--ticket', ticketId])
  const service2 = startService(workspace, ['--max-iterations', '5'])
  await service2.waitForRunning()
  const stopped2 = await service2.waitForExit()
  assert(stopped2?.code === 0, 'second service exit 0', stopped2)
  const bounded2 = evaluateBoundedExit(service2.service, 'max_iterations')
  saveEvidence(workspace, 'service2-bounded', { ...processRecord(service2), gate: bounded2 })
  assert(bounded2.ok, 'second service bounded completion receipt (max_iterations; bounded, not an explicit stop)', bounded2.problems)
  const after = await runCli(['notifications', '--workspace', workspace, '--ticket', ticketId])
  assert(after.json.notifications.length === before.json.notifications.length, 'restart did not duplicate notifications', {
    before: before.json.notifications.length,
    after: after.json.notifications.length,
  })

  console.log('\n5) 用户重新打开并授权：工具只执行一次，任务完成')
  const answered = await runCli(['answer', '--workspace', workspace, '--ticket', ticketId, '--option', 'retry_analysis', '--panel'])
  assert(answered.status === 0 && answered.json?.ok, 'authorized answer accepted', answered)
  assert(answered.json.task.status === 'completed', 'completed after authorization', answered.json.task)
  assert(answered.json.task.attempt === 2, 'exactly one new attempt', answered.json.task)
  const receipts = await runCli(['status', '--workspace', workspace, '--ticket', ticketId, '--export'])
  assert(receipts.json.receipts.length === 1, 'exactly one receipt', receipts.json.receipts)

  console.log('\n6) 到期前取消：不再提醒')
  const d2 = await runCli(['delegate', '--workspace', workspace, '--title', 'R5 取消', '--goal', '等待结果'])
  const t2 = d2.json.ticketId
  const jobsBeforeCancel = await runCli(['jobs', '--workspace', workspace])
  assert(jobsBeforeCancel.json.jobs.some((job) => job.ticketId === t2 && job.status === 'scheduled'), 'delegate scheduled a wake', jobsBeforeCancel.json.jobs)
  const cancelled = await runCli(['cancel', '--workspace', workspace, '--ticket', t2, '--reason', 'user_cancel'])
  assert(cancelled.status === 0 && cancelled.json?.ok, 'cancel accepted', cancelled)
  const jobs2 = await runCli(['jobs', '--workspace', workspace])
  assert(jobs2.json.jobs.filter((job) => job.ticketId === t2 && job.status === 'scheduled').length === 0, 'cancel removed scheduled wake', jobs2.json.jobs)
  const service3 = startService(workspace, ['--max-iterations', '5'])
  await service3.waitForRunning()
  const stopped3 = await service3.waitForExit()
  assert(stopped3?.code === 0, 'third service exit 0', stopped3)
  const bounded3 = evaluateBoundedExit(service3.service, 'max_iterations')
  saveEvidence(workspace, 'service3-bounded', { ...processRecord(service3), gate: bounded3 })
  assert(bounded3.ok, 'third service bounded completion receipt (max_iterations; bounded, not an explicit stop)', bounded3.problems)
  const notes2 = await runCli(['notifications', '--workspace', workspace, '--ticket', t2])
  assert(notes2.json.notifications.length === 0, 'no notification after cancel', notes2.json.notifications)
  void firstAttention

  console.log(`\nR5 demo ${failures === 0 ? 'PASS' : 'FAIL'} failures=${failures}`)
  return failures === 0 ? 0 : 1
}
