#!/usr/bin/env node
/**
 * 测试平台预检：把"这一层能不能跑"说明白，缺失项记 not-run 而不是假装通过。
 *
 * 用法：
 *   node scripts/preflight.mjs
 *   node scripts/preflight.mjs --require=unit,e2e     # 必需项缺失时退出码 1
 *   node scripts/preflight.mjs --json                  # 机器可读输出
 *
 * 层级：unit / integration / cleanup / e2e / windows
 * - unit：node >= 22（--experimental-strip-types）
 * - integration：ffmpeg + ffprobe（素材链路）与 assets/candidates 可读
 * - cleanup：node 自带（无额外依赖）
 * - e2e：Linux 需要 DISPLAY + xdotool + xwininfo；Electron 二进制可解析
 * - windows：仅 Windows 由 tests/platform/verify-windows.ps1 执行，其他平台记 not-run
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(path.join(petRoot, 'package.json'));
const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const requireArg = [...args].find((item) => item.startsWith('--require='));
const required = new Set((requireArg?.slice('--require='.length) ?? '').split(',').filter(Boolean));

function run(file, argv = []) {
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: 20000 }, (error, stdout) => {
      resolve(error ? { ok: false, detail: String(error.message).split('\n')[0] } : { ok: true, detail: String(stdout).trim().split('\n')[0] });
    });
  });
}

const layers = {
  unit: [],
  integration: [],
  cleanup: [],
  e2e: [],
  windows: [],
};

function check(layer, ok, detail, hint = null) {
  layers[layer].push({ ok, detail, hint });
}

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
check('unit', major >= 22 || (major === 22 && minor >= 12) || major > 22, `node ${process.versions.node}`, '需要 Node >= 22.12（--experimental-strip-types）。');
check('cleanup', major >= 20, `node ${process.versions.node}`, null);

const ffmpeg = await run('ffmpeg', ['-version']);
check('integration', ffmpeg.ok, ffmpeg.ok ? ffmpeg.detail : `ffmpeg 不可用：${ffmpeg.detail}`, '安装 ffmpeg 后重跑；缺 ffmpeg 时集成层记 not-run。');
const ffprobe = await run('ffprobe', ['-version']);
check('integration', ffprobe.ok, ffprobe.ok ? ffprobe.detail : `ffprobe 不可用：${ffprobe.detail}`, null);
let masterOk = true;
try {
  await access(path.join(petRoot, 'assets/candidates/reaction/source.webm'));
  await access(path.join(petRoot, 'assets/idle.webm'));
} catch {
  masterOk = false;
}
check('integration', masterOk, masterOk ? 'assets/idle.webm 与母带可读' : '素材文件缺失', '先跑 pnpm assets:check / pnpm assets:short。');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  electronPath = null;
}
check('e2e', typeof electronPath === 'string' && electronPath.length > 0, electronPath ? `electron ${electronPath}` : 'electron 未安装', 'pnpm install 后重试。');

if (process.platform === 'linux') {
  const display = process.env.DISPLAY ?? '';
  check('e2e', display.length > 0, display ? `DISPLAY=${display}` : 'DISPLAY 为空', '在无头环境启动 Xvfb（例如 Xvfb :1）并 export DISPLAY=:1。');
  const xdotool = await run('xdotool', ['--version']);
  check('e2e', xdotool.ok, xdotool.ok ? xdotool.detail : 'xdotool 不可用', 'apt install xdotool；缺失时 E2E 记 not-run。');
  const xwininfo = await run('xwininfo', ['-version']);
  check('e2e', xwininfo.ok, xwininfo.ok ? xwininfo.detail : 'xwininfo 不可用', null);
} else {
  check('e2e', false, `当前平台 ${process.platform} 没有本机执行器`, 'E2E 需要 Linux(X11) 或 Windows(verify-windows.ps1)。');
}

check(
  'windows',
  false,
  process.platform === 'win32' ? '由 tests/platform/verify-windows.ps1 执行（不是预检通过）' : '非 Windows 平台（not-run）',
  'Windows 验收只在 Windows 上跑，其他平台不记通过。',
);

const summary = {};
let failedRequired = false;
for (const [layer, checks] of Object.entries(layers)) {
  const ok = checks.length > 0 && checks.every((item) => item.ok);
  summary[layer] = {
    status: ok ? 'ready' : 'not-run',
    checks,
  };
  if (required.has(layer) && !ok) failedRequired = true;
}

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const [layer, entry] of Object.entries(summary)) {
    const mark = entry.status === 'ready' ? 'ready  ' : 'not-run';
    console.log(`[${mark}] ${layer}`);
    for (const item of entry.checks) {
      console.log(`  ${item.ok ? '✓' : '✗'} ${item.detail}${item.ok || !item.hint ? '' : `  → ${item.hint}`}`);
    }
  }
}
if (failedRequired) {
  console.error(`必需层未就绪：${[...required].filter((layer) => summary[layer]?.status !== 'ready').join(', ') || '未知'}`);
  process.exit(1);
}
process.exit(0);
