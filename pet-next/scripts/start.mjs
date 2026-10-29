/**
 * 启动已构建的 Electron 主进程。
 * Linux 容器里没有用户命名空间时附带 --no-sandbox，Windows 不附加该参数。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = join(root, 'dist/electron/main.js');
const args = [];
if (process.platform === 'linux') {
  args.push('--no-sandbox', '--disable-dev-shm-usage');
}
args.push(main);

const child = spawn(electronPath, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
