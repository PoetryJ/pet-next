/**
 * M3-9 先导：真实模型下的“隐藏期聊天结算”探针。
 *
 * 严格串行：只发 1 次真实 POST；本地计数代理转发到 127.0.0.1:18872，不改请求体。
 * 步骤：idle 播放 → 打开面板 → 输入 → 发送 → 立刻 hide → 隐藏期等真实回复上屏
 *      → show → 断言只有 1 条回复、1 次 POST、恢复后不重发；顺带验证 idle 暂停/恢复。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectCdp, delay, freePort, waitForPageSocket } from '/data3/DATA/project/project_meishijiang/m38-wt-lead/pet-next/bench/idle-profile/lib/cdp.mjs';

const petRoot = '/data3/DATA/project/project_meishijiang/m38-wt-lead/pet-next';
const outDir = process.argv[2] ?? '/data3/DATA/project/project_meishijiang/m38-wt-lead/pet-next/tests/chat-evidence/m39-pilot/hidden-real';
mkdirSync(outDir, { recursive: true });

const UPSTREAM = { host: '127.0.0.1', port: 18872 };
let postCount = 0;
let getModels = 0;
const forwards = [];
const proxy = http.createServer((req, res) => {
  const isPost = req.method === 'POST' && req.url === '/v1/chat/completions';
  const isModels = req.method === 'GET' && req.url === '/v1/models';
  if (isPost) postCount += 1;
  if (isModels) getModels += 1;
  const started = Date.now();
  const upstream = http.request(
    { host: UPSTREAM.host, port: UPSTREAM.port, path: req.url, method: req.method, headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` } },
    (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const body = Buffer.concat(chunks);
        forwards.push({ method: req.method, url: req.url, status: up.statusCode, ms: Date.now() - started, bytes: body.length });
        res.writeHead(up.statusCode ?? 502, up.headers);
        res.end(body);
      });
    },
  );
  upstream.on('error', (error) => {
    forwards.push({ method: req.method, url: req.url, status: null, ms: Date.now() - started, error: String(error) });
    res.writeHead(502).end(String(error));
  });
  req.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(18901, '127.0.0.1', resolve));

const debugPort = await freePort();
const userData = path.join(outDir, 'userData');
mkdirSync(userData, { recursive: true });
const env = {
  ...process.env,
  DISPLAY: ':123',
  PET_NEXT_TEST: '1',
  PET_NEXT_USER_DATA: userData,
  PET_NEXT_IDLE_PAUSE: '1',
  PET_NEXT_CHAT_LOCAL: 'local',
  PET_NEXT_QWEN_BASE_URL: 'http://127.0.0.1:18901/v1',
  PET_NEXT_QWEN_MODEL: 'qwen3.8-27b',
};
delete env.NODE_OPTIONS;

const electronPath = path.join(petRoot, 'node_modules/electron/dist/electron');
const child = spawn(electronPath, ['--no-sandbox', '--disable-dev-shm-usage', '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, 'dist/electron/main.js'], {
  cwd: petRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (c) => (stdout += String(c)));
child.stderr.on('data', (c) => (stderr += String(c)));

const ev = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
  return r.result?.value;
};
const rect = (cdp, selector) => ev(cdp, `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:r.width, h:r.height}; })()`);
const click = async (cdp, x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 0, pointerType: 'mouse' });
};
const state = (cdp) => ev(cdp, 'window.__petIdleSuspension ? JSON.parse(JSON.stringify(window.__petIdleSuspension)) : null');
const assistant = (cdp) => ev(cdp, `Array.from(document.querySelectorAll('[data-testid="chat-msg-assistant"]')).map(n => (n.textContent || '').trim())`);
const clipPaused = (cdp) => ev(cdp, 'document.querySelector("#clip").paused');

let cdp = null;
const result = { startedAt: new Date().toISOString(), display: ':123', upstream: 'http://127.0.0.1:18872/v1', proxy: 'http://127.0.0.1:18901/v1', model: 'qwen3.8-27b' };
try {
  const socket = await waitForPageSocket(debugPort, () => child.exitCode !== null, Date.now() + 30000);
  cdp = await connectCdp(socket);
  const deadline = Date.now() + 20000;
  for (;;) {
    const s = await state(cdp);
    if (s !== null && s.phase === 'playing' && s.clip === 'idle') break;
    if (Date.now() > deadline) throw new Error('等待 idle 播放超时');
    await delay(50);
  }
  result.initial = { state: await state(cdp), paused: await clipPaused(cdp), chatInfo: await ev(cdp, 'window.petChat.info ? window.petChat.info() : null') };

  const toggle = await rect(cdp, '[data-testid="chat-toggle"]');
  if (toggle === null) throw new Error('找不到 chat-toggle');
  await click(cdp, toggle.x, toggle.y);
  await delay(300);
  const input = await rect(cdp, '[data-testid="chat-input"]');
  const send = await rect(cdp, '[data-testid="chat-send"]');
  if (input === null || send === null) throw new Error('找不到 chat-input/chat-send');
  await click(cdp, input.x, input.y);
  await cdp.send('Input.insertText', { text: '请用一句话告诉我现在适合做什么。' });
  await delay(120);

  const tSend = Date.now();
  await click(cdp, send.x, send.y);
  const hideInfo = await ev(cdp, 'window.petTestWindow.act("hide")');
  const tHidden = Date.now();

  let reply = null;
  const replyDeadline = Date.now() + 30000;
  while (Date.now() < replyDeadline) {
    const messages = await assistant(cdp);
    if (messages.length > 0) {
      reply = { ms: Date.now() - tSend, hiddenMs: Date.now() - tHidden, messages };
      break;
    }
    await delay(50);
  }
  if (reply === null) throw new Error('隐藏期未收到回复');
  const hiddenState = await state(cdp);
  const hiddenPaused = await clipPaused(cdp);

  await delay(1200);
  const postBeforeShow = postCount;
  await ev(cdp, 'window.petTestWindow.act("show")');
  await delay(1500);
  const afterState = await state(cdp);
  const afterMessages = await assistant(cdp);
  const postAfterShow = postCount;

  result.hide = hideInfo;
  result.reply = reply;
  result.hidden = { state: hiddenState, paused: hiddenPaused };
  result.afterShow = { state: afterState, messages: afterMessages, paused: await clipPaused(cdp) };
  result.post = { beforeShow: postBeforeShow, afterShow: postAfterShow, total: postCount, getModels };
  result.forwards = forwards;
  result.checks = {
    hiddenStateTrue: hiddenState?.hidden === true,
    hiddenClipPaused: hiddenPaused === true,
    replyWhileHidden: reply !== null,
    singleReply: afterMessages.length === 1,
    singlePost: postBeforeShow === 1 && postAfterShow === 1,
    resumedNotPaused: (await clipPaused(cdp)) === false,
    resumedVisible: afterState?.hidden === false,
    noReplay: afterMessages.length === 1,
  };
  result.ok = Object.values(result.checks).every(Boolean);
} catch (error) {
  result.error = String(error);
  result.ok = false;
} finally {
  try { await ev(cdp, 'window.pet.quit()'); } catch { /* 已退出 */ }
  await delay(800);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  await delay(600);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  proxy.close();
  result.stdout = stdout;
  result.stderr = stderr;
  writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'product-stdout.log'), stdout);
  writeFileSync(path.join(outDir, 'product-stderr.log'), stderr);
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks, replyMs: result.reply?.ms, hiddenMs: result.reply?.hiddenMs, post: result.post, forwards: result.forwards, error: result.error }, null, 2));
  process.exit(result.ok ? 0 : 1);
}
