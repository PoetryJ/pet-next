/**
 * 设置页的写路径：把表单整包存进用户层，或把内置默认整份同步过去。
 * 写完必须立刻把成品交给容器（`petBridge.reload`）并让通知引擎重读——两条都是「保存即生效」的实现前提。
 * 结果归一成判别联合，弹窗与红字由设置页决定，这里不碰 DOM 也不碰状态。
 * @module dsh-pet/src/client/settings/persist
 */
import { reloadNotifications } from '../../notify.ts';
import { petBridge } from '../bridge.ts';
import { buildSaveBody, saveConfig, syncConfig, type SaveFields } from './config-io.ts';
import type { MergedConfig } from './config-read.ts';

/** 保存结果；`corrupt` 带出要显示在弹窗里的真实写入路径。 */
export type SaveResult = { kind: 'ok' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'corrupt'; path: string };

/**
 * 保存表单。
 *
 * @param fields - 要提交的全部字段。
 * @param force - 用户在损坏弹窗里确认过才为 `true`。
 * @param fallbackUserFile - 宿主没回写入路径时的兜底（meta 里读到的用户配置路径）。
 * @returns 保存结果；成功时已完成容器重载与通知重读。
 */
export async function persistSettings(
  fields: SaveFields,
  force: boolean,
  fallbackUserFile: string,
): Promise<SaveResult> {
  const outcome = await saveConfig(buildSaveBody(fields), force);
  if (outcome.kind === 'corrupt') return { kind: 'corrupt', path: outcome.userFile ?? fallbackUserFile };
  if (outcome.kind !== 'ok') return { kind: outcome.kind };
  petBridge.reload(outcome.merged);
  void reloadNotifications(); // 保存后即时生效，无需刷新。
  return { kind: 'ok' };
}

/**
 * 把内置默认配置整份同步到用户层。
 *
 * @returns 写入后的成品聚合（调用方还要用它刷新表单）；失败返回 `null`。
 */
export async function syncSettings(): Promise<MergedConfig | null> {
  const merged = await syncConfig();
  if (merged === null) return null;
  petBridge.reload(merged);
  void reloadNotifications();
  return merged;
}
