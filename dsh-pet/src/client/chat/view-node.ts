/**
 * 面板的工具栏与输入区节点：孤儿提示、多选开关、待发送预览、输入框与发送键。
 *
 * 消息与轮在 ./view-message；这里只放「面板外壳」的交互，`confirm` 留在此处描述点击语义。
 * @module dsh-pet/src/client/chat/view-node
 */
import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState, ConfirmKind } from './types.ts';

/**
 * 已删宠物残留历史的提示条：显示数量并给一个「清理」。
 *
 * 这类宠物已不在配置里，面板列表里根本看不到它——不在这里提示，用户就没有任何入口清掉。
 */
export function orphansNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  if (state.orphans.length === 0) return null;
  const messages = state.orphans.reduce((sum, one) => sum + one.messages, 0);
  return h('div', {
    className: 'pet-chat-orphans',
    children: [
      h('span', { children: `有 ${state.orphans.length} 只已删除宠物的历史（${messages} 条）` }),
      h('span', { className: 'pet-chat-composer-spacer' }),
      h('button', {
        type: 'button',
        className: 'pet-chat-tool',
        onClick: () => state.ask('clear-orphans'),
        children: '清理',
      }),
    ],
  });
}

/** 卷帘块与按钮共用的 id：`aria-controls` 要指向它。 */
const PERSONA_PANEL_ID = 'pet-chat-persona';

/** 「人设」按钮：点一下展开 / 收起工具栏下方那块卷帘。 */
function personaButton(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  return h('button', {
    type: 'button',
    className: 'pet-chat-tool',
    'aria-expanded': String(state.personaOpen),
    'aria-controls': PERSONA_PANEL_ID,
    onClick: () => state.togglePersona(),
    children: '人设',
  });
}

/**
 * 人设卷帘：当前这只宠物实际在用的那段正文。
 *
 * 在正常流里展开，把消息列表顶下去——人设可以很长，浮在对话上会挡住内容。
 * 收起时保留 DOM 只把高度归零，否则没有展开过渡可播。
 */
export function personaNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  return h('div', {
    id: PERSONA_PANEL_ID,
    className: 'pet-chat-persona' + (state.personaOpen ? ' is-open' : ''),
    'aria-hidden': String(!state.personaOpen),
    children: [
      h('div', {
        className: 'pet-chat-persona-clip',
        children: [h('div', { className: 'pet-chat-persona-body', children: state.persona })],
      }),
    ],
  });
}

/** 工具栏：多选开关、删除选中（带数量）与清空历史；删除都先走面板内确认条。 */
export function toolsNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  return h('div', {
    className: 'pet-chat-tools',
    children: [
      personaButton(h, state),
      h('button', {
        type: 'button',
        className: 'pet-chat-tool',
        'aria-pressed': String(state.selecting),
        onClick: () => state.toggleSelecting(),
        children: state.selecting ? '取消选择' : '选择',
      }),
      state.selecting
        ? h('button', {
            type: 'button',
            className: 'pet-chat-tool',
            disabled: state.selected.length === 0,
            onClick: () => state.ask('delete-selected'),
            children: state.selected.length === 0 ? '删除选中' : '删除选中 ' + state.selected.length,
          })
        : null,
      h('button', {
        type: 'button',
        className: 'pet-chat-tool',
        onClick: () => state.ask('clear-all'),
        children: '清空历史',
      }),
    ],
  });
}

/** 待确认操作的文案：每条都说清「删什么、不可恢复」。 */
const CONFIRM_TEXT: Record<ConfirmKind, string> = {
  'delete-selected': '删除选中的这几轮对话？',
  'clear-all': '清空这只宠物的全部对话历史？',
  'clear-orphans': '清理已删除宠物的残留历史？',
};

/**
 * 面板内的确认条：代替浏览器原生 `confirm`，样子跟面板一致。
 *
 * @returns 没有待确认操作时是 null。
 */
export function confirmNode(rt: ChatPanelRuntime, state: ChatPanelState): unknown {
  if (state.pending === null) return null;
  const { h, ui } = rt;
  const count =
    state.pending === 'delete-selected'
      ? `（${state.selected.length} 轮）`
      : state.pending === 'clear-orphans'
        ? `（${state.orphans.length} 只）`
        : '';
  const description = CONFIRM_TEXT[state.pending] + count + '删了找不回来。';
  // 平台原语缺失（旧宿主）时退化为内联确认条，功能不丢、样式差一点
  if (ui === undefined) {
    return h('div', {
      className: 'pet-chat-confirm',
      role: 'alertdialog',
      children: [
        h('span', { children: description }),
        h('span', { className: 'pet-chat-composer-spacer' }),
        h('button', {
          type: 'button',
          className: 'pet-chat-danger',
          onClick: () => state.confirmAsk(),
          children: '删除',
        }),
        h('button', {
          type: 'button',
          className: 'pet-chat-tool',
          onClick: () => state.cancelAsk(),
          children: '取消',
        }),
      ],
    });
  }
  const { Button, Modal } = ui;
  return h(Modal, {
    open: true,
    title: '删除对话历史',
    closeLabel: '关闭',
    description,
    onClose: () => state.cancelAsk(),
    footer: h('div', {
      className: 'pet-chat-confirm-actions',
      children: [
        h(Button, { variant: 'ghost', type: 'button', onClick: () => state.cancelAsk(), children: '取消' }),
        h(Button, { variant: 'primary', type: 'button', onClick: () => state.confirmAsk(), children: '删除' }),
      ],
    }),
  });
}

/** 待发送图片的预览条。 */
function previewNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  if (state.attachment === undefined) return null;
  return h('div', {
    className: 'pet-chat-preview',
    children: [
      h('img', { className: 'pet-chat-preview-img', src: state.attachment.previewUrl, alt: '待发送的图片' }),
      h('span', {
        className: 'pet-chat-preview-meta',
        children: state.attachment.width + '×' + state.attachment.height,
      }),
      h('button', {
        type: 'button',
        className: 'pet-chat-tool',
        onClick: () => state.clearAttachment(),
        children: '移除',
      }),
    ],
  });
}

/** 发送键里的箭头：与 DSH 输入框一致的圆形按钮造型。 */
function sendIcon(h: ChatPanelRuntime['h']): unknown {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: 16,
    height: 16,
    'aria-hidden': 'true',
    children: [
      h('path', {
        d: 'M12 19V6M6 12l6-6 6 6',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    ],
  });
}

/**
 * 输入区：一体化圆角容器 —— 上面输入框，下面工具行（附图 / 发送）。
 *
 * 造型对齐 DSH 自己的输入框；`focus-within` 让整个容器而不是内层框变色，
 * 因为内层 textarea 已经没有边框了。
 */
export function composerNode(h: ChatPanelRuntime['h'], state: ChatPanelState): unknown {
  return h('div', {
    className: 'pet-chat-composer',
    children: [
      previewNode(h, state),
      h('textarea', {
        className: 'pet-chat-input',
        ref: state.draftRef,
        value: state.draft,
        rows: 2,
        placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）',
        onChange: (event: { target: { value: string } }) => state.setDraft(event.target.value),
        onPaste: (event: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
          const file = event.clipboardData?.files?.[0];
          if (file === undefined) return; // 纯文本粘贴照旧
          event.preventDefault();
          state.pickFile(file);
        },
        onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            state.send();
          }
        },
      }),
      h('div', {
        className: 'pet-chat-composer-bar',
        children: [
          h('label', {
            className: 'pet-chat-attach',
            title: '附一张图（也可以直接粘贴）',
            children: [
              '附图',
              h('input', {
                className: 'pet-chat-file',
                type: 'file',
                accept: 'image/png,image/jpeg,image/webp,image/gif',
                onChange: (event: { target: { files: FileList | null; value: string } }) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) state.pickFile(file);
                  event.target.value = '';
                },
              }),
            ],
          }),
          h('span', { className: 'pet-chat-composer-spacer' }),
          h('button', {
            type: 'button',
            className: 'pet-chat-send',
            'aria-label': state.busy ? '生成中' : '发送',
            onClick: () => state.send(),
            disabled: state.busy,
            children: sendIcon(h),
          }),
        ],
      }),
    ],
  });
}
