#!/usr/bin/env node
/**
 * M3-4 B：原 Qwen 服务恢复/停止/状态（只管理本次进程，绝不碰共享环境与他人进程）。
 *
 * 用法：
 *   node scripts/qwen-recover.mjs --status        # 只读预检（GPU/端口/PID 身份）
 *   node scripts/qwen-recover.mjs --wait-start    # 每 60s 轮询，出现“无任何计算进程”的 H20 即启动；
 *                                                 # 有界等待 /v1/models 含 qwen3.8-27b（最长 20 分钟）；
 *                                                 # 绝不热身（健康探测只 GET /models，零 POST）
 *   node scripts/qwen-recover.mjs --stop          # 按 runtime/qwen38/identity.json 三重校验
 *                                                 # （PID 存活 + cmdline 匹配 + starttime 匹配）才停
 *
 * 身份记录（pet-next 自己的 runtime 目录，不覆盖 social-agent-lab 的任何文件）：
 *   runtime/qwen38/identity.json  { pid, pgid, bootId, starttime, cmdline, gpu, startedAt, cmdlineFull }
 *   runtime/qwen38/boot.log       vllm 全部输出
 *   runtime/qwen38/health.log     每次健康探测结果（GET，非 POST）
 *
 * 环境事实（2026-11-03 实查，来自验收单）：
 *   权重 /data2/model_weights/Qwen3.8-27B（18 分片 ~52GiB）；
 *   vLLM /data/social-agent-lab/server/venv-vllm032/bin/vllm（0.32.0，registry 含该架构）；
 *   端口 18872、max-model-len 8192（pet-next 约定，勿用原脚本的 18871/16384）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 测试注入点：假 nvidia-smi / 假 vllm / 隔离 runtime 目录（生产默认不变）。
const RUNTIME_DIR = process.env.PET_NEXT_QWEN_RUNTIME_DIR ?? path.join(PET_ROOT, 'runtime/qwen38');
const IDENTITY = path.join(RUNTIME_DIR, 'identity.json');
const BOOT_LOG = path.join(RUNTIME_DIR, 'boot.log');
const HEALTH_LOG = path.join(RUNTIME_DIR, 'health.log');
const VLLM_BIN = process.env.PET_NEXT_QWEN_VLLM_BIN ?? '/data/social-agent-lab/server/venv-vllm032/bin/vllm';
const WEIGHTS = '/data2/model_weights/Qwen3.8-27B';
const HOST = '127.0.0.1';
const PORT = 18872;
const MODEL_ID = 'qwen3.8-27b';
const READY_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
  return { ok: result.status === 0 && !result.error, out: (result.stdout ?? '').trim() };
}

/**
 * 注入的 JS 夹具用显式 Node 解释器（Windows 不能直接执行 shebang 脚本）；
 * 生产命令（nvidia-smi / vllm）路径不以 .js/.cjs/.mjs 结尾，原样执行，不改变真实启动链。
 */
function launchSpec(bin, args) {
  if (/\.(?:c|m)?js$/i.test(bin)) return { command: process.execPath, args: [bin, ...args] };
  return { command: bin, args };
}

/** 执行注入的 GPU 查询命令（JS 夹具经 Node，生产命令原样）。 */
function shBin(bin, args) {
  const spec = launchSpec(bin, args);
  return sh(spec.command, spec.args);
}

/**
 * M3-5 A：GPU 查询 fail-closed。
 * 所有 nvidia-smi 查询失败/超时/解析失败/无有效 GPU 条目 → 状态 unknown，
 * 绝不回落到"空列表=全空闲"（旧缺陷：查询失败误选 GPU0 启动）。
 * 命令可注入：PET_NEXT_QWEN_SMI_BIN（测试用假 nvidia-smi，零真实 GPU/GPU0 误启）。
 */
const SMI_BIN = process.env.PET_NEXT_QWEN_SMI_BIN ?? 'nvidia-smi';

/** 纯解析（可单测）：compute-apps CSV → {ok:true,apps} | {ok:false,reason}。 */
export function parseComputeApps(text) {
  const apps = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 3 || !/^\d+$/.test(parts[1] ?? '') || parts[0] === '') {
      return { ok: false, reason: `compute-apps 行无法解析：${JSON.stringify(line)}` };
    }
    apps.push({ uuid: parts[0], pid: Number(parts[1]), memMiB: Number((parts[2] ?? '0').replace(/[^\d]/g, '')) });
  }
  return { ok: true, apps };
}

/** 纯解析（可单测）：index,uuid CSV → {ok:true,gpus} | {ok:false,reason}；0 条目视为无有效 GPU。 */
export function parseGpuList(text) {
  const gpus = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 2 || !/^\d+$/.test(parts[0] ?? '') || parts[1] === '') {
      return { ok: false, reason: `gpu 列表行无法解析：${JSON.stringify(line)}` };
    }
    gpus.push({ index: Number(parts[0]), uuid: parts[1] });
  }
  if (gpus.length === 0) return { ok: false, reason: 'gpu 列表为空——无有效 GPU 条目，拒绝判定（fail-closed）' };
  return { ok: true, gpus };
}

function gpuSnapshot() {
  const appsQuery = shBin(SMI_BIN, ['--query-compute-apps=gpu_uuid,pid,used_memory', '--format=csv,noheader']);
  if (!appsQuery.ok) return { ok: false, reason: 'compute-apps 查询失败（nvidia-smi 非零/超时/不可执行）' };
  const apps = parseComputeApps(appsQuery.out);
  if (!apps.ok) return apps;
  const listQuery = shBin(SMI_BIN, ['--query-gpu=index,uuid', '--format=csv,noheader']);
  if (!listQuery.ok) return { ok: false, reason: 'gpu 列表查询失败（nvidia-smi 非零/超时/不可执行）' };
  const list = parseGpuList(listQuery.out);
  if (!list.ok) return list;
  return { ok: true, apps: apps.apps, gpus: list.gpus };
}

/**
 * 纯判定（可单测）：两份**有效**快照都证明同一批卡无其他 compute 进程才可判空闲。
 * 任一无效 → {ok:false}（unknown，拒启动）；全忙 → {ok:true,gpu:null}（继续等）。
 * busy 集合取两份快照之并（保守：任一时刻见过进程即算忙）。
 */
export function selectFreeGpuFromSnapshots(first, second) {
  if (!first.ok) return { ok: false, reason: `第一次查询无效：${first.reason}` };
  if (!second.ok) return { ok: false, reason: `第二次查询无效：${second.reason}` };
  const key = (snapshot) => snapshot.gpus.map((gpu) => `${gpu.index}:${gpu.uuid}`).sort().join('|');
  if (key(first) !== key(second)) {
    return { ok: false, reason: '两次 GPU 查询结果矛盾（列表不一致）——状态 unknown，拒绝启动' };
  }
  const busy = new Set([...first.apps, ...second.apps].map((app) => app.uuid));
  for (const gpu of first.gpus.sort((a, b) => a.index - b.index)) {
    if (!busy.has(gpu.uuid)) return { ok: true, gpu: gpu.index };
  }
  return { ok: true, gpu: null };
}

async function findFreeGpu() {
  const first = gpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 2000)); // 两次独立查询
  const second = gpuSnapshot();
  return selectFreeGpuFromSnapshots(first, second);
}

function portListening() {
  const result = sh('ss', ['-tlnp', `sport = :${PORT}`]);
  return result.out.includes(String(PORT));
}

/** GET /v1/models（只读探测，非 POST，不产生推理）。 */
function fetchModels(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port: PORT, path: '/v1/models', timeout: timeoutMs }, (response) => {
      let raw = '';
      response.on('data', (chunk) => (raw += String(chunk)));
      response.on('end', () => {
        try {
          resolve({ ok: response.statusCode === 200, status: response.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ ok: false, status: response.statusCode, body: null });
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: 'timeout', body: null });
    });
    request.on('error', () => resolve({ ok: false, status: 'unreachable', body: null }));
  });
}

async function serviceReady() {
  const result = await fetchModels();
  if (!result.ok || !result.body) return false;
  const ids = (result.body.data ?? []).map((item) => item.id ?? '');
  return ids.includes(MODEL_ID);
}

function readIdentity() {
  if (!existsSync(IDENTITY)) return null;
  try {
    return JSON.parse(readFileSync(IDENTITY, 'utf8'));
  } catch {
    return null;
  }
}

function procStat(pid) {
  const stat = sh('cat', [`/proc/${pid}/stat`]);
  if (!stat.ok) return null;
  const tail = stat.out.slice(stat.out.lastIndexOf(')') + 2).split(' ');
  return { starttime: Number(tail[19]) };
}

function bootId() {
  return sh('cat', ['/proc/sys/kernel/random/boot_id']).out;
}

function identityAlive(identity) {
  if (identity === null) return false;
  if (identity.bootId !== bootId()) return false;
  const stat = procStat(identity.pid);
  if (stat === null || stat.starttime !== identity.starttime) return false;
  const cmdline = sh('cat', [`/proc/${identity.pid}/cmdline`]).out.replace(/\0/g, ' ').trim();
  return cmdline.includes('vllm') && cmdline.includes(WEIGHTS);
}

function logHealth(line) {
  appendFileSync(HEALTH_LOG, `${new Date().toISOString()} ${line}\n`);
}

function statusReport() {
  const snapshot = gpuSnapshot();
  const identity = readIdentity();
  if (!snapshot.ok) {
    console.log(`GPU compute-apps：查询失败——状态 unknown（fail-closed：${snapshot.reason}）`);
    process.exitCode = 1;
  } else {
    const busy = snapshot.apps.length > 0 ? `${snapshot.apps.length} 个计算进程` : '无计算进程（四卡空闲）';
    console.log(`GPU compute-apps：${busy}`);
    if (snapshot.apps.length > 0) {
      const byIndex = new Map(snapshot.gpus.map((gpu) => [gpu.uuid, gpu.index]));
      const byPid = new Map();
      for (const app of snapshot.apps) {
        const gpu = byIndex.get(app.uuid);
        const cmd = sh('cat', [`/proc/${app.pid}/cmdline`]).out.replace(/\0/g, ' ').slice(0, 80);
        byPid.set(app.pid, `gpu${gpu ?? '?'} pid=${app.pid} mem=${app.memMiB}MiB ${cmd || '(已退出，陈旧条目)'}`);
      }
      for (const line of byPid.values()) console.log(`  ${line}`);
    }
  }
  const identityLine = identity
    ? `identity: pid=${identity.pid} gpu=${identity.gpu} alive=${String(identityAlive(identity))} startedAt=${identity.startedAt}`
    : 'identity: 无（未由本脚本启动）';
  console.log(`端口 ${PORT}：${portListening() ? '监听中' : '未监听'}`);
  console.log(identityLine);
  void serviceReady().then((ready) => console.log(`健康 GET /v1/models 含 ${MODEL_ID}：${ready ? '是（服务可用）' : '否'}`));
}

async function waitAndStart() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  if (portListening() && (await serviceReady())) {
    console.log(`[qwen-recover] ${PORT} 已有就绪服务（含 ${MODEL_ID}）——不重复启动。`);
    logHealth('already-ready（外部或前次启动，未重复起服务）');
    return;
  }
  if (readIdentity() !== null && identityAlive(readIdentity())) {
    console.log('[qwen-recover] 本脚本前次启动的进程仍在——不重复启动。');
    return;
  }
  console.log('[qwen-recover] ready_waiting_gpu：每 60s 检查，等一张无其他计算进程的 H20（不抢占）。');
  const waitForFreeGpu = async () => {
    for (;;) {
      const probe = await findFreeGpu();
      if (!probe.ok) {
        console.error(`[qwen-recover] GPU 查询失败——状态 unknown，拒绝启动（fail-closed）：${probe.reason}`);
        process.exit(1); // 绝不在 unknown 时选卡启动（含不误选 GPU0）
      }
      if (probe.gpu !== null) return probe.gpu;
      process.stdout.write('.');
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };
  const gpu = await waitForFreeGpu();
  console.log(`\n[qwen-recover] GPU ${gpu} 空闲，启动 vLLM（端口 ${PORT}，仅本机）。`);
  const args = [
    'serve', WEIGHTS,
    '--served-model-name', MODEL_ID,
    '--host', HOST, '--port', String(PORT),
    '--tensor-parallel-size', '1',
    '--max-model-len', '8192',
    '--gpu-memory-utilization', '0.75',
    '--max-num-seqs', '8',
    '--reasoning-parser', 'qwen3',
  ];
  const env = {
    ...process.env,
    CUDA_VISIBLE_DEVICES: String(gpu),
    VLLM_USE_FLASHINFER_SAMPLER: '0',
  };
  const bootFd = openSync(BOOT_LOG, 'a');
  const launch = launchSpec(VLLM_BIN, args);
  const child = spawn(launch.command, launch.args, { env, detached: true, stdio: ['ignore', bootFd, bootFd] });
  child.unref();
  const stat = procStat(child.pid ?? -1);
  writeFileSync(IDENTITY, `${JSON.stringify({
    pid: child.pid,
    pgid: child.pid,
    bootId: bootId(),
    starttime: stat?.starttime ?? -1,
    gpu,
    startedAt: new Date().toISOString(),
    cmdline: `${launch.command} ${launch.args.join(' ')}`,
    env: { CUDA_VISIBLE_DEVICES: String(gpu), VLLM_USE_FLASHINFER_SAMPLER: '0' },
  }, null, 2)}\n`);
  console.log(`[qwen-recover] 已启动 pid=${child.pid} gpu=${gpu}；日志：${BOOT_LOG}`);
  console.log('[qwen-recover] 有界等待就绪（最长 20 分钟，GET /models，零 POST 不热身）…');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
    if (!(await Promise.resolve(identityAlive(readIdentity())))) {
      console.error('[qwen-recover] 启动进程提前退出——见 boot 日志。');
      process.exitCode = 1;
      return;
    }
    if (await serviceReady()) {
      logHealth('ready（GET /v1/models 含目标 id；未发任何 POST）');
      console.log(`[qwen-recover] ready：GET /v1/models 含 ${MODEL_ID}。`);
      return;
    }
    process.stdout.write('.');
  }
  logHealth('ready-timeout（20 分钟未就绪）');
  console.error('[qwen-recover] 20 分钟未就绪——保留日志与进程，人工检查（不自动重试）。');
  process.exitCode = 1;
}

async function stop() {
  const identity = readIdentity();
  if (identity === null) {
    console.log('[qwen-recover] 无 identity——没有本脚本管理的服务可停（不动任何其他进程）。');
    return;
  }
  if (!identityAlive(identity)) {
    console.log('[qwen-recover] identity 不匹配（进程已不存在或非本脚本启动）——只清 identity 文件，不杀任何进程。');
    return;
  }
  console.log(`[qwen-recover] 三重校验通过，停止 pid=${identity.pid}（进程组 -${identity.pgid}）。`);
  try {
    process.kill(-identity.pgid, 'SIGTERM');
  } catch {
    process.kill(identity.pid, 'SIGTERM');
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && procStat(identity.pid) !== null) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (procStat(identity.pid) !== null) {
    console.log('[qwen-recover] 60s 未退，SIGKILL 兜底。');
    try {
      process.kill(-identity.pgid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  console.log('[qwen-recover] 已停止，GPU 释放。');
}

/** CLI 壳：仅直接执行时生效（测试 import 本模块不触发任何模式）。 */
async function main() {
  const mode = process.argv[2] ?? '--status';
  if (mode === '--status') statusReport();
  else if (mode === '--wait-start') await waitAndStart();
  else if (mode === '--stop') await stop();
  else {
    console.error('用法：qwen-recover.mjs --status | --wait-start | --stop');
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
