/**
 * M3-8 B：scripts/test-run-context.mjs 的单测。
 * 运行：node --experimental-strip-types --test --test-reporter spec scripts/test-run-context.test.mjs
 * 只碰本进程的临时目录与自起的 Xvfb；不启动 Electron，不占用 :94/:95-:97。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { createRunContext, startOwnXvfb } from './test-run-context.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const xvfbInstalled = existsSync('/usr/bin/Xvfb');

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('每次运行目录唯一，配置/日志路径都在本轮目录内', async () => {
  const first = createRunContext({ label: 'isolation-a', kind: 'e2e' });
  const second = createRunContext({ label: 'isolation-b', kind: 'e2e' });
  try {
    assert.notEqual(first.dir, second.dir);
    assert.equal(path.dirname(first.logDir), first.dir);
    assert.ok(first.configPath.startsWith(first.dir));
    assert.ok(first.modelLogPath.startsWith(first.logDir));
    assert.ok(first.sshLogPath.startsWith(first.logDir));
    assert.ok(existsSync(first.logDir));
    const meta = JSON.parse(readFileSync(path.join(first.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.label, 'isolation-a');
    assert.equal(meta.kind, 'e2e');
    assert.equal(meta.pid, process.pid);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('env 注入本轮路径与隔离变量，不继承 NODE_OPTIONS，extra 可覆盖', async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--trace-warnings';
  const ctx = createRunContext({ label: 'env-wiring', kind: 'e2e' });
  try {
    const base = ctx.env();
    assert.equal(base.NODE_OPTIONS, undefined);
    assert.equal(base.PET_NEXT_USER_DATA, path.join(ctx.dir, 'userData'));
    assert.equal(base.PET_NEXT_REMOTE_CONFIG, ctx.configPath);
    assert.equal(base.FAKE_MODEL_LOG, ctx.modelLogPath);
    assert.equal(base.FAKE_SSH_LOG, ctx.sshLogPath);
    assert.equal(base.PET_NEXT_RUN_DIR, ctx.dir);

    const overridden = ctx.env({ DISPLAY: ':123', FAKE_SSH_MODE: 'ok', NODE_OPTIONS: undefined });
    assert.equal(overridden.DISPLAY, ':123');
    assert.equal(overridden.FAKE_SSH_MODE, 'ok');
    delete base.PET_NEXT_USER_DATA;
    assert.equal(ctx.env().PET_NEXT_USER_DATA, path.join(ctx.dir, 'userData'), 'env() 每次返回新对象');
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await ctx.cleanup();
  }
});

test('freePort 每次都给不同端口，且能被同时监听；snapshot 登记全部端口', async () => {
  const ctx = createRunContext({ label: 'port-unique', kind: 'bench' });
  const servers = [];
  try {
    const first = await ctx.freePort();
    const second = await ctx.freePort();
    assert.notEqual(first, second);
    servers.push(await listen(first));
    servers.push(await listen(second));
    assert.deepEqual(ctx.snapshot().ports, [first, second]);
  } finally {
    for (const server of servers) await close(server);
    await ctx.cleanup();
  }
});

test('cleanup 先写残留断言再清目录：端口仍被监听时保留目录', async () => {
  const ctx = createRunContext({ label: 'residual-first', kind: 'e2e' });
  const port = await ctx.freePort();
  writeFileSync(ctx.modelLogPath, '{"event":"chat-request"}\n');
  writeFileSync(ctx.configPath, '{}\n');
  const server = await listen(port);
  try {
    const residual = await ctx.cleanup();
    assert.equal(residual.ok, false);
    assert.deepEqual(residual.ports.stillListening, [port]);
    assert.equal(residual.dirKept, true);
    assert.ok(existsSync(ctx.dir), '有残留时目录必须保留当证据');
    const recorded = JSON.parse(readFileSync(path.join(ctx.logDir, 'residual.json'), 'utf8'));
    assert.deepEqual(recorded.ports.stillListening, [port]);
    assert.ok(recorded.files.modelLogBytes > 0);
  } finally {
    await close(server);
  }
  const second = await ctx.cleanup();
  assert.equal(second.ok, true, '端口释放后再次清理应无残留');
  assert.equal(second.dirKept, false);
  assert.equal(existsSync(ctx.dir), false);
});

test('cleanup 不杀树外进程（只清本轮目录）', async () => {
  const ctx = createRunContext({ label: 'no-foreign-kill', kind: 'e2e' });
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await delay(100);
    assert.ok(decoy.pid !== undefined);
    await ctx.cleanup();
    assert.doesNotThrow(() => process.kill(decoy.pid, 0), '无关进程必须存活');
  } finally {
    decoy.kill('SIGKILL');
    await new Promise((resolve) => decoy.once('exit', resolve));
  }
});

test('非法 label/kind 直接拒绝', () => {
  assert.throws(() => createRunContext({ label: 'Bad_Label', kind: 'e2e' }), /kebab-case/);
  assert.throws(() => createRunContext({ label: 'ok', kind: '' }), /kebab-case/);
});

test('startOwnXvfb 起自有显示器，stop 只收本次进程', async (t) => {
  if (!xvfbInstalled) {
    t.skip('not-run: 本机没有 Xvfb');
    return;
  }
  const first = await startOwnXvfb({ label: 'xvfb-a' });
  const second = await startOwnXvfb({ label: 'xvfb-b' });
  try {
    assert.notEqual(first.display, second.display);
    for (const display of [first.display, second.display]) {
      assert.ok(![':94', ':95', ':96', ':97'].includes(display), `不得占用共享显示器：${display}`);
      assert.ok(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`));
    }
    const stopResult = await first.stop();
    assert.equal(stopResult.stopped, true);
    const deadline = Date.now() + 4000;
    while (existsSync(first.socket) && Date.now() < deadline) await delay(50);
    assert.equal(existsSync(first.socket), false, 'stop 后自己的 socket 应消失');
    assert.ok(existsSync(second.socket), '不得连带停掉别轮 Xvfb');
  } finally {
    await second.stop();
  }
  assert.equal((await first.stop()).stopped, false, 'stop 幂等');
});

test('startOwnXvfb 拒绝非法 label', async () => {
  await assert.rejects(() => startOwnXvfb({ label: 'Bad Label' }), /kebab-case/);
});
