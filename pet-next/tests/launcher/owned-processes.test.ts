/**
 * M3-7 D：tests/launcher/owned-processes.ts 单测（只读，不杀任何进程）。
 * 覆盖：/proc stat 解析（含 comm 带空格括号）、僵尸判定、linux 注入构树（树外的 PID 不入选）、
 * win32 注入进程表构树、非法 root、不支持平台、根存活/消失、空快照、超时返回仍存活 PID。
 * 运行：node --experimental-strip-types --test --test-reporter spec tests/launcher/owned-processes.test.ts
 * （pnpm test 经 scripts/unit-tests.mjs 自动收集。）
 * @module pet-next/tests/launcher/owned-processes.test
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  captureOwnedProcesses,
  isZombieStat,
  parseStatPpid,
  waitOwnedGone,
  WIN32_TABLE_PATH,
} from './owned-processes.ts';

/** 造一行 /proc/<pid>/stat：`pid (comm) state ppid ...`，后面的字段不影响解析。 */
function statLine(pid: number, ppid: number, state = 'S', comm = 'node'): string {
  return `${pid} (${comm}) ${state} ${ppid} 100 100 0 -1 4194560`;
}

test('parseStatPpid 从最后一个右括号之后取 ppid（comm 可含空格与括号）', () => {
  assert.equal(parseStatPpid(statLine(123, 45)), 45);
  assert.equal(parseStatPpid(statLine(123, 45, 'S', 'a b (c)')), 45);
  assert.equal(parseStatPpid('garbage'), undefined);
  assert.equal(parseStatPpid('123 (x) S'), undefined);
});

test('isZombieStat 只把 Z 当僵尸', () => {
  assert.equal(isZombieStat(statLine(9, 1, 'Z')), true);
  assert.equal(isZombieStat(statLine(9, 1, 'S')), false);
  assert.equal(isZombieStat('garbage'), false);
});

test('linux 注入：从 root 递归构树，pids 以 root 开头且不含树外进程', () => {
  const stats = new Map<string, string>([
    ['/proc/100/stat', statLine(100, 1)],
    ['/proc/200/stat', statLine(200, 100)],
    ['/proc/300/stat', statLine(300, 200)],
    ['/proc/400/stat', statLine(400, 1)], // 树外哨兵
  ]);
  const snapshot = captureOwnedProcesses(100, {
    platform: 'linux',
    readDir: () => ['1', 'self', '100', '200', '300', '400', '999'],
    readFile: (file) => {
      const stat = stats.get(file);
      if (stat === undefined) throw new Error(`ENOENT ${file}`);
      return stat;
    },
  });
  assert.equal(snapshot.rootPid, 100);
  assert.deepEqual(snapshot.pids, [100, 200, 300]);
});

test('linux 注入：整张表读不到时明确报错，不静默降级成「只有根」', () => {
  assert.throws(
    () =>
      captureOwnedProcesses(100, {
        platform: 'linux',
        readDir: () => {
          throw new Error('EACCES /proc');
        },
      }),
    /不能声称本次树零残留/,
  );
});

test('win32 注入：解析 "pid ppid" 进程表并只保留本次树', () => {
  const seen: string[] = [];
  const snapshot = captureOwnedProcesses(500, {
    platform: 'win32',
    readFile: (file) => {
      seen.push(file);
      return ['500 4', '501 500', '502 501', '900 4'].join('\r\n');
    },
  });
  assert.deepEqual(seen, [WIN32_TABLE_PATH]);
  assert.deepEqual(snapshot, { rootPid: 500, pids: [500, 501, 502] });
});

test('非法 rootPid 直接返回空快照，不读进程表', () => {
  let reads = 0;
  for (const bad of [0, -5, Number.NaN]) {
    const snapshot = captureOwnedProcesses(bad, {
      platform: 'linux',
      readDir: () => {
        reads += 1;
        return [];
      },
    });
    assert.deepEqual(snapshot.pids, []);
  }
  assert.equal(reads, 0);
});

test('不支持的平台明确报错，不猜', () => {
  assert.throws(() => captureOwnedProcesses(1, { platform: 'darwin', readDir: () => [] }), /只支持 linux\/win32/);
});

test('空快照立即返回空 alive', async () => {
  const started = Date.now();
  const result = await waitOwnedGone({ rootPid: 0, pids: [] }, { timeoutMs: 5000 });
  assert.deepEqual(result, { alive: [] });
  assert.ok(Date.now() - started < 1000);
});

test('根存活时返回该 PID（超时也不抛错）', async () => {
  const result = await waitOwnedGone({ rootPid: process.pid, pids: [process.pid] }, { timeoutMs: 120 });
  assert.deepEqual(result.alive, [process.pid]);
});

test('根消失后返回空 alive', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 80)'], { stdio: 'ignore' });
  const exited = waitExit(child);
  const snapshot = captureOwnedProcesses(child.pid ?? 0);
  assert.ok((child.pid ?? 0) > 0);
  assert.ok(snapshot.pids.includes(child.pid ?? 0));
  await exited;
  const result = await waitOwnedGone(snapshot, { timeoutMs: 5000 });
  assert.deepEqual(result.alive, []);
});

test('waitOwnedGone 会等到进程真正退出，不是立刻返回', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 250)'], { stdio: 'ignore' });
  const exited = waitExit(child);
  const pid = child.pid ?? 0;
  assert.ok(pid > 0);
  const started = Date.now();
  const result = await waitOwnedGone({ rootPid: pid, pids: [pid] }, { timeoutMs: 5000 });
  const elapsed = Date.now() - started;
  await exited;
  assert.deepEqual(result.alive, []);
  assert.ok(elapsed >= 100, `应等待子进程退出，实际 ${elapsed}ms`);
});

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}
