#!/usr/bin/env node
/**
 * M3-5 D 任务：Windows 复跑入口（生成器）。
 * 用途：在 Windows 上复验正式试用入口 pnpm chat:trial --context=on|off（真实 Electron 窗口
 *       + fake SSH/隧道替身 + fake 模型 + CDP 真实输入），零真实推理；不依赖 Xvfb。
 *       证据落在 tests/chat-evidence/trial/win/（NDJSON/截图/退出码；不落全量环境变量）。
 * 用法：
 *   node scripts/win-trial-recheck.mjs            # 生成 tests/independent-trial-windows.check.ts
 *   node scripts/win-trial-recheck.mjs --check    # 只显示将要做的替换，不写文件
 * 生成后运行（Windows，仓库根；文件名不带 .test.ts，避免混入 pnpm verify 的 unit 收集）：
 *   node --experimental-strip-types --test --test-concurrency=1 tests/independent-trial-windows.check.ts
 * 说明：源测试 tests/chat-trial.e2e.test.ts 的 SSH 替身直接用 fake-ssh.mjs
 *       （chat-remote 对 .mjs 替身自动改用 node 执行），故 Windows 无需 bash 包装；
 *       本生成器仅做平台适配（win32 跳 Xvfb、cmd.exe 启动、taskkill 进程树兜底、
 *       退出前截图、T4 恢复 build 的跨平台）。替换未命中即失败退出，避免静默漂移。
 * 生成规则沿袭 win-context-recheck.mjs（M3-4，Windows 实测过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = path.join(petRoot, 'tests/chat-trial.e2e.test.ts');
const outputPath = path.join(petRoot, 'tests/independent-trial-windows.check.ts');

let s = fs.readFileSync(sourcePath, 'utf8');
const replacements = [];
function replaceOnce(label, from, to) {
  const before = s;
  s = s.replace(from, to);
  if (s === before) throw new Error(`替换未命中：${label}\n  pattern: ${String(from).slice(0, 120)}`);
  replacements.push(label);
}

replaceOnce(
  '头部标记改为 Windows 复验版',
  ' * M3-5 D：正式试用入口 E2E（pnpm chat:trial --context=on|off，fake SSH 替身 + fake 模型，零真实推理）。',
  ' * M3-5 D Windows 复验版（由 scripts/win-trial-recheck.mjs 生成）：正式试用入口 E2E，零真实推理。\n' +
    ' * 本文件在 win32 上运行；Linux 侧同源验证见 tests/chat-trial.e2e.test.ts，两者互不替代。',
);
replaceOnce(
  '证据目录指向 trial/win',
  "const evidenceRoot = path.join(petRoot, 'tests/chat-evidence/trial');",
  "const evidenceRoot = path.join(petRoot, 'tests/chat-evidence/trial/win');",
);
replaceOnce(
  'win32 跳过 Xvfb（真机有显示）',
  'before(async () => {\n  if (existsSync(displaySocket)) {',
  "before(async () => {\n  if (process.platform === 'win32') {\n    displayReady = true;\n    return;\n  }\n  if (existsSync(displaySocket)) {",
);
replaceOnce(
  'cmd.exe 启动 pnpm（Windows 无 shebang 执行）',
  "  const child = spawn(pnpmPath(), ['chat:trial', ...options.args], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });",
  "  const child = process.platform === 'win32'\n    ? spawn('cmd.exe', ['/d', '/c', `pnpm chat:trial ${options.args.join(' ')}`], { cwd: petRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })\n    : spawn(pnpmPath(), ['chat:trial', ...options.args], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });",
);
replaceOnce(
  'taskkill 进程树兜底（Windows 下 SIGKILL 常不级联子进程）',
  "    if (child.exitCode === null && child.signalCode === null) {\n      child.kill('SIGKILL');",
  "    if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {\n      try {\n        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });\n      } catch {\n        /* 已退出则忽略 */\n      }\n    }\n    if (child.exitCode === null && child.signalCode === null) {\n      child.kill('SIGKILL');",
);
replaceOnce(
  '关窗前截图（Windows 无窗口管理器抓图，走 CDP）',
  '  void handle.cdp.send(\'Browser.close\', {}).catch(() => undefined);',
  "  try {\n    const shot = (await handle.cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };\n    await mkdir(path.join(evidenceRoot, 'shots'), { recursive: true });\n    await writeFile(path.join(evidenceRoot, 'shots', `${Date.now()}.png`), Buffer.from(shot.data, 'base64'));\n  } catch {\n    /* 截图失败不阻塞退出 */\n  }\n  void handle.cdp.send('Browser.close', {}).catch(() => undefined);",
);
replaceOnce(
  'T4 恢复 build 的跨平台（win32 不能直接 execFileSync pnpm）',
  "    if (!existsSync(mainJs)) execFileSync('pnpm', ['build'], { cwd: petRoot, stdio: 'ignore' });",
  "    if (!existsSync(mainJs)) {\n      if (process.platform === 'win32') execFileSync('cmd.exe', ['/d', '/c', 'pnpm', 'build'], { cwd: petRoot, stdio: 'ignore', windowsHide: true });\n      else execFileSync('pnpm', ['build'], { cwd: petRoot, stdio: 'ignore' });\n    }",
);

s += `
/* ---- Windows 复跑 not-run 说明 ----
 * 本文件只在 win32 上有意义；Linux CI/开发机上运行等同于源测试（无增量价值）。
 * Codex 验收入命令（Windows，仓库根，需先 node scripts/win-trial-recheck.mjs 生成本文件）：
 *   node --experimental-strip-types --test --test-concurrency=1 tests/independent-trial-windows.check.ts
 * 证据：tests/chat-evidence/trial/win/（log.txt / requests.ndjson / ssh.ndjson / shots/*.png）。
 */
`;

if (process.argv.includes('--check')) {
  console.log(`[win-trial-recheck] --check：将应用 ${replacements.length} 处替换；输出 ${path.relative(petRoot, outputPath)}`);
  for (const item of replacements) console.log(`  - ${item}`);
  process.exit(0);
}
fs.writeFileSync(outputPath, s);
console.log(`[win-trial-recheck] 已生成 ${outputPath}`);
console.log('[win-trial-recheck] 运行（Windows）：node --experimental-strip-types --test --test-concurrency=1 tests/independent-trial-windows.check.ts');
console.log('[win-trial-recheck] 无 Windows 时：不生成本文件、不声称 Windows 通过（not-run），把上面命令交 Codex 本机复跑。');
