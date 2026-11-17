// Independent acceptance: reads SQLite and files, never imports completionCheck.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonical = (v) => JSON.stringify(sort(v))
function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v }
export function verifyCompletion(workspace, ticketId) {
  const checks = []
  const check = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail })
  const db = new DatabaseSync(resolve(workspace, 'state/followup.sqlite'), { readOnly: true })
  let artifactPath = null
  let sourceCount = 0
  const file = (path, digest, label) => {
    const abs = path ? resolve(workspace, path) : ''
    const rel = abs ? relative(resolve(workspace), abs) : '..'
    const safe = abs && !rel.startsWith('..') && !isAbsolute(rel)
    check(`${label}.bytes`, safe && existsSync(abs) && statSync(abs).isFile() && sha(readFileSync(abs)) === digest, { path, digest })
  }
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE ticket_id = ?').get(ticketId)
    check('task.completed', task?.status === 'completed')
    const analysis = JSON.parse(task?.analysis_json ?? 'null')
    check('analysis.present', !!analysis)
    const receipt = analysis && db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(analysis.receiptId)
    check('receipt.success', receipt?.ok === 1 && receipt.inputs_verified === 1 && receipt.needs_reconciliation === 0 && receipt.tool === 'write_analysis')
    const effect = receipt && db.prepare('SELECT * FROM effects WHERE effect_id = ?').get(receipt.effect_id)
    check('effect.identity', effect?.state === 'succeeded' && effect.attempt_id === receipt?.attempt_id && effect.ticket_id === ticketId && effect.task_revision === task?.task_revision && effect.assignment_id === task?.assignment_id)
    check('receipt.identity', receipt?.ticket_id === ticketId && receipt.task_revision === task?.task_revision && receipt.assignment_id === task?.assignment_id)
    check('output.identity', !!receipt?.output_sha256 && receipt.output_path === analysis?.artifactPath && receipt.output_sha256 === analysis?.artifactSha)
    if (analysis) { artifactPath = analysis.artifactPath; file(analysis.artifactPath, analysis.artifactSha, 'analysis') }
    const proof = JSON.parse(receipt?.analysis_evidence_json ?? 'null')
    check('proof.present', !!proof)
    if (proof) {
      const bound = JSON.parse(effect?.args_json ?? '{}').__analysisEvidence
      check('effect.proof', canonical(bound) === canonical(proof))
      const auth = proof.authorization
      const attention = db.prepare('SELECT * FROM attentions WHERE attention_id = ?').get(auth.attentionId)
      check('authorization.identity', attention?.state === 'answered' && attention.ticket_id === ticketId && attention.task_revision === task.task_revision && attention.assignment_id === task.assignment_id && attention.decision_id === auth.decisionId && attention.answer_option_id === auth.optionId)
      check('authorization.visible', !!(attention?.presented_at || attention?.delivered_at))
      check('authorization.action', ['continue_now', 'analyze_failing', 'retry_analysis'].includes(auth.optionId))
      check('authorization.before_effect', Date.parse(auth.at) <= Date.parse(effect?.started_at) && auth.at === attention?.answered_at)
      const set = proof.inputSet
      const bindings = JSON.parse(task.bindings_json ?? '[]')
      check('bindings.identity', set.bindingSha === sha(canonical(bindings)))
      const entries = [set.primary, ...set.dependencies]
      sourceCount = entries.length
      check('sources.complete', entries.length === bindings.length + 1 && set.primary.taskId === ticketId && bindings.every((b) => set.dependencies.some((d) => d.alias === b.alias && d.taskId === b.taskId)))
      check('set.digest', set.sha === sha(canonical({ bindingSha: set.bindingSha, primary: { alias: set.primary.alias, taskId: set.primary.taskId, ref: set.primary.ref }, dependencies: set.dependencies.map((d) => ({ alias: d.alias, taskId: d.taskId, ref: d.ref })) })))
      for (const e of entries) {
        const ref = e.ref
        const owner = db.prepare('SELECT * FROM tasks WHERE ticket_id = ?').get(e.taskId)
        const result = JSON.parse(owner?.result_json ?? 'null')
        check(`${e.alias}.current`, ref && ref.taskId === e.taskId && ref.taskRevision === owner?.task_revision && ref.assignmentId === owner?.assignment_id && ref.runId === result?.runId && ref.revision === result?.revision && ref.resultFileSha === result?.resultFileSha && ref.artifactSha === result?.artifactSha)
        if (ref) { file(ref.resultPath, ref.resultFileSha, `${e.alias}.result`); file(ref.artifactPath, ref.artifactSha, `${e.alias}.artifact`) }
        if (artifactPath && existsSync(resolve(workspace, artifactPath))) check(`${e.alias}.in_report`, readFileSync(resolve(workspace, artifactPath), 'utf8').includes(ref?.resultFileSha))
      }
    }
  } catch (error) { check('verifier.error', false, String(error)) }
  finally { db.close() }
  return { schema: 'pet-core-completion/v1', ok: checks.every((c) => c.ok), ticketId, artifactPath, sourceCount, checks, failures: checks.filter((c) => !c.ok) }
}
