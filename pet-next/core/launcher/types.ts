/**
 * M3-7 launcher 内部类型（core 层自包含：不依赖 contracts/adapters/运行时）。
 *
 * 单一来源：contracts/launcher.ts 从这里 re-export 并补 IPC 通道常量，
 * 页面/主进程只认 contracts；core 内部只认这里，保持 tests/boundaries 的 core 边界。
 * @module pet-next/core/launcher/types
 */

/** 配置文件名（ ~/.pet-next/qwen-remote.json ，与 chat-remote.mjs 现有路径一致）。 */
export const LAUNCHER_CONFIG_FILENAME = 'qwen-remote.json';
/** 配置目录环境变量（与 chat-remote.mjs 的 PET_NEXT_REMOTE_CONFIG 同义：直接给完整文件路径）。 */
export const LAUNCHER_CONFIG_PATH_ENV = 'PET_NEXT_REMOTE_CONFIG';
/** launcher 窗口模式开关：launch-trial.mjs 设置，main.ts 检测。 */
export const LAUNCHER_MODE_ENV = 'PET_NEXT_LAUNCHER';
/** 启动页静态资源相对路径（dist/app 下）。 */
export const LAUNCHER_PAGE_URL = 'app/launcher.html';

/** 与 contracts/connection.ts 的 TunnelErrorCode 同值（core 不引用该文件，结构兼容即可）。 */
export type LauncherTunnelErrorCode =
  | 'ssh-missing'
  | 'auth-failed'
  | 'port-conflict'
  | 'not-ready'
  | 'disconnected'
  | 'config-invalid'
  | 'cancelled';

/** 用户可保存的连接字段（现有 qwen-remote.json 字段，不含超时等高级项）。 */
export interface LauncherConfig {
  host: string;
  port: number;
  user: string;
  identityFile?: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

/** 预览选项：用户显式选择，缺省值沿用现有 trial 入口（standard / context off）。 */
export type LauncherExperience = 'standard' | 'companion';

export interface LauncherStartOptions {
  experience: LauncherExperience;
  chatContext: boolean;
  /** 缺省 qwen3.8-27b（与 DEFAULT_REMOTE_MODEL 一致）。 */
  model?: string;
}

/** launcher 层错误码：隧道错误原样透传，另加配置/文件/并发错误。 */
export type LauncherErrorCode = LauncherTunnelErrorCode | 'file-unreadable' | 'write-failed' | 'busy' | 'service-unavailable';

export interface LauncherError {
  code: LauncherErrorCode;
  message: string;
}

export type LauncherLoadResult =
  | { ok: true; config: LauncherConfig | null } // null = 首次启动，尚无配置文件
  | { ok: false; error: LauncherError };

/** 校验失败（config-invalid）时不覆盖旧文件。 */
export type LauncherSaveResult = { ok: true } | { ok: false; error: LauncherError };

/** 探测：起隧道 → GET /v1/models（复用既有探测）→ 无论成败收隧道。 */
export type LauncherProbeResult =
  | { ok: true; model: string; models: string[] }
  | { ok: false; error: LauncherError };

/** 启动成功：main 用 baseUrl/model 创建 provider 与桌宠窗口；隧道由控制器持有到 stop()。 */
export type LauncherStartResult =
  | { ok: true; baseUrl: string; model: string; options: Required<LauncherStartOptions> }
  | { ok: false; error: LauncherError };

/** 隧道规格：与 contracts/connection.ts 的 TunnelConfig 结构兼容（由 adapters 层映射）。 */
export interface LauncherTunnelSpec {
  host: string;
  port: number;
  user: string;
  identityFile?: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  connectTimeoutSec: number;
  readyTimeoutMs: number;
}

/** 配置校验注入：真实实现复用 resolveTunnelConfig（adapters 层）。 */
export type LauncherConfigValidator = (
  raw: unknown,
) => { ok: true; config: LauncherConfig } | { ok: false; error: LauncherError };

/** 连接配置 → 隧道规格注入：真实实现复用 resolveTunnelConfig（adapters 层）。 */
export type LauncherTunnelResolver = (
  config: LauncherConfig,
) => { ok: true; spec: LauncherTunnelSpec } | { ok: false; error: LauncherError };

/**
 * 控制器（core/launcher 实现，IO 全部可注入）。
 * 并发约束：probe 与 start 共享一个"操作槽"——进行中时再次调用返回 busy，不排队。
 */
export interface LauncherController {
  loadConfig(): Promise<LauncherLoadResult>;
  saveConfig(config: LauncherConfig): Promise<LauncherSaveResult>;
  probe(config: LauncherConfig, model?: string): Promise<LauncherProbeResult>;
  start(config: LauncherConfig, options: LauncherStartOptions): Promise<LauncherStartResult>;
  /** 幂等收尾：停隧道并等待退出；未运行时也是 resolved。 */
  stop(): Promise<void>;
  /** 渲染层禁用按钮的依据：probe/start 是否进行中或已启动。 */
  state(): { phase: 'idle' | 'probing' | 'starting' | 'running' };
}
