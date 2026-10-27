/**
 * 设置页共用的小件：字段、问号说明、卡片头、开关格，以及输入框与等宽字体的共享常量。
 * 全部只是造节点，不含状态也不读翻译以外的全局——样式规则在 `css.ts`，文案键在 `locales.ts`。
 * 说明统一走 `data-tip` 气泡（CSS 的 `[data-tip]::after`），不额外包一层 DOM，避免打乱外层 flex 的间距与对齐。
 * @module dsh-pet/src/client/settings/ui
 */
import type { ChangeEvent } from 'react';
import type { jsx } from 'react/jsx-runtime';
import type { SettingsRuntime } from './runtime.ts';

/** 输入框与下拉框共用的类名。 */
export const INPUT_CLASS = 'dsh-pet-cfg__inp';

/** 等宽字体栈（路径与命令展示用），走系统栈以免多拉一份资源。 */
export const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

/** 设置页的共用小件；由 {@link makeUiKit} 一次造好，各卡片共享同一套翻译与节点工厂。 */
export interface SettingsUiKit {
  /** 悬浮说明的展开属性：带 `data-tip` 即悬浮出气泡。 */
  tip: (text: string, end?: boolean) => Record<string, string>;
  /** 问号说明入口：气泡的圆形触发元素。 */
  q: (text: string, end?: boolean) => ReturnType<typeof jsx>;
  /** 卡片头：标题与问号说明；右侧动作由调用方自行追加。 */
  cardHead: (title: string, hint?: string, end?: boolean) => ReturnType<typeof jsx>;
  /** 一个字段：标签（可带问号）在上、控件在下。 */
  field: (label: string, control: ReturnType<typeof jsx>, hint?: string, end?: boolean) => ReturnType<typeof jsx>;
  /** 开关的一格：勾选框、标题与问号；说明挂在问号上，点标题只切开关。 */
  toggleCell: (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (value: boolean) => void,
    end?: boolean,
  ) => ReturnType<typeof jsx>;
}

/**
 * 造设置页的共用小件。
 *
 * @param rt - 只用到节点工厂 `h` 与翻译 `t`。
 * @returns 各卡片共享的小件集合。
 */
export function makeUiKit(rt: Pick<SettingsRuntime, 'h' | 't'>): SettingsUiKit {
  const { h, t } = rt;

  /**
   * 悬浮说明的展开属性。
   *
   * @param text - 说明正文（已翻译）。
   * @param end - 气泡右对齐，给栅格最右列或贴右缘的元素用。
   */
  const tip = (text: string, end = false): Record<string, string> =>
    end ? { 'data-tip': text, 'data-tip-end': '' } : { 'data-tip': text };

  /** 问号：气泡的圆形触发元素。用 `<i>` 而不是 `<button>`——它只展示说明，点了不该有行为，也不该进 Tab 顺序。 */
  const q = (text: string, end = false): ReturnType<typeof jsx> =>
    h('i', { className: 'dsh-pet-cfg__q', ...tip(text, end), 'aria-label': text, role: 'img', children: '?' });

  return {
    tip,
    q,
    cardHead: (title, hint, end = false) =>
      h('div', {
        className: 'dsh-pet-cfg__cardHead',
        children: [
          h('span', { key: 't', className: 'dsh-pet-cfg__cardTitle', children: title }),
          hint ? q(hint, end) : null,
        ],
      }),
    field: (label, control, hint, end = false) =>
      h('div', {
        className: 'dsh-pet-cfg__field',
        children: [
          h('span', {
            key: 'l',
            className: 'dsh-pet-cfg__flabel',
            children: hint ? [label, q(hint, end)] : label,
          }),
          control,
        ],
      }),
    toggleCell: (label, value, disabled, onToggle, end = false) =>
      h('div', {
        className: 'dsh-pet-cfg__toggle',
        children: [
          h('label', {
            key: 'l',
            children: [
              h('input', {
                key: 'i',
                type: 'checkbox',
                checked: value,
                disabled,
                onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
              }),
              h('span', { key: 't', children: t(label) }),
            ],
          }),
          q(t(label + 'Hint'), end),
        ],
      }),
  };
}
