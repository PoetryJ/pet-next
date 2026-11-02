/**
 * 聊天面板单测：Node 无 DOM，自建最小 DOM 桩（仅本文件用，不新增依赖）。
 * 覆盖任务 9 条交互态 + 纯函数判定；请求结果用受控 Promise 驱动迟到/隔离场景。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHAT_MAX_INPUT_CHARS, type ChatSendRequest, type ChatSendResult } from '../contracts/chat.ts';
import {
  CHAT_PANEL_MAX_HEIGHT_PX,
  CHAT_VIEWPORT_RESERVE_PX,
  enterShouldSend,
  mountChatPanel,
  panelMaxHeight,
  phaseForResult,
  resolveViewportHeight,
  validateChatInput,
  type ChatPanelClient,
  type ChatPanelMountOptions,
} from './chat-panel.ts';

interface StubEvent extends Record<string, unknown> {
  type: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** 最小 DOM 元素桩：只实现面板用到的那几个接口。 */
class StubElement {
  tagName: string;
  children: StubElement[] = [];
  parentNode: StubElement | null = null;
  ownText = '';
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<(ev: StubEvent) => void>>();
  classes = new Set<string>();
  style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = '';
  focused = false;

  constructor(tag: string) {
    this.tagName = tag;
  }

  /** DOM 语义：有子节点时聚合子树文本；赋值则清空子节点。 */
  get textContent(): string {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('');
    return this.ownText;
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  get className(): string {
    return [...this.classes].join(' ');
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  get classList(): {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  } {
    const classes = this.classes;
    return {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }

  appendChild(child: StubElement): StubElement {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: StubElement): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  setAttribute(key: string, value: string): void {
    this.attrs[key] = value;
  }

  getAttribute(key: string): string | null {
    return this.attrs[key] ?? null;
  }

  addEventListener(type: string, handler: (ev: StubEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (ev: StubEvent) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }

  /** 触发事件：返回带 defaultPrevented/propagationStopped 标记的事件对象。 */
  dispatch(type: string, init: Record<string, unknown> = {}): StubEvent {
    const ev: StubEvent = {
      type,
      ...init,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(ev);
    return ev;
  }

  focus(): void {
    this.focused = true;
  }
}

(globalThis as { document?: unknown }).document = { createElement: (tag: string) => new StubElement(tag) };

/** 按类名深度查找（测试定位用）。 */
function find(root: StubElement, className: string): StubElement {
  const hit = findAll(root, className)[0];
  assert.ok(hit, `missing .${className}`);
  return hit;
}

function findAll(root: StubElement, className: string): StubElement[] {
  const out: StubElement[] = [];
  for (const child of root.children) {
    if (child.classes.has(className)) out.push(child);
    out.push(...findAll(child, className));
  }
  return out;
}

/** 受控 client：send 记录调用并挂起 Promise，测试手动 resolve/reject。 */
interface Controlled {
  calls: { send: ChatSendRequest[]; cancel: string[] };
  client: ChatPanelClient;
  settle(id: string, result: ChatSendResult): void;
  fail(id: string, error?: unknown): void;
}

function createClient(): Controlled {
  const calls = { send: [] as ChatSendRequest[], cancel: [] as string[] };
  const live = new Map<string, { resolve: (r: ChatSendResult) => void; reject: (e: unknown) => void }>();
  const client: ChatPanelClient = {
    send(request) {
      calls.send.push(request);
      return new Promise<ChatSendResult>((resolve, reject) => live.set(request.id, { resolve, reject }));
    },
    cancel(id) {
      calls.cancel.push(id);
    },
  };
  return {
    calls,
    client,
    settle(id, result) {
      live.get(id)?.resolve(result);
      live.delete(id);
    },
    fail(id, error = new Error('boom')) {
      live.get(id)?.reject(error);
      live.delete(id);
    },
  };
}

interface Harness {
  root: StubElement;
  panelRoot: StubElement;
  panelBody: StubElement;
  toggle: StubElement;
  input: StubElement;
  sendBtn: StubElement;
  cancelBtn: StubElement;
  closeBtn: StubElement;
  logTexts(): string[];
  open(): void;
  enter(opts?: Record<string, unknown>): StubEvent;
  unmount(): void;
}

function mount(controlled: Controlled, options?: ChatPanelMountOptions): Harness {
  const root = new StubElement('div');
  const handle = mountChatPanel(root as unknown as HTMLElement, controlled.client, options);
  const panelRoot = root.children[0] ?? assert.fail('panel root missing');
  const open = () => find(panelRoot, 'chat-toggle').dispatch('click');
  return {
    root,
    panelRoot,
    get panelBody() {
      return find(panelRoot, 'chat-panel');
    },
    get toggle() {
      return find(panelRoot, 'chat-toggle');
    },
    get input() {
      return find(panelRoot, 'chat-input');
    },
    get sendBtn() {
      return find(panelRoot, 'chat-send');
    },
    get cancelBtn() {
      return find(panelRoot, 'chat-cancel');
    },
    get closeBtn() {
      return find(panelRoot, 'chat-close');
    },
    logTexts: () => find(panelRoot, 'chat-log').children.map((entry) => entry.textContent),
    open,
    enter: (opts = {}) => find(panelRoot, 'chat-input').dispatch('keydown', { key: 'Enter', shiftKey: false, ...opts }),
    unmount: () => handle.unmount(),
  };
}

test('1 默认收起：只剩小按钮；点击展开；指针/按键事件在面板根截停不冒泡', () => {
  const h = mount(createClient());
  assert.equal(h.panelRoot.dataset.state, 'closed');
  assert.equal(find(h.panelRoot, 'chat-panel').hidden, true);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown', 'wheel']) {
    const ev = h.panelRoot.dispatch(type);
    assert.equal(ev.propagationStopped, true, type);
  }
  h.toggle.dispatch('click');
  assert.equal(h.panelRoot.dataset.state, 'open');
  assert.equal(find(h.panelRoot, 'chat-panel').hidden, false);
  assert.equal(h.input.focused, true);
});

test('2 Enter 发送；组合输入期间（isComposing 或 composition 状态）不发送；Shift+Enter 不发送（留给换行）', () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  h.input.value = '你好';
  h.input.dispatch('input');
  assert.equal(h.panelRoot.dataset.state, 'typing');

  assert.equal(h.enter({ isComposing: true }).defaultPrevented, false);
  assert.equal(c.calls.send.length, 0);

  h.input.dispatch('compositionstart');
  assert.equal(h.enter().defaultPrevented, false);
  assert.equal(c.calls.send.length, 0);

  h.input.dispatch('compositionend');
  assert.equal(h.enter({ shiftKey: true }).defaultPrevented, false);
  assert.equal(c.calls.send.length, 0);

  const ev = h.enter();
  assert.equal(ev.defaultPrevented, true);
  assert.equal(c.calls.send.length, 1);
  assert.equal(c.calls.send[0]?.text, '你好');
  assert.match(c.calls.send[0]?.id ?? '', /^chat-[a-z0-9-]{1,48}$/);
});

test('3 pending 禁发且二次 Enter/点击不产生第二次 client.send（面板层一次一个在途）', () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  h.input.value = '一';
  h.input.dispatch('input');
  h.sendBtn.dispatch('click');
  assert.equal(c.calls.send.length, 1);
  assert.equal(h.panelRoot.dataset.state, 'pending');
  assert.equal(h.sendBtn.disabled, true);
  assert.equal(h.cancelBtn.disabled, false);
  assert.ok(h.logTexts().some((t) => t.includes('发送中')));

  h.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
  h.sendBtn.dispatch('click');
  assert.equal(c.calls.send.length, 1);
  assert.equal(h.panelRoot.dataset.state, 'pending');
});

test('4 取消按钮 pending 可点：调 client.cancel(id)，结果显示已取消', () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  h.input.value = '要取消的';
  h.input.dispatch('input');
  h.enter();
  const id = c.calls.send[0]?.id;
  h.cancelBtn.dispatch('click');
  assert.deepEqual(c.calls.cancel, [id]);
  assert.equal(h.panelRoot.dataset.state, 'cancelled');
  assert.ok(h.logTexts().some((t) => t.includes('已取消')));
  assert.equal(h.sendBtn.disabled, false);
  assert.equal(h.cancelBtn.disabled, true);
});

test('5 迟到结果隔离：取消后立即新发送，旧请求迟到 ok/error 不得覆盖新请求状态', async () => {
  const c = createClient();
  const h = mount(c);
  h.open();

  h.input.value = '旧问题';
  h.input.dispatch('input');
  h.enter();
  const oldId = c.calls.send[0]?.id ?? '';
  h.cancelBtn.dispatch('click');

  h.input.value = '新问题';
  h.input.dispatch('input');
  h.enter();
  const newId = c.calls.send[1]?.id ?? '';
  assert.notEqual(oldId, newId);
  assert.equal(h.panelRoot.dataset.state, 'pending');

  c.settle(oldId, { id: oldId, status: 'ok', text: '旧迟到回复' });
  c.fail(oldId);
  await Promise.resolve();
  assert.equal(h.panelRoot.dataset.state, 'pending');
  assert.ok(!h.logTexts().some((t) => t.includes('旧迟到回复')));

  c.settle(newId, { id: newId, status: 'ok', text: '新回复' });
  await Promise.resolve();
  assert.equal(h.panelRoot.dataset.state, 'reply');
  assert.ok(h.logTexts().some((t) => t.includes('新回复')));
});

test('6 错误显示含 code（含 client.send reject 映射），失败后可再次发送', async () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  h.input.value = '一';
  h.input.dispatch('input');
  h.enter();
  const firstId = c.calls.send[0]?.id ?? '';
  c.settle(firstId, { id: firstId, status: 'error', code: 'provider-error' });
  await Promise.resolve();
  assert.equal(h.panelRoot.dataset.state, 'error');
  assert.ok(h.logTexts().some((t) => t.includes('provider-error')));

  h.input.value = '二';
  h.input.dispatch('input');
  h.enter();
  const secondId = c.calls.send[1]?.id ?? '';
  c.fail(secondId);
  await Promise.resolve();
  assert.equal(h.panelRoot.dataset.state, 'error');
  assert.ok(h.logTexts().some((t) => t.includes('发送失败（provider-error）')));

  h.input.value = '三';
  h.input.dispatch('input');
  h.enter();
  const thirdId = c.calls.send[2]?.id ?? '';
  assert.equal(c.calls.send.length, 3);
  c.settle(thirdId, { id: thirdId, status: 'ok', text: '恢复了' });
  await Promise.resolve();
  assert.equal(h.panelRoot.dataset.state, 'reply');
});

test('7 回复区明确标注演示回复字样', async () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  h.input.value = 'q';
  h.input.dispatch('input');
  h.enter();
  const id = c.calls.send[0]?.id ?? '';
  c.settle(id, { id, status: 'ok', text: '这是回复正文' });
  await Promise.resolve();
  assert.ok(find(h.panelRoot, 'chat-log').textContent.includes('演示回复'));
  const tag = find(h.panelRoot, 'chat-demo-tag');
  assert.equal(tag.textContent, '演示回复');
  const bot = findAll(h.panelRoot, 'chat-entry').find((el) => el.classes.has('chat-entry-bot'));
  assert.ok(bot?.textContent.includes('这是回复正文'));
});

test('8 空输入与超 500 字符禁发并提示', () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  assert.equal(h.sendBtn.disabled, true);
  h.enter();
  assert.equal(c.calls.send.length, 0);

  h.input.value = 'a'.repeat(CHAT_MAX_INPUT_CHARS + 1);
  h.input.dispatch('input');
  assert.equal(h.sendBtn.disabled, true);
  assert.ok(find(h.panelRoot, 'chat-hint').textContent.includes(String(CHAT_MAX_INPUT_CHARS)));
  h.enter();
  assert.equal(c.calls.send.length, 0);

  h.input.value = 'a'.repeat(CHAT_MAX_INPUT_CHARS);
  h.input.dispatch('input');
  assert.equal(h.sendBtn.disabled, false);
  assert.equal(find(h.panelRoot, 'chat-hint').textContent, '');
});

test('9 unmount：撤销在途（cancel 被调）、移除 DOM；收起按钮同样撤销在途；再次 mount 可用', async () => {
  const c = createClient();
  const h = mount(c);
  h.open();
  h.input.value = '在途消息';
  h.input.dispatch('input');
  h.enter();
  const id = c.calls.send[0]?.id ?? '';
  h.unmount();
  assert.deepEqual(c.calls.cancel, [id]);
  assert.equal(h.root.children.length, 0);
  c.settle(id, { id, status: 'ok', text: '迟到' });
  await Promise.resolve();

  const c2 = createClient();
  const h2 = mount(c2);
  h2.open();
  h2.input.value = '重新挂载';
  h2.input.dispatch('input');
  h2.enter();
  const id2 = c2.calls.send[0]?.id ?? '';
  c2.settle(id2, { id: id2, status: 'ok', text: 'ok' });
  await Promise.resolve();
  assert.equal(h2.panelRoot.dataset.state, 'reply');
  assert.notEqual(id, id2);

  h2.input.value = '再取消一次';
  h2.input.dispatch('input');
  h2.enter();
  const id3 = c2.calls.send[1]?.id ?? '';
  h2.closeBtn.dispatch('click');
  assert.deepEqual(c2.calls.cancel, [id3]);
  assert.equal(find(h2.panelRoot, 'chat-panel').hidden, true);
  assert.equal(h2.panelRoot.dataset.state, 'closed');
});

test('纯函数：validateChatInput 边界与 enterShouldSend/phaseForResult 判定', () => {
  assert.equal(validateChatInput(''), 'empty');
  assert.equal(validateChatInput(' '.repeat(0)), 'empty');
  assert.equal(validateChatInput('a'.repeat(CHAT_MAX_INPUT_CHARS)), null);
  assert.equal(validateChatInput('a'.repeat(CHAT_MAX_INPUT_CHARS + 1)), 'too-long');

  assert.equal(enterShouldSend({ key: 'Enter', shiftKey: false }, false), true);
  assert.equal(enterShouldSend({ key: 'Enter', shiftKey: true }, false), false); // Shift+Enter 留给换行
  assert.equal(enterShouldSend({ key: 'a', shiftKey: false }, false), false);
  assert.equal(enterShouldSend({ key: 'Enter', shiftKey: false, isComposing: true }, false), false);
  assert.equal(enterShouldSend({ key: 'Enter', shiftKey: false }, true), false);
  assert.equal(enterShouldSend({ key: 'Enter', shiftKey: false, isComposing: false }, false), true);

  assert.equal(phaseForResult('ok'), 'reply');
  assert.equal(phaseForResult('error'), 'error');
  assert.equal(phaseForResult('cancelled'), 'cancelled');
});

test('10 视口约束：panelMaxHeight/resolveViewportHeight 边界，挂载按视口写入面板行内 max-height', () => {
  // 320×240 窗口：240 - 50 = 190，面板不再撑到 320 把标题顶出视口。
  assert.equal(CHAT_VIEWPORT_RESERVE_PX, 50);
  assert.equal(panelMaxHeight(240), 190);
  assert.equal(panelMaxHeight(900), CHAT_PANEL_MAX_HEIGHT_PX);
  assert.equal(panelMaxHeight(CHAT_VIEWPORT_RESERVE_PX + 100.9), 100);
  assert.equal(panelMaxHeight(CHAT_VIEWPORT_RESERVE_PX), 0); // 退化：宁可 0 也不越界
  assert.equal(panelMaxHeight(0), CHAT_PANEL_MAX_HEIGHT_PX);
  assert.equal(panelMaxHeight(Number.NaN), CHAT_PANEL_MAX_HEIGHT_PX);

  assert.equal(resolveViewportHeight(240), 240);
  assert.equal(resolveViewportHeight(Number.NaN), null);

  const small = mount(createClient(), { viewportHeight: 240 });
  assert.equal(small.panelBody.style.maxHeight, '190px');

  const big = mount(createClient(), { viewportHeight: 900 });
  assert.equal(big.panelBody.style.maxHeight, '320px');

  // 未注入时读真实视口（浏览器里等同 window.innerHeight）。
  const scope = globalThis as unknown as { innerHeight?: number };
  scope.innerHeight = 240;
  try {
    assert.equal(resolveViewportHeight(), 240);
    assert.equal(mount(createClient()).panelBody.style.maxHeight, '190px');
  } finally {
    delete scope.innerHeight;
  }

  // 拿不到视口高度时留空，交给 CSS 的 100vh 兜底，不写死像素。
  assert.equal('maxHeight' in mount(createClient()).panelBody.style, false);
});

test('11 结构：标题/关闭/滚动正文/输入/发送/取消齐备，正文列表为中间可滚动区，data-testid 契约不变', async () => {
  const c = createClient();
  const h = mount(c, { viewportHeight: 240 });
  const panelBody = h.panelBody;
  assert.deepEqual(
    panelBody.children.map((child) => child.className),
    ['chat-head', 'chat-note', 'chat-log', 'chat-composer'],
    '面板子项顺序：固定头 → 提示 → 可滚动正文 → 固定输入区',
  );
  const head = panelBody.children[0] as StubElement;
  assert.ok(find(head, 'chat-title').textContent.includes('文字对话预览'), '标题必须可见可读');
  assert.ok(find(head, 'chat-close'), '关闭按钮必须在面板头内');

  h.open();
  const composer = find(panelBody, 'chat-composer');
  assert.ok(find(composer, 'chat-input'));
  assert.ok(find(composer, 'chat-send'));
  assert.ok(find(composer, 'chat-cancel'));

  // data-testid 全部保留（D 的 E2E 依赖这些 id）。
  const testIds = collectTestIds(h.panelRoot);
  for (const id of ['chat-panel', 'chat-toggle', 'chat-panel-open', 'chat-input', 'chat-send', 'chat-cancel', 'chat-close']) {
    assert.ok(testIds.includes(id), `缺少 data-testid=${id}`);
  }

  h.input.value = '视口问答';
  h.input.dispatch('input');
  h.enter();
  assert.ok(collectTestIds(h.panelRoot).includes('chat-status'), '在途时应有 chat-status');
  const id = c.calls.send[0]?.id ?? '';
  c.settle(id, { id, status: 'ok', text: '回复正文' });
  await Promise.resolve();
  const afterSend = collectTestIds(h.panelRoot);
  for (const idName of ['chat-msg-user', 'chat-msg-assistant']) {
    assert.ok(afterSend.includes(idName), `发送后缺少 ${idName}`);
  }
  // 回复仍挂在滚动容器内（滚动的是列表，不是整块面板）。
  const botEntry = byTestId(panelBody, 'chat-msg-assistant');
  assert.equal(botEntry.parentNode, find(panelBody, 'chat-log'));
});

test('12 CSS 视口方案静态校验：面板高度受 100vh 约束，仅 chat-log 滚动，固定区不收缩，预留值与 TS 常量一致', () => {
  const css = chatPanelCss();
  const panel = cssRule(css, '.chat-panel');
  assert.match(panel, /max-height:\s*min\(320px,\s*calc\(100vh - var\(--chat-panel-reserve\)\)\)/, '面板高度必须随视口收缩');
  assert.match(panel, /overflow:\s*hidden/, '面板自身不滚动，避免固定区被裁');
  assert.match(panel, /display:\s*flex/);

  const root = cssRule(css, '.chat-panel-root');
  assert.match(root, /--chat-panel-reserve:\s*calc\(/, '预留必须由可见变量算出');
  assert.match(root, /bottom:\s*var\(--chat-gutter\)/);

  const log = cssRule(css, '.chat-log');
  assert.match(log, /flex:\s*1/, '正文列表吃掉剩余高度');
  assert.match(log, /min-height:\s*0/, 'flex 子项必须 min-height:0，否则把输入区顶出面板');
  assert.match(log, /overflow-y:\s*auto/, '正文列表必须内部滚动');

  for (const selector of ['.chat-head', '.chat-note', '.chat-composer']) {
    assert.match(cssRule(css, selector), /flex:\s*0 0 auto/, `${selector} 不得被压缩`);
  }

  // 预留 = 底边距 + 开关按钮 + 间隙 + 顶边距；与 chat-panel.ts 的 CHAT_VIEWPORT_RESERVE_PX 必须同源。
  const reserve =
    cssPx(css, '--chat-gutter') +
    cssPx(css, '--chat-toggle-size') +
    cssPx(css, '--chat-gap') +
    cssPx(css, '--chat-top-margin');
  assert.equal(reserve, CHAT_VIEWPORT_RESERVE_PX, `CSS 预留 ${reserve}px 与 TS 常量不一致`);
});

/** 读样式表原文（静态校验用，无需 DOM/CSS 引擎）。 */
function chatPanelCss(): string {
  return readFileSync(new URL('./chat-panel.css', import.meta.url), 'utf8');
}

/** 取顶层规则体（首个同名规则；@media 内同名规则不在校验范围）。 */
function cssRule(css: string, selector: string): string {
  const needle = `${selector} {`;
  const start = css.indexOf(needle);
  assert.ok(start >= 0, `CSS 缺少 ${selector} 规则`);
  const end = css.indexOf('}', start);
  return css.slice(start + needle.length, end);
}

/** 取自定义属性的 px 数值。 */
function cssPx(css: string, name: string): number {
  const match = new RegExp(`${name}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(css);
  const raw = match?.[1];
  assert.ok(raw !== undefined, `CSS 缺少 ${name}`);
  return Number(raw);
}

/** 按 data-testid 深度查找（testid 与 class 不同名时用）。 */
function byTestId(root: StubElement, id: string): StubElement {
  if (root.dataset.testid === id) return root;
  for (const child of root.children) {
    const hit = tryByTestId(child, id);
    if (hit) return hit;
  }
  return assert.fail(`missing data-testid=${id}`);
}

function tryByTestId(root: StubElement, id: string): StubElement | null {
  if (root.dataset.testid === id) return root;
  for (const child of root.children) {
    const hit = tryByTestId(child, id);
    if (hit) return hit;
  }
  return null;
}

/** 收集子树内所有 data-testid。 */
function collectTestIds(el: StubElement): string[] {
  const out: string[] = [];
  const own = el.dataset.testid;
  if (own !== undefined && own !== '') out.push(own);
  for (const child of el.children) out.push(...collectTestIds(child));
  return out;
}
