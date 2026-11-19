import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { runJunit } from '../producer/test-report/run-junit.mjs'
import { importTestReport } from '../producer/import-test-report.mjs'
import { verifyCompletion } from '../eval/core-completion/verify.mjs'

// Launch the actual product window, desktop IPC, outbox and host. CDP sends pointer/key
// input to the rendered controls. Only task setup uses the authenticated HTTP API.
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const root = fileURLToPath(new URL('../', import.meta.url))
const app = resolve(arg('--app') || join(root, '../..'))
const upstream = process.env.PET_MODEL_BASE_URL?.replace(/\/v1\/?$/, '')
if (!arg('--out') || !upstream || !process.env.PET_MODEL_NAME)
  throw Error(
    'Required: --out <new directory>, PET_MODEL_BASE_URL, PET_MODEL_NAME. Build pet-next before running.',
  )
const out = resolve(arg('--out')),
  workspace = join(out, '桌宠 跟进')
if (existsSync(out)) throw Error('Use a new output directory')
mkdirSync(out, { recursive: true })
const ui = !process.argv.includes('--http')
const executable = ui ? createRequire(join(app, 'package.json'))('electron') : process.execPath
const events = [],
  connections = []
const write = (file, value) => writeFileSync(join(out, file), JSON.stringify(value, null, 2))
const mark = (step, detail = {}) => {
  events.push({ at: new Date().toISOString(), step, ...detail })
  write('steps.json', events)
  console.log(step)
}
async function until(label, predicate, ms = 30000) {
  const untilAt = Date.now() + ms
  while (Date.now() < untilAt) {
    const value = await predicate()
    if (value) return value
    await sleep(200)
  }
  throw Error('Timed out: ' + label)
}
async function freePort() {
  const s = createServer()
  await new Promise((ok, no) => s.once('error', no).listen(0, '127.0.0.1', ok))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}
const debugPort = await freePort(),
  proxyPort = await freePort()
let electron,
  host,
  panel,
  proxy,
  A,
  B,
  ok = false,
  failure
function launch(command, args, options, name) {
  const child = spawn(command, args, {
    ...options,
    windowsHide: name !== 'desktop',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (b) => appendFileSync(join(out, name + '.log'), b))
  child.stderr.on('data', (b) => appendFileSync(join(out, name + '.log'), b))
  return child
}
async function startDesktop() {
  const previous = host?.pid
  const env = {
    ...process.env,
    PET_MODEL_BASE_URL: 'http://127.0.0.1:' + proxyPort + '/v1',
    PET_FOLLOWUP_PREVIEW: '1',
    PET_FOLLOWUP_RECORDING_ON_TOP: '1',
    PET_FOLLOWUP_WORKSPACE: workspace,
    PET_FOLLOWUP_NODE: process.execPath,
    PET_FOLLOWUP_ASSESSOR: 'capability-conditions',
    PET_FOLLOWUP_ASSESSOR_TIMEOUT_MS: '360000',
    PET_MEMORY_ADAPTER: 'versioned',
    PET_ASSESS_SETTLE: '1',
    PET_CONDITION_MENU: '1',
    PET_MODEL_TIMEOUT_MS: '360000',
    PET_CALL_LEDGER: join(out, 'client-ledger.jsonl'),
    PET_MODEL_RECORD_DIR: join(out, 'model-io'),
    PET_NEXT_USER_DATA: join(out, 'electron-profile'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const args = ui
    ? ['--remote-debugging-port=' + debugPort, join(app, 'dist/electron/main.js')]
    : [
        '--experimental-transform-types',
        '--no-warnings',
        join(root, 'run.mjs'),
        'host',
        '--workspace',
        workspace,
        '--timezone',
        'Asia/Shanghai',
        '--assessor',
        'capability-conditions',
        '--assessor-timeout-ms',
        '360000',
      ]
  electron = launch(executable, args, { env, cwd: ui ? app : root }, ui ? 'desktop' : 'host')
  host = await until('host ready', () => {
    if (electron.exitCode !== null) throw Error('Electron exited ' + electron.exitCode)
    try {
      const v = JSON.parse(readFileSync(join(workspace, 'state/host.json')))
      return v.state === 'ready' && v.pid !== previous && v
    } catch {
      return null
    }
  })
  if (!ui) {
    mark('host.opened', { hostPid: host.pid })
    return
  }
  const pet = await target('page.html')
  await pet.click('#followup-btn:not(.offline)')
  panel = await target('/panel?')
  if ((await panel.read('document.visibilityState')) !== 'visible')
    throw Error('Electron panel hidden. Unlock the Windows desktop and rerun with a fresh output directory.')
  mark('desktop.opened', { desktopPid: electron.pid, hostPid: host.pid })
}
async function target(urlPart) {
  const t = await until(urlPart, async () => {
    try {
      return (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) =>
        t.url.includes(urlPart),
      )
    } catch {
      return null
    }
  })
  const ws = new WebSocket(t.webSocketDebuggerUrl),
    pending = new Map()
  await new Promise((y, n) => {
    ws.onopen = y
    ws.onerror = n
  })
  connections.push(ws)
  let counter = 0
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data)
    if (msg.method === 'Page.javascriptDialogOpening') {
      void call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
      return
    }
    const reply = pending.get(msg.id)
    if (reply) {
      pending.delete(msg.id)
      clearTimeout(reply.timer)
      msg.error ? reply.no(Error(msg.error.message)) : reply.yes(msg.result)
    }
  }
  function call(method, params = {}) {
    return new Promise((yes, no) => {
      const id = ++counter
      const timer = setTimeout(() => {
        pending.delete(id)
        no(Error('CDP ' + method + ' timed out'))
      }, 10000)
      pending.set(id, { yes, no, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async function read(expression) {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw Error(r.exceptionDetails.text)
    return r.result.value
  }
  await call('Page.enable')
  await call('Page.bringToFront')
  return {
    read,
    call,
    async click(selector, ms = 30000) {
      const point = await until(
        selector,
        () =>
          read(
            '(()=>{const e=document.querySelector(' +
              JSON.stringify(selector) +
              ');if(!e||e.disabled)return null;e.scrollIntoView({block:"nearest",inline:"nearest"});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()',
          ),
        ms,
      )
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      for (const type of ['mousePressed', 'mouseReleased'])
        await call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    },
    async shot(file) {
      writeFileSync(
        join(out, file + '.png'),
        Buffer.from((await call('Page.captureScreenshot')).data, 'base64'),
      )
    },
  }
}
async function api(route, body) {
  const resp = await fetch('http://127.0.0.1:' + host.port + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-followup-token': host.token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await resp.json()
  if (!resp.ok || json.ok === false)
    throw Error('HTTP ' + resp.status + ' ' + route + ' ' + JSON.stringify(json))
  return json
}
async function create(name, binding) {
  mkdirSync(join(workspace, 'inbox', name), { recursive: true })
  const r = await api('/api/tasks', {
    title: name,
    dir: 'inbox/' + name,
    goal: binding ? '跟进主测试，原本两份报告齐后再问我是否分析' : '接收报告',
    ...(binding ? { analysisWhen: 'always', reportBindings: [{ alias: 'B 报告', taskId: binding }] } : {}),
  })
  return r.task.ticketId
}
async function select(id) {
  await until('selected task', async () => {
    await panel.click('.task[data-ticket="' + id + '"]')
    return panel.read('document.querySelector(".task.sel")?.dataset.ticket === ' + JSON.stringify(id))
  })
}
async function tell(text) {
  await panel.click('#say-text')
  await panel.call('Input.insertText', { text })
  await panel.click('#say-btn')
  await until('user turn saved', () =>
    panel.read(
      'document.getElementById("say-msg").innerText.includes("已记下") && document.getElementById("say-text").value===""',
    ),
  )
}
function bindings(id) {
  const db = new DatabaseSync(join(workspace, 'state/followup.sqlite'), { readOnly: true })
  try {
    return (
      JSON.parse(
        db.prepare('SELECT bindings_json FROM tasks WHERE ticket_id=?').get(id).bindings_json ?? '[]',
      ) ?? []
    )
  } finally {
    db.close()
  }
}
function produce(name) {
  const dir = join(out, 'junit-' + name)
  const invocation = runJunit({
    out: dir,
    source: name,
    cases: [join(root, 'producer/test-report/checks/cn-path.check.mjs')],
  })
  assert.equal(invocation.exitCode, 0)
  importTestReport({
    report: join(dir, 'junit.xml'),
    out: join(workspace, 'inbox', name),
    workspace,
    source: name,
    experiment: name,
    command: invocation.command,
    exitCode: invocation.exitCode,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
  })
}
async function closeDesktop() {
  if (ui)
    await panel.click('#quit-btn').catch((error) => {
      if (electron.exitCode === null && !String(error).includes('Input.dispatchMouseEvent')) throw error
    })
  else await api('/api/shutdown', {})
  await until('desktop exited', () => electron.exitCode !== null, 20000)
  assert.equal(electron.exitCode, 0)
  mark(ui ? 'desktop.closed' : 'host.closed')
}
try {
  proxy = launch(
    process.execPath,
    [
      join(root, 'eval/condition-followup/live/accounting/proxy.mjs'),
      '--port',
      String(proxyPort),
      '--upstream',
      upstream,
      '--ledger',
      join(out, 'proxy-ledger.jsonl'),
    ],
    {},
    'proxy',
  )
  await until('local model health', async () => {
    try {
      return (await fetch('http://127.0.0.1:' + proxyPort + '/health')).ok
    } catch {
      return false
    }
  })
  await startDesktop()
  B = await create('B')
  A = await create('A', B)
  assert.deepEqual(
    bindings(A).map((b) => b.taskId),
    [B],
  )
  const correction = '更正：B 那份不用等了，只等 A 的报告就问我。'
  if (ui) {
    await select(A)
    await tell(correction)
  } else await api('/api/say', { ticketId: A, text: correction })
  await until('only A is required', () => bindings(A).length === 0, 360000)
  assert.equal((await api('/api/task?ticket=' + A)).task.decision, null)
  if (ui) await panel.shot('01-correction')
  mark('correction.persisted', { ticketId: A, requiresOnlyPrimary: true })
  await closeDesktop()
  produce('A')
  await startDesktop()
  if (ui) await select(A)
  const selector = 'button[data-option="continue_now"],button[data-option="analyze_failing"]'
  let text
  if (ui) {
    await until(
      'visible decision',
      () => panel.read('Boolean(document.querySelector(' + JSON.stringify(selector) + '))'),
      360000,
    )
    await panel.shot('02-decision')
    mark('decision.visible', {
      question: await panel.read('document.querySelector("#question p").innerText'),
      conditionCard: await panel.read('Boolean(document.querySelector(".card.condition"))'),
    })
    await panel.click(selector)
    await panel.click('#open-report', 60000)
    const report = await target('/report-view?')
    await until('report viewer contents', () =>
      report.read('document.getElementById("content")?.innerText.length>0'),
    )
    text = await report.read('document.getElementById("content").textContent')
    await report.shot('03-analysis')
  } else {
    const d = await until(
      'delivered question',
      async () => {
        const t = (await api('/api/task?ticket=' + A)).task
        return t.bucket === 'needs_decision' && t.decision
      },
      360000,
    )
    const option = d.options.find((o) => ['continue_now', 'analyze_failing'].includes(o.id))
    assert.ok(option)
    await api('/api/present', { ticketId: A, attentionId: d.attentionId })
    await api('/api/answer', {
      ticketId: A,
      attentionId: d.attentionId,
      decisionId: d.decisionId,
      taskRevision: d.taskRevision,
      optionId: option.id,
    })
    await until('completed', async () => (await api('/api/task?ticket=' + A)).task.status === 'completed')
    text = (await api('/api/report?ticket=' + A)).content
    mark('http.scripted_answer', { question: d.question, option: option.id })
  }
  const proof = verifyCompletion(workspace, A)
  write('verified-artifact.json', proof)
  assert.ok(proof.ok)
  assert.equal(proof.sourceCount, 1)
  assert.equal(text, readFileSync(join(workspace, proof.artifactPath), 'utf8'))
  mark('report.opened', { path: proof.artifactPath, sources: proof.sourceCount })
  if (ui) {
    await select(B)
    await panel.click('#cancel-btn')
  } else await api('/api/cancel', { ticketId: B })
  const cancellation = await until('cancelled', async () => {
    const state = await api('/api/task?ticket=' + B)
    return state.task.status === 'cancelled' && state
  })
  await closeDesktop()
  produce('B')
  await startDesktop()
  if (ui) await select(B)
  await sleep(3500)
  const cancelled = await api('/api/task?ticket=' + B)
  assert.equal(cancelled.task.status, 'cancelled')
  assert.ok(!cancelled.task.decision && !cancelled.task.report)
  assert.equal(cancelled.receipts.filter((r) => r.tool === 'write_analysis').length, 0)
  assert.deepEqual(cancelled.notifications, cancellation.notifications)
  if (ui) await panel.shot('04-cancelled')
  mark('cancel.survived_restart')
  await closeDesktop()
  ok = true
} catch (e) {
  failure = String(e)
  console.error(e)
  if (panel) {
    try {
      await panel.shot('failure')
      write('failed-page.json', await panel.read('document.body.innerText'))
    } catch {}
  }
} finally {
  for (const ws of connections) ws.close()
  if (electron && electron.exitCode === null) {
    try {
      await api('/api/shutdown', {})
    } catch {}
    electron.kill()
  }
  const ledgerPath = join(out, 'proxy-ledger.jsonl')
  const usage = () => {
    const rows = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : []
    const starts = new Set(rows.filter((row) => row.phase === 'start').map((row) => row.id))
    const ends = rows.filter((row) => row.phase === 'end')
    const endIds = new Set(ends.map((row) => row.id))
    return {
      requests: starts.size,
      unsettled: [...starts].filter((id) => !endIds.has(id)).length,
      usageUnknown: ends.filter((row) => !row.usageKnown).length,
      knownTokens: ends.reduce((n, row) => n + (row.usage?.total_tokens ?? 0), 0),
    }
  }
  if (proxy) {
    try {
      await until('proxy settlement', () => usage().unsettled === 0, 360000)
    } catch (e) {
      ok = false
      failure ??= String(e)
    }
    proxy.kill()
  }
  write('result.json', {
    ok,
    failure,
    mode: ui ? 'electron' : 'scripted-http',
    platform: process.platform,
    node: process.version,
    model: process.env.PET_MODEL_NAME,
    A,
    B,
    events,
    manualTicks: 0,
    usage: usage(),
  })
  process.exitCode = ok ? 0 : 1
}
