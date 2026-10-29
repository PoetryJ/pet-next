/**
 * 运行记录把环境、命令、退出码和两份原始输出分成不同文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { redactEnv, writeRunRecord } from './run-record.ts';

test('凭据键被换成占位符，普通环境变量保留', () => {
  const redacted = redactEnv({
    PATH: '/usr/bin',
    PET_NEXT_CLEANUP: 'fail',
    PET_NEXT_EXAMPLE_TOKEN: 'super-secret',
    API_KEY: 'hidden',
  });
  assert.equal(redacted.PATH, '/usr/bin');
  assert.equal(redacted.PET_NEXT_CLEANUP, 'fail');
  assert.equal(redacted.PET_NEXT_EXAMPLE_TOKEN, '[redacted]');
  assert.equal(redacted.API_KEY, '[redacted]');
});

test('五份记录分开落盘，退出码缺失时写成 null', async () => {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), 'pet-next-record-')), 'run');
  await writeRunRecord({
    platform: 'linux',
    executable: '/usr/bin/node',
    args: ['fixture.mjs', 'fail'],
    cwd: '/tmp/pet',
    env: { PET_NEXT_EXAMPLE_TOKEN: 'super-secret', PET_NEXT_CLEANUP: 'fail' },
    exitCode: null,
    stdout: 'CHILD 9\n',
    stderr: 'MODE fail\n',
    directory,
  });
  const commandText = await readFile(path.join(directory, 'command.json'), 'utf8');
  const command = JSON.parse(commandText) as { executable: string; args: string[]; platform: string };
  assert.equal(command.executable, '/usr/bin/node');
  assert.deepEqual(command.args, ['fixture.mjs', 'fail']);
  assert.equal(command.platform, 'linux');
  assert.equal(commandText.includes('super-secret'), false);
  const environment = await readFile(path.join(directory, 'environment.json'), 'utf8');
  assert.equal(environment.includes('super-secret'), false);
  assert.equal(JSON.parse(environment).PET_NEXT_EXAMPLE_TOKEN, '[redacted]');
  assert.equal(await readFile(path.join(directory, 'exit-code.txt'), 'utf8'), 'null\n');
  assert.equal(await readFile(path.join(directory, 'stdout.log'), 'utf8'), 'CHILD 9\n');
  assert.equal(await readFile(path.join(directory, 'stderr.log'), 'utf8'), 'MODE fail\n');
});
