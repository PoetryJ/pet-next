/**
 * 语音卡：播报总开关与音色选择。
 *
 * 切换只改本地状态、随「保存」整包写入——即时写盘会重启桌面 Helper、重建全部桌面宠物窗口。
 * 音色选择器由外壳注入（与模型卡注入 picker 同构），卡片本身不硬编码任何音色 id。
 * @module dsh-pet/src/client/settings/voice-card
 */
import type { FunctionComponent } from 'react';
import type { VoiceOption, VoicePickerProps } from './picker/voice-picker.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

export type { VoiceOption } from './picker/voice-picker.ts';

/** 语音卡的输入。 */
export interface VoiceCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  readonly busy: boolean;
  /** 播报总开关的当前值。 */
  readonly enabled: boolean;
  /** 当前音色 id。 */
  readonly voiceName: string;
  /** 可选音色；为空时选择器只显示当前值（列表还没拉回来或拉取失败）。 */
  readonly voices: readonly VoiceOption[];
  /** 切换播报开关。 */
  readonly onToggle: (value: boolean) => void;
  /** 选择音色。 */
  readonly onVoiceChange: (voiceName: string) => void;
}

/**
 * 造语音卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @param picker - 音色选择器组件；与模型卡一样由装配根造一次后注入，保证组件类型跨渲染稳定。
 * @returns 卡片组件。
 */
export function makeVoiceCard(
  rt: SettingsRuntime,
  picker: FunctionComponent<VoicePickerProps>,
): FunctionComponent<VoiceCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function VoiceCard(props: VoiceCardProps) {
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('voiceTitle'), t('voiceHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            toggleCell('voiceEnabled', props.enabled, props.busy, props.onToggle),
            field(
              t('voiceNameLabel'),
              h(picker, {
                label: t('voiceNameLabel'),
                value: props.voiceName,
                options: props.voices,
                disabled: props.busy,
                onChange: props.onVoiceChange,
              }),
              t('voiceNameHint'),
            ),
          ],
        }),
      ],
    });
  };
}
