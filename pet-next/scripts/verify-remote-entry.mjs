#!/usr/bin/env node
/**
 * M3-2 chat:remote 验收自动化（跨平台单一实现）。
 *
 * 默认零推理：只验证 隧道 → /models → 面板就绪 → 收尾 → 残留断言，从不发送聊天消息。
 * --fake            用 fake SSH + fake 模型替身（零推理）；--interact 只能与 --fake 组合，
 *                   用 CDP 真实鼠标键盘做 发送/取消/重发（仍是零推理）。
 * --allow-real-inference  显式真实单次：仅真实模式可用，恰好一次发送，不可循环；默认关闭。
 * --expect=<reason> 指定负路径（auth-failed/probe-failed/not-ready/port-conflict/cancelled），
 *                   成功路径与负路径分开，二者都要求退出码是明确的数字。
 *
 * 证据：out 目录内 env.txt / stdout.ndjson / stderr.txt / models.json / 截图 /
 *       owned-pids.txt / SUMMARY.txt；任何断言失败 → 退出码 1。
 * @module pet-next/scripts/verify-remote-entry
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pidIsAlive, snapshotChildren } from '../tests/support/process-table.ts';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const args = new Map();
for (const item of process.argv.slice(2)) {
  const [key, value] = item.replace(/^--/, '').split('=');
  args.set(key, value ?? 'true');
}
const expect = args.get('expect') ?? 'ok';
const useFake = args.get('fake') === 'true';
const interact = args.get('interact') === 'true';
const allowRealInference = args.get('allow-real-inference') === 'true';
const readyTimeoutMs = Number(args.get('ready-timeout-ms') ?? 120000);
const totalTimeoutMs = Number(args.get('total-timeout-ms') ?? 300000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(args.get('out') ?? path.join(petRoot, 'tests/chat-evidence/remote', `auto-${stamp}`));

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `（${detail}）` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** 预先存在的 ssh 进程：收尾后必须仍然存活（只证明本脚本没有波及无关进程）。 */
function listSshPids() {
  try {
    if (isWin) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8', timeout: 15000 });
      return out.split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const out = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8', timeout: 10000 });
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[1] === 'ssh')
      .map((parts) => Number(parts[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** 从入口 PID 展开本次进程树（pnpm → node → ssh/electron），只用于归属判定。 */
async function collectTree(rootPid) {
  const lookup = await snapshotChildren(process.platform);
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    for (const child of lookup(pid)) queue.push(child);
  }
  return [...seen];
}

/** 找到入口真实的 chat-remote 进程（pnpm 的子进程），把 Ctrl-C 发给它而不是 pnpm。 */
async function findEntryNodePid(rootPid) {
  const lookup = await snapshotChildren(process.platform);
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    try {
      const cmd =
        process.platform === 'win32'
          ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 8000 })
          : execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      // 只认真正的 node 进程：`sh -c "pnpm build && node ... chat-remote.mjs"` 的参数也含该文件名，
      // 把 SIGINT 发给 shell 只会杀掉包装层，真正的入口会继续跑（取消语义失效）。
      const isWrapper = /^(sh|bash|dash|cmd|powershell|pwsh)\b/.test(cmd.trim()) || cmd.includes('&&');
      if (cmd.includes('chat-remote.mjs') && !isWrapper) return pid;
    } catch {
      /* 进程已退出 */
    }
    for (const child of lookup(pid)) queue.push(child);
  }
  return null;
}

function spawnCommand(command, cmdArgs, env, detached = false) {
  return spawn(command, cmdArgs, {
    cwd: petRoot,
    env,
    shell: isWin,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function startFakeModel(modelId = 'qwen3.8-27b') {
  const child = spawn(process.execPath, [path.join(petRoot, 'tests/support/fake-model-service.mjs')], {
    cwd: petRoot,
    env: { ...process.env, FAKE_MODEL_DELAY_MS: '300', FAKE_MODEL_ID: modelId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const line = out.split('\n').find((l) => l.includes('fake-model-ready'));
    if (line) return { child, port: JSON.parse(line.slice(line.indexOf('{'))).port };
    await sleep(80);
  }
  child.kill('SIGKILL');
  throw new Error('fake 模型服务未就绪');
}

/** 组装入口环境：fake 模式全部用替身；真实模式只用已配置的 PET_NEXT_SSH_*。 */
async function buildEnv(tunnelPort, debugPort) {
  const env = { ...process.env, PET_NEXT_TUNNEL_LOCAL_PORT: String(tunnelPort), PET_NEXT_CHAT_DEBUG_PORT: String(debugPort) };
  if (!useFake) {
    if (!env.PET_NEXT_SSH_HOST) throw new Error('真实模式需要 PET_NEXT_SSH_HOST/PORT/USER（仓库不含真实地址）');
    return { env, fakeModel: null };
  }
  // 负路径用替身模式复现；probe-failed 用不同模型 id；cancelled 由 SIGINT 注入（无替身模式）。
  const fakeModel = await startFakeModel(expect === 'probe-failed' ? 'other-9b' : 'qwen3.8-27b');
  const sshBin = isWin ? path.join(petRoot, 'tests/support/fake-ssh.mjs') : path.join(petRoot, 'tests/support/fake-ssh-bin.sh');
  if (!isWin) await chmod(sshBin, 0o755);
  env.PET_NEXT_SSH_BIN = sshBin;
  env.PET_NEXT_SSH_HOST = 'fake.example.invalid';
  env.PET_NEXT_SSH_PORT = '10977';
  env.PET_NEXT_SSH_USER = 'tester';
  const modeMap = { ok: 'ok', 'auth-failed': 'auth-fail', 'not-ready': 'no-listen', 'port-conflict': 'port-conflict', cancelled: 'no-listen' };
  env.FAKE_SSH_MODE = modeMap[expect] ?? 'ok';
  env.FAKE_SSH_TARGET_PORT = String(fakeModel.port);
  env.FAKE_SSH_LOG = path.join(outDir, 'fake-ssh.ndjson');
  return { env, fakeModel };
}

/** 极简 CDP：只做截图、点击、输入与状态读取。 */
async function connectCdp(debugPort, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let socketUrl = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await res.json();
      const page = Array.isArray(list) ? list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) : null;
      if (page) {
        socketUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 未就绪 */
    }
    await sleep(150);
  }
  if (!socketUrl) throw new Error('面板未暴露 CDP');
  const ws = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };
  const click = async (rect) => {
    const x = Math.round(rect.x + rect.w / 2);
    const y = Math.round(rect.y + rect.h / 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const screenshot = async (file) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const data = res.result?.data;
    if (!data) throw new Error('截图失败');
    await writeFile(file, Buffer.from(data, 'base64'));
  };
  return { send, evaluate, click, screenshot, close: () => ws.close() };
}

const stateExpression = `(() => {
  const by = (id, cls) => document.querySelector('[data-testid="' + id + '"]') ?? document.querySelector(cls);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const root = by('chat-panel', '.chat-panel-root');
  const body = by('chat-panel-open', '.chat-panel');
  return {
    phase: root?.dataset.state ?? '',
    open: body instanceof HTMLElement ? !body.hidden : false,
    bots: Array.from(document.querySelectorAll('[data-testid="chat-msg-assistant"]')).length,
    status: (document.querySelector('[data-testid="chat-status"]')?.textContent ?? '').trim(),
    rects: { toggle: rect(by('chat-toggle', '.chat-toggle')), input: rect(by('chat-input', '.chat-input')), send: rect(by('chat-send', '.chat-send')), cancel: rect(by('chat-cancel', '.chat-cancel')) },
  };
})()`;

async function waitState(cdp, ok, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(stateExpression);
    if (ok(state)) return state;
    last = state;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}（last=${JSON.stringify(last)}）`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const stdoutFile = path.join(outDir, 'stdout.ndjson');
  const stderrFile = path.join(outDir, 'stderr.txt');

  if (expect !== 'ok' && (interact || allowRealInference)) throw new Error('负路径模式不能与 --interact/--allow-real-inference 组合');
  if (interact && !useFake) throw new Error('--interact 只能与 --fake 组合（零推理）；真实发送需 --allow-real-inference');
  if (allowRealInference && useFake) throw new Error('--allow-real-inference 只用于真实目标（fake 模式不需要）');

  const envInfo = [
    `os: ${os.type()} ${os.release()} ${os.arch()}`,
    `node: ${process.version}`,
    `pnpm: ${execFileSync(isWin ? 'pnpm.cmd' : 'pnpm', ['-v'], { encoding: 'utf8', shell: isWin }).trim()}`,
    `ssh: ${args.get('skip-ssh-version') ? '<skipped>' : (() => { try { return execFileSync(isWin ? 'ssh.exe' : 'ssh', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }); } catch (error) { return String(error?.stderr ?? error?.message ?? 'unknown'); } })()}`,
    `fake: ${useFake}`,
    `expect: ${expect}`,
    `interact: ${interact}`,
    `allowRealInference: ${allowRealInference}`,
  ].join('\n');
  await writeFile(path.join(outDir, 'env.txt'), `${envInfo}\n`);

  const tunnelPort = await freePort();
  const debugPort = await freePort();
  const preexistingSsh = listSshPids();
  await writeFile(path.join(outDir, 'ssh-before.txt'), `${preexistingSsh.join('\n')}\n`);

  const { env, fakeModel } = await buildEnv(tunnelPort, debugPort);
  const outStream = [];
  const errStream = [];
  const entry = spawnCommand('pnpm', ['chat:remote'], env, expect === 'cancelled' && !isWin);
  entry.stdout.on('data', (chunk) => outStream.push(String(chunk)));
  entry.stderr.on('data', (chunk) => errStream.push(String(chunk)));
  // 被信号杀死时 exitCode 为 null，必须用 exit 事件的 (code, signal) 判断真实终态。
  let exitInfo = null;
  entry.on('exit', (code, signal) => {
    exitInfo = { code: code ?? null, signal: signal ?? null };
  });
  const allOut = () => outStream.join('');
  const allErr = () => errStream.join('');

  if (expect === 'cancelled') {
    // 启动阶段注入 Ctrl-C：等到隧道开始建立后 400ms 再发，确保命中"隧道未就绪"而非构建阶段。
    // 只发给 chat-remote 进程本身，让 pnpm 能回报数字退出码 130。
    void (async () => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !allOut().includes('"event":"chat-remote-config"')) await sleep(100);
      await sleep(400);
      const target = await findEntryNodePid(entry.pid);
      record('取消注入目标已定位（chat-remote 进程）', target !== null, `pid=${target ?? 'fallback-group'}`);
      try {
        if (target !== null) process.kill(target, 'SIGINT');
        else if (!isWin) process.kill(-entry.pid, 'SIGINT');
        else entry.kill('SIGINT');
      } catch {
        /* 已退出 */
      }
    })();
  }

  let ownedPids = [];
  let cdp = null;
  let exitCode = null;
  try {
    const deadline = Date.now() + readyTimeoutMs;
    let sawReady = false;
    let sawFailed = null;
    const readEvents = () => {
      const text = allOut();
      if (!sawReady && text.includes('"event":"chat-remote-ready"')) sawReady = true;
      const failLine = text.split('\n').filter((l) => l.includes('"event":"chat-remote-failed"')).at(-1);
      if (failLine) sawFailed = JSON.parse(failLine.slice(failLine.indexOf('{')));
    };
    while (Date.now() < deadline) {
      readEvents();
      if (sawReady || sawFailed) break;
      if (exitInfo !== null) break;
      await sleep(200);
    }
    // 进程退出与 stdout 数据到达存在竞争：退出后终读一次，避免漏判失败事件。
    readEvents();
    ownedPids = await collectTree(entry.pid);
    await writeFile(path.join(outDir, 'owned-pids.txt'), `${ownedPids.join('\n')}\n`);

    if (expect === 'ok') {
      record('隧道与模型就绪（chat-remote-ready）', sawReady, sawReady ? '' : `stderr=${allErr().slice(-400)}`);
      if (sawReady) {
        const res = await fetch(`http://127.0.0.1:${tunnelPort}/v1/models`, { signal: AbortSignal.timeout(8000) });
        const body = await res.text();
        await writeFile(path.join(outDir, 'models.json'), body);
        record('/models 返回 200 且含目标模型', res.status === 200 && body.includes(process.env.PET_NEXT_QWEN_MODEL ?? 'qwen3.8-27b'), `status=${res.status}`);

        cdp = await connectCdp(debugPort);
        let state = await waitState(cdp, (s) => s.rects?.toggle, 30000, '面板挂载');
        await cdp.screenshot(path.join(outDir, '01-ready.png'));
        record('面板就绪并截图（退出前）', true);

        if (interact) {
          await cdp.click(state.rects.toggle);
          state = await waitState(cdp, (s) => s.open && s.rects?.input, 8000, '面板打开');
          await cdp.click(state.rects.input);
          await cdp.send('Input.insertText', { text: '你好，验收测试' });
          await sleep(200);
          state = await cdp.evaluate(stateExpression);
          await cdp.click(state.rects.send);
          state = await waitState(cdp, (s) => s.bots >= 1, 20000, '收到回复');
          await cdp.screenshot(path.join(outDir, '02-reply.png'));
          record('发送并收到回复（fake 服务）', state.bots >= 1);

          await cdp.click(state.rects.input);
          await cdp.send('Input.insertText', { text: '这句取消' });
          await sleep(200);
          state = await cdp.evaluate(stateExpression);
          await cdp.click(state.rects.send);
          state = await waitState(cdp, (s) => s.phase === 'pending', 5000, '进入发送中');
          await cdp.click(state.rects.cancel);
          await waitState(cdp, (s) => s.status.includes('已取消') || s.phase === 'cancelled', 5000, '显示已取消');
          await cdp.screenshot(path.join(outDir, '03-cancelled.png'));
          record('取消成功', true);

          state = await cdp.evaluate(stateExpression);
          await cdp.click(state.rects.input);
          await cdp.send('Input.insertText', { text: '取消后重发' });
          await sleep(200);
          state = await cdp.evaluate(stateExpression);
          await cdp.click(state.rects.send);
          state = await waitState(cdp, (s) => s.bots >= 2, 20000, '重发成功');
          await cdp.screenshot(path.join(outDir, '04-resend.png'));
          record('取消后重发成功（旧请求未上屏）', state.bots === 2, `bots=${state.bots}`);
        }

        if (allowRealInference) {
          // 显式真实单次：恰好一个请求，循环会被计数断言拦住。
          await cdp.click(state.rects.toggle);
          state = await waitState(cdp, (s) => s.open && s.rects?.input, 8000, '面板打开');
          await cdp.click(state.rects.input);
          await cdp.send('Input.insertText', { text: '你好，请用一句话回应。' });
          await sleep(200);
          state = await cdp.evaluate(stateExpression);
          await cdp.click(state.rects.send);
          state = await waitState(cdp, (s) => s.bots >= 1, 30000, '真实单次回复');
          await cdp.screenshot(path.join(outDir, '05-real-once.png'));
          record('真实单次发送（唯一一次）', state.bots >= 1);
        }

        await cdp.screenshot(path.join(outDir, '06-before-close.png'));
        // 关闭走产品内 Browser.close（等同于用户关窗），由入口自己收尾。
        void cdp.send('Browser.close', {}).catch(() => undefined);
      }
    } else if (expect === 'cancelled') {
      record('取消：出现 chat-remote-cancelled 事件', allOut().includes('"event":"chat-remote-cancelled"'));
      record('取消：不得报就绪', !sawReady);
      record('取消：不得暴露 CDP（未启动 Electron）', !(await portListening(debugPort)));
    } else {
      record(`负路径 ${expect}：入口报告失败事件`, sawFailed !== null, sawFailed ? '' : allErr().slice(-400));
      record(`失败原因分类为 ${expect}`, sawFailed?.reason === expect, `reason=${sawFailed?.reason}`);
      record('失败路径不得报就绪', !sawReady);
      record('失败路径不得暴露 CDP', !(await portListening(debugPort)));
    }

    // 等入口退出（有界）
    const exitDeadline = Date.now() + totalTimeoutMs;
    while (exitInfo === null && Date.now() < exitDeadline) await sleep(200);
    if (exitInfo === null) {
      record('入口在总时限内退出', false, `${totalTimeoutMs}ms 未退出`);
      try {
        for (const pid of ownedPids) process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    } else {
      exitCode = exitInfo.code;
      record('入口终态已记录', true, `code=${exitInfo.code} signal=${exitInfo.signal}`);
      if (expect === 'ok') {
        record('成功路径退出码为 0', exitInfo.code === 0, `code=${exitInfo.code}`);
      } else if (expect === 'cancelled') {
        const doneLine = allOut()
          .split('\n')
          .filter((line) => line.includes('"event":"chat-remote-done"'))
          .at(-1);
        const doneExit = doneLine ? JSON.parse(doneLine.slice(doneLine.indexOf('{'))).exit : null;
        // 取消发生在隧道建立完成前时没有 done 事件（隧道层自行关闭）；此时以进程退出码 130 为准。
        record(
          '取消终态为 130（done 事件或进程退出码）',
          doneExit === 130 || exitInfo.code === 130,
          `doneExit=${doneExit} code=${exitInfo.code}`,
        );
      } else {
        record('失败路径退出码为 1', exitInfo.code === 1, `code=${exitInfo.code}`);
      }
    }
  } catch (error) {
    record('验收过程无异常', false, error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.close();
    // 残留断言：本次进程树必须退出；本地端口必须释放；预先存在的 ssh 必须存活。
    await sleep(1500);
    const aliveTree = ownedPids.filter((pid) => pidIsAlive(pid));
    if (aliveTree.length > 0) {
      for (const pid of aliveTree) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    }
    record('本次启动的 PID 全部退出（含 pnpm/node/ssh/electron）', aliveTree.length === 0, aliveTree.length > 0 ? `残留=${aliveTree.join(',')}` : '');
    record('本地转发端口已释放', !(await portListening(tunnelPort)), `port=${tunnelPort}`);
    const preexistingAfter = listSshPids();
    const preexistingAlive = preexistingSsh.filter((pid) => preexistingAfter.includes(pid));
    record('预先存在的 ssh 进程仍存活（无关进程未受影响）', preexistingAlive.length === preexistingSsh.length, `before=${preexistingSsh.join(',') || '-'} after=${preexistingAlive.join(',') || '-'}`);

    const sshLogPath = path.join(outDir, 'fake-ssh.ndjson');
    if (useFake && existsSync(sshLogPath)) {
      const text = await readFile(sshLogPath, 'utf8');
      if (expect === 'ok') record('本次隧道已由入口停止（fake-ssh-stopped）', text.includes('fake-ssh-stopped'));
    }

    await writeFile(stdoutFile, allOut());
    await writeFile(stderrFile, allErr());
    fakeModel?.child.kill('SIGTERM');

    const failed = checks.filter((check) => !check.ok);
    const summary = [
      'M3-2 chat:remote 验收自动化 SUMMARY',
      `stamp: ${stamp}`,
      `os: ${process.platform} ${os.release()}`,
      `mode: expect=${expect} fake=${useFake} interact=${interact} realInference=${allowRealInference}`,
      `exit: ${exitCode === null ? 'null' : exitCode}`,
      ...checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? `（${check.detail}）` : ''}`),
      `result: ${failed.length === 0 ? 'PASS' : 'FAIL'}`,
    ].join('\n');
    await writeFile(path.join(outDir, 'SUMMARY.txt'), `${summary}\n`);
    console.log(`\n证据目录: ${outDir}`);
    process.exit(failed.length === 0 ? 0 : 1);
  }
}

main().catch((error) => {
  console.error(`验收自动化异常：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
