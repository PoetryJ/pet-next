import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const [root, storyFile] = process.argv.slice(2)
if (!root) throw Error('Usage: node archive-proof.mjs <extract-root> [stories.mjs]')
// The default is relative to this script in docs/checkpoints/r8-20261126/.
const storyUrl = storyFile ? pathToFileURL(path.resolve(storyFile)) :
  new URL('../../../pet-next/experiments/task-followup/eval/first-failure-pair/stories.mjs', import.meta.url)
const { storyFor } = await import(storyUrl)
const parse = str => JSON.parse(str ?? 'null')
const load = file => parse(fs.readFileSync(file, 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = []
const expect = (pass, id, label) => { if (!pass) fail.push({ id, label }) }
const rows = []
const fixtureFiles = new Set()
const endpoints = new Set()
let modelPosts = 0
let nArtifacts = 0
let nHistoryTurns = 0
for (const group of ['final-a', 'final-b']) {
  for (const entry of fs.readdirSync(path.join(root, group), {withFileTypes: true}).filter(entry => entry.isDirectory())) {
    const id = entry.name
    const dir = path.join(root, group, id)
    const loadRun = relative => load(path.join(dir, relative))
    const raw = loadRun('raw.json')
    const story = storyFor(raw.group, raw.promise)
    const calls = loadRun('http.json')
    const turns = calls.filter(c => c.route === '/api/say' && c.status === 200)
    const scriptedTurns = [...story.history, ...story.steps.filter(s => s.op === 'say')]
    expect(turns.length === scriptedTurns.length && turns.every((turn, i) => turn.body.text === scriptedTurns[i].text && turn.body.ticketId === raw.tasks[scriptedTurns[i].target]), id, 'all user utterances match scripted turns')
    nHistoryTurns += turns.length
    const db = new DatabaseSync(path.join(dir, 'ws/state/followup.sqlite'), {readOnly:true})
    const getAll = (query, ...parameters) => db.prepare(query).all(...parameters)
    const task = db.prepare('select * from tasks where ticket_id = ?').get(raw.tasks.A)
    const storedTurns = new Map(getAll('select turn_id,text from cap_turns').map(turn => [turn.turn_id, turn.text]))
    expect(turns.every(t => storedTurns.get(t.response.turnId) === t.body.text), id, 'scripted text recorded in workspace')
    const attention = getAll('select * from attentions where ticket_id = ? order by created_at', raw.tasks.A)
    const notifications = getAll('select * from notifications order by created_at')
    const timeline = loadRun('timeline.json')
    const rounds = timeline.filter(x => x.kind === 'produce')
    const artifactChecks = []
    for (const receipt of getAll("select * from receipts where ticket_id = ? and tool = 'write_analysis' and ok = 1", raw.tasks.A)) {
      const evidence = parse(receipt.analysis_evidence_json)
      const auth = evidence?.authorization
      const set = evidence?.inputSet
      const question = attention.find(a => a.attention_id === auth?.attentionId)
      const file = fs.readFileSync(path.join(dir, 'ws', receipt.output_path))
      const currentAnalysis = parse(task.analysis_json)
      const check = { scope: evidence?.scope, files: [] }
      check.output = sha(file) === receipt.output_sha256 && receipt.output_sha256 === currentAnalysis?.artifactSha
      check.authorization = question?.state === 'answered' && question.answer_option_id === auth.optionId && question.decision_id === auth.decisionId && question.answered_at === auth.at && Boolean(question.presented_at || question.delivered_at) && Date.parse(auth.at) <= Date.parse(receipt.started_at)
      const entries = [set.primary, ...set.dependencies].filter(entry => entry.ref)
      if (evidence.scope === 'partial') {
        check.partial = set.mode === 'partial' && entries.length === 1 && set.authorizedTaskIds.length === 1 && set.authorizedTaskIds[0] === entries[0].taskId;
      }
      for (const {ref} of entries) {
        const imported = fs.readFileSync(path.join(dir, 'ws', ref.artifactPath))
        const bySha = path.join(dir, 'ws/state/inputs', ref.resultFileSha + '.json')
        const preserved = fs.existsSync(bySha) ? fs.readFileSync(bySha) : fs.readFileSync(path.join(dir, 'ws', ref.resultPath))
        check.files.push({ key: ref.taskId === raw.tasks.A ? 'A' : 'B', revision: ref.revision, resultHashOk: sha(preserved) === ref.resultFileSha, artifactHashOk: sha(imported) === ref.artifactSha, included: file.toString().includes(ref.resultFileSha) })
      }
      expect(check.output && check.authorization && check.partial !== false && check.files.every(f => f.resultHashOk && f.artifactHashOk && f.included), id, 'output, input bytes and authorization')
      artifactChecks.push(check)
      nArtifacts += 1
    }
    const requests = fs.readdirSync(path.join(dir, 'model-io')).filter(name => name.endsWith('.request.json'))
    for (const name of requests) {
      const request = loadRun(path.join('model-io', name))
      const endpoint = new URL(request.url)
      endpoints.add(endpoint.hostname)
      expect(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && request.body.model === 'Qwen3-8B', id, 'used local Qwen proxy')
      modelPosts += 1
    }
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory() && e.name.startsWith('junit-'))) {
      const xml = fs.readFileSync(path.join(dir, entry.name, 'junit.xml'), 'utf8')
      for (const match of xml.matchAll(/\bfile="([^"]+)"/g)) {
        const file = match[1].split('/').at(-1)
        fixtureFiles.add(file)
        expect(['ci-failure.check.mjs','runtime.test.ts','cn-path.check.mjs'].includes(file), id, 'JUnit fixture path')
      }
    }
    const phases = timeline.filter(t => t.kind.startsWith('host.re') || t.kind === 'host.ready')
    rows.push({id, status:task.status, rawAction:raw.checks.action, correction:raw.group === 'G4' ? turns.at(-1).body.text : null,
      rounds, phases, attention:attention.map(({ state, answer_option_id, created_at, delivered_at, presented_at })=>({ state, answer_option_id, created_at, delivered_at, presented_at })),
      deliveredMain: notifications.filter(n=>n.ticket_id===raw.tasks.A && n.delivered_at).length,
      deliveredSide: notifications.filter(n=>n.ticket_id!==raw.tasks.A && n.delivered_at).length,
      artifacts:artifactChecks})
    db.close()
  }
}
console.log(JSON.stringify({ summary: { runs: rows.length, nArtifacts, nHistoryTurns, modelPosts, endpoints: [...endpoints], fixtureFiles: [...fixtureFiles] }, fail, rows }, null, 2))
process.exitCode = fail.length ? 1 : 0
