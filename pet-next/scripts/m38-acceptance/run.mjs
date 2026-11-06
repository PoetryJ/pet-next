#!/usr/bin/env node
/**
 * M3-8 独立验收执行器（agent D）。命令固定 `pnpm m38:accept`（package.json 由负责人接线）。
 *
 * 约束：
 * - 分层可单独跑（--layer=pre|post|all|id,id），只跑固定命令，逐层记录真实命令/退出码/耗时。
 * - 原始子进程输出原样落到 tests/chat-evidence/m38/<phase>/logs/<layer>-<stamp>.log（不掺笔记）；
 *   命令、环境、计数写同名 .meta.json，并追加到 results.ndjson（不覆盖历史）。
 * - 未跑即 not-run；不为换绿重试；超时只杀本轮自己的进程组。
 * - GUI 层串行，统一用自起自收 Xvfb（默认 :96；拒绝 :94）。
 *
 * 用法示例：
 *   node scripts/m38-acceptance/run.mjs --list
 *   node scripts/m38-acceptance/run.mjs --layer=pre
 *   node scripts/m38-acceptance/run.mjs --layer=post --phase=post
 *   node scripts/m38-acceptance/run.mjs --zip=<zip> --pkg-dir=<dir> --phase=pkg2 --layer=pkg-extract,pkg-install,pkg-build,pkg-test-serial
 */
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DisplayManager, childEnv, parseCounts, runChild, sha256 } from './lib.mjs';
import {
  runEnvLayer,
  runPkgElectronBinaryLayer,
  runPkgExtractLayer,
  runPkgHashLayer,
  runPkgTestSerialLayer,
} from './layers-pre.mjs';
import { runLauncherLayer, runResourcesLayer, runRoundsLayer, runWindowsLayer } from './layers-post.mjs';

const APP_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rawArgv = process.argv.slice(2);
const opt = (name, fallback) => {
  const prefix = `--${name}=`;
  const hit = rawArgv.find((item) => item.startsWith(prefix));
  return hit === undefined ? fallback : hit.slice(prefix.length);
};
const flag = (name) => rawArgv.includes(`--${name}`);

const display = opt('display', ':96');
const dryRun = flag('dry-run');
const timeoutOverride = Number(opt('timeout', '0'));
const tag = opt('tag', '');
const zipPath = opt('zip', '/data3/DATA/project/project_meishijiang/m3-7-r1-delivery/pet-next-trial-src-60af704.zip');
const pkgDir = opt('pkg-dir', '/tmp/m38-d/中文 空格 解压包');
const electronDistSource = opt('electron-dist', path.join(APP_ROOT, 'node_modules/electron'));
const phaseOverride = opt('phase', '');
const expectedZipSha = opt('expect-zip-sha256', '3ad2a72fa7773f1103da9fb32a58370327bb6539b9933b3b54aac21d5e174fb9');
const expectedEntries = Number(opt('expect-entries', '370'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
const evidenceRoot = path.join(APP_ROOT, 'tests/chat-evidence/m38');
const lockPath = '/tmp/m38-d-accept.lock';

if (display === ':94') {
  console.error('D 不得占用共享显示 :94；请用 :96（默认）。');
  process.exit(2);
}

const shell = (id, group, title, cmd, argv, extra = {}) => ({
  id,
  group,
  title,
  gui: extra.gui ?? false,
  timeoutMs: extra.timeoutMs ?? 900_000,
  cwd: extra.cwd,
  preview: `${cmd} ${argv.join(' ')}`,
  run: async (ctx) => {
    const child = await runChild({
      cmd,
      argv,
      cwd: ctx.cwd,
      env: childEnv(ctx.gui ? ctx.display : undefined),
      logPath: ctx.logPath,
      timeoutMs: ctx.timeoutMs,
    });
    const text = await readFile(ctx.logPath, 'utf8');
    const { counts, blocks } = parseCounts(text);
    const notes = [`耗时 ${Math.round(child.durationMs / 1000)}s`, `汇总块 ${blocks}`];
    if (child.spawnError !== undefined) notes.push(`spawn 失败：${child.spawnError}`);
    if (child.timedOut) notes.push(`超时被终止（上限 ${Math.round(ctx.timeoutMs / 1000)}s），exit=${String(child.exitCode)}`);
    return {
      exitCode: child.exitCode,
      counts,
      status: child.exitCode === 0 ? 'pass' : 'fail',
      notes,
    };
  },
});

const LAYERS = [
  { id: 'env', group: 'pre', title: '环境快照', timeoutMs: 120_000, preview: '(内部检查：node/pnpm/HEAD/显示/工具)', run: runEnvLayer },
  { id: 'pkg-hash', group: 'pre', title: '交付包 SHA256 + 完整性 + 启动.cmd 字节', timeoutMs: 120_000, preview: '(内部检查：sha256/zipfile/启动.cmd 字节)', run: runPkgHashLayer },
  { id: 'pkg-extract', group: 'pre', title: '解压到中文+空格目录', timeoutMs: 300_000, preview: `python3 -c <zipfile.extractall> ${zipPath} ${pkgDir}`, run: runPkgExtractLayer },
  shell('pkg-install', 'pre', '解压包 pnpm install --frozen-lockfile', 'pnpm', ['install', '--frozen-lockfile'], { timeoutMs: 900_000, cwd: pkgDir }),
  { id: 'pkg-electron-binary', group: 'pre', title: 'electron 二进制环境替代（披露项）', timeoutMs: 300_000, preview: '(内部检查：pkg node_modules/electron/path.txt，缺则从本机同版本硬链接)', run: runPkgElectronBinaryLayer },
  shell('pkg-build', 'pre', '解压包 pnpm build', 'pnpm', ['build'], { timeoutMs: 900_000, cwd: pkgDir }),
  shell('pkg-test', 'pre', '解压包 pnpm test（默认并发；挂起则如实记 124）', 'pnpm', ['test'], { timeoutMs: 600_000, cwd: pkgDir }),
  { id: 'pkg-test-serial', group: 'pre', title: '解压包纯单元串行复跑', timeoutMs: 1_200_000, preview: 'node --experimental-strip-types --test --test-concurrency=1 ... <同一批文件>', run: runPkgTestSerialLayer },
  shell('unit', 'post', '纯单元 pnpm test', 'pnpm', ['test'], { timeoutMs: 900_000 }),
  shell('cleanup', 'post', '清理层 pnpm test:cleanup', 'pnpm', ['test:cleanup'], { timeoutMs: 600_000 }),
  shell('integration', 'post', '集成层 pnpm test:integration', 'pnpm', ['test:integration'], { timeoutMs: 900_000 }),
  shell('typecheck', 'post', 'pnpm typecheck', 'pnpm', ['typecheck'], { timeoutMs: 600_000 }),
  shell('lint', 'post', 'pnpm lint', 'pnpm', ['lint'], { timeoutMs: 600_000 }),
  shell('build', 'post', 'pnpm build', 'pnpm', ['build'], { timeoutMs: 900_000 }),
  shell('e2e', 'post', 'E2E 套件 pnpm test:e2e', 'pnpm', ['test:e2e'], { gui: true, timeoutMs: 1_800_000 }),
  { id: 'launcher', group: 'post', title: '显式 PET_NEXT_LAUNCHER_E2E=1 的 7 例', gui: true, timeoutMs: 1_800_000, preview: 'PET_NEXT_LAUNCHER_E2E=1 node --experimental-strip-types --test --test-concurrency=1 tests/launcher/first-run.e2e.test.ts', run: runLauncherLayer },
  { id: 'rounds', group: 'post', title: '关键取消/重试/退出 3 轮隔离', gui: true, timeoutMs: 2_400_000, preview: 'PET_NEXT_LAUNCHER_E2E=1 node --test --test-name-pattern=<3 例> ×3 轮', run: runRoundsLayer },
  shell('verify', 'post', '完整 pnpm verify（串行自然结束）', 'pnpm', ['verify'], { gui: true, timeoutMs: 2_700_000 }),
  { id: 'resources', group: 'post', title: '资源对照复核', timeoutMs: 120_000, preview: '(内部检查：bench/idle-profile/runs)', run: runResourcesLayer },
  { id: 'windows', group: 'post', title: 'Windows 项判定', timeoutMs: 60_000, preview: '(内部判定：无 Windows 则 not-run，只列命令)', run: runWindowsLayer },
];

function selectLayers() {
  const selection = opt('layer', 'all');
  if (selection === 'all') return LAYERS;
  if (selection === 'pre' || selection === 'post') return LAYERS.filter((layer) => layer.group === selection);
  const wanted = selection.split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !LAYERS.some((layer) => layer.id === id));
  if (unknown.length > 0) {
    console.error(`未知层：${unknown.join(',')}；可用：${LAYERS.map((layer) => layer.id).join(',')}`);
    process.exit(2);
  }
  return LAYERS.filter((layer) => wanted.includes(layer.id));
}

async function acquireLock() {
  if (existsSync(lockPath)) {
    const raw = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
    const pid = Number(raw.split('\n')[0]);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      console.error(`已有 m38:accept 在跑（pid=${pid}）。单核禁止并发 GUI，退出。`);
      process.exit(3);
    }
    console.error(`清理陈旧锁（pid=${pid} 不存在）`);
  }
  await writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
}

async function executeLayer(layer, ctx, displayManager) {
  const info = {
    layer: layer.id,
    group: layer.group,
    phase: ctx.phase,
    title: layer.title,
    stamp,
    startedAt: new Date().toISOString(),
    command: layer.preview,
    cwd: layer.cwd ?? APP_ROOT,
    display: layer.gui ? ctx.display : null,
    log: path.relative(APP_ROOT, ctx.logPath),
  };
  const displayState = layer.gui ? await displayManager.ensure() : null;
  if (displayState !== null) {
    info.displayState = displayState;
    if (!displayState.ready) {
      info.status = 'not-run';
      info.notRun = `显示不可用：${displayState.reason}`;
      info.exitCode = null;
      info.endedAt = new Date().toISOString();
      await writeFile(ctx.logPath, `# not-run: ${info.notRun}\n`);
      return info;
    }
  }
  const startedAt = Date.now();
  const result = await layer.run(ctx);
  info.durationMs = Date.now() - startedAt;
  info.endedAt = new Date().toISOString();
  info.exitCode = result.exitCode ?? null;
  info.status = result.status ?? (result.exitCode === 0 ? 'pass' : 'fail');
  info.counts = result.counts ?? null;
  info.notes = result.notes ?? [];
  if (result.notRun !== undefined) info.notRun = result.notRun;
  if (result.logJson !== undefined) {
    // 检查结果写独立 .json；若本层没有子进程原始输出，则把该文件当作本层日志。
    const detailPath = ctx.logPath.replace(/\.log$/, '.json');
    await writeFile(detailPath, `${JSON.stringify(result.logJson, null, 2)}\n`);
    info.detail = path.relative(APP_ROOT, detailPath);
    if (!existsSync(ctx.logPath)) info.log = info.detail;
  }
  if (existsSync(ctx.logPath)) {
    const logBuffer = await readFile(ctx.logPath);
    info.logBytes = logBuffer.length;
    info.logSha256 = sha256(logBuffer);
  }
  return info;
}

async function main() {
  if (flag('list')) {
    for (const layer of LAYERS) console.log(`${layer.id.padEnd(16)} ${layer.group.padEnd(5)} ${layer.title}`);
    return 0;
  }
  const layers = selectLayers();
  if (dryRun) {
    for (const layer of layers) {
      console.log(`[dry-run] ${layer.id} (${layer.group}, timeout=${Math.round((timeoutOverride > 0 ? timeoutOverride * 1000 : layer.timeoutMs) / 1000)}s)`);
      console.log(`          ${layer.preview}`);
    }
    return 0;
  }
  await acquireLock();
  const displayManager = new DisplayManager(display, (line) => console.error(`[display] ${line}`));
  const results = [];
  try {
    for (const layer of layers) {
      const phase = phaseOverride || layer.group;
      const dir = path.join(evidenceRoot, phase);
      const logDir = path.join(dir, 'logs');
      await mkdir(logDir, { recursive: true });
      const suffix = tag === '' ? '' : `-${tag}`;
      const logPath = path.join(logDir, `${layer.id}${suffix}-${stamp}.log`);
      const ctx = {
        appRoot: APP_ROOT,
        cwd: layer.cwd ?? APP_ROOT,
        evidenceRoot,
        evidenceDir: dir,
        logDir,
        logPath,
        display,
        pkgDir,
        electronDistSource,
        zipPath,
        expectedZipSha,
        expectedEntries,
        stamp,
        phase,
        gui: layer.gui === true,
        timeoutMs: timeoutOverride > 0 ? timeoutOverride * 1000 : layer.timeoutMs,
      };
      process.stdout.write(`\n=== ${layer.id} (${layer.group}) ${layer.title}\n`);
      const info = await executeLayer(layer, ctx, displayManager);
      results.push(info);
      await writeFile(
        path.join(logDir, `${layer.id}${suffix}-${stamp}.meta.json`),
        `${JSON.stringify(info, null, 2)}\n`,
      );
      await appendFile(path.join(dir, 'results.ndjson'), `${JSON.stringify(info)}\n`);
      const counts = info.counts;
      const countText = counts === null ? '' : ` tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skip=${counts.skipped}`;
      console.log(`    status=${info.status} exit=${String(info.exitCode)}${countText}`);
      for (const note of info.notes ?? []) console.log(`    note: ${note}`);
      if (info.notRun !== undefined) console.log(`    not-run: ${info.notRun}`);
    }
  } finally {
    await displayManager.stop();
    await rm(lockPath, { force: true });
  }

  const failed = results.filter((item) => item.status === 'fail');
  const notRun = results.filter((item) => item.status === 'not-run');
  const lines = [];
  lines.push(`M3-8 acceptance ${stamp}  phase=${phaseOverride || 'by-group'}  display=${display}  root=${APP_ROOT}`);
  lines.push('id                status   exit  tests pass fail skip  dur(s)  log');
  for (const item of results) {
    const counts = item.counts ?? {};
    lines.push(
      [
        item.layer.padEnd(17),
        item.status.padEnd(8),
        String(item.exitCode ?? '-').padEnd(5),
        String(counts.tests ?? '-').padEnd(5),
        String(counts.pass ?? '-').padEnd(4),
        String(counts.fail ?? '-').padEnd(4),
        String(counts.skipped ?? '-').padEnd(5),
        String(item.durationMs === undefined ? '-' : Math.round(item.durationMs / 1000)).padEnd(7),
        item.log,
      ].join(' '),
    );
  }
  if (failed.length > 0) lines.push(`失败层：${failed.map((item) => item.layer).join(', ')}`);
  if (notRun.length > 0) lines.push(`not-run 层：${notRun.map((item) => item.layer).join(', ')}`);
  lines.push(`VERDICT: ${failed.length > 0 ? 'fail' : notRun.length > 0 ? 'pass-with-not-run' : 'pass'}`);
  const summaryText = `${lines.join('\n')}\n`;
  console.log(`\n${summaryText}`);
  for (const phase of new Set(results.map((item) => item.phase))) {
    await mkdir(path.join(evidenceRoot, phase), { recursive: true });
    const subset = results.filter((item) => item.phase === phase);
    const verdict = failed.length > 0 ? 'fail' : notRun.length > 0 ? 'pass-with-not-run' : 'pass';
    const summaryJson = `${JSON.stringify({ stamp, display, root: APP_ROOT, verdict, layers: subset }, null, 2)}\n`;
    // 每个 stamp 留一份，同时更新 latest，避免后续单层复跑把整轮汇总覆盖掉。
    await writeFile(path.join(evidenceRoot, phase, `summary-${stamp}.json`), summaryJson);
    await writeFile(path.join(evidenceRoot, phase, `summary-${stamp}.txt`), summaryText);
    await writeFile(path.join(evidenceRoot, phase, 'summary.json'), summaryJson);
    await writeFile(path.join(evidenceRoot, phase, 'summary.txt'), summaryText);
  }
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(error);
    await rm(lockPath, { force: true });
    process.exit(1);
  });
