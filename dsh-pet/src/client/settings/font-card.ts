/**
 * 外观与字体卡（全局默认）：字体种类、字号、是否跟随宠物说话。
 * 字体种类作用于现在用软糖体的全部文字；字号只作用于气泡与悬浮提示，对话窗与得分弹窗不变。
 * 与其余全局默认同语义：只改本地状态，随「保存」整包写入。
 * @module dsh-pet/src/client/settings/font-card
 */
import type { ChangeEvent, FunctionComponent } from 'react';
import type { FontConfig, FontFamilyId } from '../../shared/types.ts';
import { FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../shared/fonts.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit } from './ui.ts';

/** 字体卡的输入。 */
export interface FontCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  busy: boolean;
  /** 当前字体配置。 */
  font: FontConfig;
  /** 改字体配置的若干字段。 */
  onChange: (patch: Partial<FontConfig>) => void;
}

/**
 * 造外观与字体卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makeFontCard(rt: SettingsRuntime): FunctionComponent<FontCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function FontCard(props: FontCardProps) {
    const { busy, font } = props;
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('fontTitle'), t('fontHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            field(
              t('fontFamilyLabel'),
              h('select', {
                className: INPUT_CLASS,
                value: font.family,
                disabled: busy,
                onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                  props.onChange({ family: e.target.value as FontFamilyId }),
                children: FONT_PRESETS.map((preset) =>
                  h('option', { key: preset.id, value: preset.id, children: t('font.' + preset.id) }),
                ),
              }),
              t('fontFamilyHint'),
            ),
            field(
              t('fontSizeLabel'),
              h('input', {
                type: 'number',
                className: INPUT_CLASS,
                step: '1',
                min: String(FONT_SIZE_MIN),
                max: String(FONT_SIZE_MAX),
                value: String(font.size),
                disabled: busy,
                onChange: (e: ChangeEvent<HTMLInputElement>) => props.onChange({ size: Number(e.target.value) }),
              }),
              t('fontSizeHint'),
            ),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [toggleCell('fontFollowToggle', font.followPet, busy, (v) => props.onChange({ followPet: v }))],
        }),
      ],
    });
  };
}
