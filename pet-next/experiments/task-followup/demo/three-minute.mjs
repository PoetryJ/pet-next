/**
 * 3 分钟验收脚本：每一步都是独立 Node 进程，读同一个 SQLite。
 * 因此“关闭面板 / 重启进程”不是 new 对象，而是真的换进程。
 *
 * 用法：node run.mjs demo
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = resolve(HERE, '..', 'run.mjs')

function runCli(args, env = {}) {
  // 显式 UTC：演示不依赖宿主 TZ，也不靠改宿主 TZ 让断言变绿。
  const full = [...args, '--timezone', 'UTC']
  const result = spawnSync(process.execPath, [RUN, ...full], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  })
  const stdout = result.stdout?.trim() ?? ''
  let json = null
  if (stdout) {
    try {
      json = JSON.parse(stdout.slice(stdout.indexOf('{')))
    } catch {
      json = null
    }
  }
  return { status: result.status, stdout, stderr: result.stderr ?? '', json }
}

function assert(condition, message, evidence) {
  if (!condition) {
    console.error(`FAIL ${message}`)
    if (evidence !== undefined) console.error(JSON.stringify(evidence, null, 2))
    process.exitCode = 1
    throw new Error(message)
  }
  console.log(`PASS ${message}`)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function runDemo(workspaceArg) {
  const workspace = resolve(workspaceArg ?? join(HERE, '..', 'out', 'workspace'))
  if (!workspace.includes('out') && !workspace.startsWith('/tmp/')) {
    throw new Error(`refuse to clean workspace outside out/ or /tmp: ${workspace}`)
  }
  rmSync(workspace, { recursive: true, force: true })
  console.log(`workspace ${workspace}\n`)

  console.log('1) 新进程：创建长期委托（关闭面板不会删除它）')
  const delegated = runCli(['delegate', '--workspace', workspace, '--title', '跟进实验 E17', '--goal', 'E17 结果不足时分析失败样本并给出产物'])
  assert(delegated.status === 0 && delegated.json?.ok, 'delegate persisted', delegated)
  const ticketId = delegated.json.ticketId
  assert(delegated.json.stage === 'awaiting_result', 'stage=awaiting_result before result', delegated.json)

  console.log('\n2) 新进程：实验目录出现 result.json（此刻没有任何面板进程存活）')
  const seeded = runCli(['seed', '--workspace', workspace, '--experiment', 'E17', '--status', 'partial', '--revision', '1', '--failed', '11', '--passed', '29'])
  assert(seeded.status === 0 && seeded.json?.ok, 'result.json written atomically', seeded)
  assert(existsSync(seeded.json.resultPath), 'result file exists', seeded.json)

  console.log('\n3) 新进程：启动扫描 inbox，核对文件 SHA，转成事件')
  const observed = runCli(['observe', '--workspace', workspace, '--ticket', ticketId, '--experiment', 'E17'])
  assert(observed.status === 0 && observed.json?.ok, 'observe completed', observed)
  const attention = observed.json.task.openAttention
  assert(Boolean(attention), 'a real question is open', observed.json.task)
  assert(attention.options.some((option) => option.id === 'analyze_failing'), 'question offers a concrete choice', attention)
  console.log(`     question: ${attention.question}`)

  console.log('\n4) 新进程：重启后读同一个库，任务与问题仍在')
  const status = runCli(['status', '--workspace', workspace, '--ticket', ticketId])
  assert(status.status === 0 && status.json?.ok, 'status read after restart', status)
  assert(status.json.stage === 'awaiting_decision', 'stage=awaiting_decision persisted', status.json)
  assert(status.json.openAttention?.attentionId === attention.attentionId, 'same attention survives restart', status.json)

  console.log('\n5) 新进程：用户打开面板看到问题并选择“分析失败样本”，本地工具生成产物')
  const answered = runCli([
    'answer',
    '--workspace',
    workspace,
    '--ticket',
    ticketId,
    '--option',
    'analyze_failing',
    '--panel',
  ])
  assert(answered.status === 0 && answered.json?.ok, 'answer accepted after panel presentation', answered)
  assert(answered.json.visibility?.visible === true, 'answer cites a real presentation receipt', answered.json.visibility)
  assert(answered.json.task.status === 'completed', 'task completed only after receipt + goal check', answered.json.task)
  const analysis = answered.json.task.analysis
  assert(Boolean(analysis?.receiptId), 'analysis has a receipt', analysis)
  const abs = join(workspace, analysis.artifactPath)
  assert(existsSync(abs), 'analysis artifact exists on disk', analysis)
  const sha = sha256File(abs)
  assert(sha === analysis.artifactSha, 'artifact sha matches persisted record', { sha, recorded: analysis.artifactSha })
  assert(answered.json.task.completion?.checkedPaths?.length >= 2, 'completion re-read result and analysis paths', answered.json.task.completion)

  console.log('\n6) 上游委托也结束为 completed')
  const exported = runCli(['status', '--workspace', workspace, '--ticket', ticketId, '--export'])
  assert(exported.json?.upstream?.ticket?.ended?.outcome === 'completed', 'upstream ticket ended completed', exported.json?.upstream?.ticket)
  assert(exported.json?.receipts?.length >= 1, 'receipt persisted', exported.json?.receipts)

  console.log('\n7) 恢复入口（受控时钟）：暂缺输入 → 输入门拒绝 → 恢复同字节 → 当前问题可见 → 新授权 → 完成')
  const T = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString()
  const d2 = runCli(['delegate', '--workspace', workspace, '--clock', T(2), '--title', '跟进实验 E18', '--goal', 'E18 结果不足时分析失败样本并给出产物'])
  assert(d2.status === 0 && d2.json?.ok, 'second delegation persisted', d2)
  const ticket2 = d2.json.ticketId
  const s2 = runCli(['seed', '--workspace', workspace, '--clock', T(3), '--experiment', 'E18', '--status', 'partial', '--revision', '1', '--failed', '12', '--passed', '28'])
  assert(s2.status === 0 && s2.json?.ok, 'second result written', s2)
  const o2 = runCli(['observe', '--workspace', workspace, '--clock', T(4), '--ticket', ticket2, '--experiment', 'E18'])
  assert(Boolean(o2.json?.task?.openAttention), 'second question open', o2.json?.task)
  const original = readFileSync(s2.json.resultPath)
  rmSync(s2.json.resultPath)
  const rejected = runCli(['answer', '--workspace', workspace, '--clock', T(6), '--ticket', ticket2, '--option', 'analyze_failing', '--panel'])
  assert(rejected.status === 0 && rejected.json?.ok, 'answer accepted before dispatch', rejected)
  assert(rejected.json.task.stage === 'continuation_pending', 'input gate rejection keeps a continuation', rejected.json.task)
  assert(rejected.json.task.continuation?.kind === 'input_rejected', 'continuation records the rejected action', rejected.json.task.continuation)
  assert(rejected.json.task.attempt === 1, 'no new attempt before a new authorization', rejected.json.task)
  writeFileSync(s2.json.resultPath, original)
  runCli(['observe', '--workspace', workspace, '--clock', T(7), '--ticket', ticket2, '--experiment', 'E18'])
  const ticked = runCli(['tick', '--workspace', workspace, '--clock', T(7), '--minutes', '31'])
  assert(ticked.status === 0, 'controlled clock advanced 31 minutes', ticked)
  const waiting = ticked.json.tasks.find((task) => task.ticketId === ticket2)
  assert(Boolean(waiting?.openAttention), 'current-version continuation question is open', waiting)
  assert(String(waiting.openAttention.decisionKey).startsWith('continuation:'), 'continuation question is version/attempt bound', waiting.openAttention)
  assert(Boolean(waiting.openAttention.deliveredAt), 'continuation question was actually delivered', waiting.openAttention)
  const retried = runCli(['answer', '--workspace', workspace, '--clock', T(39), '--ticket', ticket2, '--option', 'retry_analysis', '--panel'])
  assert(retried.status === 0 && retried.json?.ok, 'new authorization accepted', retried)
  assert(retried.json.task.attempt === 2, 'new authorization created attempt 2', retried.json.task)
  assert(retried.json.task.status === 'completed', 'completed after new authorization', retried.json.task)
  const export2 = runCli(['status', '--workspace', workspace, '--ticket', ticket2, '--export'])
  assert(export2.json?.receipts?.length === 1, 'exactly one receipt for the new attempt', export2.json?.receipts)
  const diagnostics2 = export2.json?.task?.diagnostics ?? []
  assert(
    diagnostics2.some((item) => String(item).startsWith('tool_input_rejected:')),
    'old input rejection evidence kept in diagnostics',
    diagnostics2,
  )

  console.log('\n产物内容（真实文件，非静态报告）:')
  console.log(readFileSync(abs, 'utf8').split('\n').slice(0, 14).join('\n'))
  console.log('\n3 分钟验收通过。每一步都是独立进程，状态仅来自 SQLite。')
  return process.exitCode ?? 0
}

if (process.argv[1] && process.argv[1].endsWith('three-minute.mjs')) {
  runDemo(process.argv[2]).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
