/**
 * M3-5 B 测试：chat:trial 参数模块与入口子进程（零网络、零真实模型）。
 * 入口子进程通过 PET_NEXT_REMOTE_CONFIG 指向坏 JSON，使复用的 chat-remote 在
 * 读取本地配置阶段（先于任何 spawn/隧道/探测）exit 1——既证明"复用而非重实现"，
 * 又构成零网络边界。收集：pnpm test（scripts/*.test.ts）。
 * @module pet-next/scripts/chat-trial-args.test
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildTrialEnv,
  OFF_LOG,
  ON_LOG,
  parseTrialArgs,
  TRIAL_CONTEXT_ENV,
  TRIAL_USAGE,
} from './chat-trial-args.mjs';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = path.join(petRoot, 'scripts/chat-trial.mjs');

test('parseTrialArgs：无参数缺省 off', () => {
  assert.deepEqual(parseTrialArgs([]), { ok: true, context: 'off' });
});

test('parseTrialArgs：--context=on / --context=off', () => {
  assert.deepEqual(parseTrialArgs(['--context=on']), { ok: true, context: 'on' });
  assert.deepEqual(parseTrialArgs(['--context=off']), { ok: true, context: 'off' });
});

test('parseTrialArgs：非法值/不带值/未知参数/位置参数 → exit 2', () => {
  for (const bad of [
    ['--context=onn'], ['--context=true'], ['--context=1'], ['--context='],
    ['--context'], ['--verbose'], ['on'], ['--context=on', 'extra'],
  ]) {
    const result = parseTrialArgs(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.exitCode, 2, JSON.stringify(bad));
  }
});

test('parseTrialArgs：重复 --context 显式报错（防误粘）', () => {
  for (const argv of [['--context=on', '--context=off'], ['--context=on', '--context=on']]) {
    const result = parseTrialArgs(argv);
    assert.equal(result.ok, false, JSON.stringify(argv));
    assert.ok(result.error.includes('重复'), JSON.stringify(argv));
  }
});

test('buildTrialEnv：on 设 1；off 删除继承值；原对象不被改；其余键透传', () => {
  const parent = { PATH: '/bin', HOME: '/root', [TRIAL_CONTEXT_ENV]: '1' };
  const offChild = buildTrialEnv(parent, 'off');
  assert.ok(!(TRIAL_CONTEXT_ENV in offChild));
  assert.equal(parent[TRIAL_CONTEXT_ENV], '1'); // 父对象原样
  assert.equal(offChild.PATH, '/bin');
  assert.equal(offChild.HOME, '/root');

  const onChild = buildTrialEnv({ [TRIAL_CONTEXT_ENV]: '0' }, 'on');
  assert.equal(onChild[TRIAL_CONTEXT_ENV], '1'); // 覆盖旧值
  assert.equal(buildTrialEnv({}, 'on')[TRIAL_CONTEXT_ENV], '1'); // 补齐缺失
  assert.ok(!(TRIAL_CONTEXT_ENV in buildTrialEnv({}, 'off'))); // 幂等

  assert.throws(() => buildTrialEnv({}, 'onn'), TypeError);
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 起真 node 进程跑入口；env 剥掉一切可推进链路的输入并指向坏配置（零网络）。 */
function runEntry(args: string[], options: { env?: Record<string, string>; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd: options.cwd ?? petRoot,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('入口子进程：非法参数 exit 2、stderr 含用法、未进入复用链', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-next-trial-args-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const env: Record<string, string> = { PET_NEXT_REMOTE_CONFIG: path.join(dir, 'absent.json') };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of [
    'PET_NEXT_SSH_HOST', 'PET_NEXT_SSH_USER', 'PET_NEXT_SSH_PORT', 'PET_NEXT_SSH_BIN',
    TRIAL_CONTEXT_ENV, 'PET_NEXT_CHAT_BASE_URL', 'PET_NEXT_CHAT_TRANSPORT', 'PET_NEXT_CHAT_LOCAL',
  ]) {
    delete env[key];
  }
  const run = await runEntry(['--context=onn'], { env });
  assert.equal(run.code, 2);
  assert.ok(run.stderr.includes(TRIAL_USAGE), run.stderr);
  assert.ok(!run.stdout.includes('[chat-trial]'), run.stdout);
});

test('入口子进程：状态行与复用链（坏配置 exit 1）；父残留 on + 显式 off 生效；带空格目录', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-next chat trial '));
  const spaced = path.join(dir, 'dir with spaces');
  await mkdir(spaced, { recursive: true });
  const badConfig = path.join(spaced, 'bad remote config.json');
  await writeFile(badConfig, 'not-json{', 'utf8');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const env: Record<string, string> = { PET_NEXT_REMOTE_CONFIG: badConfig };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of [
    'PET_NEXT_SSH_HOST', 'PET_NEXT_SSH_USER', 'PET_NEXT_SSH_PORT', 'PET_NEXT_SSH_BIN',
    'PET_NEXT_CHAT_BASE_URL', 'PET_NEXT_CHAT_TRANSPORT', 'PET_NEXT_CHAT_LOCAL',
  ]) {
    delete env[key];
  }

  // 父残留 on + 显式 off：状态行必须是 off，且确实进入复用链（chat-remote 读坏配置失败）
  const off = await runEntry(['--context=off'], { env: { ...env, [TRIAL_CONTEXT_ENV]: '1' }, cwd: spaced });
  assert.ok(off.stdout.includes(OFF_LOG), off.stdout);
  assert.ok(!off.stdout.includes(ON_LOG), off.stdout);
  assert.equal(off.code, 1);
  assert.ok(off.stderr.includes('chat-remote 失败'), off.stderr);

  const on = await runEntry(['--context=on'], { env, cwd: spaced });
  assert.ok(on.stdout.includes(ON_LOG), on.stdout);
  assert.equal(on.code, 1);

  const none = await runEntry([], { env, cwd: spaced });
  assert.ok(none.stdout.includes(OFF_LOG), none.stdout);
  assert.equal(none.code, 1);
});
