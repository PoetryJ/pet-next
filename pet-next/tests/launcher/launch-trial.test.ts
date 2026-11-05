/**
 * M3-7 D：scripts/launch-trial.mjs 单测（全部 IO 注入，不真起 Electron、不读真盘）。
 * 覆盖：Node 版本不足非零退出、main.js 缺失退出 1、正常路径 PET_NEXT_LAUNCHER=1
 * 与退出码透传（含 exit 7）、Linux 参数含 --no-sandbox、信号透传、
 * ELECTRON_RUN_AS_NODE 残留清理、契约常量与 contracts/launcher.ts 不漂移。
 * 运行：node --experimental-strip-types --test --test-reporter spec tests/launcher/launch-trial.test.ts
 * （pnpm test 经 scripts/unit-tests.mjs 自动收集。）
 * @module pet-next/tests/launcher/launch-trial
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_MODE_ENV as CONTRACT_LAUNCHER_MODE_ENV } from '../../contracts/launcher.ts';
import {
  buildLauncherArgs,
  LAUNCHER_MODE_ENV,
  MIN_NODE,
  nodeVersionProblem,
  NO_BUILD_HINT,
  runLaunchTrial,
} from '../../scripts/launch-trial.mjs';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 假子进程：只实现 on/error/exit 形状，由测试手动触发。 */
interface FakeChild {
  on(event: string, handler: (...args: never[]) => void): FakeChild;
  emitExit(code: number | null, signal: string | null): void;
  emitError(error: Error): void;
}

function createFakeChild(): FakeChild {
  const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  const child: FakeChild = {
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler as (code: number | null, signal: string | null) => void);
      if (event === 'error') errorHandlers.push(handler as (error: Error) => void);
      return child;
    },
    emitExit(code, signal) {
      for (const handler of [...exitHandlers]) handler(code, signal);
    },
    emitError(error) {
      for (const handler of [...errorHandlers]) handler(error);
    },
  };
  return child;
}

interface SpawnCall {
  command: string;
  args: string[];
  stdio: unknown;
  env: NodeJS.ProcessEnv;
}

function createHarness(overrides: { env?: NodeJS.ProcessEnv; platform?: string; exists?: (file: string) => boolean } = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const signals: string[] = [];
  const fakePetRoot = '/fake-pet-root';
  const mainPath = path.join(fakePetRoot, 'dist/electron/main.js');
  const harness = {
    calls,
    children,
    errors,
    logs,
    signals,
    fakePetRoot,
    mainPath,
    spawn(command: string, args: string[], options: { stdio: unknown; env: NodeJS.ProcessEnv }): FakeChild {
      calls.push({ command, args, stdio: options.stdio, env: options.env });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    run(): Promise<number> {
      return runLaunchTrial({
        nodeVersion: '24.22.1',
        platform: overrides.platform ?? 'linux',
        petRoot: fakePetRoot,
        electronPath: '/fake/electron',
        spawn: harness.spawn,
        env: overrides.env ?? {},
        log: (line) => logs.push(line),
        logError: (line) => errors.push(line),
        exists: overrides.exists ?? ((file: string) => file === mainPath),
        onChildSignal: (signal) => signals.push(signal),
      });
    },
  };
  return harness;
}

test('契约不漂移：LAUNCHER_MODE_ENV 与 contracts/launcher.ts 一致，值为 PET_NEXT_LAUNCHER', () => {
  assert.equal(LAUNCHER_MODE_ENV, 'PET_NEXT_LAUNCHER');
  assert.equal(LAUNCHER_MODE_ENV, CONTRACT_LAUNCHER_MODE_ENV);
  assert.deepEqual(MIN_NODE, { major: 22, minor: 12 });
});

test('nodeVersionProblem：22.12.0/24.22.1 通过；22.11.9/20.x/乱串给出含版本号的中文错误', () => {
  assert.equal(nodeVersionProblem('22.12.0'), null);
  assert.equal(nodeVersionProblem('24.22.1'), null);
  for (const low of ['22.11.9', '20.10.0', '21.0.0']) {
    const problem = nodeVersionProblem(low);
    assert.ok(problem !== null, `${low} 必须判为版本过低`);
    assert.ok(problem.includes(low), `错误要带上实际版本号：${problem}`);
    assert.ok(problem.includes('22.12'), `错误要写清最低版本：${problem}`);
    assert.ok(problem.includes('Node 版本过低'), `错误要可读：${problem}`);
  }
  const garbage = nodeVersionProblem('not-a-version');
  assert.ok(garbage !== null && garbage.includes('not-a-version'), '乱串按版本过低处理并原样展示');
  assert.equal(nodeVersionProblem('22.12'), null, '两段版本号 22.12 视同 22.12.0 通过');
});

test('buildLauncherArgs：Linux 附 --no-sandbox --disable-dev-shm-usage；win32/darwin 只有 main.js', () => {
  const main = '/x/dist/electron/main.js';
  assert.deepEqual(buildLauncherArgs('linux', main), ['--no-sandbox', '--disable-dev-shm-usage', main]);
  assert.deepEqual(buildLauncherArgs('win32', main), [main]);
  assert.deepEqual(buildLauncherArgs('darwin', main), [main]);
});

test('runLaunchTrial：Node 版本不足 → 退出 1、可读中文错误、不 spawn', async () => {
  const harness = createHarness();
  const code = await runLaunchTrial({
    nodeVersion: '20.10.0',
    platform: 'linux',
    petRoot: harness.fakePetRoot,
    electronPath: '/fake/electron',
    spawn: harness.spawn,
    env: {},
    logError: (line) => harness.errors.push(line),
  });
  assert.equal(code, 1);
  assert.equal(harness.calls.length, 0, '版本不足必须先于 spawn 失败');
  assert.ok(harness.errors.join('\n').includes('20.10.0'), '错误要包含实际版本号');
  assert.ok(harness.errors.join('\n').includes('Node 版本过低'), '错误文案要可读');
});

test('runLaunchTrial：dist/electron/main.js 缺失 → 退出 1、提示 pnpm install && pnpm build、不 spawn', async () => {
  const harness = createHarness({ exists: () => false });
  const code = await harness.run();
  assert.equal(code, 1);
  assert.equal(harness.calls.length, 0, '缺构建产物不得尝试起 Electron');
  const message = harness.errors.join('\n');
  assert.ok(message.includes('pnpm install && pnpm build'), `提示要可操作：${message}`);
  assert.ok(message.includes(NO_BUILD_HINT), `与统一提示文案一致：${message}`);
});

test('runLaunchTrial：正常路径（Linux）→ env 含 PET_NEXT_LAUNCHER=1、参数含 --no-sandbox、stdio inherit、退出码 7 透传', async () => {
  const harness = createHarness({ env: { PET_NEXT_KEEP: '1' } });
  const pending = harness.run();
  const child = harness.children[0];
  assert.ok(child !== undefined, 'spawn 必须同步发生');
  child.emitExit(7, null);
  assert.equal(await pending, 7, '子进程退出码原样透传');
  const call = harness.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.command, '/fake/electron');
  assert.deepEqual(call.args, ['--no-sandbox', '--disable-dev-shm-usage', harness.mainPath]);
  assert.equal(call.stdio, 'inherit');
  assert.equal(call.env.PET_NEXT_LAUNCHER, '1', '必须设置 launcher 模式开关');
  assert.equal(call.env.PET_NEXT_KEEP, '1', '其余环境变量原样透传');
});

test('runLaunchTrial：win32 不带 --no-sandbox；父 env 残留的 ELECTRON_RUN_AS_NODE 被清掉', async () => {
  const harness = createHarness({ platform: 'win32', env: { ELECTRON_RUN_AS_NODE: '1' } });
  const pending = harness.run();
  const child = harness.children[0];
  assert.ok(child !== undefined);
  child.emitExit(0, null);
  assert.equal(await pending, 0);
  const call = harness.calls[0];
  assert.ok(call !== undefined);
  assert.deepEqual(call.args, [harness.mainPath], 'Windows 不附沙箱参数（同 start.mjs）');
  assert.equal('ELECTRON_RUN_AS_NODE' in call.env, false, '不得以 node 方式运行 Electron');
  assert.equal(call.env.PET_NEXT_LAUNCHER, '1');
});

test('runLaunchTrial：子进程被信号结束 → 透传同一信号（注入记录器验证）', async () => {
  const harness = createHarness();
  const pending = harness.run();
  const child = harness.children[0];
  assert.ok(child !== undefined);
  child.emitExit(null, 'SIGTERM');
  assert.equal(await pending, 0, '无退出码时按 0 收尾（真实路径先自signal）');
  assert.deepEqual(harness.signals, ['SIGTERM'], '必须对自身重发同一信号');
});

test('runLaunchTrial：spawn 触发 error 事件（Electron 不可执行）→ 退出 1、错误可读', async () => {
  const harness = createHarness();
  const pending = harness.run();
  const child = harness.children[0];
  assert.ok(child !== undefined);
  child.emitError(new Error('ENOENT: /fake/electron'));
  assert.equal(await pending, 1);
  assert.ok(harness.errors.join('\n').includes('启动失败'), `错误要可读：${harness.errors.join('\n')}`);
});

test('runLaunchTrial：默认注入项存在性自检（真机环境不执行，仅类型与默认路径核对）', () => {
  // 不调用真 spawn/真 fs：只确认 petRoot 下预期产物路径形状（分隔符合规）。
  const expected = path.join(petRoot, 'dist/electron/main.js');
  assert.ok(expected.endsWith(path.join('dist', 'electron', 'main.js')));
});
