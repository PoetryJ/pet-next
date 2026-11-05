/**
 * M3-7 B：launcher 配置读写（IO 与校验全部注入，core 层自包含）。
 *
 * 复用既有约定：
 * - 文件仍是 ~/.pet-next/qwen-remote.json（PET_NEXT_REMOTE_CONFIG 可覆盖完整路径，路径解析在 adapters 层）；
 * - 校验注入 LauncherConfigValidator（真实实现复用 resolveTunnelConfig，不另造一套规则）；
 * - 只保存连接字段与私钥路径；不保存私钥内容、口令、聊天。
 * 失败语义：坏 JSON / 读失败 → file-unreadable；字段非法 → config-invalid；
 * 保存前先校验，校验失败绝不触碰旧文件。
 * @module pet-next/core/launcher/config
 */
import type {
  LauncherConfig,
  LauncherConfigValidator,
  LauncherLoadResult,
  LauncherSaveResult,
} from './types.ts';

/** 配置文件 IO（真实实现见 adapters/launcher/node.ts；单测用内存实现）。 */
export interface LauncherConfigIo {
  readFile(file: string): Promise<string>;
  /** 同一目录内的原子写（临时文件 + rename）。 */
  writeFileAtomic(file: string, text: string): Promise<void>;
  /** 确保 file 的父目录存在（路径计算留在 adapters 层）。 */
  ensureParent(file: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 落盘形状：字段顺序与 chat-remote.example.json 一致，identityFile 缺省省略。 */
function toFileShape(config: LauncherConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    ...(config.identityFile ? { identityFile: config.identityFile } : {}),
    localPort: config.localPort,
    remoteHost: config.remoteHost,
    remotePort: config.remotePort,
  };
}

/** 读配置：文件不存在 → {ok:true, config:null}（首次启动）；存在但无效 → 明确错误。 */
export async function loadLauncherConfig(
  io: LauncherConfigIo,
  file: string,
  validate: LauncherConfigValidator,
): Promise<LauncherLoadResult> {
  let text: string;
  try {
    text = await io.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, config: null };
    return {
      ok: false,
      error: { code: 'file-unreadable', message: `读取配置失败（${file}）：${messageOf(error)}` },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'file-unreadable', message: `配置文件不是合法 JSON（${file}）：${messageOf(error)}` },
    };
  }
  return validate(raw);
}

/** 写配置：先校验（无效不覆盖旧文件），再原子写；目录不存在时创建。 */
export async function saveLauncherConfig(
  io: LauncherConfigIo,
  file: string,
  config: LauncherConfig,
  validate: LauncherConfigValidator,
): Promise<LauncherSaveResult> {
  const normalized = validate(config);
  if (!normalized.ok) return normalized;
  const text = `${JSON.stringify(toFileShape(normalized.config), null, 2)}\n`;
  try {
    await io.ensureParent(file);
    await io.writeFileAtomic(file, text);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'write-failed', message: `写入配置失败（${file}）：${messageOf(error)}` },
    };
  }
}
