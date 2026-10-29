/**
 * 启动失败、超时和正常退出之后，只清掉这次夹具的进程树。
 * 旁边一个名为 electron 的无关进程必须还在。
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pidIsAlive, signalPid } from './support/process-table.ts';
import { startTrackedRun, type ReadyWait, type TrackedRun } from './support/tracked-run.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/cleanup-child.mjs', import.meta.url));

test('启动失败：子进程还在时根进程退出，清理后树没了，无关进程还在', { timeout: 20000 }, async () => {
  const root = await makeLogRoot();
  const run = startFixture('fail', root);
  const decoy = await startDecoy(root);
  try {
    const ready = await run.untilReady({ timeoutMs: 4000, ready: (stdout) => stdout.includes('READY') });
    const failed = finished(ready);
    assert.equal(failed.status, 'startup-failure');
    assert.equal(failed.exitCode, 2);
    await assertTreeGone(run);
    await assertRecord(failed.recordDir, '2\n', 'fail');
    assert.equal(pidIsAlive(decoy.pid), true, '这次运行之外的进程应该还在');
  } finally {
    await release(run, decoy);
  }
});

test('超时：就绪没有出现就结束整棵树，退出码不是成功', { timeout: 20000 }, async () => {
  const root = await makeLogRoot();
  const run = startFixture('hang', root);
  const decoy = await startDecoy(root);
  try {
    const ready = await run.untilReady({ timeoutMs: 700, ready: () => false });
    const timedOut = finished(ready);
    assert.equal(timedOut.status, 'timeout');
    assert.notEqual(timedOut.exitCode, 0);
    if (process.platform === 'linux') {
      assert.equal(timedOut.exitCode, null, 'Linux 上超时终止应该没有退出码');
      assert.equal(timedOut.signal, 'SIGKILL');
    }
    await assertTreeGone(run);
    await assertRecord(timedOut.recordDir, exitText(timedOut.exitCode), 'hang');
    assert.equal(pidIsAlive(decoy.pid), true, '这次运行之外的进程应该还在');
  } finally {
    await release(run, decoy);
  }
});

test('正常退出：根进程自己以 0 结束，留下的子进程仍被清掉', { timeout: 20000 }, async () => {
  const root = await makeLogRoot();
  const run = startFixture('exit', root);
  const decoy = await startDecoy(root);
  try {
    const ready = await run.untilReady({ timeoutMs: 4000, ready: (stdout) => stdout.includes('READY') });
    assert.equal(ready.status, 'ready');
    const exited = await run.untilExit(4000);
    assert.equal(exited.timedOut, false);
    assert.equal(exited.exitCode, 0);
    await assertTreeGone(run);
    await assertRecord(exited.recordDir, '0\n', 'exit');
    assert.equal(pidIsAlive(decoy.pid), true, '这次运行之外的进程应该还在');
  } finally {
    await release(run, decoy);
  }
});

function startFixture(mode: string, logRoot: string): TrackedRun {
  return startTrackedRun({
    executable: process.execPath,
    args: [fixturePath, mode],
    cwd: path.dirname(fixturePath),
    env: {
      ...process.env,
      PET_NEXT_CLEANUP: mode,
      PET_NEXT_EXAMPLE_TOKEN: 'super-secret',
    },
    label: `cleanup-${mode}`,
    logRoot,
    platformSegment: process.env.PET_NEXT_RUN_LOG_ROOT === undefined,
  });
}

async function makeLogRoot(): Promise<string> {
  const fromEnv = process.env.PET_NEXT_RUN_LOG_ROOT;
  if (fromEnv) return fromEnv;
  return mkdtemp(path.join(tmpdir(), 'pet-next-run-log-'));
}

interface Decoy {
  readonly pid: number;
  readonly imageName: string;
  close(): Promise<void>;
}

async function startDecoy(logRoot: string): Promise<Decoy> {
  if (process.platform === 'win32') return startWindowsDecoy(logRoot);
  return startPosixDecoy(logRoot);
}

function startWindowsDecoy(logRoot: string): Decoy {
  const run = startTrackedRun({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: logRoot,
    env: process.env,
    label: 'decoy',
    logRoot,
  });
  return { pid: run.pid, imageName: path.basename(process.execPath), close: () => run.stop() };
}

async function startPosixDecoy(logRoot: string): Promise<Decoy> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-next-decoy-'));
  const executable = path.join(dir, 'electron');
  await writeFile(executable, '#!/bin/sh\nwhile true; do sleep 30; done\n');
  await chmod(executable, 0o755);
  const run = startTrackedRun({
    executable,
    args: [],
    cwd: dir,
    env: process.env,
    label: 'decoy',
    logRoot,
  });
  const imageName = path.basename(executable);
  assert.equal(imageName, 'electron');
  return {
    pid: run.pid,
    imageName,
    close: async () => {
      await run.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function assertTreeGone(run: TrackedRun): Promise<void> {
  const childPid = childPidFrom(run.stdout());
  assert.ok(run.trackedPids().includes(childPid), '清理范围应该包含夹具拉起的子进程');
  assert.equal(pidIsAlive(childPid), false, '夹具的子进程应该已经结束');
  assert.equal(pidIsAlive(run.pid), false, '夹具根进程应该已经结束');
}

function childPidFrom(stdout: string): number {
  const match = /CHILD (\d+)/.exec(stdout);
  const text = match?.[1];
  assert.ok(text, '夹具应该把子进程 PID 写到 stdout');
  return Number(text);
}

async function assertRecord(directory: string, expectedExit: string, mode: string): Promise<void> {
  const commandText = await readFile(path.join(directory, 'command.json'), 'utf8');
  const command = JSON.parse(commandText) as { executable: string; args: string[]; platform: string };
  assert.equal(command.executable, process.execPath);
  assert.equal(command.platform, process.platform);
  assert.ok(Array.isArray(command.args), '命令应该是参数数组，不是拼出来的 shell 字符串');
  assert.equal(command.args.at(-1), mode);
  const environment = await readFile(path.join(directory, 'environment.json'), 'utf8');
  const env = JSON.parse(environment) as Record<string, string>;
  assert.equal(env.PET_NEXT_CLEANUP, mode);
  assert.equal(env.PET_NEXT_EXAMPLE_TOKEN, '[redacted]');
  assert.equal(environment.includes('super-secret'), false);
  assert.equal(commandText.includes('super-secret'), false);
  assert.equal(await readFile(path.join(directory, 'exit-code.txt'), 'utf8'), expectedExit);
  const stdout = await readFile(path.join(directory, 'stdout.log'), 'utf8');
  const stderr = await readFile(path.join(directory, 'stderr.log'), 'utf8');
  assert.match(stdout, /CHILD \d+/);
  assert.equal(stdout.includes(`MODE ${mode}`), false);
  assert.match(stderr, new RegExp(`MODE ${mode}`));
  assert.equal(stderr.includes('CHILD '), false);
}

function finished(ready: ReadyWait): Exclude<ReadyWait, { status: 'ready' }> {
  if (ready.status === 'ready') throw new Error('run became ready');
  return ready;
}

function exitText(exitCode: number | null): string {
  return exitCode === null ? 'null\n' : `${exitCode}\n`;
}

async function release(run: TrackedRun, decoy: Decoy): Promise<void> {
  const childPid = childPidFromMaybe(run.stdout());
  await run.stop();
  if (childPid !== undefined && pidIsAlive(childPid)) signalPid(childPid, false);
  await decoy.close();
  if (pidIsAlive(decoy.pid)) signalPid(decoy.pid, true);
}

function childPidFromMaybe(stdout: string): number | undefined {
  const match = /CHILD (\d+)/.exec(stdout);
  const text = match?.[1];
  return text ? Number(text) : undefined;
}
