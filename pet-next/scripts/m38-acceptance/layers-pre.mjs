/**
 * M3-8 阶段1（pre）层：环境快照 + 基线交付包独立复核 + 中文+空格解压包的 install/build/test。
 * 全部只读交付包与解压目录，不改产品源码。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, execCapture, parseCounts, runChild, sha256 } from './lib.mjs';
import { collectUnitFiles } from './collect-unit.mjs';

export async function runEnvLayer(ctx) {
  const gitHead = await execCapture('git', ['rev-parse', 'HEAD'], { cwd: ctx.appRoot });
  const gitBranch = await execCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.appRoot });
  const gitStatus = await execCapture('git', ['status', '--porcelain'], { cwd: ctx.appRoot });
  const pnpmVersion = await execCapture('pnpm', ['-v'], { cwd: ctx.appRoot, env: childEnv() });
  const tools = {};
  for (const tool of ['Xvfb', 'xdotool', 'xwininfo', 'python3']) {
    tools[tool] = (await execCapture('bash', ['-lc', `command -v ${tool} || true`])).stdout || null;
  }
  const info = {
    capturedAt: new Date().toISOString(),
    appRoot: ctx.appRoot,
    evidenceDir: ctx.evidenceDir,
    node: process.version,
    pnpm: pnpmVersion.stdout,
    platform: process.platform,
    arch: process.arch,
    release: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    display: ctx.display,
    displaySocketExists: existsSync(`/tmp/.X11-unix/X${ctx.display.replace(/^:/, '')}`),
    head: gitHead.stdout || null,
    branch: gitBranch.stdout || null,
    worktreeClean: gitStatus.ok && gitStatus.stdout === '',
    gitStatusPorcelain: gitStatus.stdout,
    tools,
    inheritedEnv: {
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      PET_NEXT_LAUNCHER_E2E: process.env.PET_NEXT_LAUNCHER_E2E ?? null,
      DISPLAY: process.env.DISPLAY ?? null,
      PET_NEXT_E2E_DISPLAY: process.env.PET_NEXT_E2E_DISPLAY ?? null,
    },
  };
  const notes = [];
  if ((process.env.NODE_OPTIONS ?? '') !== '') notes.push('父进程 NODE_OPTIONS 非空（子进程已剔除，记录备查）');
  if (info.pnpm !== '10.33.4') notes.push(`pnpm=${info.pnpm}，冻结值为 10.33.4`);
  if (!process.version.startsWith('v22.')) notes.push(`node=${process.version}，冻结值为 v22.20.0`);
  if (info.cpuCount !== 1) notes.push(`CPU ${info.cpuCount} 核（FREEZE 记录为单核，GUI 仍串行）`);
  if (!info.worktreeClean) notes.push('工作树不干净：' + JSON.stringify(info.gitStatusPorcelain));
  return { exitCode: 0, counts: null, status: 'pass', notes, logJson: info };
}

export async function runPkgHashLayer(ctx) {
  if (!existsSync(ctx.zipPath)) {
    return { exitCode: null, counts: null, status: 'not-run', notRun: `交付包不存在：${ctx.zipPath}`, notes: [] };
  }
  const zipSha = sha256(await readFile(ctx.zipPath));
  const py = [
    'import hashlib, json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'bad = z.testzip()',
    'names = z.namelist()',
    "req = ['package.json', 'pnpm-lock.yaml', '启动.cmd', 'scripts/m38-acceptance/run.mjs',",
    "       'tests/launcher/first-run.e2e.test.ts']",
    // 用 SHA1 与 `git rev-parse HEAD:<path>` 的 blob 哈希对齐，保证比的是"这个 commit"而不是我的工作树。
    'files = {n: (hashlib.sha1(z.read(n)).hexdigest() if n in names else None) for n in req}',
    "cmd = [n for n in names if n.endswith('.cmd')]",
    'entry = {}',
    'if cmd:',
    '    b = z.read(cmd[0])',
    "    entry = {'name': cmd[0], 'bytes': len(b), 'crlf': b.count(b'\\r\\n'),",
    "             'loneLf': b.count(b'\\n') - b.count(b'\\r\\n'),",
    "             'nonAscii': sum(1 for x in b if x > 127),",
    "             'bom': b[:3] == b'\\xef\\xbb\\xbf',",
    "             'chcp': b'chcp' in b.lower(),",
    "             'sha256': hashlib.sha256(b).hexdigest()}",
    "    print(json.dumps({'testzip': bad, 'entries': len(names), 'names': names, 'cmd': entry, 'files': files},",
    '                     ensure_ascii=False))',
  ].join('\n');
  const analyzed = await execCapture('python3', ['-c', py, ctx.zipPath]);
  if (!analyzed.ok) {
    return { exitCode: 1, counts: null, status: 'fail', notes: [`python3 解析 zip 失败：${analyzed.stderr}`], logJson: { zipSha } };
  }
  const info = JSON.parse(analyzed.stdout);
  const cmd = info.cmd ?? {};
  // 逐文件比对：包内关键文件必须与当前 worktree（应为待验收 HEAD）字节一致，
  // 这比固定 SHA 常量更能发现"包不是从这个 commit 打的"。
  const requiredFiles = [
    'package.json',
    'pnpm-lock.yaml',
    '启动.cmd',
    'scripts/m38-acceptance/run.mjs',
    'tests/launcher/first-run.e2e.test.ts',
  ];
  const fileChecks = [];
  // 仓库根可能高于应用根（本 worktree 是 <repo>/pet-next），先取相对前缀再拼 HEAD:path。
  const prefixInfo = await execCapture('git', ['-C', ctx.appRoot, 'rev-parse', '--show-prefix']);
  const gitPrefix = prefixInfo.ok ? prefixInfo.stdout : '';
  // 比的是"这个 commit 的 blob"：包内容经 `git hash-object --path=...` 按路径过滤后
  // 得到 blob 哈希，再与 `git rev-parse HEAD:<path>` 对齐；这样既不受我本地未提交改动影响，
  // 也不受 启动.cmd 的 CRLF/eol 属性影响（--path 会应用同一套过滤器）。
  const extractedRoot = existsSync(path.join(ctx.pkgDir, 'package.json')) ? ctx.pkgDir : null;
  for (const rel of requiredFiles) {
    const extracted = extractedRoot === null ? null : path.join(extractedRoot, rel);
    if (extracted === null || !existsSync(extracted)) {
      fileChecks.push({ id: `file-vs-HEAD:${rel}`, ok: false, expected: 'HEAD blob', actual: `解压目录缺该文件（${extractedRoot === null ? '解压目录为空' : '缺文件'}）` });
      continue;
    }
    const expected = await execCapture('git', ['-C', ctx.appRoot, 'rev-parse', `HEAD:${gitPrefix}${rel}`]);
    const actual = await execCapture('git', ['-C', ctx.appRoot, 'hash-object', `--path=${gitPrefix}${rel}`, extracted]);
    fileChecks.push({
      id: `file-vs-HEAD:${rel}`,
      ok: expected.ok && actual.ok && expected.stdout === actual.stdout,
      expected: expected.ok ? expected.stdout : `rev-parse 失败：${expected.stderr}`,
      actual: actual.ok ? actual.stdout : `hash-object 失败：${actual.stderr}`,
    });
  }
  const checks = [
    { id: 'zip-testzip', ok: info.testzip === null, expected: null, actual: info.testzip },
    // 只有显式传入基线常量时才做等值断言；否则 SHA/条目数仅记录（随 HEAD 变化）。
    ...(ctx.expectedZipSha === null ? [] : [{ id: 'zip-sha256', ok: zipSha === ctx.expectedZipSha, expected: ctx.expectedZipSha, actual: zipSha }]),
    ...(ctx.expectedEntries === null ? [] : [{ id: 'zip-entries', ok: info.entries === ctx.expectedEntries, expected: ctx.expectedEntries, actual: info.entries }]),
    // 结构不变量：启动.cmd 必须是纯 ASCII + 全 CRLF + 无 BOM + 无 chcp；字节数随内容记录不断言。
    { id: 'cmd-lone-lf', ok: cmd.loneLf === 0, expected: 0, actual: cmd.loneLf },
    { id: 'cmd-non-ascii', ok: cmd.nonAscii === 0, expected: 0, actual: cmd.nonAscii },
    { id: 'cmd-bom', ok: cmd.bom === false, expected: false, actual: cmd.bom },
    { id: 'cmd-no-chcp', ok: cmd.chcp === false, expected: false, actual: cmd.chcp },
    { id: 'zip-no-node-modules', ok: !(info.names ?? []).some((name) => name.includes('node_modules/')), expected: 'no node_modules', actual: 'checked' },
    { id: 'zip-has-lock', ok: (info.names ?? []).includes('pnpm-lock.yaml'), expected: 'pnpm-lock.yaml', actual: 'checked' },
    ...fileChecks,
  ];
  const failures = checks.filter((check) => !check.ok);
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    counts: null,
    status: failures.length === 0 ? 'pass' : 'fail',
    notes: failures.length > 0
      ? failures.map((item) => `失败项 ${item.id}: 期望 ${String(item.expected)}，实际 ${String(item.actual)}`)
      : [
        `zip sha256 ${zipSha}`,
        `条目 ${info.entries}，启动.cmd ${cmd.bytes}B/${cmd.crlf} CRLF/${cmd.loneLf} 孤立 LF/非ASCII ${cmd.nonAscii}/BOM ${cmd.bom}/chcp ${cmd.chcp}`,
        `逐文件比对 ${requiredFiles.length} 个关键文件与 HEAD blob 一致`,
      ],
    logJson: {
      zipPath: ctx.zipPath,
      zipSha,
      expectedZipSha: ctx.expectedZipSha,
      expectedEntries: ctx.expectedEntries,
      zip: info,
      checks,
    },
  };
}

export async function runPkgExtractLayer(ctx) {
  const py = [
    'import os, sys, zipfile',
    'z, d = sys.argv[1], sys.argv[2]',
    'os.makedirs(d, exist_ok=True)',
    'zf = zipfile.ZipFile(z)',
    "print('testzip:', zf.testzip())",
    'zf.extractall(d)',
    "entries = sorted(os.listdir(d))",
    "print('root entries:', len(entries))",
    "print('root sample:', ', '.join(entries[:8]))",
  ].join('\n');
  const child = await runChild({
    cmd: 'python3',
    argv: ['-c', py, ctx.zipPath, ctx.pkgDir],
    cwd: ctx.appRoot,
    env: childEnv(),
    logPath: ctx.logPath,
    timeoutMs: Math.min(ctx.timeoutMs, 300_000),
  });
  return {
    exitCode: child.exitCode,
    counts: null,
    status: child.exitCode === 0 ? 'pass' : 'fail',
    notes: child.spawnError === undefined ? [`解压目录 ${ctx.pkgDir}`] : [`解压失败：${child.spawnError}`],
    logJson: { pkgDir: ctx.pkgDir, durationMs: child.durationMs },
  };
}

/**
 * electron 二进制补齐（环境替代，必须披露）：
 * 本机到 GitHub 不可达，解压包 `pnpm install --frozen-lockfile` exit0 却不落
 * node_modules/electron/path.txt（pendingBuilds 为空、侧效应缓存未产出 dist），
 * 于是任何 require('electron')/spawn electron 的用例都会同步下载二进制并永久等待。
 * 该层从本机同版本（43.3.0）worktree 硬链接 dist 并补 path.txt，只动临时解压目录的
 * node_modules，不动产品源码；结果必须标为"环境替代"，不得当成干净安装的产物。
 */
export async function runPkgElectronBinaryLayer(ctx) {
  const pkgElectron = path.join(ctx.pkgDir, 'node_modules/electron');
  const pathFile = path.join(pkgElectron, 'path.txt');
  const distDir = path.join(pkgElectron, 'dist');
  const distReady = () => {
    if (!existsSync(pathFile)) return false;
    const name = readFileSync(pathFile, 'utf8');
    return name.length > 0 && existsSync(path.join(distDir, name));
  };
  if (distReady()) {
    return {
      exitCode: 0,
      counts: null,
      status: 'pass',
      notes: ['electron 二进制已可用（未做替换）'],
      logJson: { substituted: false, pathTxt: await readFile(pathFile, 'utf8') },
    };
  }
  if (!existsSync(pkgElectron)) {
    return { exitCode: 1, counts: null, status: 'fail', notes: [`${pkgElectron} 不存在：install 未完成`] };
  }
  const sourceDist = path.join(ctx.electronDistSource, 'dist');
  if (!existsSync(sourceDist)) {
    return {
      exitCode: null,
      counts: null,
      status: 'not-run',
      notRun: `解压包缺 electron 二进制且无本机替代源：${sourceDist}`,
      notes: [],
    };
  }
  let copy = { exitCode: 0, durationMs: 0 };
  if (!existsSync(path.join(distDir, 'electron'))) {
    copy = await runChild({
      cmd: 'cp',
      // 跨文件系统（/data3 与 /tmp）不能硬链接，用真实复制；只写临时解压目录。
      argv: ['-a', sourceDist, distDir],
      cwd: ctx.pkgDir,
      env: childEnv(),
      logPath: ctx.logPath,
      timeoutMs: 300_000,
    });
    if (copy.exitCode !== 0) {
      return { exitCode: copy.exitCode, counts: null, status: 'fail', notes: ['复制 electron dist 失败'], logJson: { copy } };
    }
  }
  const sourcePathTxt = path.join(ctx.electronDistSource, 'path.txt');
  // 关键：path.txt 必须与官方 postinstall 一致（纯 "electron"，不带换行）；
  // 多一个 \n 会让 path.join(__dirname,'dist','electron\n') 不存在而再次触发下载。
  const pathTxt = existsSync(sourcePathTxt) ? await readFile(sourcePathTxt, 'utf8') : 'electron';
  await writeFile(pathFile, pathTxt);
  const version = await execCapture(path.join(pkgElectron, 'dist', 'electron'), ['--version'], {
    env: { ...childEnv(), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 60_000,
  });
  const notes = [
    '环境替代：解压包 install 未产出 electron 二进制（本机 GitHub 不可达），dist 取本机同版本 worktree，已补 path.txt',
    `替代源 ${sourceDist}，path.txt=${pathTxt}`,
    `二进制自检 ELECTRON_RUN_AS_NODE --version → ${version.ok ? version.stdout.split('\n').at(-1) : `失败: ${version.stderr}`}`,
  ];
  return {
    exitCode: version.ok ? 0 : 1,
    counts: null,
    status: version.ok ? 'pass' : 'fail',
    notes,
    logJson: { substituted: true, sourceDist, pathTxt, version: version.stdout, versionOk: version.ok, copyDurationMs: copy.durationMs },
  };
}

/** 解压包纯单元串行复跑：与官方 `pnpm test` 同一批文件，只用 --test-concurrency=1。 */
export async function runPkgTestSerialLayer(ctx) {
  const files = await collectUnitFiles(ctx.pkgDir);
  const child = await runChild({
    cmd: process.execPath,
    argv: ['--experimental-strip-types', '--test', '--test-concurrency=1', '--test-reporter', 'spec', ...files],
    cwd: ctx.pkgDir,
    env: childEnv(ctx.display),
    logPath: ctx.logPath,
    timeoutMs: ctx.timeoutMs,
  });
  const text = await readFile(ctx.logPath, 'utf8');
  const { counts, blocks } = parseCounts(text);
  return {
    exitCode: child.exitCode,
    counts,
    status: child.exitCode === 0 ? 'pass' : 'fail',
    notes: [`串行文件数 ${files.length}`, `汇总块 ${blocks}`, `耗时 ${Math.round(child.durationMs / 1000)}s`],
    logJson: { fileCount: files.length, files, blocks, durationMs: child.durationMs, timedOut: child.timedOut },
  };
}
