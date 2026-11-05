/**
 * M3-7 B：真实 IO 绑定单测（真实 fs、临时目录；隧道/探测全部注入，零网络）。
 * 覆盖：首次无文件、保存往返、JSON 形状、坏 JSON、无效不覆盖、无临时文件残留、中文+空格路径。
 * @module pet-next/adapters/launcher/node.test
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createNodeLauncherController, resolveConfigFilePath } from './node.ts';
import type { LauncherConfig } from '../../contracts/launcher.ts';

const config: LauncherConfig = {
  host: 'fake.example.invalid',
  port: 22,
  user: 'tester',
  identityFile: 'C:/Users/you/.ssh/id_ed25519',
  localPort: 18873,
  remoteHost: '127.0.0.1',
  remotePort: 18872,
};

const fakeTunnel = async () => ({
  ok: true as const,
  handle: { localBaseUrl: 'http://127.0.0.1:18873', stop: async () => undefined, isAlive: () => true },
});
const fakeProbe = async () => ({ ok: true, models: ['qwen3.8-27b'] });

function controllerFor(file: string) {
  return createNodeLauncherController({
    env: { PET_NEXT_REMOTE_CONFIG: file },
    home: '/unused-home',
    startTunnel: fakeTunnel,
    probeService: fakeProbe,
  });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'pet-launcher-'));
  try {
    const dir = path.join(base, '中文 空格 目录');
    await mkdir(dir, { recursive: true });
    await run(dir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('首次启动：配置文件不存在 → config:null', async () => {
  await withTempDir(async (dir) => {
    const controller = controllerFor(path.join(dir, 'qwen-remote.json'));
    assert.deepEqual(await controller.loadConfig(), { ok: true, config: null });
  });
});

test('中文+空格路径下保存后再读回，字段一致且 JSON 形状受控', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'qwen-remote.json');
    const controller = controllerFor(file);
    assert.deepEqual(await controller.saveConfig(config), { ok: true });
    const reloaded = await controller.loadConfig();
    assert.equal(reloaded.ok, true);
    assert.deepEqual(reloaded.ok ? reloaded.config : null, config);

    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['host', 'port', 'user', 'identityFile', 'localPort', 'remoteHost', 'remotePort']);
    assert.equal(parsed.identityFile, 'C:/Users/you/.ssh/id_ed25519');
  });
});

test('identityFile 省略时不写入该键（不存私钥内容/口令）', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'qwen-remote.json');
    const controller = controllerFor(file);
    const { identityFile: _ignored, ...withoutKey } = config;
    assert.deepEqual(await controller.saveConfig(withoutKey), { ok: true });
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal('identityFile' in parsed, false);
  });
});

test('坏 JSON → file-unreadable（可读错误，不崩溃）', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'qwen-remote.json');
    await writeFile(file, '{ not json', 'utf8');
    const result = await controllerFor(file).loadConfig();
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'file-unreadable');
    assert.match(!result.ok ? result.error.message : '', /不是合法 JSON/);
  });
});

test('校验失败的保存不覆盖旧文件，且不残留临时文件', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'qwen-remote.json');
    const controller = controllerFor(file);
    await controller.saveConfig(config);
    const before = await readFile(file, 'utf8');

    const invalid = await controller.saveConfig({ ...config, host: '', user: '' });
    assert.equal(invalid.ok, false);
    assert.equal(!invalid.ok && invalid.error.code, 'config-invalid');
    assert.equal(await readFile(file, 'utf8'), before);

    const entries = await readdir(dir);
    assert.deepEqual(entries, ['qwen-remote.json'], '原子写不得残留临时文件');
  });
});

test('配置路径：PET_NEXT_REMOTE_CONFIG 优先，否则 ~/.pet-next/qwen-remote.json', () => {
  assert.equal(resolveConfigFilePath({ PET_NEXT_REMOTE_CONFIG: '/tmp/custom.json' }, '/home/me'), path.resolve('/tmp/custom.json'));
  assert.equal(resolveConfigFilePath({}, '/home/me'), path.join('/home/me', '.pet-next', 'qwen-remote.json'));
});
