/**
 * M3-2 验收脚本自测（Linux）：
 * - 负路径 auth-failed 必须被判 PASS（脚本成功路径与指定负路径分开）；
 * - 断言必须落到「明确数字退出码 + 本次 PID/端口归属 + 无关进程存活」；
 * - 缺真实配置时明确失败非零，不静默跳过。
 * Windows 由 verify-windows-chat-remote.ps1 走同一份 Node 实现，本文件在非 Linux 跳过。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 不能用 URL.pathname：含空格/中文的路径会被百分号编码，导致 cwd 不存在。
const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform !== 'linux' ? '验收脚本自测仅在 Linux 运行（Windows 由 ps1 执行）' : false;

test(
  'verify-linux-chat-remote.sh 负路径 auth-failed：判 PASS、留证据、退出码为数字',
  { skip, timeout: 180000 },
  async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'pet-next-verify-script-'));
    try {
      const result = spawnSync(
        'bash',
        ['scripts/verify-linux-chat-remote.sh', '--expect=auth-failed', '--fake', `--out=${out}`],
        { cwd: petRoot, encoding: 'utf8', timeout: 170000 },
      );
      assert.equal(result.status, 0, `脚本应判 PASS；stdout=${result.stdout} stderr=${result.stderr}`);
      const summary = await readFile(path.join(out, 'SUMMARY.txt'), 'utf8');
      assert.match(summary, /PASS 失败原因分类为 auth-failed/);
      assert.match(summary, /PASS 失败路径退出码为 1（code=1）/);
      assert.match(summary, /PASS 本次启动的 PID 全部退出/);
      assert.match(summary, /PASS 本地转发端口已释放/);
      assert.match(summary, /result: PASS/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
);

test(
  'verify-linux-chat-remote.sh 缺真实配置：明确失败非零（不静默跳过）',
  { skip, timeout: 60000 },
  async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'pet-next-verify-script-'));
    try {
      const env = { ...process.env, PET_NEXT_SSH_HOST: '', PET_NEXT_REMOTE_CONFIG: path.join(out, 'none.json') };
      const result = spawnSync('bash', ['scripts/verify-linux-chat-remote.sh', `--out=${out}`], {
        cwd: petRoot,
        encoding: 'utf8',
        timeout: 50000,
        env,
      });
      assert.notEqual(result.status, 0, '缺配置必须非零退出');
      assert.match(String(result.stderr), /真实模式需要 PET_NEXT_SSH_HOST/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
);
