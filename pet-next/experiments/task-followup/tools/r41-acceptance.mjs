#!/usr/bin/env node
/**
 * R4.1 独立验收：每次 CLI 调用都是真实子进程；崩溃点是真实 exit 42。
 *
 * 覆盖：
 *  - 原四个崩溃检查点（ingest_persisted / pre_dispatch / receipt_persisted / effect_running）
 *  - F2 重复恢复：recover1/2/3 都阻断，attempt/receipt 不增加；显式对账后才允许重新授权
 *  - F1-A：r1 回执落盘后 exit42 → 摄取 r2 → 不得用 r1 分析完成
 *  - F1-B：r1 提问 → 磁盘换 r2 未 observe → 回答 → 工具按实际字节拒绝
 *  - F3：静默期问题未送达时回答被拒（exit 3 not_visible），present 后才可回答
 *  - 时间：tick 必须显式 --clock；真实时钟拒绝逻辑前进
 *
 * 用法：node tools/r41-acceptance.mjs <task-followup 目录> <输出目录>
 * 退出码：0 全部断言通过；1 有断言失败；2 参数/环境错误。诊断退出码（42/4/3/6）单独记录在 raw JSON。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const source = resolve(process.argv[2] ?? '.')
const out = resolve(process.argv[3] ?? join(source, 'out', 'r41-acceptance'))
mkdirSync(out, { recursive: true })

const rows = []
const assertions = []
let failures = 0

function record(name, detail) {
  rows.push({ name, ...detail })
  writeFileSync(join(out, `${name}.json`), JSON.stringify(rows.at(-1), null, 2) + '\n')
}

function cli(caseName, workspace, name, args, env = {}, clock = '2026-11-12T08:00:00.000Z') {
  const argv = [join(source, 'run.mjs'), ...args, '--workspace', workspace, '--timezone', 'UTC', '--clock', clock]
  const proc = spawnSync(process.execPath, argv, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 })
  let json = null
  try {
    json = JSON.parse(proc.stdout.slice(proc.stdout.indexOf('{')))
  } catch {
    json = null
  }
  record(name, { case: caseName, argv, exit: proc.status, stdout: proc.stdout, stderr: proc.stderr })
  return { exit: proc.status, json, stdout: proc.stdout, stderr: proc.stderr }
}

function check(name, condition, evidence) {
  const ok = Boolean(condition)
  assertions.push({ name, ok, evidence })
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`)
  if (!ok) process.stdout.write(`     ${JSON.stringify(evidence)}\n`)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function state(caseName, workspace, name, ticket, clock) {
  const res = cli(caseName, workspace, name, ['status', '--ticket', ticket, '--export'], {}, clock)
  if (!res.json) throw new Error(`status failed for ${name}: ${res.stderr}`)
  return res.json
}

function toolEffects(dbPath) {
  const proc = spawnSync(process.execPath, [
    '-e',
    `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(dbPath)});console.log(JSON.stringify({effects:db.prepare("SELECT effect_id,state,input_ref_json,detail FROM effects WHERE kind='tool' ORDER BY created_at").all(),receipts:db.prepare("SELECT receipt_id,effect_id,input_ref_json,inputs_verified FROM receipts").all()}))`,
  ], { encoding: 'utf8' })
  if (proc.status !== 0) throw new Error(`sqlite read failed: ${proc.stderr}`)
  return JSON.parse(proc.stdout)
}

// ------------------------------------------------------------------ 1. ingest_persisted
{
  const ws = join(out, 'c1-ingest')
  const d = cli('c1', ws, 'c1-delegate-crash', ['delegate', '--title', 'c1', '--goal', 'g'], { PET_FOLLOWUP_CRASH_AT: 'ingest_persisted' })
  check('ingest_persisted 真实退出 42', d.exit === 42, { exit: d.exit })
  const list = cli('c1', ws, 'c1-status', ['status'])
  const ticket = list.json?.tasks?.[0]?.ticketId
  check('崩溃后任务已持久化', Boolean(ticket) && list.json.tasks[0].stage === 'awaiting_result', list.json?.tasks?.[0])
  const r = cli('c1', ws, 'c1-recover', ['recover'])
  check('ingest_persisted 恢复后继续', r.exit === 0, { exit: r.exit, out: r.json })
}

// ------------------------------------------------------------------ 2. pre_dispatch
{
  const ws = join(out, 'c2-predispatch')
  const d = cli('c2', ws, 'c2-delegate', ['delegate', '--title', 'c2', '--goal', 'g'])
  const ticket = d.json.ticketId
  cli('c2', ws, 'c2-seed', ['seed', '--experiment', 'E17', '--revision', '1', '--status', 'partial', '--failed', '11', '--passed', '29'])
  const o = cli('c2', ws, 'c2-observe-crash', ['observe', '--ticket', ticket, '--experiment', 'E17'], { PET_FOLLOWUP_CRASH_AT: 'pre_dispatch' })
  check('pre_dispatch 真实退出 42', o.exit === 42, { exit: o.exit })
  const r = cli('c2', ws, 'c2-recover', ['recover'])
  const st = state('c2', ws, 'c2-state', ticket)
  check('pre_dispatch 恢复后问题仍可回答', r.exit === 0 && st.task.status === 'active' && Boolean(st.task.openAttention), {
    exit: r.exit,
    stage: st.task.stage,
    open: st.task.openAttention?.attentionId ?? null,
  })
}

// ------------------------------------------------------------------ 3. receipt_persisted 正控
{
  const ws = join(out, 'c3-receipt')
  const d = cli('c3', ws, 'c3-delegate', ['delegate', '--title', 'c3', '--goal', 'g'])
  const ticket = d.json.ticketId
  cli('c3', ws, 'c3-seed', ['seed', '--experiment', 'E17', '--revision', '1', '--status', 'partial', '--failed', '11', '--passed', '29'])
  cli('c3', ws, 'c3-observe', ['observe', '--ticket', ticket, '--experiment', 'E17'])
  const a = cli('c3', ws, 'c3-answer-crash', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'], { PET_FOLLOWUP_CRASH_AT: 'receipt_persisted' })
  check('receipt_persisted 真实退出 42', a.exit === 42, { exit: a.exit })
  const r1 = cli('c3', ws, 'c3-recover1', ['recover'])
  const s1 = state('c3', ws, 'c3-state1', ticket)
  const r2 = cli('c3', ws, 'c3-recover2', ['recover'])
  const s2 = state('c3', ws, 'c3-state2', ticket)
  const db = toolEffects(join(ws, 'state', 'followup.sqlite'))
  const analysisPath = s2.task.analysis?.artifactPath
  const analysisSha = analysisPath ? sha256File(join(ws, analysisPath)) : null
  check('已核验回执恢复后完成，且只消费一次', r1.exit === 0 && r2.exit === 0 && s2.task.status === 'completed' && db.effects.length === 1 && db.receipts.length === 1, {
    exit1: r1.exit,
    exit2: r2.exit,
    status: s2.task.status,
    effects: db.effects.length,
    receipts: db.receipts.length,
  })
  check('完成时分析 SHA 与文件一致且绑定输入', Boolean(analysisSha) && analysisSha === s2.task.analysis.artifactSha && Boolean(s2.task.analysis.inputRef?.resultFileSha), {
    analysisSha,
    recorded: s2.task.analysis?.artifactSha,
    inputRef: s2.task.analysis?.inputRef ?? null,
  })
  check('receipt_persisted 后阶段稳定', s1.task.status === 'completed' && s1.task.completion?.checkedPaths?.length >= 2, {
    status: s1.task.status,
    checked: s1.task.completion?.checkedPaths ?? null,
  })
}

// ------------------------------------------------------------------ 4. effect_running（F2）
{
  const ws = join(out, 'c4-running')
  const d = cli('c4', ws, 'c4-delegate', ['delegate', '--title', 'c4', '--goal', 'g'])
  const ticket = d.json.ticketId
  cli('c4', ws, 'c4-seed', ['seed', '--experiment', 'E17', '--revision', '1', '--status', 'partial', '--failed', '11', '--passed', '29'])
  cli('c4', ws, 'c4-observe', ['observe', '--ticket', ticket, '--experiment', 'E17'])
  const crash = cli('c4', ws, 'c4-answer-crash', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'], { PET_FOLLOWUP_CRASH_AT: 'effect_running' })
  const db0 = toolEffects(join(ws, 'state', 'followup.sqlite'))
  check('effect_running 真实退出 42', crash.exit === 42 && db0.effects.length === 1 && db0.receipts.length === 0, { exit: crash.exit, ...db0 })

  const rec1 = cli('c4', ws, 'c4-recover1', ['recover'])
  const s1 = state('c4', ws, 'c4-state1', ticket)
  const rec2 = cli('c4', ws, 'c4-recover2', ['recover'])
  const s2 = state('c4', ws, 'c4-state2', ticket)
  const rec3 = cli('c4', ws, 'c4-recover3', ['recover'])
  const s3 = state('c4', ws, 'c4-state3', ticket)
  const db3 = toolEffects(join(ws, 'state', 'followup.sqlite'))
  check('recover1 阻断', rec1.exit === 4 && s1.task.stage === 'needs_reconciliation', { exit: rec1.exit, stage: s1.task.stage })
  check(
    'recover2/3 仍阻断且不新建 attempt/receipt',
    rec2.exit === 4 &&
      rec3.exit === 4 &&
      s3.task.stage === 'needs_reconciliation' &&
      db3.effects.length === db0.effects.length &&
      db3.receipts.length === db0.receipts.length &&
      s3.task.attempt === s1.task.attempt,
    {
      exits: [rec2.exit, rec3.exit],
      stage: s3.task.stage,
      effects: db3.effects.length,
      receipts: db3.receipts.length,
      attempt: [s1.task.attempt, s3.task.attempt],
    },
  )
  const accepted = cli('c4', ws, 'c4-reconcile-accept', ['reconcile', '--ticket', ticket, '--option', 'accept_receipt'])
  const sAfterAccept = state('c4', ws, 'c4-state-after-accept', ticket)
  check('没有回执时 accept_receipt 被拒且保持阻断', accepted.exit === 4 && sAfterAccept.task.stage === 'needs_reconciliation', {
    exit: accepted.exit,
    result: accepted.json,
    stage: sAfterAccept.task.stage,
  })
  const blockedStatus = state('c4', ws, 'c4-state-blocked', ticket)
  check('未对账时不产生可回答的问题（持久阻断）', blockedStatus.task.stage === 'needs_reconciliation' && !blockedStatus.task.openAttention, {
    stage: blockedStatus.task.stage,
    openAttention: blockedStatus.task.openAttention ?? null,
  })
  const abandoned = cli('c4', ws, 'c4-reconcile-abandon', ['reconcile', '--ticket', ticket, '--option', 'abandon_attempt'])
  const sAfterAbandon = state('c4', ws, 'c4-state-after-abandon', ticket)
  const dbAfterAbandon = toolEffects(join(ws, 'state', 'followup.sqlite'))
  check('显式放弃后解除阻断但不自动重试', abandoned.exit === 0 && sAfterAbandon.task.stage !== 'needs_reconciliation' && dbAfterAbandon.effects.length === db0.effects.length, {
    exit: abandoned.exit,
    stage: sAfterAbandon.task.stage,
    effects: dbAfterAbandon.effects.length,
  })
  // 冻结的 P3 冷却 30 分钟：放弃后需等冷却结束，问题才会重新出现（不改阈值）。
  cli('c4', ws, 'c4-tick-after-cooldown', ['tick', '--minutes', '0'], {}, '2026-11-12T08:31:00.000Z')
  const redo = cli('c4', ws, 'c4-answer-redo', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'], {}, '2026-11-12T08:32:00.000Z')
  const sFinal = state('c4', ws, 'c4-state-final', ticket)
  const dbFinal = toolEffects(join(ws, 'state', 'followup.sqlite'))
  check(
    '重新授权后恰好执行一次并完成',
    redo.exit === 0 &&
      sFinal.task.status === 'completed' &&
      dbFinal.effects.length === 2 &&
      dbFinal.receipts.length === 1 &&
      sFinal.task.completion?.checkedPaths?.length >= 2,
    { exit: redo.exit, status: sFinal.task.status, effects: dbFinal.effects.length, receipts: dbFinal.receipts.length },
  )
}

// ------------------------------------------------------------------ 5. F1-A 回执落盘后来源更正
{
  const ws = join(out, 'c5-source-correction')
  const d = cli('c5', ws, 'c5-delegate', ['delegate', '--title', 'c5', '--goal', '分析失败样本'])
  const ticket = d.json.ticketId
  cli('c5', ws, 'c5-seed-r1', ['seed', '--experiment', 'E17', '--run', 'same-run', '--revision', '1', '--status', 'partial', '--failed', '11', '--passed', '29'])
  cli('c5', ws, 'c5-observe-r1', ['observe', '--ticket', ticket, '--experiment', 'E17'])
  const crash = cli('c5', ws, 'c5-answer-crash', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'], {
    PET_FOLLOWUP_CRASH_AT: 'receipt_persisted',
  })
  check('r1 回执落盘后真实退出 42', crash.exit === 42, { exit: crash.exit })
  const mid = state('c5', ws, 'c5-state-mid', ticket)
  check('r1 分析已落盘但任务未完成（未执行完成核验）', Boolean(mid.task.analysis) && mid.task.status === 'active', {
    status: mid.task.status,
    analysis: mid.task.analysis?.artifactPath ?? null,
  })
  cli('c5', ws, 'c5-seed-r2', ['seed', '--experiment', 'E17', '--run', 'same-run', '--revision', '2', '--status', 'partial', '--failed', '30', '--passed', '10'], {}, '2026-11-12T08:20:00.000Z')
  const observe2 = cli('c5', ws, 'c5-observe-r2', ['observe', '--ticket', ticket, '--experiment', 'E17'], {}, '2026-11-12T08:20:00.000Z')
  const after = state('c5', ws, 'c5-state-after-r2', ticket, '2026-11-12T08:21:00.000Z')
  check(
    '摄取 r2 后不得用 r1 分析完成，旧分析失效并留明确原因',
    observe2.exit === 0 &&
      after.task.status === 'active' &&
      after.task.result?.revision === 2 &&
      !after.task.analysis &&
      after.task.diagnostics.some((item) => item.startsWith('analysis_invalidated:new_source')),
    {
      status: after.task.status,
      revision: after.task.result?.revision,
      analysis: after.task.analysis,
      diagnostics: after.task.diagnostics.slice(-3),
    },
  )
  // 冻结的 P3 冷却 30 分钟：r2 的新问题在 08:31 之后才会出现（不改阈值）。
  cli('c5', ws, 'c5-tick-after-cooldown', ['tick', '--minutes', '0'], {}, '2026-11-12T08:31:00.000Z')
  const redo = cli('c5', ws, 'c5-answer-r2', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'], {}, '2026-11-12T08:32:00.000Z')
  const final = state('c5', ws, 'c5-state-final', ticket, '2026-11-12T08:33:00.000Z')
  const body = final.task.analysis ? readFileSync(join(ws, final.task.analysis.artifactPath), 'utf8') : ''
  const resultSha = sha256File(join(ws, 'inbox', 'E17', 'result.json'))
  check(
    '重新授权后按 r2 完成，分析与回执绑定同一来源',
    redo.exit === 0 &&
      final.task.status === 'completed' &&
      final.task.result?.revision === 2 &&
      final.task.analysis.inputRef?.resultFileSha === resultSha &&
      body.includes(resultSha) &&
      body.includes('r2）') &&
      !body.includes('r1）'),
    {
      exit: redo.exit,
      status: final.task.status,
      revision: final.task.result?.revision,
      analysisInputSha: final.task.analysis?.inputRef?.resultFileSha ?? null,
      resultFileSha: resultSha,
      hasR1Heading: body.includes('r1）'),
    },
  )
  check('有效完成：completionCheck 输入一致', Boolean(final.task.completion?.inputRef) && final.task.completion.inputRef.resultFileSha === resultSha, {
    completion: final.task.completion,
  })
}

// ------------------------------------------------------------------ 6. F1-B 磁盘换文件但未 observe
{
  const ws = join(out, 'c6-disk-replaced')
  const d = cli('c6', ws, 'c6-delegate', ['delegate', '--title', 'c6', '--goal', '分析当前失败样本'])
  const ticket = d.json.ticketId
  cli('c6', ws, 'c6-seed-r1', ['seed', '--experiment', 'E17', '--run', 'same-run', '--revision', '1', '--status', 'partial', '--failed', '11', '--passed', '29'])
  cli('c6', ws, 'c6-observe-r1', ['observe', '--ticket', ticket, '--experiment', 'E17'])
  cli('c6', ws, 'c6-seed-r2-no-observe', ['seed', '--experiment', 'E17', '--run', 'same-run', '--revision', '2', '--status', 'partial', '--failed', '30', '--passed', '10'])
  const answer = cli('c6', ws, 'c6-answer', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'])
  const s1 = state('c6', ws, 'c6-state-after-answer', ticket)
  const db1 = toolEffects(join(ws, 'state', 'followup.sqlite'))
  check(
    '磁盘字节与权威结果不符时拒绝执行：无回执、无分析、未完成',
    answer.exit === 0 &&
      s1.task.status === 'active' &&
      !s1.task.analysis &&
      db1.receipts.length === 0 &&
      db1.effects.length === 1 &&
      String(db1.effects[0].detail).startsWith('input_gate:'),
    {
      exit: answer.exit,
      status: s1.task.status,
      receipts: db1.receipts.length,
      effectDetail: db1.effects[0]?.detail ?? null,
      diagnostics: s1.task.diagnostics.slice(-3),
    },
  )
  cli('c6', ws, 'c6-observe-r2', ['observe', '--ticket', ticket, '--experiment', 'E17'], {}, '2026-11-12T08:20:00.000Z')
  const redo = cli('c6', ws, 'c6-answer-r2', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--panel'], {}, '2026-11-12T08:21:00.000Z')
  const s2 = state('c6', ws, 'c6-state-final', ticket, '2026-11-12T08:22:00.000Z')
  const resultSha = sha256File(join(ws, 'inbox', 'E17', 'result.json'))
  const db2 = toolEffects(join(ws, 'state', 'followup.sqlite'))
  check(
    '重新观察并重新授权后按当前版本完成',
    redo.exit === 0 &&
      s2.task.status === 'completed' &&
      s2.task.analysis.inputRef?.resultFileSha === resultSha &&
      db2.receipts.length === 1 &&
      db2.receipts[0].inputs_verified === 1,
    {
      exit: redo.exit,
      status: s2.task.status,
      analysisSha: s2.task.analysis?.inputRef?.resultFileSha ?? null,
      resultFileSha: resultSha,
      receipts: db2.receipts.length,
    },
  )
}

// ------------------------------------------------------------------ 7. F3 可见性
{
  const ws = join(out, 'c7-visibility')
  const d = cli('c7', ws, 'c7-delegate', ['delegate', '--title', 'c7', '--goal', 'g'], {}, '2026-11-12T02:00:00.000Z')
  const ticket = d.json.ticketId
  cli('c7', ws, 'c7-seed', ['seed', '--experiment', 'E17', '--revision', '1', '--status', 'partial', '--failed', '11', '--passed', '29'], {}, '2026-11-12T02:05:00.000Z')
  cli('c7', ws, 'c7-observe', ['observe', '--ticket', ticket, '--experiment', 'E17', '--quiet-from', '23', '--quiet-to', '7'], {}, '2026-11-12T02:05:00.000Z')
  const hidden = cli('c7', ws, 'c7-answer-hidden', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--quiet-from', '23', '--quiet-to', '7'], {}, '2026-11-12T02:06:00.000Z')
  const notif = cli('c7', ws, 'c7-notifications-hidden', ['notifications', '--ticket', ticket], {}, '2026-11-12T02:06:00.000Z')
  check('静默期未送达时回答被拒绝（exit 3 not_visible）', hidden.exit === 3 && hidden.json?.result?.code === 'not_visible' && notif.json.notifications.length === 0, {
    exit: hidden.exit,
    result: hidden.json?.result,
    notifications: notif.json?.notifications,
  })
  const presented = cli('c7', ws, 'c7-present', ['present', '--ticket', ticket, '--quiet-from', '23', '--quiet-to', '7'], {}, '2026-11-12T02:07:00.000Z')
  const after = cli('c7', ws, 'c7-answer-visible', ['answer', '--ticket', ticket, '--option', 'analyze_failing', '--quiet-from', '23', '--quiet-to', '7'], {}, '2026-11-12T02:08:00.000Z')
  const vis = after.json?.visibility
  check('显式呈现后回答被接受，可见性回执可核验', presented.exit === 0 && after.exit === 0 && vis?.visible === true && vis?.via === 'presented', {
    presentExit: presented.exit,
    answerExit: after.exit,
    visibility: vis,
  })
}

// ------------------------------------------------------------------ 8. 时钟
{
  const ws = join(out, 'c8-clock')
  const d = cli('c8', ws, 'c8-delegate', ['delegate', '--title', 'c8', '--goal', 'g'])
  const ticket = d.json.ticketId
  const noClock = spawnSync(process.execPath, [join(source, 'run.mjs'), 'tick', '--minutes', '30', '--workspace', ws, '--timezone', 'UTC'], {
    encoding: 'utf8',
  })
  record('c8-tick-no-clock', { case: 'c8', exit: noClock.status, stdout: noClock.stdout, stderr: noClock.stderr })
  check('真实时钟拒绝逻辑前进（exit 6）', noClock.status === 6, { exit: noClock.status, stderr: noClock.stderr })
  const tick = cli('c8', ws, 'c8-tick', ['tick', '--minutes', '30'], {}, '2026-11-12T08:00:00.000Z')
  check('受控时钟按 30 分钟相对推进', tick.exit === 0 && tick.json.now === '2026-11-12T08:30:00.000Z', { exit: tick.exit, now: tick.json?.now })
  void ticket
}

// ------------------------------------------------------------------ summary
writeFileSync(join(out, 'acceptance-result.json'), JSON.stringify({ assertions, failures, rows: rows.map((row) => row.name) }, null, 2) + '\n')
process.stdout.write(`\n${failures === 0 ? 'ACCEPTANCE PASS' : 'ACCEPTANCE FAIL'} assertions=${assertions.length} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
