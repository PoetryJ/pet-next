/**
 * 对照用的 Electron 窗口。三种模式共用同一组窗口参数。
 * 样本写到任务给出的目录；这里不判断收益。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchPlay, BenchSample } from '../contracts/bench.ts';
import { cpuPercent, parseProcStat } from './cpu.ts';
import type { BenchJob } from './job.ts';
import { IDLE_CPU_MS, windowBounds } from './protocol.ts';

interface PageMessage {
  type: string;
  id?: number;
  boot?: string;
  message?: string;
  commandType?: string;
  play?: string;
  index?: number;
  clickToFirstFrameMs?: number | null;
  playResolvedMs?: number | null;
  blankMs?: number | null;
  loadCount?: number;
  evidenceBase64?: string | null;
  frames?: unknown;
  sidecar?: unknown;
}

const job = readJob();
if (process.env.BENCH_USER_DATA) app.setPath('userData', process.env.BENCH_USER_DATA);
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const marks = new Map<number, number | null>();
const clkTck = readClkTck();

function readJob(): BenchJob {
  const raw = process.env.BENCH_JOB;
  if (!raw) throw new Error('BENCH_JOB missing');
  return JSON.parse(raw) as BenchJob;
}

function readClkTck(): number {
  try {
    const text = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim();
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

function pidTicks(pid: number): number {
  try {
    const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return parsed ? parsed.utime + parsed.stime : 0;
  } catch {
    return 0;
  }
}

function metricPids(): number[] {
  return app.getAppMetrics().map((item) => item.pid);
}

function memoryBytes(): number | null {
  let sum = 0;
  for (const pid of metricPids()) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (match?.[1]) sum += Number(match[1]) * 1024;
    } catch {
      // 进程在采样时退出就跳过。
    }
  }
  return sum > 0 ? sum : null;
}

async function idleCpu(ms: number): Promise<number | null> {
  const start = new Map<number, number>();
  for (const pid of metricPids()) start.set(pid, pidTicks(pid));
  await delay(ms);
  const pids = new Set<number>([...start.keys(), ...metricPids()]);
  let startTicks = 0;
  let endTicks = 0;
  for (const pid of pids) {
    startTicks += start.get(pid) ?? 0;
    endTicks += pidTicks(pid);
  }
  return cpuPercent({ startTicks, endTicks, wallMs: ms, clkTck });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pageFile(): string {
  const root = process.env.BENCH_ROOT;
  if (!root) throw new Error('BENCH_ROOT missing');
  return path.join(root, 'dist/bench-build/bench/page.html');
}

function preloadFile(): string {
  const root = process.env.BENCH_ROOT;
  if (!root) throw new Error('BENCH_ROOT missing');
  return path.join(root, 'bench/preload.cjs');
}

void app.whenReady().then(async () => {
  mkdirSync(path.join(job.outDir, 'strips'), { recursive: true });
  const bounds = windowBounds(job.mode);
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, _level, message) => {
    if (message) console.log(JSON.stringify({ event: 'console', message }));
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.log(JSON.stringify({ event: 'fail-load', code, description }));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(JSON.stringify({ event: 'gone', details }));
  });

  let pageToken = 0;
  const readyWaiters = new Map<number, () => void>();
  const waitReady = (token: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('page ready timeout')), 20000);
      readyWaiters.set(token, () => {
        clearTimeout(timer);
        readyWaiters.delete(token);
        resolve();
      });
    });

  const pending = new Map<number, (message: PageMessage) => void>();
  ipcMain.on('bench', (_event, message: PageMessage) => {
    if (message.type === 'ready' && message.boot === String(pageToken)) {
      readyWaiters.get(pageToken)?.();
      return;
    }
    if (message.type === 'mark' && typeof message.id === 'number') {
      marks.set(message.id, memoryBytes());
      return;
    }
    if (message.type === 'error') {
      console.log(JSON.stringify({ event: 'page-error', message: message.message ?? '' }));
    }
    if (typeof message.id === 'number') pending.get(message.id)?.(message);
  });

  let nextId = 1;
  const send = (command: Record<string, unknown>, timeoutMs: number): Promise<PageMessage> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`command timeout ${JSON.stringify(command)}`)), timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      win.webContents.send('bench-command', { ...command, id });
    });
  };

  const load = async (): Promise<void> => {
    pageToken += 1;
    const gate = waitReady(pageToken);
    await win.loadFile(pageFile(), {
      query: {
        mode: job.mode,
        idle: job.idleUrl,
        reaction: job.reactionUrl,
        stress: String(job.stressDelayMs),
        boot: String(pageToken),
      },
    });
    await gate;
    if (!win.isVisible()) win.show();
  };

  try {
    await load();
    const cpu = await measureIdle(send);
    writeFileSync(
      path.join(job.outDir, 'cpu.json'),
      JSON.stringify({ idleCpuPercent: cpu, idleCpuMs: job.idleCpuMs || IDLE_CPU_MS, clkTck, pids: metricPids() }, null, 2),
    );
    for (let index = 1; index <= job.firstCount; index += 1) {
      await load();
      await collect(send, 'first', index, cpu, job.wait ?? 'ended');
    }
    if (job.repeatCount > 0) {
      await load();
      await collect(send, 'warmup', 0, cpu, 'ended');
      for (let index = 1; index <= job.repeatCount; index += 1) {
        await collect(send, 'repeat', index, cpu, 'ended');
      }
    }
    console.log(JSON.stringify({ event: 'done', mode: job.mode, round: job.round }));
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    app.exit(1);
  }
});

async function measureIdle(
  send: (command: Record<string, unknown>, timeoutMs: number) => Promise<PageMessage>,
): Promise<number | null> {
  const holding = await send({ type: 'hold-idle', dwellMs: job.dwellMs }, 20000);
  if (holding.type === 'error') return null;
  return idleCpu(job.idleCpuMs || IDLE_CPU_MS);
}

async function collect(
  send: (command: Record<string, unknown>, timeoutMs: number) => Promise<PageMessage>,
  play: BenchPlay | 'warmup',
  index: number,
  cpu: number | null,
  wait: 'frame' | 'ended',
): Promise<void> {
  const message = await send({ type: 'trial', play, index, dwellMs: job.dwellMs, wait }, 20000);
  if (message.type !== 'sample') throw new Error(message.message ?? `missing sample ${play} ${index}`);
  if (play === 'warmup') {
    appendFileSync(
      path.join(job.outDir, 'warmup.jsonl'),
      `${JSON.stringify({ ...message, evidenceBase64: undefined, memoryBytes: marks.get(message.id ?? -1) ?? memoryBytes() })}\n`,
    );
    console.log(JSON.stringify({ event: 'warmup', mode: job.mode, round: job.round, click: message.clickToFirstFrameMs }));
    return;
  }
  const evidencePath = writeStrip(play, index, message.evidenceBase64 ?? null);
  const sample: BenchSample = {
    mode: job.mode,
    round: job.round,
    index,
    play,
    clickToFirstFrameMs: numberOrNull(message.clickToFirstFrameMs),
    playResolvedMs: numberOrNull(message.playResolvedMs),
    blankMs: numberOrNull(message.blankMs),
    loadCount: typeof message.loadCount === 'number' ? message.loadCount : 0,
    memoryBytes: (message.id !== undefined ? marks.get(message.id) : undefined) ?? memoryBytes(),
    idleCpuPercent: cpu,
    assetSha256: job.assetSha256,
    evidencePath,
  };
  appendFileSync(path.join(job.outDir, 'samples.jsonl'), `${JSON.stringify(sample)}\n`);
  appendFileSync(
    path.join(job.outDir, 'frames.jsonl'),
    `${JSON.stringify({
      mode: job.mode,
      round: job.round,
      play,
      index,
      frames: message.frames ?? [],
      sidecar: message.sidecar ?? null,
      evidencePath,
    })}\n`,
  );
  console.log(
    JSON.stringify({
      event: 'sample',
      mode: job.mode,
      round: job.round,
      play,
      index,
      click: sample.clickToFirstFrameMs,
      playResolved: sample.playResolvedMs,
      blank: sample.blankMs,
      loads: sample.loadCount,
    }),
  );
}

function writeStrip(play: BenchPlay, index: number, base64: string | null): string | null {
  if (!base64) return null;
  const name = `${play}-${String(index).padStart(2, '0')}.png`;
  const file = path.join(job.outDir, 'strips', name);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  const relative = path.relative(job.runRoot, file);
  return relative.split(path.sep).join('/');
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

app.on('window-all-closed', () => {
  app.quit();
});
