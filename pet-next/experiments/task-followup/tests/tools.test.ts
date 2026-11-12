import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { sha256Bytes } from '../contracts.ts'
import type { InputRef, ToolContext } from '../contracts.ts'
import { LocalTools } from '../tools/workspace.ts'
import type { SeedOutput } from '../tools/seed.ts'
import { seedResult } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'

/** 构造一份与 runtime 派发时一致的已核验上下文：快照 SHA == inputRef.resultFileSha。 */
function contextFor(root: string, seeded: SeedOutput): ToolContext {
  const snapshotRel = `state/inputs/${seeded.resultFileSha}.json`
  mkdirSync(join(root, 'state', 'inputs'), { recursive: true })
  writeFileSync(join(root, snapshotRel), readFileSync(seeded.resultPath))
  const inputRef: InputRef = {
    taskId: 'ticket-1',
    taskRevision: 1,
    assignmentId: 'assignment-1',
    sourceId: `inbox/${seeded.seed.experimentId}/${seeded.seed.runId}`,
    sourceRevision: `r${seeded.seed.revision}:${seeded.artifactSha.slice(0, 16)}`,
    runId: seeded.seed.runId,
    revision: seeded.seed.revision,
    resultFileSha: seeded.resultFileSha,
    artifactSha: seeded.artifactSha,
    resultPath: relative(root, seeded.resultPath),
    artifactPath: relative(root, seeded.artifactPath),
  }
  return {
    effectId: 'fx-1',
    attemptId: 'att-1',
    ticketId: 'ticket-1',
    taskRevision: 1,
    assignmentId: 'assignment-1',
    now: '2026-11-11T08:00:00.000Z',
    inputRef,
    resultSnapshotPath: snapshotRel,
  }
}

test('write_analysis 写真实文件并给出一致 SHA', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-followup-tools-'))
  try {
    const tools = new LocalTools({ root })
    const seeded = seedResult({ workspace: root, experimentId: 'E17', runId: 'run-1', revision: 1, status: 'partial', total: 40, passed: 29, failed: 11 })
    const execution = tools.execute(
      { tool: 'write_analysis', args: { resultPath: 'inbox/E17/result.json', runId: 'run-1', revision: 1 } },
      contextFor(root, seeded),
    )
    assert.equal(execution.receipt.ok, true)
    const out = join(root, execution.receipt.outputPath!)
    assert.equal(existsSync(out), true)
    assert.equal(sha256Bytes(readFileSync(out)), execution.receipt.outputSha256)
    assert.ok(execution.receipt.bytesWritten > 0)
    assert.ok(execution.receipt.bytesRead > 0)
    assert.equal(execution.receipt.inputsVerified, true)
    assert.equal(execution.receipt.inputRef?.resultFileSha, seeded.resultFileSha)
    assert.ok(seeded.artifactSha.length === 64)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('路径越界与缺失文件都是确定性失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-followup-tools-'))
  try {
    const tools = new LocalTools({ root })
    const seeded = seedResult({ workspace: root, experimentId: 'E17', runId: 'run-1', revision: 1, status: 'partial', total: 40, passed: 29, failed: 11 })
    const context = contextFor(root, seeded)
    const escape = tools.execute({ tool: 'inspect_artifact', args: { path: '../outside.json' } }, context)
    assert.equal(escape.receipt.ok, false)
    assert.equal(escape.receipt.needsReconciliation, false)
    const missing = tools.execute(
      { tool: 'write_analysis', args: { resultPath: 'inbox/E17/missing.json', resultSnapshotPath: 'state/inputs/missing.json' } },
      context,
    )
    assert.equal(missing.receipt.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compare_metrics 给出指标差值', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-followup-tools-'))
  try {
    const tools = new LocalTools({ root })
    const seeded = seedResult({ workspace: root, experimentId: 'E17', runId: 'run-1', revision: 1, status: 'partial', total: 40, passed: 29, failed: 11 })
    seedResult({ workspace: root, experimentId: 'E18', runId: 'run-2', revision: 1, status: 'succeeded', total: 40, passed: 40, failed: 0 })
    const execution = tools.execute(
      { tool: 'compare_metrics', args: { currentPath: 'inbox/E17/result.json', baselinePath: 'inbox/E18/result.json' } },
      contextFor(root, seeded),
    )
    assert.equal(execution.receipt.ok, true)
    const delta = execution.payload.delta as Record<string, number>
    // current=partial(29/11) vs baseline=succeeded(40/0)
    assert.equal(delta.failed, 11)
    assert.equal(delta.passed, -11)
    assert.equal(execution.receipt.inputsVerified, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('输入快照 SHA 不符时 write_analysis 必须失败（不按可变路径重读）', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-followup-tools-'))
  try {
    const tools = new LocalTools({ root })
    const seeded = seedResult({ workspace: root, experimentId: 'E17', runId: 'run-1', revision: 1, status: 'partial', total: 40, passed: 29, failed: 11 })
    const context = contextFor(root, seeded)
    writeFileSync(join(root, context.resultSnapshotPath), '{"tampered":true}')
    const execution = tools.execute(
      { tool: 'write_analysis', args: { resultPath: 'inbox/E17/result.json', resultSnapshotPath: context.resultSnapshotPath } },
      context,
    )
    assert.equal(execution.receipt.ok, false)
    assert.match(execution.receipt.detail, /input snapshot sha/)
    assert.equal(execution.receipt.outputPath, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('watch 拒绝 partial JSON 与 artifact SHA 不符', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-followup-watch-'))
  try {
    mkdirSync(join(root, 'inbox', 'E17'), { recursive: true })
    const partial = join(root, 'inbox', 'E17', 'result.json')
    writeFileSync(partial, '{"schema":"pet-followup-result/v1","runId":')
    const first = readResultFile({ root, path: partial, observedAt: '2026-11-11T08:00:00.000Z' })
    assert.equal(first.status, 'not_ready')
    const body = {
      schema: 'pet-followup-result/v1',
      experimentId: 'E17',
      runId: 'run-1',
      revision: 1,
      status: 'partial',
      metrics: { total: 40, passed: 29, failed: 11, score: 0.7 },
      artifactPath: 'inbox/E17/artifact.txt',
      artifactSha: '00'.repeat(32),
    }
    writeFileSync(partial, JSON.stringify(body))
    writeFileSync(join(root, 'inbox', 'E17', 'artifact.txt'), 'content')
    const second = readResultFile({ root, path: partial, observedAt: '2026-11-11T08:00:00.000Z' })
    assert.equal(second.status, 'artifact_mismatch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
