/**
 * 把预览查询变成页面上的标记。
 * 标记与实际接线一致：点名的策略会创建对应工厂，未点名的保持已验收路径。
 * @module pet-next/app/preview-gate
 */
import { formatPreview, parsePreview, PREVIEW_QUERY, previewUsesAcceptedPath, type PreviewSelection } from '../contracts/preview.ts';

export interface PreviewMarker {
  previewRequested: string;
  /** 与请求相同。工厂已按这些令牌接线，未出现的令牌不会运行。 */
  previewActive: string;
}

/**
 * 读取页面查询。已验收路径返回 null，调用方不写 dataset。
 *
 * @param search - `location.search`，可以带或不带前导 `?`。
 * @returns 有新策略令牌时返回标记。`previewActive` 等于实际启用的令牌。
 */
export function previewDataset(search: string): PreviewMarker | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const selection = parsePreview(new URLSearchParams(query).get(PREVIEW_QUERY));
  return markerFor(selection);
}

/** 已验收路径返回 null。 */
export function markerFor(selection: PreviewSelection): PreviewMarker | null {
  if (previewUsesAcceptedPath(selection)) return null;
  const active = formatPreview(selection);
  return { previewRequested: active, previewActive: active };
}
