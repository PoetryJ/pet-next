// Semantic test of S1's stored condition. Isolate it from the host's input
// guard: an invalid plan can appear correct when the guard blocks an early ask.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { evaluate } from '../../../capability/conditions/kernel.ts'
const [database, ticket] = process.argv.slice(2)
if (!database || !ticket) throw Error('Usage: check-all-arrived.mjs <S1 sqlite> <primary ticket>')
const db = new DatabaseSync(database, {readOnly: true})
const task = db.prepare('SELECT bindings_json FROM tasks WHERE ticket_id=?').get(ticket)
const bindings = JSON.parse(task?.bindings_json ?? '[]')
if (bindings.length !== 1) throw Error('S1 requires one primary and one additional report')
const row = db.prepare('SELECT p.json FROM cond_current AS c JOIN cond_plans AS p USING (task_id,compilation_key) WHERE c.task_id=?').get(ticket)
if (!row) throw Error('missing current plan')
const plan = JSON.parse(row.json)
db.close()
const cases = []
const possibilities = ['absent', 'failed', 'succeeded']
for (const a of possibilities) for (const b of possibilities) {
  const facts = {}, currentBindings = {}, allowedFacts = []
  const now = plan.compiledAt
  function addReport(prefix, id, status) {
    const binding = {sourceId:id, version:'1', sha256:createHash('sha256').update(id+status).digest('hex')}
    currentBindings[id] = binding
    for (const [field,value] of [['present', status !== 'absent'], ['status', status]]) {
      const key = prefix + 'result.' + field
      allowedFacts.push(key)
      if (field === 'present' || status !== 'absent') facts[key] = {value, binding, observedAt:now}
    }
  }
  addReport('', ticket, a)
  addReport('task:'+ticket+'.', ticket, a)
  addReport('task:'+bindings[0].taskId+'.', bindings[0].taskId, b)
  const shouldAsk = a !== 'absent' && b !== 'absent'
  let state, reason
  try { state = evaluate(plan.when, {now, facts, currentBindings, allowedFacts}).state }
  catch (error) { state = 'error'; reason = String(error) }
  cases.push({a,b,shouldAsk,state,reason,pass:state !== 'error' && (state === 'true') === shouldAsk})
}
const ok = cases.every(x => x.pass)
console.log(JSON.stringify({ticket,compilationKey:plan.compilationKey,quotes:plan.sourceQuotes,when:plan.when,cases,ok},null,2))
if (!ok) process.exitCode = 1
