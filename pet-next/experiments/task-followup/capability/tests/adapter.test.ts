import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAICompatibleClient, configFromEnv, isLoopbackUrl } from '../model/openai-compatible.ts'
import { makeRequest } from '../model/protocol.ts'
import { FileQueueClient } from '../model/file-queue.ts'
import { runCase } from '../model/schema-adapter.ts'
import { fakeOpenAI } from './fixture-model.ts'

const req = makeRequest('assess', [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], '2026-11-13T00:00:00Z')
const cfg = (baseUrl: string, extra: any = {}) => ({ baseUrl, apiKey: null, model: 'm', timeoutMs: 2000, provider: 'p', temperature: 0, ...extra })

test('无 key 只允许 loopback；非本机无 key 拒绝', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:18881/v1'), true)
  assert.equal(isLoopbackUrl('http://localhost:18881/v1'), true)
  assert.equal(isLoopbackUrl('http://[::1]:18881/v1'), true)
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com/v1'), false)
  assert.equal(isLoopbackUrl('http://10.0.0.5:18881/v1'), false)
  const remote = configFromEnv({ PET_MODEL_BASE_URL: 'http://10.0.0.5/v1', PET_MODEL_NAME: 'm' } as any)
  assert.equal(remote.ok, false)
  const local = configFromEnv({ PET_MODEL_BASE_URL: 'http://127.0.0.1:18881/v1', PET_MODEL_NAME: 'm' } as any)
  assert.equal(local.ok, true)
  assert.equal(configFromEnv({} as any).ok, false)
})

test('真实 HTTP 协议路径：成功、HTTP 错误、超时、空输出都给出真实结果；不带 Authorization', async () => {
  const srv = await fakeOpenAI((body) => {
    const u = body.messages.at(-1).content
    if (u === 'u' && body.model === 'm') return { status: 200, body: { id: 'cmpl-1', model: 'served-m', choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } } }
    if (body.model === 'err') return { status: 500, body: { error: { message: 'boom' } } }
    if (body.model === 'slow') return { status: 200, body: {}, delayMs: 1500 }
    return { status: 200, body: { choices: [{ message: { content: '' } }] } }
  })
  try {
    const ok = await new OpenAICompatibleClient(cfg(srv.url)).complete(req)
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.response.rawText, '{"ok":1}')
      assert.equal(ok.response.model.name, 'served-m')
      assert.equal(ok.response.sessionId, 'cmpl-1')
    }
    assert.equal(srv.bodies[0].headers.authorization, undefined)
    assert.equal(srv.bodies[0].path, '/v1/chat/completions')
    const e = await new OpenAICompatibleClient(cfg(srv.url, { model: 'err' })).complete(req)
    assert.equal(!e.ok && e.code, 'http_error')
    const s = await new OpenAICompatibleClient(cfg(srv.url, { model: 'slow', timeoutMs: 200 })).complete(req)
    assert.equal(!s.ok && s.code, 'timeout')
    const empty = await new OpenAICompatibleClient(cfg(srv.url, { model: 'x' })).complete(makeRequest('assess', [{ role: 'user', content: 'zz' }], 'n'))
    assert.equal(!empty.ok && empty.code, 'empty_output')
    const remote = await new OpenAICompatibleClient(cfg('http://10.255.255.1/v1')).complete(req)
    assert.equal(!remote.ok && remote.code, 'not_configured')
  } finally {
    await srv.close()
  }
})

test('文件队列：请求不含 caseId；无响应为 pending；执行方写回后读取原文与元信息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-queue-'))
  try {
    const qc = new FileQueueClient(dir)
    const r = await qc.complete(req)
    assert.equal(!r.ok && r.code, 'pending')
    assert.deepEqual(qc.pending(), [req.requestId])
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'responses', `${req.requestId}.json`), JSON.stringify({ requestId: req.requestId, sessionId: 'sess-x', rawText: '{"a":1}', model: {} }))
    const r2 = await qc.complete(req)
    assert.equal(r2.ok && r2.response.model.name, 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SCHEMA adapter：case 输入 → 两次 HTTP 调用（抽取+assessment），请求不含 caseId/未来原话，输出 SCHEMA response', async () => {
  const input = {
    turns: [
      { id: 'turn-001', sessionId: 's1', seq: 1, at: '2026-11-13T09:00:00+08:00', role: 'user', text: '报告格式用PDF。', taskIds: ['task:r'] },
      { id: 'turn-002', sessionId: 's2', seq: 2, at: '2026-11-13T10:00:00+08:00', role: 'user', text: '未来的话：改成xlsx。', taskIds: ['task:r'] },
    ],
    query: { text: '报告格式？', taskId: 'task:r', asOfSeq: 1, asOfAt: '2026-11-13T09:30:00+08:00', intent: 'current', requestedFactKeys: ['format'] },
    runtimeState: { now: '2026-11-13T09:30:00+08:00', entities: [{ id: 'task:r', type: 'task', label: 'R' }], taskStatuses: [] },
  } as any
  const srv = await fakeOpenAI((body) => {
    const sys: string = body.messages[0].content
    const content = sys.startsWith('你是记忆抽取器')
      ? JSON.stringify({ items: [{ kind: 'commitment', key: 'format', value: 'PDF', statement: '格式PDF', scope: { level: 'task', id: 'task:r' }, validFrom: '2026-11-13T09:00:00+08:00', validUntil: null, supersedes: [], confidence: 0.9, status: 'active', quotes: [{ turnId: 'turn-001', start: 5, end: 8, text: 'PDF' }] }] })
      : JSON.stringify({ kind: 'none', reasonCode: 'no_current_action', evidenceTurnIds: ['turn-001'], evidenceItemIds: [], answerFacts: [{ key: 'format', value: 'PDF', sourceTurnIds: ['turn-001'] }] })
    return { status: 200, body: { id: 'c', model: 'fixture-served', choices: [{ message: { content } }] } }
  })
  try {
    const r = await runCase(input, new OpenAICompatibleClient(cfg(srv.url)))
    assert.equal(r.ok, true)
    assert.equal(srv.bodies.length, 2)
    for (const b of srv.bodies) assert.ok(!JSON.stringify(b.body).includes('xlsx'), '未来原话不进请求')
    if (r.ok) {
      assert.deepEqual(r.response.answerFacts, [{ key: 'format', value: 'PDF', sourceTurnIds: ['turn-001'] }])
      assert.equal(r.response.action.kind, 'none')
      assert.equal(r.guard.code, 'accepted')
    }
  } finally {
    await srv.close()
  }
})
