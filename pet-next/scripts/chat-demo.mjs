/**
 * M3-0 聊天预览演示编排：本地假服务 + 真实 Electron 聊天面板。
 * 产物链路：fake-server-main.ts(127.0.0.1) -> http provider(主进程) -> 面板"演示回复"。
 * 未接真实模型：健康口径只报 offline_ready。
 * 用法：pnpm chat:preview（先 build）；Ctrl-C 或关窗结束并清理子进程。
 * @module pet-next/scripts/chat-demo
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const keepOpen = !args.has('--smoke');

function forward(prefix, chunk) {
  for (const line of String(chunk).split('\n')) {
    if (line.trim().length > 0) console.log(`[${prefix}] ${line}`);
  }
}

const fake = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(petRoot, 'adapters/chat/fake-server-main.ts')],
  { cwd: petRoot },
);
let fakeUrl = null;
let settled = false;

fake.stdout.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line.includes('{') ? line.slice(line.indexOf('{')) : '{}');
    if (record.event === 'fake-chat-server-ready') {
      fakeUrl = record.url;
      console.log(JSON.stringify({ event: 'fake-chat-server-ready', port: record.port, url: record.url }));
      void startElectron();
    }
  }
});
fake.stderr.on('data', (c) => forward('fake-stderr', c));
fake.on('exit', (code) => {
  console.log(JSON.stringify({ event: 'fake-chat-server-exit', code }));
  cleanup(code ?? 0);
});

let electronProc = null;
async function startElectron() {
  if (electronProc !== null || fakeUrl === null) return;
  const mainPath = path.join(petRoot, 'dist/electron/main.js');
  const electronPath = createRequire(path.join(petRoot, 'package.json')).electron;
  const electronArgs = [];
  if (process.platform === 'linux') electronArgs.push('--no-sandbox', '--disable-dev-shm-usage');
  electronArgs.push(mainPath);
  electronProc = spawn(electronPath, electronArgs, {
    cwd: petRoot,
    env: {
      ...process.env,
      PET_NEXT_CHAT_PREVIEW: '1',
      PET_NEXT_CHAT_FAKE_URL: fakeUrl,
      PET_NEXT_TEST: '1',
    },
  });
  electronProc.stdout.on('data', (c) => forward('electron', c));
  electronProc.stderr.on('data', (c) => forward('electron-stderr', c));
  electronProc.on('exit', (code) => {
    console.log(JSON.stringify({ event: 'electron-exit', code }));
    if (!keepOpen || code !== 0) cleanup(code ?? 0);
    else cleanup(0);
  });
}

function cleanup(code) {
  if (settled) return;
  settled = true;
  if (electronProc !== null && electronProc.exitCode === null) electronProc.kill('SIGTERM');
  if (fake.exitCode === null) fake.kill('SIGTERM');
  console.log(JSON.stringify({ event: 'chat-demo-done', offline_ready: true, exit: code }));
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
