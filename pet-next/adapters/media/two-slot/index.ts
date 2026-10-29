/**
 * 双槽适配器入口。默认桌宠不引用这里；预览模式由调用方选择。
 */
export { createTwoSlotAdapter } from './adapter.ts';
export { bindTwoSlotSurface } from './bind-surface.ts';
export { twoSlotModeForPreview } from './select-slot.ts';
export type { SlotSurface, TwoSlotRuntime } from './types.ts';
