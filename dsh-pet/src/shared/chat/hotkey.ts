/**
 * 悬停快捷键的判据：鼠标停在某只宠物上时，按 `T` 打开对话。
 * 纯函数，两端共用；桌面端只在窗口已聚焦时收得到按键（透明穿透窗默认不抢焦点）。
 * @module dsh-pet/src/shared/chat/hotkey
 */

/** 快捷键的显示文案（菜单项右侧灰字）。与 {@link isChatHotkey} 的按键保持同一份事实。 */
export const CHAT_HOTKEY_HINT = 'T 键';

/** 判据只读这几个字段，测试可以用普通对象代替 KeyboardEvent。 */
export interface HotkeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

/** 这些地方按键属于打字，不能抢：输入框、文本域、下拉、contenteditable。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
}

/**
 * 这次按键该不该打开对话。
 *
 * @param e - 键盘事件（只读 key 与修饰键、target）。
 * @returns `T`（含大写）、不带 Ctrl/Meta/Alt，且焦点不在可编辑元素上时为 true。
 */
export function isChatHotkey(e: HotkeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key !== 't' && e.key !== 'T') return false;
  return !isTypingTarget(e.target);
}
