/**
 * 聊天面板单测：Node 无 DOM，自建最小 DOM 桩（仅本文件用，不新增依赖）。
 * 覆盖任务 9 条交互态 + 纯函数判定；请求结果用受控 Promise 驱动迟到/隔离场景。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_MAX_INPUT_CHARS, type ChatSendRequest, type ChatSendResult } from '../contracts/chat.ts';
import { enterShouldSend, mountChatPanel, phaseForResult, validateChatInput, type ChatPanelClient } from './chat-panel.ts';

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

function mount(controlled: Controlled): Harness {
  const root = new StubElement('div');
  const handle = mountChatPanel(root as unknown as HTMLElement, controlled.client);
  const panelRoot = root.children[0] ?? assert.fail('panel root missing');
  const open = () => find(panelRoot, 'chat-toggle').dispatch('click');
  return {
    root,
    panelRoot,
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
