/**
 * 点播修复的统一验收。任一检查失败则本进程退出码非零。
 *
 * 用法（在 dsh-pet 目录）：
 *   node scripts/verify/accept.mjs
 *
 * 依次跑：静态检查、装配测试（DISPLAY 有/无各三次）、单元测试、test:ui、build、真实 Electron。
 * 不改 DISPLAY 来掩盖泄漏；装配测试自己替换 Linux 指针。单元测试若挂起，到时限即失败。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;

function run(name, command, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
      }, timeoutMs);
    }
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      const elapsed = Date.now() - started;
      const ok = code === 0 && !signal;
      process.stdout.write(
        `\n[accept] ${name} exit=${String(code)} signal=${String(signal)} elapsed_ms=${elapsed} ${ok ? 'ok' : 'FAIL'}\n`,
      );
      resolve(ok ? 0 : code || 1);
    });
  });
}

const steps = [];

function add(name, args, env = process.env, timeoutMs = 0) {
  steps.push({ name, args, env, timeoutMs });
}

add('typecheck', ['run', 'typecheck'], process.env, 120_000);
add('lint', ['run', 'lint'], process.env, 120_000);
add('check:cycles', ['run', 'check:cycles'], process.env, 60_000);
add('check:runtime', ['run', 'check:runtime'], process.env, 60_000);
add('format:check', ['run', 'format:check'], process.env, 120_000);
add('check:openapi', ['run', 'check:openapi'], process.env, 60_000);

const wiring = [
  NODE,
  '--experimental-strip-types',
  '--import',
  './scripts/test-register.mjs',
  '--test',
  'src/host/desktop-main-wiring.test.ts',
];
const withDisplay = { ...process.env, DISPLAY: process.env.DISPLAY || ':1' };
delete withDisplay.WAYLAND_DISPLAY;
const withoutDisplay = { ...process.env };
delete withoutDisplay.DISPLAY;
delete withoutDisplay.WAYLAND_DISPLAY;
for (let i = 1; i <= 3; i += 1) {
  steps.push({
    name: `wiring DISPLAY ${i}`,
    command: wiring[0],
    args: wiring.slice(1),
    env: withDisplay,
    timeoutMs: 30_000,
  });
  steps.push({
    name: `wiring no-DISPLAY ${i}`,
    command: wiring[0],
    args: wiring.slice(1),
    env: withoutDisplay,
    timeoutMs: 30_000,
  });
}

add('test', ['test'], process.env, 300_000);
add('test:ui', ['run', 'test:ui'], process.env, 180_000);
add('build', ['run', 'build'], process.env, 180_000);
steps.push({
  name: 'electron',
  command: NODE,
  args: ['scripts/verify/playback-lifecycle-electron.mjs'],
  env: process.env,
  timeoutMs: 180_000,
});

let failed = 0;
for (const step of steps) {
  const command = step.command ?? 'pnpm';
  const code = await run(step.name, command, step.args, step.env, step.timeoutMs);
  if (code !== 0) failed += 1;
}
if (failed > 0) {
  process.stderr.write(`[accept] ${failed} 项失败\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('[accept] 全部通过\n');
}
