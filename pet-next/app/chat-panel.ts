/**
 * M3-0 文字对话预览面板：纯注入、无框架，仅由接线方在预览开关下挂载；普通入口不加载，M2 零改动。
 * 面板自持状态机（closed→open→typing→pending→{reply|error|cancelled}），迟到结果按当前会话 id 隔离；
 * DOM 全用 createElement+textContent（绝不 innerHTML）；指针/按键事件在面板根内截停，不影响宠物。
 * 视口约束：挂载时按实际视口高度写入面板 max-height（320×240 窗口下不越界），标题/关闭/输入/发送/取消恒可见。
 * @module pet-next/app/chat-panel
 */
import { CHAT_MAX_INPUT_CHARS, type ChatSendRequest, type ChatSendResult } from '../contracts/chat.ts';

/** 面板使用的模型客户端（接线方注入：指向 IPC 或测试桩）。 */
export interface ChatPanelClient {
  send(request: ChatSendRequest): Promise<ChatSendResult>;
  cancel(id: string): void;
}

/** 挂载句柄：unmount 撤销在途请求并移除面板 DOM 与事件。 */
export interface ChatPanelHandle {
  unmount(): void;
}

/** 状态机视角：收起→打开→输入→在途→终态之一，可再发送。 */
export type ChatPanelState = 'closed' | 'open' | 'typing' | 'pending' | 'reply' | 'error' | 'cancelled';

/** 输入校验（纯函数）：空/超长拒绝，不截断。 */
export function validateChatInput(text: string): 'empty' | 'too-long' | null {
  if (text.length === 0) return 'empty';
  if (text.length > CHAT_MAX_INPUT_CHARS) return 'too-long';
  return null;
}

/** Enter 是否发送（纯函数）。Shift+Enter 不发送，留给换行；组合输入（isComposing 或 composition 状态）不发送。 */
export function enterShouldSend(input: { key: string; shiftKey: boolean; isComposing?: boolean }, composing: boolean): boolean {
  if (input.key !== 'Enter') return false;
  if (input.shiftKey) return false;
  if (composing) return false;
  if (input.isComposing === true) return false;
  return true;
}

/** 结果三态映射终态（纯函数）。 */
export function phaseForResult(status: ChatSendResult['status']): 'reply' | 'error' | 'cancelled' {
  if (status === 'ok') return 'reply';
  if (status === 'error') return 'error';
  return 'cancelled';
}

/**
 * 视口纵向预留 = 底部边距 8 + 开关按钮 34 + 间距 4 + 顶部边距 4 = 50。
 * 与 chat-panel.css 的 --chat-panel-reserve 同源；改一处必须同步另一处。
 */
export const CHAT_VIEWPORT_RESERVE_PX = 50;
/** 面板高度舒适上限（宽屏用）；小窗口由视口高度进一步收紧。 */
export const CHAT_PANEL_MAX_HEIGHT_PX = 320;

/**
 * 面板可用的最大高度（纯函数）：视口高度减纵向预留，并不超过 320。
 * 退化输入（<=0/非有限）回落到 320 上限；小到放不下预留时返回 0，绝不越过视口。
 */
export function panelMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return CHAT_PANEL_MAX_HEIGHT_PX;
  return Math.max(0, Math.min(CHAT_PANEL_MAX_HEIGHT_PX, Math.floor(viewportHeight - CHAT_VIEWPORT_RESERVE_PX)));
}

/** 读实际视口高度：显式注入优先，其次 globalThis.innerHeight，再退到 documentElement.clientHeight；都没有则 null。 */
export function resolveViewportHeight(explicit?: number): number | null {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const inner = (globalThis as { innerHeight?: unknown }).innerHeight;
  if (typeof inner === 'number' && Number.isFinite(inner) && inner > 0) return inner;
  const client = (globalThis as { document?: { documentElement?: { clientHeight?: unknown } } }).document
    ?.documentElement?.clientHeight;
  if (typeof client === 'number' && Number.isFinite(client) && client > 0) return client;
  return null;
}

/** 挂载选项：视口高度可注入（单测/嵌入场景），缺省读真实 innerHeight。 */
export interface ChatPanelMountOptions {
  viewportHeight?: number;
}

/** 请求 id：满足 CHAT_ID_PATTERN（chat-[a-z0-9-]{1,48}）。 */
let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `chat-p${requestSeq}`;
}

/**
 * 挂载聊天面板。面板以独立子树追加进 root；unmount 对在途 id 调 client.cancel 并移除 DOM/事件。
 */
export function mountChatPanel(
  root: HTMLElement,
  client: ChatPanelClient,
  options: ChatPanelMountOptions = {},
): ChatPanelHandle {
  const panelRoot = document.createElement('div');
  panelRoot.className = 'chat-panel-root';
  panelRoot.dataset.testid = 'chat-panel';
  panelRoot.dataset.state = 'closed';

  const toggle = document.createElement('button');
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-label', '打开聊天面板');
  toggle.className = 'chat-toggle';
  toggle.dataset.testid = 'chat-toggle';
  toggle.textContent = '聊';

  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.dataset.testid = 'chat-panel-open';
  panel.hidden = true;
  // 视口约束：行内 max-height 用实测视口压住 CSS 的 100vh 兜底，面板永不高于「视口 - 预留」。
  const viewportHeight = resolveViewportHeight(options.viewportHeight);
  if (viewportHeight !== null) {
    panel.style.maxHeight = `${panelMaxHeight(viewportHeight)}px`;
  }

  const head = document.createElement('div');
  head.className = 'chat-head';
  const title = document.createElement('span');
  title.className = 'chat-title';
  title.textContent = '文字对话预览';
  const closeBtn = document.createElement('button');
  closeBtn.setAttribute('type', 'button');
  closeBtn.setAttribute('aria-label', '收起面板');
  closeBtn.className = 'chat-close';
  closeBtn.dataset.testid = 'chat-close';
  closeBtn.textContent = '×';
  head.appendChild(title);
  head.appendChild(closeBtn);

  const note = document.createElement('div');
  note.className = 'chat-note';
  note.textContent = '以下回复均为演示回复（预览假数据），非真实模型输出。';

  const log = document.createElement('div');
  log.className = 'chat-log';

  const composer = document.createElement('div');
  composer.className = 'chat-composer';
  const input = document.createElement('textarea');
  input.setAttribute('type', 'text');
  input.setAttribute('rows', '3');
  input.setAttribute('aria-label', '聊天输入');
  input.setAttribute('placeholder', `给宠物留言（Enter 发送，Shift+Enter 换行，上限 ${CHAT_MAX_INPUT_CHARS} 字）`);
  input.className = 'chat-input';
  input.dataset.testid = 'chat-input';
  const hint = document.createElement('div');
  hint.className = 'chat-hint';
  const actions = document.createElement('div');
  actions.className = 'chat-actions';
  const sendBtn = document.createElement('button');
  sendBtn.setAttribute('type', 'button');
  sendBtn.className = 'chat-send';
  sendBtn.dataset.testid = 'chat-send';
  sendBtn.textContent = '发送';
  const cancelBtn = document.createElement('button');
  cancelBtn.setAttribute('type', 'button');
  cancelBtn.className = 'chat-cancel';
  cancelBtn.dataset.testid = 'chat-cancel';
  cancelBtn.textContent = '取消';
  cancelBtn.disabled = true;
  actions.appendChild(sendBtn);
  actions.appendChild(cancelBtn);
  composer.appendChild(input);
  composer.appendChild(hint);
  composer.appendChild(actions);

  panel.appendChild(head);
  panel.appendChild(note);
  panel.appendChild(log);
  panel.appendChild(composer);
  panelRoot.appendChild(toggle);
  panelRoot.appendChild(panel);
  root.appendChild(panelRoot);

  let open = false;
  let busy = false;
  let composing = false;
  let disposed = false;
  let outcome: 'reply' | 'error' | 'cancelled' | null = null;
  let activeId: string | null = null;
  let statusEntry: HTMLElement | null = null;

  const listeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  function on(target: EventTarget, type: string, handler: (ev: Event) => void): void {
    const wrapped = handler as EventListener;
    target.addEventListener(type, wrapped);
    listeners.push({ target, type, handler: wrapped });
  }

  function appendEntry(kind: string, text: string): HTMLElement {
    const entry = document.createElement('div');
    entry.className = `chat-entry chat-entry-${kind}`;
    entry.dataset.testid = kind === 'status' ? 'chat-status' : `chat-msg-${kind}`;
    entry.textContent = text;
    log.appendChild(entry);
    scrollLogToEnd();
    return entry;
  }

  /** 新条目贴底：小窗口里正文只有几行，最新消息必须自己滚进可视区。 */
  function scrollLogToEnd(): void {
    log.scrollTop = log.scrollHeight;
  }

  function appendBotEntry(text: string): void {
    const entry = document.createElement('div');
    entry.className = 'chat-entry chat-entry-bot';
    entry.dataset.testid = 'chat-msg-assistant';
    const tag = document.createElement('span');
    tag.className = 'chat-demo-tag';
    tag.textContent = '演示回复';
    entry.appendChild(tag);
    const body = document.createElement('span');
    body.className = 'chat-entry-text';
    body.textContent = text;
    entry.appendChild(body);
    log.appendChild(entry);
    scrollLogToEnd();
  }

  function syncState(): void {
    const state: ChatPanelState = !open
      ? 'closed'
      : busy
        ? 'pending'
        : (outcome ?? (input.value.length === 0 ? 'open' : 'typing'));
    panelRoot.dataset.state = state;
    panelRoot.classList.toggle('is-open', open);
  }

  function updateComposer(): void {
    const problem = validateChatInput(input.value);
    sendBtn.disabled = busy || problem !== null;
    hint.textContent = problem === 'too-long' ? `输入超过 ${CHAT_MAX_INPUT_CHARS} 字符，请缩短后再发送` : '';
    cancelBtn.disabled = !busy;
  }

  function clearStatusEntry(): void {
    if (statusEntry) {
      statusEntry.remove();
      statusEntry = null;
    }
  }

  /** 只采纳与当前展示会话 id 匹配的结果；取消/重发/卸载后的迟到结果一律丢弃。 */
  function settle(id: string, result: ChatSendResult): void {
    if (disposed || activeId !== id) return;
    activeId = null;
    busy = false;
    outcome = phaseForResult(result.status);
    clearStatusEntry();
    if (result.status === 'ok') appendBotEntry(result.text ?? '');
    else if (result.status === 'error') appendEntry('error', `发送失败（${result.code ?? 'provider-error'}）`);
    else appendEntry('status', '已取消');
    updateComposer();
    syncState();
  }

  function submit(): void {
    if (disposed || !open || busy) return;
    const text = input.value;
    if (validateChatInput(text)) {
      updateComposer();
      return;
    }
    const id = nextRequestId();
    activeId = id;
    busy = true;
    outcome = null;
    appendEntry('user', text);
    statusEntry = appendEntry('status', '发送中…');
    updateComposer();
    syncState();
    client
      .send({ id, text })
      .then(
        (result) => settle(id, result),
        () => settle(id, { id, status: 'error', code: 'provider-error' }),
      );
  }

  function cancelActive(): void {
    if (disposed || !busy || activeId === null) return;
    client.cancel(activeId);
    activeId = null;
    busy = false;
    outcome = 'cancelled';
    clearStatusEntry();
    appendEntry('status', '已取消');
    updateComposer();
    syncState();
  }

  function openPanel(): void {
    if (disposed || open) return;
    open = true;
    panel.hidden = false;
    syncState();
    input.focus();
  }

  /** 收起面板：等价于面板内撤销——在途请求同样取消；DOM 移除仍归 unmount。 */
  function closePanel(): void {
    if (disposed || !open) return;
    cancelActive();
    open = false;
    panel.hidden = true;
    syncState();
  }

  function handleKeydown(ev: Event): void {
    const key = ev as KeyboardEvent;
    if (enterShouldSend({ key: key.key, shiftKey: key.shiftKey, isComposing: key.isComposing }, composing)) {
      ev.preventDefault();
      submit();
    }
  }

  // 面板内指针/滚轮/按键事件全部截停，不冒泡到宠物元素或 window（别绑 window）。
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'contextmenu', 'wheel', 'keydown', 'keyup']) {
    on(panelRoot, type, (ev) => {
      ev.stopPropagation();
    });
  }
  on(toggle, 'click', () => (open ? closePanel() : openPanel()));
  on(closeBtn, 'click', closePanel);
  on(sendBtn, 'click', submit);
  on(cancelBtn, 'click', cancelActive);
  on(input, 'keydown', handleKeydown);
  on(input, 'compositionstart', () => {
    composing = true;
  });
  on(input, 'compositionend', () => {
    composing = false;
  });
  on(input, 'input', () => {
    updateComposer();
    syncState();
  });

  updateComposer();
  syncState();

  return {
    unmount() {
      if (disposed) return;
      if (busy && activeId !== null) client.cancel(activeId);
      disposed = true;
      activeId = null;
      busy = false;
      for (const item of listeners) item.target.removeEventListener(item.type, item.handler);
      listeners.length = 0;
      panelRoot.remove();
    },
  };
}
