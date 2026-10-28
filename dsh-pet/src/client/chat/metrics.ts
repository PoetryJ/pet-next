/**
 * 面板的尺寸常量：CSS 与 JS 共用的唯一来源。
 *
 * 尺寸不写字面量（规范要求走共享常量）；输入框的最大高度还要被自动长高的脚本读到，
 * 所以放在这里而不是 CSS 字符串里各写一份。
 * @module dsh-pet/src/client/chat/metrics
 */

/** 面板尺寸与间距（px）。 */
export const SIZE = {
  pad: 12,
  padBottom: 10,
  gap: 8,
  gapTight: 6,
  gapWide: 10,
  listGap: 20,
  avatar: 28,
  imgMaxW: 220,
  imgMaxH: 180,
  preview: 48,
  hairline: 2,
  tabPadY: 3,
  tabPadX: 12,
  toolPadY: 2,
  toolPadX: 10,
  bubblePadY: 8,
  bubblePadX: 12,
  composerPad: 10,
  composerPadBottom: 6,
  inputMinH: 44,
  inputMaxH: 140,
  send: 34,
  pillPadY: 4,
  pill: 999,
} as const;

/** 输入框自动长高的上限（px）；超过就内部滚动。 */
export const INPUT_MAX_HEIGHT = SIZE.inputMaxH;

/** 数值 → px 字符串。 */
export const px = (value: number): string => value + 'px';
