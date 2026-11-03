#!/usr/bin/env node
/**
 * M3-4 A 任务：Windows 复跑入口（生成器）。
 * 用途：在 Windows 上复验聊天上下文语义（真实 Electron 窗口 + fake HTTP + CDP 真实输入），
 *       不依赖 Xvfb，不依赖真实模型服务；证据落在 tests/chat-evidence/context-live/win/。
 * 用法：
 *   node scripts/win-context-recheck.mjs            # 生成 tests/independent-context-windows.check.ts
 *   node scripts/win-context-recheck.mjs --check    # 只显示将要做的替换，不写文件
 * 生成后运行（Windows，仓库根；文件名不带 .test.ts，避免混入 pnpm verify 的 unit 收集）：
 *   node --experimental-strip-types --test --test-concurrency=1 tests/independent-context-windows.check.ts
 * 说明：派生自 tests/chat-context.e2e.test.ts（M3-4 版，原生带请求 NDJSON 持久化），
 *       仅做平台适配（cmd.exe 启动、taskkill 清理、退出前截图、win32 跳过 Xvfb）
 *       并附加 T3（连续 3 次在途清空 → 立即重发，旧内容不上屏、后续请求无旧历史）。
 *       生成规则沿袭 Codex 验收包 prepare-windows-review.mjs（Windows 实测过），
 *       因源文件已原生落证据，本版替换点更少；替换未命中即失败退出，避免静默漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = path.join(petRoot, 'tests/chat-context.e2e.test.ts');
const outputPath = path.join(petRoot, 'tests/independent-context-windows.check.ts');

let s = fs.readFileSync(sourcePath, 'utf8');
const replacements = [];
function replaceOnce(label, from, to) {
  const before = s;
  s = s.replace(from, to);
  if (s === before) throw new Error(`替换未命中：${label}\n  pattern: ${String(from).slice(0, 120)}`);
  replacements.push(label);
}

replaceOnce(
  'import execFileSync',
  "import { type ChildProcess, spawn } from 'node:child_process';",
  "import { type ChildProcess, spawn, execFileSync } from 'node:child_process';",
);
replaceOnce(
  '证据目录指向 context-live/win',
  "const evidenceDir = path.join(petRoot, 'tests/chat-evidence/context');",
  "const evidenceDir = path.join(petRoot, 'tests/chat-evidence/context-live/win');",
);
replaceOnce(
  'win32 跳过 Xvfb',
  'before(async () => {',
  "before(async () => {\n  if (process.platform === 'win32') {\n    displayReady = true;\n    return;\n  }",
);
replaceOnce(
  'cmd.exe 启动 pnpm（Windows 无 shebang 执行）',
  "  const entry = spawn(pnpmPath(), ['chat:local'], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });",
  "  const entry = process.platform === 'win32'\n    ? spawn('cmd.exe', ['/d', '/c', 'pnpm chat:local'], { cwd: petRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })\n    : spawn(pnpmPath(), ['chat:local'], { cwd: petRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });",
);
replaceOnce(
  'taskkill 进程树兜底（Windows 下 SIGTERM 常不级联子进程）',
  "    if (entry.exitCode === null) {\n      entry.kill('SIGTERM');",
  "    if (process.platform === 'win32' && entry.exitCode === null && entry.signalCode === null && entry.pid !== undefined) {\n      try {\n        execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true });\n      } catch {\n        /* 已退出则忽略 */\n      }\n    }\n    if (entry.exitCode === null) {\n      entry.kill('SIGTERM');",
);
replaceOnce(
  '退出前截图（Windows 无窗口管理器抓图，走 CDP）',
  "  await evaluate(cdp, 'window.pet.quit()');",
  "  try {\n    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };\n    await mkdir(evidenceDir, { recursive: true });\n    await writeFile(path.join(evidenceDir, `before-quit-${Date.now()}.png`), Buffer.from(shot.data, 'base64'));\n  } catch {\n    /* 截图失败不阻塞退出 */\n  }\n  await evaluate(cdp, 'window.pet.quit()');",
);

s += `
test('T3 连续在途清空→立即重发×3：旧内容不上屏、后续请求无旧历史（Windows 复验）', { timeout: 120000 }, async (t) => {
  if (!displayReady) return t.skip('not-run: 无显示环境');
  const evidence = createEvidence('t3-pending-reset');
  process.env.FAKE_MODEL_DELAY_MS = '1200';
  let handle: Awaited<ReturnType<typeof launchLocal>> | undefined;
  try {
    handle = await launchLocal({ context: true, label: 'ctx-pending', evidence });
    const { cdp } = handle;
    await openPanel(cdp, evidence);
    for (let i = 0; i < 3; i++) {
      await typeAndSend(cdp, \`待取消\${i}\`, evidence.lines);
      const pending = await waitDom(cdp, 'pending', (st) => st.phase === 'pending', 5000, 'old request');
      await clickRect(cdp, pending.rects.reset);
      await typeAndSend(cdp, \`新请求\${i}\`, evidence.lines);
      await waitReply(cdp, \`隧道回复：新请求\${i}\`);
      await delay(1400);
      const state = await readDom(cdp);
      assert.equal(state.assistantMsgs.length, 1, '旧内容不得上屏');
      assert.ok(state.assistantMsgs[0]?.includes(\`新请求\${i}\`));
      assert.ok(!JSON.stringify(state.assistantMsgs).includes('待取消'), '被取消轮不得出现在展示区');
      const request: FakeRequest | undefined = readRequests(handle.logFile).at(-1);
      assert.ok(request !== undefined, 'missing request');
      assert.deepEqual(request.body.messages.map((m: { role: string }) => m.role), ['system', 'user'], '清空后请求必须回单轮形态');
      assert.equal(request.body.messages[1]?.content, \`新请求\${i}\`);
      evidence.log(\`reset-resend \${i} PASS\`);
      await clickRect(cdp, state.rects.reset);
    }
    await quitByApi(cdp);
    const exit = await waitExit(handle.entry, 10000);
    assert.equal(exit.code, 0);
    evidence.log('PASS exit0');
  } finally {
    delete process.env.FAKE_MODEL_DELAY_MS;
    if (handle) await handle.stop().catch(() => undefined);
    await flushEvidence(evidence, 't3-pending-reset');
  }
});
`;

if (process.argv.includes('--check')) {
  console.log(`[win-context-recheck] --check：将应用 ${replacements.length} 处替换并附加 T3；输出 ${path.relative(petRoot, outputPath)}`);
  for (const item of replacements) console.log(`  - ${item}`);
  process.exit(0);
}
fs.writeFileSync(outputPath, s);
console.log(`[win-context-recheck] 已生成 ${outputPath}`);
console.log('[win-context-recheck] 运行（Windows）：node --experimental-strip-types --test --test-concurrency=1 tests/independent-context-windows.check.ts');
