/**
 * M3-7 首次启动体验：launcher 公共契约（IPC 通道 + 类型 re-export）。
 *
 * 边界（TASKS M3-7 冻结）：
 * - 配置 = ~/.pet-next/qwen-remote.json 现有连接字段 + 私钥路径；不保存私钥内容/口令/聊天。
 * - 探测只 GET /v1/models（零 POST）；成功/失败/取消都收本次隧道。
 * - 重复点击不得并发两套资源；stop 幂等。
 * - 类型单一来源在 core/launcher/types.ts（core 层自包含）；本文件只加 IPC 通道常量并 re-export，
 *   页面/主进程只认本文件。
 * @module pet-next/contracts/launcher
 */
export {
  LAUNCHER_CONFIG_FILENAME,
  LAUNCHER_CONFIG_PATH_ENV,
  LAUNCHER_MODE_ENV,
  LAUNCHER_PAGE_URL,
  type LauncherConfig,
  type LauncherConfigValidator,
  type LauncherController,
  type LauncherError,
  type LauncherErrorCode,
  type LauncherExperience,
  type LauncherLoadResult,
  type LauncherProbeResult,
  type LauncherSaveResult,
  type LauncherStartOptions,
  type LauncherStartResult,
  type LauncherTunnelErrorCode,
  type LauncherTunnelResolver,
  type LauncherTunnelSpec,
} from '../core/launcher/types.ts';

/** IPC 通道（main/preload 接线冻结；载荷形状 = 对应结果类型）。 */
export const LAUNCHER_LOAD_CHANNEL = 'launcher:load';
export const LAUNCHER_SAVE_CHANNEL = 'launcher:save';
export const LAUNCHER_PROBE_CHANNEL = 'launcher:probe';
export const LAUNCHER_START_CHANNEL = 'launcher:start';
