/**
 * 「AI 模型与对话上下文」卡：碎碎念 / 对话各自的模型（条目级），对话历史条数与配图张数上限（全局默认）。
 * 都与全局开关同语义：只改本地状态，随「保存」整包写入；宿主生成时优先用模型，失败自动回落。
 * 候选清单拉取失败只在这里提示一行，不阻塞已有配置值的显示与保存。
 * @module dsh-pet/src/client/settings/model-card
 */
import type { FunctionComponent } from 'react';
import type { ModelSelection } from '../../shared/types.ts';
import type { ModelCatalogGroup } from './picker/index.ts';
import type { ModelPickerProps } from './picker/index.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit } from './ui.ts';

/** 两个模型字段的键名。 */
export type ModelFieldKey = 'whisperModel' | 'chatModel';

/** 模型卡的输入。 */
export interface ModelCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  busy: boolean;
  /** 候选清单；`null` 表示还在拉取。 */
  catalog: readonly ModelCatalogGroup[] | null;
  /** 候选清单拉取失败。 */
  failed: boolean;
  /** 碎碎念用的模型。 */
  whisperModel: ModelSelection;
  /** 对话用的模型。 */
  chatModel: ModelSelection;
  /** 某个模型字段被改。 */
  onModelChange: (key: ModelFieldKey, value: ModelSelection) => void;
  /** 对话历史条数。 */
  chatMemory: number;
  /** 对话配图张数上限。 */
  chatImageLimit: number;
  /** 改对话历史条数。 */
  onChatMemoryChange: (value: number) => void;
  /** 改对话配图张数上限。 */
  onChatImageLimitChange: (value: number) => void;
}

/**
 * 造模型卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @param picker - 模型选择器组件（由外壳用同一份运行时造好，跨渲染稳定）。
 * @returns 卡片组件。
 */
export function makeModelCard(
  rt: SettingsRuntime,
  picker: FunctionComponent<ModelPickerProps>,
): FunctionComponent<ModelCardProps> {
  const { h, t } = rt;
  const { cardHead, field } = makeUiKit({ h, t });

  return function ModelCard(props: ModelCardProps) {
    const { busy, catalog, failed } = props;

    /** 「全局默认」的数字格：标签与问号在上、数字输入在下。 */
    const numField = (label: string, value: number, setter: (v: number) => void) =>
      field(
        t(label),
        h('input', {
          type: 'number',
          className: INPUT_CLASS,
          step: '1',
          min: '0',
          value: String(value),
          disabled: busy,
          onChange: (e: { target: { value: string } }) => setter(Number(e.target.value)),
        }),
        t(label + 'Hint'),
      );

    /** 「AI 模型」的一格：标签与问号在上、单下拉选择器在下。 */
    const modelCell = (key: ModelFieldKey, value: ModelSelection) => {
      const label = t(key === 'whisperModel' ? 'whisperModelLabel' : 'chatModelLabel');
      return field(
        label,
        h(picker, {
          label,
          value,
          disabled: busy,
          catalog,
          failed,
          onChange: (next: ModelSelection) => props.onModelChange(key, next),
        }),
        t('modelFieldHint'),
      );
    };

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('modelTitle'), t('modelHint')),
        failed
          ? h('p', {
              className: 'dsh-pet-cfg__note',
              style: { color: 'var(--dsw-alias-state-error-primary)' },
              children: t('modelCatalogFailed'),
            })
          : null,
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [modelCell('whisperModel', props.whisperModel), modelCell('chatModel', props.chatModel)],
        }),
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            numField('chatMemory', props.chatMemory, props.onChatMemoryChange),
            numField('chatImageLimit', props.chatImageLimit, props.onChatImageLimitChange),
          ],
        }),
      ],
    });
  };
}
