/**
 * M3-2 正式入口 pnpm chat:remote：Windows 本机一条命令经 SSH 隧道使用现有服务器 Qwen。
 * 只做 IO 注入；编排与失败分类见 chat-remote-core.mjs。不启动 fake、不启动模型、不开放公网端口。
 * @module pet-next/scripts/chat-remote
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRemote } from './chat-remote-core.mjs';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.PET_NEXT_REMOTE_CONFIG ?? path.join(homedir(), '.pet-next', 'qwen-remote.json');

/** 本地配置文件：可选；不存在返回空；存在但不可解析则明确失败（不静默兜底）。 */
function loadFileConfig() {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return { ok: true, fileConfig: {} };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '本地配置必须是 JSON 对象' };
    }
    return { ok: true, fileConfig: parsed };
  } catch (error) {
    return { ok: false, error: `本地配置无法解析：${error instanceof Error ? error.message : String(error)}` };
  }
}

const loaded = loadFileConfig();
if (!loaded.ok) {
  console.error(`chat-remote 失败：${loaded.error}（${configPath}）`);
  process.exit(1);
}

const code = await runRemote({
  spawn,
  petRoot,
  platform: process.platform,
  env: process.env,
  signals: process,
  fileConfig: loaded.fileConfig,
  sshBin: process.env.PET_NEXT_SSH_BIN ?? 'ssh',
  log: (line) => console.log(line),
  logError: (line) => console.error(line),
});
process.exit(code);
