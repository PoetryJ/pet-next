/**
 * M3-2 SSH 本地转发隧道：启动、就绪判定、失败分类与幂等关闭。
 * 原理：ssh -N -L 只转发端口，不执行远端命令；ExitOnForwardFailure 让转发失败立即退出，
 * ConnectTimeout 有界；就绪不能只看 spawn 成功，要等本地端口真的能连上模型服务。
 * 只管理本次 ssh 子进程：stop 幂等、只收本次 PID，无关进程/既有隧道不受影响。
 * @module pet-next/adapters/connection/tunnel
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import {
  TUNNEL_DEFAULT_CONNECT_TIMEOUT_SEC,
  TUNNEL_DEFAULT_LOCAL_PORT,
  TUNNEL_DEFAULT_READY_TIMEOUT_MS,
  TUNNEL_DEFAULT_REMOTE_HOST,
  TUNNEL_DEFAULT_REMOTE_PORT,
  TUNNEL_ENV_IDENTITY_FILE,
  TUNNEL_ENV_LOCAL_PORT,
  TUNNEL_ENV_REMOTE_HOST,
  TUNNEL_ENV_REMOTE_PORT,
  TUNNEL_ENV_SSH_HOST,
  TUNNEL_ENV_SSH_PORT,
  TUNNEL_ENV_SSH_USER,
  type TunnelConfig,
  type TunnelDeps,
  type TunnelErrorCode,
  type TunnelErrorInfo,
  type TunnelHandle,
  type TunnelStartResult,
} from '../../contracts/connection.ts';

export interface StartTunnelOptions extends TunnelDeps {
  /** ssh 可执行文件（Windows 可用绝对路径；默认 'ssh'）。 */
  sshBin?: string;
}

function fail(code: TunnelErrorCode, message: string): { ok: false; error: TunnelErrorInfo } {
  return { ok: false, error: { code, message } };
}

function parsePort(value: string | number | undefined, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** 解析/校验配置：fileConfig 优先于 env；缺失或非法给 config-invalid，不静默兜底。 */
export function resolveTunnelConfig(
  env: Record<string, string | undefined>,
  fileConfig: Partial<TunnelConfig> = {},
): { ok: true; config: TunnelConfig } | { ok: false; error: TunnelErrorInfo } {
  const host = fileConfig.host ?? env[TUNNEL_ENV_SSH_HOST];
  const user = fileConfig.user ?? env[TUNNEL_ENV_SSH_USER];
  const port = parsePort(fileConfig.port ?? env[TUNNEL_ENV_SSH_PORT], Number.NaN as unknown as number);
  if (!host || typeof host !== 'string' || host.trim() === '') {
    return fail('config-invalid', `缺少 SSH 主机：请设置 ${TUNNEL_ENV_SSH_HOST} 或本地配置 host`);
  }
  if (!user || typeof user !== 'string' || user.trim() === '') {
    return fail('config-invalid', `缺少 SSH 用户：请设置 ${TUNNEL_ENV_SSH_USER} 或本地配置 user`);
  }
  if (port === null || Number.isNaN(port)) {
    return fail('config-invalid', `SSH 端口无效：请设置 ${TUNNEL_ENV_SSH_PORT}（1-65535）`);
  }
  const localPort = parsePort(fileConfig.localPort ?? env[TUNNEL_ENV_LOCAL_PORT], TUNNEL_DEFAULT_LOCAL_PORT);
  if (localPort === null) {
    return fail('config-invalid', `本地转发端口无效：请设置 ${TUNNEL_ENV_LOCAL_PORT}（1-65535）`);
  }
  const remotePort = parsePort(
    fileConfig.remotePort ?? env[TUNNEL_ENV_REMOTE_PORT],
    TUNNEL_DEFAULT_REMOTE_PORT,
  );
  if (remotePort === null) {
    return fail('config-invalid', `服务器模型端口无效：请设置 ${TUNNEL_ENV_REMOTE_PORT}（1-65535）`);
  }
  if (localPort === remotePort) {
    return fail('config-invalid', '本地转发端口不能与服务器模型端口相同（避免误连本机服务）');
  }
  const remoteHost = fileConfig.remoteHost ?? env[TUNNEL_ENV_REMOTE_HOST] ?? TUNNEL_DEFAULT_REMOTE_HOST;
  if (typeof remoteHost !== 'string' || remoteHost.trim() === '') {
    return fail('config-invalid', '服务器侧目标主机为空');
  }
  const identityFile = fileConfig.identityFile ?? env[TUNNEL_ENV_IDENTITY_FILE];
  const connectTimeoutSec =
    fileConfig.connectTimeoutSec ?? TUNNEL_DEFAULT_CONNECT_TIMEOUT_SEC;
  const readyTimeoutMs = fileConfig.readyTimeoutMs ?? TUNNEL_DEFAULT_READY_TIMEOUT_MS;
  if (!Number.isInteger(connectTimeoutSec) || connectTimeoutSec <= 0) {
    return fail('config-invalid', 'connectTimeoutSec 必须是正整数秒');
  }
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
    return fail('config-invalid', 'readyTimeoutMs 必须是正整数毫秒');
  }
  return {
    ok: true,
    config: {
      host: host.trim(),
      port: port as number,
      user: user.trim(),
      ...(identityFile ? { identityFile } : {}),
      localPort,
      remoteHost,
      remotePort,
      connectTimeoutSec,
      readyTimeoutMs,
    },
  };
}

/** 端口是否已被占用（true = 被占）。 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** 构造 ssh 参数（数组执行，不拼 shell）。 */
export function sshArgs(config: TunnelConfig, sshBin: string): string[] {
  const args: string[] = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `ConnectTimeout=${config.connectTimeoutSec}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-L',
    `127.0.0.1:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
    '-p',
    String(config.port),
  ];
  if (config.identityFile) args.push('-i', config.identityFile);
  args.push(`${config.user}@${config.host}`);
  return [sshBin, ...args];
}

/** 探测本地转发是否就绪：GET http://127.0.0.1:<localPort>/models 有响应即算通（模型服务在监听）。 */
async function probeReady(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/models`, { signal: controller.signal });
      return response.ok || response.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

function classifyStderr(text: string): TunnelErrorCode | null {
  const lower = text.toLowerCase();
  if (
    lower.includes('permission denied') ||
    lower.includes('authentication failed') ||
    lower.includes('publickey')
  ) {
    return 'auth-failed';
  }
  if (lower.includes('address already in use') || lower.includes('bind: ')) {
    return 'port-conflict';
  }
  if (lower.includes('could not resolve hostname') || lower.includes('connection timed out') || lower.includes('connection refused')) {
    return 'not-ready';
  }
  return null;
}

/**
 * 启动隧道。返回句柄或明确错误分类；不重试、不吞错、只管理本次子进程。
 */
export async function startTunnel(
  config: TunnelConfig,
  deps: TunnelDeps & { sshBin?: string } = {},
): Promise<TunnelStartResult> {
  const spawnImpl = deps.spawn ?? (nodeSpawn as unknown as TunnelDeps['spawn']);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sshBin = deps.sshBin ?? 'ssh';

  if (await portInUse(config.localPort)) {
    return fail(
      'port-conflict',
      `本地端口 ${config.localPort} 已被占用：请关闭占用进程或设置 ^PET_NEXT_TUNNEL_LOCAL_PORT 换一个端口（不会抢占已有进程）`,
    );
  }

  const [bin, ...args] = sshArgs(config, sshBin);
  let child: ChildProcess;
  try {
    child = spawnImpl([bin, ...args]) as ChildProcess;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fail('ssh-missing', '找不到 ssh 可执行文件：Windows 请安装 OpenSSH 客户端，或用 PET_NEXT_SSH_BIN 指定路径');
    }
    return fail('not-ready', `ssh 启动失败：${(error as Error).message}`);
  }
  let stderr = '';
  let alive = true;
  let stopped = false;
  let spawnErrorCode: string | undefined;

  const finished = new Promise<void>((resolve) => {
    child.once('exit', () => {
      alive = false;
      resolve();
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error?.code;
      alive = false;
      resolve();
    });
  });

  child.stderr?.on?.('data', (chunk: Buffer | string) => {
    stderr += String(chunk);
  });
  child.stdout?.on?.('data', () => undefined);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (!alive) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    const deadline = now() + 3000;
    while (alive && now() < deadline) await sleep(50);
    if (alive) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  };

  const deadline = now() + config.readyTimeoutMs;
  while (now() < deadline) {
    if (!alive) break;
    if (await probeReady(config.localPort, fetchImpl)) {
      return {
        ok: true,
        handle: {
          localBaseUrl: `http://127.0.0.1:${config.localPort}`,
          stop,
          isAlive: () => alive,
        },
      };
    }
    await sleep(200);
  }

  await stop();
  await finished;

  if (spawnErrorCode === 'ENOENT') {
    return fail('ssh-missing', '找不到 ssh 可执行文件：Windows 请安装 OpenSSH 客户端，或用 PET_NEXT_SSH_BIN 指定路径');
  }
  const kind = classifyStderr(stderr);
  if (kind === 'auth-failed') {
    return fail('auth-failed', 'SSH 认证失败：请确认密钥已加载（ssh-agent）或 -i 私钥路径正确，服务器已授权该公钥');
  }
  if (kind === 'port-conflict') {
    return fail('port-conflict', 'ssh 报告本地端口转发失败（端口被占用），请更换 PET_NEXT_TUNNEL_LOCAL_PORT');
  }
  return fail(
    'not-ready',
    `隧道未在 ${config.readyTimeoutMs}ms 内就绪：请检查网络可达性、SSH 端口与服务器模型服务是否在监听`,
  );
}
