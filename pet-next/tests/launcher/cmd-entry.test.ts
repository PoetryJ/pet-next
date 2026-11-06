/**
 * M3-7 D / M3-8 A：交付的 启动.cmd 真实执行回归（REVIEW 第 16 行）。
 *
 * 问题 1（产品侧，已修）：交付 .cmd 用 UTF-8 保存且注释是中文，cmd.exe 按默认代码页（GBK/437）
 * 读批处理时把注释片段当命令执行，整条包装器落进 cd_fail，受控 Node exit 7 被吞成 exit 1。
 * 本文件测的是**实际交付的 .cmd**（copyFile 逐字节复制后执行），不是等价 Node 脚本：
 * - 字节层（所有平台都跑）：纯 ASCII、CRLF、无 BOM、无 chcp；
 * - 执行层（仅 Windows 真跑）：exit 0 / exit 7 原样透传、stderr 为空、不进入 cd_fail / no_node、
 *   `cd /d "%~dp0"` 真的把工作目录切到 .cmd 所在目录，且路径含中文与空格。
 *
 * 问题 2（本夹具侧，M3-8 修）：旧夹具把交付文件复制成 ASCII 名 start.cmd，再用
 * `cmd /c start.cmd` 启动。start 是 CMD 的内建命令（START 启动新窗口），在 Windows 上与
 * 文件名解析冲突：REVIEW 的三例失败/超时就出在这里（evidence/cmd-invocation-probe.json：
 * start.cmd 失败，同字节的 entry.cmd 与原名 启动.cmd exit0/exit7 均正常）。
 * 现在**保留原交付文件名** 启动.cmd，并以显式路径调用：
 *   cmd.exe /d /s /c ""<中文 空格 目录>\启动.cmd""
 * 命令行里没有任何裸的 start 词，不会再命中 START 内建；`/s` 只剥外层引号，
 * 内层引号仍然保护含中文与空格的路径。
 *
 * 问题 3（本夹具侧，M3-8 修）：旧超时处理只 `child.kill()`（cmd.exe 本身），随后立刻删临时目录，
 * 子进程还活着 → EBUSY 把「.cmd 卡住」的原始原因盖掉。现在：
 * - 超时只收**本测试自己的进程树**（win32 用 tests/support/process-tree.ts 的
 *   windowsTerminatePlan → `taskkill /PID <pid> /T /F`，绝不按映像名全局结束）；
 * - 删临时目录前必须先等到子进程 close（有界等待，等不到就报「未 close」，不做 rm）；
 * - 超时错误里必须带 stdout / stderr / closed 诊断，清理失败不覆盖原始失败。
 *
 * 构造方式：把 .cmd 复制进临时目录「中文 空格 目录」，同目录放受控 scripts/launch-trial.mjs
 * （写自己的工作目录、只 process.exit，不启动 Electron），子进程 PATH 前置真实 node 目录；
 * 子进程 cwd 故意设成临时根的上级，逼 `cd /d "%~dp0"` 真的起作用。
 * 只影响子进程环境：不改系统代码页、不改系统 PATH、无窗口。
 *
 * not-run：非 Windows 主机不执行真实 .cmd（cmd.exe 不存在），用例显式 skip 并标 not-run。
 * @module pet-next/tests/launcher/cmd-entry.test
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { windowsTerminatePlan } from '../support/process-tree.ts';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 交付文件的原名（不得改名的语义：这是用户双击的那个文件）。 */
const DELIVERED_NAME = '启动.cmd';
const cmdSource = path.join(petRoot, DELIVERED_NAME);

/** 交付字节的硬约束：命令在子进程里跑，不读宿主代码页。 */
const cmdBytes = readFileSync(cmdSource);
const cmdText = cmdBytes.toString('latin1');

/** 非 Windows：真实 .cmd 不执行，如实记 not-run（不伪装成通过）。 */
const windowsOnly: false | string =
  process.platform === 'win32' ? false : 'not-run: Windows-only（本机非 win32，真实 .cmd 未执行）';

/** pause 等待的总超时；到这里说明 .cmd 卡住了。 */
const RUN_TIMEOUT_MS = 20000;
/** 超时收树之后等 close 的上限：等不到就带 closed=false 报错，不再无限挂。 */
const CLOSE_GRACE_MS = 8000;
/** 删临时目录前等 close 的上限（子树已被收，正常是毫秒级）。 */
const CLEANUP_CLOSE_TIMEOUT_MS = 10000;

interface CmdRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  closed: boolean;
}

interface ActiveRun {
  child: ChildProcess;
  isClosed(): boolean;
  /** 有界等 close：已 close 返回 true，超时返回 false（调用方据此决定是否 rm）。 */
  waitClosed(timeoutMs: number): Promise<boolean>;
}

/** 最近一次真实执行：测试 finally 先等它 close，再删临时目录。 */
let activeRun: ActiveRun | undefined;

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
  let failure: unknown;
  try {
    const wrapperDir = await makeWrapperDir(base);
    const result = await runRealCmd(wrapperDir, '0');
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('Failed to change directory'), `不得进入 cd_fail：${result.stdout}`);
    assert.ok(!result.stdout.includes('Node.js was not found'), `不得进入 no_node：${result.stdout}`);
    assertCwdSwitched(wrapperDir);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupCase(base, failure);
  }
});

test('真实 启动.cmd：受控 exit 7 原样透传（REVIEW 第 16 行的复现点）', { skip: windowsOnly }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'cmd-entry-'));
  let failure: unknown;
  try {
    const wrapperDir = await makeWrapperDir(base);
    const result = await runRealCmd(wrapperDir, '7');
    assert.equal(result.code, 7, `README 承诺原样透传；stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Launcher exited with code 7\./);
    assert.ok(!result.stdout.includes('Failed to change directory'), `不得进入 cd_fail：${result.stdout}`);
    assert.ok(!result.stdout.includes('Node.js was not found'), `不得进入 no_node：${result.stdout}`);
    assertCwdSwitched(wrapperDir);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupCase(base, failure);
  }
});

test('真实 启动.cmd：node 不在 PATH 时提示并退出 1（不进 cd_fail）', { skip: windowsOnly }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'cmd-entry-'));
  let failure: unknown;
  try {
    const wrapperDir = await makeWrapperDir(base);
    // 真实 where.exe 保留在子进程 PATH 中；不可用 where.cmd 替身，批处理会转移控制流。
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const preflight = spawnSync(path.join(system32, 'where.exe'), ['node'], {
      cwd: wrapperDir,
      env: childEnv(system32, '0', path.join(wrapperDir, 'launch-cwd.txt')),
      timeout: 3000,
      windowsHide: true,
      encoding: 'utf8',
    });
    assert.ifError(preflight.error);
    assert.equal(preflight.status, 1, `夹具必须排除 node：${preflight.stdout}${preflight.stderr}`);
    const result = await runRealCmd(wrapperDir, '0', { pathValue: system32 });
    assert.equal(result.code, 1);
    // 与 REVIEW 的 no-node-real-where-result.json 同一条件：no_node 分支只写 stdout，stderr 必须为空。
    assert.equal(result.stderr, '', `no_node 分支不得写 stderr：${result.stderr}`);
    assert.match(result.stdout, /Node\.js was not found in PATH/);
    assert.ok(!result.stdout.includes('Failed to change directory'), `不得进入 cd_fail：${result.stdout}`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupCase(base, failure);
  }
});

/**
 * 临时目录布局：<base>/中文 空格 目录/{启动.cmd, scripts/launch-trial.mjs}。
 * 启动.cmd 与交付文件逐字节相同、**文件名也保持原样**（不再改叫 start.cmd——
 * 那会与 CMD 的 START 内建冲突）；调用方用显式路径启动，见 runRealCmd。
 */
async function makeWrapperDir(base: string): Promise<string> {
  const dir = path.join(base, '中文 空格 目录');
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await copyFile(cmdSource, path.join(dir, DELIVERED_NAME));
  const copied = readFileSync(path.join(dir, DELIVERED_NAME));
  assert.ok(copied.equals(cmdBytes), '临时目录里的 .cmd 必须与交付字节逐字节相同（测的就是交付字节）');
  await writeFile(
    path.join(dir, 'scripts', 'launch-trial.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      'const target = process.env.FAKE_LAUNCH_CWD_FILE;',
      'if (target) writeFileSync(target, process.cwd());',
      "process.exit(Number(process.env.FAKE_LAUNCH_EXIT ?? '0'));",
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

/** 子进程环境：只替换 PATH（大小写变体先清掉），再加受控退出码与 cwd 落盘点。 */
function childEnv(pathValue: string, exitCode: string, cwdFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue;
    env[key] = value;
  }
  env.Path = pathValue;
  env.FAKE_LAUNCH_EXIT = exitCode;
  env.FAKE_LAUNCH_CWD_FILE = cwdFile;
  return env;
}

/** 路径比较口径：win32 大小写不敏感、分隔符统一；其他平台原样。 */
function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
}

/**
 * 工作目录断言：子进程从「临时根」（.cmd 的上级）启动，必须靠 `cd /d "%~dp0"` 切到 .cmd 所在目录，
 * 否则 `node scripts\launch-trial.mjs` 根本找不到。落盘的 cwd 是直接证据。
 */
function assertCwdSwitched(wrapperDir: string): void {
  const cwdFile = path.join(wrapperDir, 'launch-cwd.txt');
  const childCwd = readFileSync(cwdFile, 'utf8').trim();
  assert.ok(childCwd !== '', `launch-trial 应写回自己的 cwd：${cwdFile}`);
  assert.equal(
    normalizePath(childCwd),
    normalizePath(wrapperDir),
    `cd /d "%~dp0" 必须把 cwd 切到 .cmd 所在目录（含中文与空格）；实际 ${childCwd}`,
  );
  assert.notEqual(
    normalizePath(childCwd),
    normalizePath(path.dirname(wrapperDir)),
    `cwd 不得停留在继承的上级目录 ${path.dirname(wrapperDir)}`,
  );
}

/** 超时诊断：必须能看出是「卡住」还是「关不掉」，并带原始 stdout/stderr。 */
function timeoutMessage(run: { code: number | null; stdout: string; stderr: string; closed: boolean }): string {
  return [
    `${DELIVERED_NAME} 在 ${RUN_TIMEOUT_MS}ms 内没有结束（可能卡在 pause）`,
    `timedOut=true closed=${String(run.closed)} code=${String(run.code)}`,
    `stdout=${JSON.stringify(run.stdout)}`,
    `stderr=${JSON.stringify(run.stderr)}`,
  ].join('；');
}

/**
 * 超时/失败只收本测试的进程树：
 * - win32：process-tree.ts 的既有计划 → `taskkill /PID <pid> /T /F`（/T 只展开这个 PID 的子树）；
 * - 其他平台：本文件真实执行分支本就 not-run，只杀自己的直接子进程。
 * 不按映像名全局结束，不做 pkill。
 */
async function terminateOwnTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
  if (process.platform !== 'win32') {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    return;
  }
  let plan: ReturnType<typeof windowsTerminatePlan>;
  try {
    plan = windowsTerminatePlan(pid, true, process.pid);
  } catch (error) {
    console.error(`[cmd-entry] 拒绝结束 pid=${pid}：${String(error)}`);
    return;
  }
  await new Promise<void>((done) => {
    const killer = spawn(plan.command, [...plan.args], { stdio: 'ignore', windowsHide: true });
    killer.once('close', () => done());
    killer.once('error', () => done());
  });
}

/**
 * 执行真实 .cmd：显式路径调用
 *   cmd.exe /d /s /c ""<中文 空格 目录>\启动.cmd""
 * windowsVerbatimArguments 让 Node 不再二次加引号，命令行就是上面这一条；
 * /s 剥掉最外层引号后执行 "…启动.cmd"，内层引号继续保护中文与空格。
 */
function runRealCmd(wrapperDir: string, exitCode: string, options: { pathValue?: string } = {}): Promise<CmdRun> {
  const comspec = process.env.ComSpec ?? 'cmd.exe';
  const cmdPath = path.join(wrapperDir, DELIVERED_NAME);
  const runCwd = path.dirname(wrapperDir);
  const nodeDir = path.dirname(process.execPath);
  const pathValue = options.pathValue ?? [nodeDir, wrapperDir, process.env.Path ?? process.env.PATH ?? ''].join(path.delimiter);
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(comspec, ['/d', '/s', '/c', `""${cmdPath}""`], {
      cwd: runCwd,
      env: childEnv(pathValue, exitCode, path.join(wrapperDir, 'launch-cwd.txt')),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let closed = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const waiters: Array<() => void> = [];
    const markClosed = (): void => {
      closed = true;
      for (const wake of waiters.splice(0)) wake();
    };
    const waitClosed = (timeoutMs: number): Promise<boolean> =>
      new Promise((done) => {
        if (closed) {
          done(true);
          return;
        }
        const timer = setTimeout(() => done(false), timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          done(true);
        });
      });
    activeRun = { child, isClosed: () => closed, waitClosed };

    const closeTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void terminateOwnTree(child);
      // 收树之后仍等不到 close：照实报 closed=false，不让用例挂到 harness 超时。
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(timeoutMessage({ code: null, stdout, stderr, closed })));
      }, CLOSE_GRACE_MS);
    }, RUN_TIMEOUT_MS);

    const finish = (code: number | null): void => {
      markClosed();
      if (settled) return;
      settled = true;
      clearTimeout(closeTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (timedOut) {
        reject(new Error(timeoutMessage({ code, stdout, stderr, closed })));
        return;
      }
      resolve({ code, stdout, stderr, timedOut, closed });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      markClosed();
      if (settled) return;
      settled = true;
      clearTimeout(closeTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      reject(new Error(`启动 cmd.exe 失败；closed=${String(closed)}；stdout=${stdout} stderr=${stderr}`, { cause: error }));
    });
    // pause 读一行就返回，不会真的等人按键。
    child.stdin?.end('\n');
    child.once('close', (code) => finish(code));
  });
}

/**
 * 清理临时目录：**先等子进程 close，再 rm**。
 * - 原始失败优先：有 failure 时清理错误只打日志，不覆盖（EBUSY 不得遮住真实原因）；
 * - 没有原始失败却删不掉：如实报「已 close 仍删不掉」，并带上 close 状态。
 */
async function cleanupCase(base: string, failure: unknown): Promise<void> {
  const run = activeRun;
  activeRun = undefined;
  if (run !== undefined && !run.isClosed()) {
    const closed = await run.waitClosed(CLEANUP_CLOSE_TIMEOUT_MS);
    if (!closed) {
      const message =
        `临时目录 ${base} 未删除：子进程在 ${CLEANUP_CLOSE_TIMEOUT_MS}ms 内仍未 close ` +
        `（pid=${String(run.child.pid)}），无法安全 rm`;
      if (failure !== undefined) {
        console.error(`[cmd-entry] ${message}；保留原始失败，不用清理错误覆盖`);
        return;
      }
      throw new Error(message);
    }
  }
  try {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    if (failure !== undefined) {
      console.error(`[cmd-entry] 清理临时目录失败（原始失败已保留，不覆盖）：${String(error)}`);
      return;
    }
    throw new Error(`清理临时目录失败：子进程已 close 仍无法删除，说明还有句柄未释放：${String(error)}`, {
      cause: error,
    });
  }
}
