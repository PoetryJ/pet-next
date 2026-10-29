/**
 * 把预览查询变成页面上的标记。
 * 标记不是实现：本轮不加载双槽适配器，也不加载行为调度器。
 * @module pet-next/app/preview-gate
 */
import { formatPreview, parsePreview, PREVIEW_QUERY, previewUsesAcceptedPath, type PreviewSelection } from '../contracts/preview.ts';

export interface PreviewMarker {
  previewRequested: string;
  /** 工厂尚未接入，所以请求不会变成运行中的策略。 */
  previewActive: 'off';
}

/**
 * 读取页面查询。已验收路径返回 null，调用方不写 dataset。
 *
 * @param search - `location.search`，可以带或不带前导 `?`。
 * @returns 有新策略令牌时返回标记。标记的 `previewActive` 固定为 `off`。
 */
export function previewDataset(search: string): PreviewMarker | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const selection = parsePreview(new URLSearchParams(query).get(PREVIEW_QUERY));
  return markerFor(selection);
}

/** 已验收路径返回 null。 */
export function markerFor(selection: PreviewSelection): PreviewMarker | null {
  if (previewUsesAcceptedPath(selection)) return null;
  return { previewRequested: formatPreview(selection), previewActive: 'off' };
}
