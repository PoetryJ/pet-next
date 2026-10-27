/**
 * 设置页与宿主的 HTTP 契约：读配置、读元信息、读候选模型、写配置（PUT）与同步（POST）。
 * 每个函数都是「总函数」——失败不抛给调用方，而是返回约定好的空值或判别联合，调用方只管分支与文案。
 * 写配置强制显式 `force` 布尔：严格 `=== true` 才拼 `?force=1`，绝不能让事件对象冒充真值绕过损坏预检。
 * @module dsh-pet/src/client/settings/config-io
 */
import { ROUTE_PATH } from '../../../shared/constants.ts';
import type { FontConfig, ModelSelection, Pet, PhysicsParams } from '../../../shared/types.ts';
import type { ModelCatalogGroup } from '../picker/index.ts';
import type { MergedConfig } from './config-read.ts';

/** 配置文件路径与存储位置清单；宿主按平台推导，反推不出 `profile` 时为空串。 */
export interface ConfigMeta {
  user: string;
  default: string;
  animations: string;
  /** 用户表情包目录（加图不必改包）。 */
  memes?: string;
  /** 统一日志文件；桌面版没控制台，排障只看它。 */
  logs?: string;
  /** 插件落盘的全部位置（路径与是否已存在）。 */
  storage?: Array<{ key: string; path: string; exists?: boolean }>;
  /** 当前 profile 名（拼卸载命令用）。 */
  profile?: string;
}

/** 保存要提交的全部字段；键名即宿主 `PUT /config` 的字段名。 */
export interface SaveFields {
  pets: readonly Pet[];
  notificationsEnabled: boolean;
  clickSoundEnabled: boolean;
  whisperImageEnabled: boolean;
  chatImageEnabled: boolean;
  confineToScreen: boolean;
  trayEnabled: boolean;
  physics: PhysicsParams;
  whisperModel: ModelSelection;
  chatModel: ModelSelection;
  chatMemoryRounds: number;
  chatImageLimit: number;
  font: FontConfig;
}

/** 保存结果：调用方按 `kind` 分支，不再猜 HTTP 细节。 */
export type SaveOutcome =
  | { kind: 'ok'; merged: MergedConfig }
  | { kind: 'corrupt'; userFile: string | null }
  | { kind: 'invalid' }
  | { kind: 'error' };

/**
 * 把表单状态压成请求体。
 *
 * @param fields - 表单当前值。
 * @returns 直接可 `JSON.stringify` 的对象；字段名必须与宿主校验的键一一对应。
 */
export function buildSaveBody(fields: SaveFields): Record<string, unknown> {
  return {
    pets: fields.pets,
    notificationsEnabled: fields.notificationsEnabled,
    clickSoundEnabled: fields.clickSoundEnabled,
    whisperImageEnabled: fields.whisperImageEnabled,
    chatImageEnabled: fields.chatImageEnabled,
    confineToScreen: fields.confineToScreen,
    trayEnabled: fields.trayEnabled,
    physics: fields.physics,
    whisperModel: fields.whisperModel,
    chatModel: fields.chatModel,
    chatMemoryRounds: fields.chatMemoryRounds,
    chatImageLimit: fields.chatImageLimit,
    font: fields.font,
  };
}

/**
 * 读成品配置。
 *
 * @param signal - 卸载或重试时中断请求。
 * @returns 成品聚合；非 2xx、网络错误或被中断时返回 `null`。
 */
export async function loadConfig(signal?: AbortSignal): Promise<MergedConfig | null> {
  try {
    const response = await fetch(ROUTE_PATH + '/config', signal === undefined ? {} : { signal });
    if (!response.ok) return null;
    return (await response.json()) as MergedConfig;
  } catch {
    return null;
  }
}

/**
 * 读配置文件的路径与存储清单。
 *
 * @returns 元信息；读不到时返回 `null`，调用方据此隐藏「高级配置」与「卸载与存储」两张卡。
 */
export async function loadMeta(): Promise<ConfigMeta | null> {
  try {
    const response = await fetch(ROUTE_PATH + '/config/meta');
    if (!response.ok) return null;
    return (await response.json()) as ConfigMeta;
  } catch {
    return null;
  }
}

/**
 * 读候选模型清单。
 *
 * @returns 服务商分组；响应缺 `providers` 或请求失败时返回 `null`（选择器显示「拉取失败」）。
 */
export async function loadModelCatalog(): Promise<ModelCatalogGroup[] | null> {
  try {
    const response = await fetch(ROUTE_PATH + '/models');
    if (!response.ok) return null;
    const body = (await response.json()) as { providers?: unknown };
    if (!body || !Array.isArray(body.providers)) return null;
    return body.providers as ModelCatalogGroup[];
  } catch {
    return null;
  }
}

/**
 * 全量写用户层配置。
 *
 * @param body - {@link buildSaveBody} 的输出。
 * @param force - 严格 `true` 才允许按白名单重建损坏文件（用户在损坏弹窗里确认过）。
 * @returns 保存结果；409 带出宿主给出的真实写入路径，供弹窗显示。
 */
export async function saveConfig(body: Record<string, unknown>, force: boolean): Promise<SaveOutcome> {
  try {
    const response = await fetch(ROUTE_PATH + '/config' + (force === true ? '?force=1' : ''), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 409 = 宿主损坏预检拦下：白名单重建会把文件里剩下的内容整份丢掉，必须让用户决定。
    if (response.status === 409) {
      const info = (await response.json().catch(() => null)) as { userFile?: unknown } | null;
      return { kind: 'corrupt', userFile: typeof info?.userFile === 'string' ? info.userFile : null };
    }
    if (response.status === 400) return { kind: 'invalid' };
    if (!response.ok) return { kind: 'error' };
    return { kind: 'ok', merged: (await response.json()) as MergedConfig };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * 把内置默认配置整份写入用户层（设置页的「同步」）。
 *
 * @returns 写入后的成品聚合；失败返回 `null`。
 */
export async function syncConfig(): Promise<MergedConfig | null> {
  try {
    const response = await fetch(ROUTE_PATH + '/config', { method: 'POST' });
    if (!response.ok) return null;
    return (await response.json()) as MergedConfig;
  } catch {
    return null;
  }
}
