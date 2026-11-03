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
import { fileURLToPath } from 'node:url';

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = path.join(PET_ROOT, 'runtime/qwen38');
const IDENTITY = path.join(RUNTIME_DIR, 'identity.json');
const BOOT_LOG = path.join(RUNTIME_DIR, 'boot.log');
const HEALTH_LOG = path.join(RUNTIME_DIR, 'health.log');
const VLLM_BIN = '/data/social-agent-lab/server/venv-vllm032/bin/vllm';
const WEIGHTS = '/data2/model_weights/Qwen3.8-27B';
const HOST = '127.0.0.1';
const PORT = 18872;
const MODEL_ID = 'qwen3.8-27b';
const READY_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

/** compute-apps：[{gpuIndex, pid, memMiB}]；空数组=四卡全无计算进程。 */
function gpuComputeApps() {
  const query = sh('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,used_memory', '--format=csv,noheader']);
  if (!query.ok) return [];
  return query.out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [uuid, pid, mem] = line.split(',').map((part) => part.trim());
      return { uuid, pid: Number(pid), memMiB: Number((mem ?? '0').replace(/[^\d]/g, '')) };
    });
}

function gpuIndexOf(uuid) {
  const map = sh('nvidia-smi', ['--query-gpu=index,uuid', '--format=csv,noheader']);
  for (const line of map.out.split('\n')) {
    const [index, gpuUuid] = line.split(',').map((part) => part.trim());
    if (gpuUuid === uuid) return Number(index);
  }
  return null;
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
  const apps = gpuComputeApps();
  const identity = readIdentity();
  const busy = apps.length > 0 ? `${apps.length} 个计算进程` : '无计算进程（四卡空闲）';
  const identityLine = identity
    ? `identity: pid=${identity.pid} gpu=${identity.gpu} alive=${String(identityAlive(identity))} startedAt=${identity.startedAt}`
    : 'identity: 无（未由本脚本启动）';
  console.log(`端口 ${PORT}：${portListening() ? '监听中' : '未监听'}`);
  console.log(`GPU compute-apps：${busy}`);
  if (apps.length > 0) {
    const byPid = new Map();
    for (const app of apps) {
      const gpu = gpuIndexOf(app.uuid);
      const cmd = sh('cat', [`/proc/${app.pid}/cmdline`]).out.replace(/\0/g, ' ').slice(0, 80);
      byPid.set(app.pid, `gpu${gpu ?? '?'} pid=${app.pid} mem=${app.memMiB}MiB ${cmd || '(已退出，陈旧条目)'}`);
    }
    for (const line of byPid.values()) console.log(`  ${line}`);
  }
  console.log(identityLine);
  void serviceReady().then((ready) => console.log(`健康 GET /v1/models 含 ${MODEL_ID}：${ready ? '是（服务可用）' : '否'}`));
}

/** 等待出现“整卡无任何计算进程”的 GPU，返回其 index。 */
function findFreeGpu() {
  const apps = gpuComputeApps();
  if (apps.length === 0) return 0;
  const busyUuids = new Set(apps.map((app) => app.uuid));
  const map = sh('nvidia-smi', ['--query-gpu=index,uuid', '--format=csv,noheader']);
  for (const line of map.out.split('\n')) {
    const [indexRaw, uuid] = line.split(',').map((part) => part.trim());
    if (!busyUuids.has(uuid)) return Number(indexRaw);
  }
  return null;
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
  let gpu = null;
  while (gpu === null) {
    gpu = findFreeGpu();
    if (gpu !== null) break;
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
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
  const child = spawn(VLLM_BIN, args, { env, detached: true, stdio: ['ignore', bootFd, bootFd] });
  child.unref();
  const stat = procStat(child.pid ?? -1);
  writeFileSync(IDENTITY, `${JSON.stringify({
    pid: child.pid,
    pgid: child.pid,
    bootId: bootId(),
    starttime: stat?.starttime ?? -1,
    gpu,
    startedAt: new Date().toISOString(),
    cmdline: `${VLLM_BIN} ${args.join(' ')}`,
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

const mode = process.argv[2] ?? '--status';
if (mode === '--status') statusReport();
else if (mode === '--wait-start') await waitAndStart();
else if (mode === '--stop') await stop();
else {
  console.error('用法：qwen-recover.mjs --status | --wait-start | --stop');
  process.exitCode = 1;
}
