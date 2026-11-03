/**
 * M3-2 冻结契约：SSH 本地转发隧道（Windows 本机 -> 现有服务器 Qwen）。
 * 原理：Windows 的 127.0.0.1 是 Windows 自己，必须用 SSH 本地转发把服务器 127.0.0.1:18872
 * 映到本机 127.0.0.1:18873；只管理本次进程，不开放公网端口，不保存密码。
 * 由集成负责人冻结；改动需全员同步。
 * @module pet-next/contracts/connection
 */

/** 默认本地转发端口（与服务器模型端口错开，避免误连本机已有服务）。 */
export const TUNNEL_DEFAULT_LOCAL_PORT = 18873;
/** 服务器侧目标（模型服务默认只监听其本机回环）。 */
export const TUNNEL_DEFAULT_REMOTE_HOST = '127.0.0.1';
export const TUNNEL_DEFAULT_REMOTE_PORT = 18872;
/** 有界 SSH 连接超时（秒）与就绪等待总超时（毫秒）。 */
export const TUNNEL_DEFAULT_CONNECT_TIMEOUT_SEC = 8;
export const TUNNEL_DEFAULT_READY_TIMEOUT_MS = 20_000;

/** 配置环境变量（连接信息只经环境/本地配置提供，仓库只放占位符示例）。 */
export const TUNNEL_ENV_SSH_HOST = 'PET_NEXT_SSH_HOST';
export const TUNNEL_ENV_SSH_PORT = 'PET_NEXT_SSH_PORT';
export const TUNNEL_ENV_SSH_USER = 'PET_NEXT_SSH_USER';
export const TUNNEL_ENV_IDENTITY_FILE = 'PET_NEXT_SSH_IDENTITY_FILE';
export const TUNNEL_ENV_LOCAL_PORT = 'PET_NEXT_TUNNEL_LOCAL_PORT';
export const TUNNEL_ENV_REMOTE_HOST = 'PET_NEXT_REMOTE_HOST';
export const TUNNEL_ENV_REMOTE_PORT = 'PET_NEXT_REMOTE_PORT';

/** 隧道配置。 */
export interface TunnelConfig {
  /** SSH 目标主机（不含 user）。 */
  host: string;
  /** SSH 端口。 */
  port: number;
  /** SSH 用户。 */
  user: string;
  /** 可选私钥路径；缺省使用 ssh-agent / 默认密钥，绝不保存密码。 */
  identityFile?: string;
  /** 本地转发端口（Windows 本机 127.0.0.1）。 */
  localPort: number;
  /** 服务器侧目标主机与端口。 */
  remoteHost: string;
  remotePort: number;
  /** ssh ConnectTimeout（秒），有界。 */
  connectTimeoutSec: number;
  /** 就绪等待总超时（毫秒）。 */
  readyTimeoutMs: number;
}

/** 明确的失败分类；页面/CLI 可据此给中文可行动提示。 */
export type TunnelErrorCode =
  | 'ssh-missing'
  | 'auth-failed'
  | 'port-conflict'
  | 'not-ready'
  | 'disconnected'
  | 'config-invalid'
  | 'cancelled';

export interface TunnelErrorInfo {
  code: TunnelErrorCode;
  message: string;
}

/** 启动结果：成功给句柄；失败给明确分类，不静默重试。 */
export type TunnelStartResult = { ok: true; handle: TunnelHandle } | { ok: false; error: TunnelErrorInfo };

/** 隧道句柄：只收本次 ssh 正 PID；stop 幂等。 */
export interface TunnelHandle {
  /** 本地转发基址：http://127.0.0.1:<localPort>。 */
  readonly localBaseUrl: string;
  /** 幂等停止；无关进程与既有隧道必须存活。 */
  stop(): Promise<void>;
  /** 本次 ssh 是否仍存活。 */
  isAlive(): boolean;
}

/** 可注入依赖：便于单测，不真实建隧道。 */
export interface TunnelDeps {
  spawn?(args: readonly string[], options?: { env?: Record<string, string | undefined> }): unknown;
  fetchImpl?: typeof fetch;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** 取消信号：启动/就绪等待期间 abort 会关闭本次 ssh 并返回 cancelled（绝不收无关进程）。 */
  signal?: AbortSignal;
  /** 可执行文件前置参数（如用 node 执行 .mjs 替身）；默认为空。 */
  argsPrefix?: readonly string[];
}

/** 启动隧道：spawn ssh -N -L ...，启用 ExitOnForwardFailure 与有界 ConnectTimeout；就绪以本地端口可探测为准。 */
export type StartTunnel = (config: TunnelConfig, deps?: TunnelDeps) => Promise<TunnelStartResult>;

/** 解析/校验配置（env + 可选本地配置文件）。缺失或非法给 config-invalid，不静默兜底。 */
export type ResolveTunnelConfig = (
  env: Record<string, string | undefined>,
  fileConfig?: Partial<TunnelConfig>,
) =>
  | { ok: true; config: TunnelConfig }
  | { ok: false; error: TunnelErrorInfo };
