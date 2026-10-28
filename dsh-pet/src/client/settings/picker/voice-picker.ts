/**
 * 音色单选下拉：触发器 + 浮层，复用模型选择器的样式类与浮层定位。
 *
 * 只处理一维列表，不含搜索与分组——四个音色不值得再配一个搜索框。交互与模型选择器一致：
 * 打开时实测定位、点浮层外或 Esc 关闭、选中即收起。
 * @module dsh-pet/src/client/settings/picker/voice-picker
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from '../runtime.ts';
import { computePanelPlacement, type PanelPosition } from './model-picker-placement.ts';

/** 一个可选音色的展示信息；`id` 既是提交值也是稳定 key。 */
export interface VoiceOption {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
}

/** 音色选择器的对外契约：一个字段一个实例。 */
export interface VoicePickerProps {
  /** 字段标签，作为触发器的无障碍名。 */
  readonly label: string;
  /** 当前音色 id。 */
  readonly value: string;
  /** 可选音色；为空时触发器只显示 id，打开后是空列表。 */
  readonly options: readonly VoiceOption[];
  /** 禁用原因（保存中 / 配置未加载）。 */
  readonly disabled: boolean;
  /** 选中一个音色。 */
  readonly onChange: (voiceName: string) => void;
}

/**
 * 造音色选择器。
 * 依赖只在调用时注入一次：组件类型必须跨渲染稳定，否则浮层状态（打开 / 定位）每次渲染都会丢。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 选择器组件。
 */
export function makeVoicePicker(
  rt: Pick<SettingsRuntime, 'h' | 'useState' | 'useEffect' | 'useRef' | 't'>,
): FunctionComponent<VoicePickerProps> {
  const { h, useState, useEffect, useRef } = rt;

  return function VoicePicker(props: VoicePickerProps) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<PanelPosition | null>(null);
    const rootRef = useRef<HTMLElement | null>(null);
    const panelRef = useRef<HTMLElement | null>(null);

    const picked = props.options.find((option) => option.id === props.value);

    useEffect(() => {
      if (!open) return;
      const el = rootRef.current;
      // 定位 + 关闭时机与模型选择器同一套：浮层脱流实测定位，滚动/缩放跟着走，点外面或 Esc 关。
      const place = (): void => {
        if (!el) return;
        setPos(
          computePanelPlacement(el.getBoundingClientRect(), {
            width: window.innerWidth,
            height: window.innerHeight,
          }),
        );
      };
      place();
      const onDown = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true)) {
          return;
        }
        setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open]);

    const panel =
      open && pos
        ? h('div', {
            ref: panelRef,
            className: 'dsh-pet-mp__panel',
            role: 'listbox',
            style: {
              left: pos.left + 'px',
              top: pos.top === undefined ? undefined : pos.top + 'px',
              bottom: pos.bottom === undefined ? undefined : pos.bottom + 'px',
              width: pos.width + 'px',
              maxHeight: pos.maxHeight + 'px',
            },
            children: [
              h('div', {
                className: 'dsh-pet-mp__list',
                children: props.options.map((option) =>
                  h('div', {
                    key: option.id,
                    className: 'dsh-pet-mp__item' + (option.id === props.value ? ' is-active' : ''),
                    role: 'option',
                    'aria-selected': option.id === props.value,
                    onClick: () => {
                      props.onChange(option.id);
                      setOpen(false);
                    },
                    children: [
                      h('span', {
                        key: 'n',
                        className: 'dsh-pet-mp__name',
                        children: `${option.name}（${option.tag}）`,
                      }),
                      h('span', {
                        key: 'c',
                        className: 'dsh-pet-mp__check',
                        children: option.id === props.value ? '✓' : '',
                      }),
                    ],
                  }),
                ),
              }),
            ],
          })
        : null;

    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-mp',
      children: [
        h('button', {
          key: 't',
          type: 'button',
          className: 'dsh-pet-mp__trigger',
          disabled: props.disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': props.label,
          onClick: () => {
            if (!props.disabled) setOpen(!open);
          },
          children: [
            h('span', { key: 'l', className: 'dsh-pet-mp__label', children: picked ? picked.name : props.value }),
            picked ? h('span', { key: 's', className: 'dsh-pet-mp__sub', children: picked.tag }) : null,
            h('span', { key: 'c', className: 'dsh-pet-mp__chevron' + (open ? ' is-open' : ''), children: '▾' }),
          ],
        }),
        panel,
      ],
    });
  };
}
