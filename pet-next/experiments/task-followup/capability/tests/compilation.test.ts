import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryCompilation, MemoryCompilationClosedError } from '../memory/compilation.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}
const microtasks = async () => { await Promise.resolve(); await Promise.resolve() }

test('快速新assessment复用同任务编译；消费者取消不取消编译；结束后允许下个delta', async () => {
  const compiler = new MemoryCompilation<number>()
  const work = deferred<number>()
  const assessment = new AbortController()
  let calls = 0, compilationSignal: AbortSignal | undefined
  const first = compiler.run('task:A', async (signal) => { calls++; compilationSignal = signal; return work.promise })
  await microtasks()
  assessment.abort(new Error('new message supersedes assessment'))
  const reused = compiler.run('task:A', async () => { calls++; return 999 })
  assert.equal(first, reused)
  assert.equal(calls, 1)
  assert.equal(compilationSignal!.aborted, false)
  assert.equal(compiler.inFlightCount, 1)
  work.resolve(7)
  assert.equal(await reused, 7)
  assert.equal(compiler.inFlightCount, 0)
  assert.equal(await compiler.run('task:A', async () => { calls++; return 8 }), 8)
  assert.equal(calls, 2)
  await compiler.close()
})

test('不同任务编译独立：一个未结束不阻止另一个完成', async () => {
  const compiler = new MemoryCompilation<string>()
  const slow = deferred<string>()
  const a = compiler.run('task:A', () => slow.promise)
  const b = compiler.run('task:B', async () => 'B compiled')
  assert.equal(await b, 'B compiled')
  assert.equal(compiler.has('task:A'), true)
  assert.equal(compiler.has('task:B'), false)
  slow.resolve('A compiled')
  assert.equal(await a, 'A compiled')
  await compiler.close()
})

test('close封闭入口、传播取消并等待清理结束，失败原样交给run调用者', async () => {
  const compiler = new MemoryCompilation<number>()
  const cleanup = deferred<void>()
  const stopped = new Error('host shutdown identity')
  let signalSeen: AbortSignal | undefined, writesFinished = false, finished = false
  const flight = compiler.run('task:A', async (signal) => {
    signalSeen = signal
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    await cleanup.promise
    writesFinished = true
    throw signal.reason
  })
  const observed = flight.then(() => null, (e) => e)
  await microtasks()
  const closing = compiler.close(stopped)
  assert.equal(compiler.close(), closing, '重复close复用同一屏障')
  void closing.then(() => { finished = true })
  await microtasks()
  assert.equal(signalSeen!.aborted, true)
  assert.equal(signalSeen!.reason, stopped)
  assert.equal(finished, false, '不能在写者清理前关闭数据库')
  assert.equal(compiler.has('task:A'), true, '清理期间仍占用该任务single-flight')
  let called = false
  await assert.rejects(compiler.run('task:B', async () => { called = true; return 1 }), MemoryCompilationClosedError)
  assert.equal(called, false)
  cleanup.resolve()
  await closing
  assert.equal(await observed, stopped)
  assert.equal(writesFinished, true)
  assert.equal(compiler.inFlightCount, 0)
})

test('不合作的work也必须settle后close才完成；close不伪造完成或改写原错误', async () => {
  const compiler = new MemoryCompilation<number>()
  const stubborn = deferred<number>()
  const failure = { code: 'provider-error', raw: 'original failure object' }
  const flight = compiler.run('task:A', () => stubborn.promise)
  const observed = flight.catch((e) => e)
  await microtasks()
  let closed = false
  const closing = compiler.close().then(() => { closed = true })
  await microtasks()
  assert.equal(closed, false)
  stubborn.reject(failure)
  await closing
  assert.equal(await observed, failure)
})

test('abortAll只取消当前批；清理期间不能重叠同任务，结束后可继续且新flight不被旧finally清除', async () => {
  const compiler = new MemoryCompilation<number>()
  const cleanup = deferred<void>(), replacement = deferred<number>()
  const old = compiler.run('task:A', async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    await cleanup.promise
    throw signal.reason
  })
  void old.catch(() => undefined)
  await microtasks()
  const aborting = compiler.abortAll(new Error('cancel current batch'))
  let extraWork = false
  assert.equal(compiler.run('task:A', async () => { extraWork = true; return 77 }), old)
  cleanup.resolve()
  await aborting
  assert.equal(extraWork, false)
  assert.equal(compiler.closed, false)
  const next = compiler.run('task:A', () => replacement.promise)
  await microtasks()
  assert.equal(compiler.has('task:A'), true)
  assert.notEqual(next, old)
  replacement.resolve(9)
  assert.equal(await next, 9)
  await compiler.close()
})

test('close发生在work启动微任务之前：不再调用work；同步抛错也原样传播并释放任务', async () => {
  const compiler = new MemoryCompilation<number>()
  let started = false
  const reason = new Error('closed before start')
  const flight = compiler.run('task:A', async () => { started = true; return 1 })
  const observed = flight.catch((e) => e)
  await compiler.close(reason)
  assert.equal(started, false)
  assert.equal(await observed, reason)
  const another = new MemoryCompilation<number>()
  const error = new Error('synchronous work error')
  await assert.rejects(another.run('task:A', () => { throw error }), (e) => e === error)
  assert.equal(another.has('task:A'), false)
  await another.close()
})
