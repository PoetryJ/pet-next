/**
 * 拖拽文件的归属：认领落在我们界面上的 drop，避免同一张图被 DSH 与桌宠各处理一次。
 */
import { dragHasFiles, firstImageFile } from '../shared/chat/image-pick.ts';

/** 拖拽事件的结构子集：原生 DragEvent 与注入 react 的合成事件都满足。 */
export interface DragLike {
  /** 拖拽携带的数据；非 HTML 拖拽来源可能为空。 */
  readonly dataTransfer: DataTransfer | null;
  /** 拦掉默认行为：否则浏览器会把拖进去的文件当导航打开，页面直接被换掉。 */
  preventDefault: () => void;
  /** 阻断冒泡：DSH 的拖拽监听就在同一棵树的祖先上，不拦会被它再处理一遍。 */
  stopPropagation: () => void;
}

/**
 * 认领「有文件经过」的拖拽。
 *
 * @param event - 我们的界面收到的 dragover。
 * @returns 带文件时为 true，且已拦默认行为与冒泡；纯文本等其它拖拽返回 false 且不碰事件。
 */
export function claimFileDragOver(event: DragLike): boolean {
  if (!dragHasFiles(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

/**
 * 认领落在我们界面上的文件拖放。
 *
 * @param event - 我们的界面收到的 drop。
 * @returns 第一张可发送的图片；不是文件拖放时一律不碰事件，是文件但认不出图片时吞下并返回 undefined。
 */
export function claimFileDrop(event: DragLike): File | undefined {
  if (!dragHasFiles(event)) return undefined;
  event.preventDefault();
  event.stopPropagation();
  hideHostDropOverlay();
  return firstImageFile(event.dataTransfer);
}

/**
 * 收起宿主（DSH）的整页拖拽遮罩。
 *
 * 它用 document 上的 dragenter/dragleave 计数维护遮罩，只有 drop 与 window 的 dragend 会清零。
 * 我们的 drop 截住冒泡后它收不到收尾信号，遮罩会一直挂着；补这一次不带文件，不会触发上传。
 */
function hideHostDropOverlay(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('dragend'));
}
