/**
 * M3-7 D：交付的 启动.cmd 真实执行回归（REVIEW 第 16 行）。
 *
 * 问题：交付 .cmd 用 UTF-8 保存且注释是中文，cmd.exe 按默认代码页（GBK/437）读批处理时
 * 把注释片段当命令执行，整条包装器落进 cd_fail，受控 Node exit 7 被吞成 exit 1。
 * 本文件测的是**实际交付的 .cmd**（copyFile 逐字节复制后执行），不是等价 Node 脚本：
 * - 字节层（所有平台都跑）：纯 ASCII、CRLF、无 BOM、无 chcp；
 * - 执行层（仅 Windows 真跑）：exit 0 / exit 7 原样透传、stderr 为空、不进入 cd_fail / no_node，
 *   且路径含中文与空格（cd /d "%~dp0" 必须真的生效）。
 *
 * 构造方式：把 .cmd 复制进临时目录「中文 空格 目录」，同目录放受控 scripts/launch-trial.mjs
 * （只 process.exit，不启动 Electron），子进程 PATH 前置真实 node 目录；
 * 用 cmd /c 以 ASCII 单 token（start.cmd）+ 该目录在 PATH 中的方式启动，
 * 子进程 cwd 故意设成临时根的上级，逼 cd /d "%~dp0" 真的起作用。
 * 只影响子进程环境：不改系统代码页、不改系统 PATH、无窗口。
 *
 * not-run：非 Windows 主机不执行真实 .cmd（cmd.exe 不存在），用例显式 skip 并标 not-run。
 * @module pet-next/tests/launcher/cmd-entry.test
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cmdSource = path.join(petRoot, '启动.cmd');

/** 交付字节的硬约束：命令在子进程里跑，不读宿主代码页。 */
const cmdBytes = readFileSync(cmdSource);
const cmdText = cmdBytes.toString('latin1');

/** 非 Windows：真实 .cmd 不执行，如实记 not-run（不伪装成通过）。 */
const windowsOnly: false | string =
  process.platform === 'win32' ? false : 'not-run: Windows-only（本机非 win32，真实 .cmd 未执行）';

/** pause 等待的总超时；到这里说明 .cmd 卡住了。 */
const RUN_TIMEOUT_MS = 20000;

interface CmdRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

test('启动.cmd 是纯 ASCII + CRLF，默认代码页可直接解析', () => {
  assert.equal(cmdBytes[0], 0x40, '首字节应为 @（不能有 UTF-8 BOM）');
  const nonAscii = [...cmdBytes].filter((byte) => byte > 0x7f);
  assert.deepEqual(nonAscii, [], `存在 ${nonAscii.length} 个非 ASCII 字节：非 ASCII 注释会被 cmd 当命令执行`);
  const bareLf = cmdText.match(/[^\r]\n/g) ?? [];
  assert.equal(bareLf.length, 0, '存在裸 LF，行尾必须全是 CRLF');
  assert.ok(cmdText.endsWith('\r\n'), '文件必须以 CRLF 结尾');
  assert.ok(!/\n$/.test(cmdText.replace(/\r\n$/, '')), '结尾不应有多余空行');
  assert.ok(!/chcp/i.test(cmdText), '不得设置代码页（不 chcp）');
  assert.ok(!/^\s*setx?\s/im.test(cmdText), '不得设置环境变量');
});

test('启动.cmd 保留原有逻辑：切目录、查 node、跑 launch-trial、透传退出码', () => {
  const logic = [
    /^cd \/d "%~dp0"$/m,
    /^where node >nul 2>nul$/m,
    /^node scripts\\launch-trial\.mjs$/m,
    /^exit \/b %ERRORLEVEL%$/m,
    /^:no_node$/m,
    /^:fail$/m,
    /^:cd_fail$/m,
    /^pause$/m,
  ];
  for (const pattern of logic) assert.match(cmdText, pattern);
  assert.ok(!/^\s*powershell|^\s*wmic/im.test(cmdText), '包装器不引入新的外部依赖');
});

test('真实 启动.cmd：中文+空格路径下 exit 0 原样透传', { skip: windowsOnly }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'cmd-entry-'));
  try {
    const wrapperDir = await makeWrapperDir(base);
    const result = await runRealCmd(wrapperDir, '0');
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('Failed to change directory'), `不得进入 cd_fail：${result.stdout}`);
    assert.ok(!result.stdout.includes('Node.js was not found'), `不得进入 no_node：${result.stdout}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('真实 启动.cmd：受控 exit 7 原样透传（REVIEW 第 16 行的复现点）', { skip: windowsOnly }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'cmd-entry-'));
  try {
    const wrapperDir = await makeWrapperDir(base);
    const result = await runRealCmd(wrapperDir, '7');
    assert.equal(result.code, 7, `README 承诺原样透传；stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Launcher exited with code 7\./);
    assert.ok(!result.stdout.includes('Failed to change directory'), `不得进入 cd_fail：${result.stdout}`);
    assert.ok(!result.stdout.includes('Node.js was not found'), `不得进入 no_node：${result.stdout}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('真实 启动.cmd：node 不在 PATH 时提示并退出 1（不进 cd_fail）', { skip: windowsOnly }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'cmd-entry-'));
  try {
    const wrapperDir = await makeWrapperDir(base);
    // 注入一个 where 替身（exit /b 1）当「node 不存在」：真实 Windows 上无法删掉 node。
    const stubDir = path.join(base, 'no-node-path');
    await mkdir(stubDir, { recursive: true });
    await writeFile(path.join(stubDir, 'where.cmd'), '@echo off\r\nexit /b 1\r\n', 'latin1');
    const result = await runRealCmd(wrapperDir, '0', { pathValue: [stubDir, wrapperDir].join(path.delimiter) });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Node\.js was not found in PATH/);
    assert.ok(!result.stdout.includes('Failed to change directory'), `不得进入 cd_fail：${result.stdout}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * 临时目录布局：<base>/中文 空格 目录/{start.cmd, scripts/launch-trial.mjs}。
 * start.cmd 与交付文件逐字节相同；文件名改用 ASCII，免掉「cmd /c 传中文文件名」的二次编码
 * 变量，被测对象仍是交付字节本身（%@dp0 指向含中文与空格的目录）。
 */
async function makeWrapperDir(base: string): Promise<string> {
  const dir = path.join(base, '中文 空格 目录');
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await copyFile(cmdSource, path.join(dir, 'start.cmd'));
  await writeFile(
    path.join(dir, 'scripts', 'launch-trial.mjs'),
    "process.exit(Number(process.env.FAKE_LAUNCH_EXIT ?? '0'));\n",
    'utf8',
  );
  return dir;
}

/** 子进程环境：只替换 PATH（大小写变体先清掉），再加受控退出码。 */
function childEnv(pathValue: string, exitCode: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue;
    env[key] = value;
  }
  env.Path = pathValue;
  env.FAKE_LAUNCH_EXIT = exitCode;
  return env;
}

/**
 * 执行真实 .cmd：`cmd /d /s /c start.cmd`，cwd 设成临时根（不是 wrapper 目录），
 * start.cmd 通过 PATH 找到，因此 `cd /d "%~dp0"` 必须真的生效才能跑通 launch-trial。
 * 命令行里没有一个带空格/中文的参数，避免 cmd 的引号处理把断言弄脏。
 */
function runRealCmd(wrapperDir: string, exitCode: string, options: { pathValue?: string } = {}): Promise<CmdRun> {
  const comspec = process.env.ComSpec ?? 'cmd.exe';
  const nodeDir = path.dirname(process.execPath);
  const pathValue = options.pathValue ?? [nodeDir, wrapperDir, process.env.Path ?? process.env.PATH ?? ''].join(path.delimiter);
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(comspec, ['/d', '/s', '/c', 'start.cmd'], {
      cwd: path.dirname(wrapperDir),
      env: childEnv(pathValue, exitCode),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`启动.cmd 在 ${RUN_TIMEOUT_MS}ms 内没有结束（可能卡在 pause）`));
    }, RUN_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // pause 读一行就返回，不会真的等人按键。
    child.stdin?.end('\n');
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
