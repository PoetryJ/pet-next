/**
 * M3-7 首次启动体验：launcher（配置/测试连接/启动）冻结接口。
 *
 * 边界（TASKS M3-7 冻结）：
 * - 配置 = ~/.pet-next/qwen-remote.json 现有连接字段 + 私钥路径；不保存私钥内容/口令/聊天。
 * - 探测只 GET /v1/models（零 POST）；成功/失败/取消都收本次隧道。
 * - 重复点击不得并发两套资源；stop 幂等。
 * - B 实现 core/launcher 控制器与 adapters/launcher；C 只消费本契约形状；
 *   IPC/preload 接线与通道名以本文件为准，由集成负责人独占维护。
 * @module pet-next/contracts/launcher
 */
import type { TunnelErrorCode } from './connection.ts';

/** 配置文件名（ ~/.pet-next/qwen-remote.json ，与 chat-remote.mjs 现有路径一致）。 */
export const LAUNCHER_CONFIG_FILENAME = 'qwen-remote.json';
/** 配置目录环境变量（与 chat-remote.mjs 的 PET_NEXT_REMOTE_CONFIG 同义：直接给完整文件路径）。 */
export const LAUNCHER_CONFIG_PATH_ENV = 'PET_NEXT_REMOTE_CONFIG';
/** launcher 窗口模式开关：launch-trial.mjs 设置，main.ts 检测。 */
export const LAUNCHER_MODE_ENV = 'PET_NEXT_LAUNCHER';
/** 渲染层（launcher 页面）从 preload 拿到的启动模式回执查询参数。 */
export const LAUNCHER_PAGE_URL = 'app/launcher.html';

/** IPC 通道（main/preload 接线冻结；载荷形状 = 本文件对应结果类型）。 */
export const LAUNCHER_LOAD_CHANNEL = 'launcher:load';
export const LAUNCHER_SAVE_CHANNEL = 'launcher:save';
export const LAUNCHER_PROBE_CHANNEL = 'launcher:probe';
export const LAUNCHER_START_CHANNEL = 'launcher:start';

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
export type LauncherErrorCode = TunnelErrorCode | 'config-invalid' | 'file-unreadable' | 'write-failed' | 'busy' | 'service-unavailable';

export interface LauncherError {
  code: LauncherErrorCode;
  message: string;
}

export type LauncherLoadResult =
  | { ok: true; config: LauncherConfig | null } // null = 首次启动，尚无配置文件
  | { ok: false; error: LauncherError };

/** 校验失败（config-invalid）时不覆盖旧文件。 */
export type LauncherSaveResult = { ok: true } | { ok: false; error: LauncherError };

/** 探测：起隧道 → GET /v1/models（复用 probeLocalService）→ 无论成败收隧道。 */
export type LauncherProbeResult =
  | { ok: true; model: string; models: string[] }
  | { ok: false; error: LauncherError };

/** 启动成功：main 用 baseUrl/model 创建 provider 与桌宠窗口；隧道由控制器持有到 stop()。 */
export type LauncherStartResult =
  | { ok: true; baseUrl: string; model: string; options: Required<LauncherStartOptions> }
  | { ok: false; error: LauncherError };

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
