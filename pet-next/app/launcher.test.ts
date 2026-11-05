/**
 * launcher 首启配置页单测：Node 无 DOM，自建最小 DOM 桩（与 chat-panel.test.ts 同法，不新增依赖）。
 * mock window.petLauncher 桥（按 contracts/launcher.ts 形状，受控 Promise），
 * 覆盖：加载回填/空表单/load 失败重试、探测中禁用与提示、启动中禁用、保存失败停留、启动失败可重试、
 * 选项缺省（standard/off）与显式选择、回车提交，以及纯函数边界。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  LauncherConfig,
  LauncherLoadResult,
  LauncherProbeResult,
  LauncherSaveResult,
  LauncherStartResult,
} from '../contracts/launcher.ts';
import {
  buildConfig,
  configToForm,
  defaultStartOptions,
  enterShouldSubmit,
  launcherErrorText,
  launcherHintFor,
  mountLauncher,
  parsePortField,
  summaryFor,
  validateForm,
  type PetLauncherBridge,
} from './launcher-view.ts';

interface StubEvent extends Record<string, unknown> {
  type: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** 最小 DOM 元素桩：只实现页面用到的那几个接口（checked/id 为表单控件补充）。 */
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
  checked = false;
  focused = false;
  id = '';

  constructor(tag: string) {
    this.tagName = tag;
  }

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

interface Def<T> {
  resolve(value: T): void;
  reject(error?: unknown): void;
}

function defer<T>(): { promise: Promise<T>; d: Def<T> } {
  let d!: Def<T>;
  const promise = new Promise<T>((resolve, reject) => {
    d = { resolve, reject };
  });
  return { promise, d };
}

interface Controlled {
  calls: {
    load: number[];
    save: LauncherConfig[];
    probe: LauncherConfig[];
    start: { config: LauncherConfig; options: unknown }[];
  };
  bridge: PetLauncherBridge;
  loads: Def<LauncherLoadResult>[];
  saves: Def<LauncherSaveResult>[];
  probes: Def<LauncherProbeResult>[];
  starts: Def<LauncherStartResult>[];
}

function createBridge(): Controlled {
  const calls = { load: [] as number[], save: [] as LauncherConfig[], probe: [] as LauncherConfig[], start: [] as { config: LauncherConfig; options: unknown }[] };
  const loads: Def<LauncherLoadResult>[] = [];
  const saves: Def<LauncherSaveResult>[] = [];
  const probes: Def<LauncherProbeResult>[] = [];
  const starts: Def<LauncherStartResult>[] = [];
  const bridge: PetLauncherBridge = {
    loadConfig() {
      calls.load.push(1);
      const { promise, d } = defer<LauncherLoadResult>();
      loads.push(d);
      return promise;
    },
    saveConfig(config) {
      calls.save.push(config);
      const { promise, d } = defer<LauncherSaveResult>();
      saves.push(d);
      return promise;
    },
    probe(config) {
      calls.probe.push(config);
      const { promise, d } = defer<LauncherProbeResult>();
      probes.push(d);
      return promise;
    },
    start(config, options) {
      calls.start.push({ config, options });
      const { promise, d } = defer<LauncherStartResult>();
      starts.push(d);
      return promise;
    },
  };
  return { calls, bridge, loads, saves, probes, starts };
}

const CONFIG: LauncherConfig = {
  host: 'server.example.com',
  port: 22,
  user: 'root',
  identityFile: '/home/me/.ssh/id_ed25519',
  localPort: 18873,
  remoteHost: '127.0.0.1',
  remotePort: 18872,
};

interface Harness {
  c: Controlled;
  page: StubElement;
  handle: { state(): string; unmount(): void };
  field(key: string): StubElement;
  fieldError(key: string): StubElement;
  button(id: string): StubElement;
  radio(id: string): StubElement;
  phaseText(): string;
  summaryText(): string;
  clickProbe(): void;
  clickStart(): void;
  setField(key: string, value: string): void;
}

async function boot(result: LauncherLoadResult = { ok: true, config: CONFIG }): Promise<Harness> {
  const c = createBridge();
  const root = new StubElement('div');
  const handle = mountLauncher(root as unknown as HTMLElement, c.bridge);
  c.loads[0]?.resolve(result);
  await Promise.resolve();
  const page = root.children[0] ?? assert.fail('launcher root missing');
  const byTestId = (id: string): StubElement => {
    const hit = find(page, (el) => el.dataset.testid === id);
    assert.ok(hit, `missing data-testid=${id}`);
    return hit;
  };
  return {
    c,
    page,
    handle,
    field: (key) => byTestId(`launcher-field-${key}`),
    fieldError: (key) => byTestId(`launcher-field-error-${key}`),
    button: (id) => byTestId(id),
    radio: (id) => find(page, (el) => el.attrs['id'] === id) ?? assert.fail(`missing #${id}`),
    phaseText: () => byTestId('launcher-phase').textContent,
    summaryText: () => byTestId('launcher-summary').textContent,
    clickProbe: () => byTestId('launcher-probe').dispatch('click'),
    clickStart: () => byTestId('launcher-start').dispatch('click'),
    setField: (key, value) => {
      const input = byTestId(`launcher-field-${key}`);
      input.value = value;
      input.dispatch('input');
    },
  };
}

function find(root: StubElement, pred: (el: StubElement) => boolean): StubElement | null {
  if (pred(root)) return root;
  for (const child of root.children) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return null;
}

test('1 加载回填：有配置时各字段回填、摘要正确、无引导、聚焦首字段', async () => {
  const h = await boot();
  assert.equal(h.handle.state(), 'editing');
  assert.equal(h.page.dataset.state, 'editing');
  assert.equal(h.field('host').value, 'server.example.com');
  assert.equal(h.field('port').value, '22');
  assert.equal(h.field('user').value, 'root');
  assert.equal(h.field('identityFile').value, '/home/me/.ssh/id_ed25519');
  assert.equal(h.field('localPort').value, '18873');
  assert.equal(h.field('remoteHost').value, '127.0.0.1');
  assert.equal(h.field('remotePort').value, '18872');
  assert.equal(h.summaryText(), 'root@server.example.com:22 → 127.0.0.1:18872');
  assert.equal(find(h.page, (el) => el.dataset.testid === 'launcher-guide')?.hidden, true);
  assert.equal(h.field('host').focused, true);
  assert.equal(h.phaseText(), '');
  // 不显示任何凭据内容：摘要不含私钥路径。
  assert.ok(!h.summaryText().includes('id_ed25519'));
});

test('2 无配置：空表单 + 引导文案 + 摘要占位，选项缺省 standard/off', async () => {
  const h = await boot({ ok: true, config: null });
  assert.equal(h.handle.state(), 'editing');
  for (const key of ['host', 'port', 'user', 'identityFile', 'localPort', 'remoteHost', 'remotePort']) {
    assert.equal(h.field(key).value, '', `${key} 应为空`);
    assert.ok(h.field(key).attrs['placeholder'], `${key} 应有占位提示`);
  }
  const guide = find(h.page, (el) => el.dataset.testid === 'launcher-guide');
  assert.ok(guide);
  assert.equal(guide?.hidden, false);
  assert.ok((guide?.textContent ?? '').includes('测试连接'));
  assert.equal(h.summaryText(), '（连接信息尚未填完整）');
  assert.equal(h.page.dataset.experience, 'standard');
  assert.equal(h.page.dataset.context, 'off');
  assert.equal(h.radio('launcher-experience-standard').checked, true);
  assert.equal(h.radio('launcher-experience-companion').checked, false);
});

test('3 load 失败：显示错误码与重试按钮；重试成功后进入编辑', async () => {
  const h = await boot({ ok: false, error: { code: 'file-unreadable', message: 'boom' } });
  assert.equal(h.handle.state(), 'load-error');
  assert.ok(h.phaseText().includes('file-unreadable'));
  assert.ok(h.phaseText().includes('qwen-remote.json'));
  const retry = h.button('launcher-retry');
  assert.equal(retry.hidden, false);
  assert.equal(h.button('launcher-probe').disabled, true);
  assert.equal(h.button('launcher-start').disabled, true);

  retry.dispatch('click');
  assert.equal(h.c.calls.load.length, 2);
  assert.equal(h.handle.state(), 'loading');
  h.c.loads[1]?.resolve({ ok: true, config: CONFIG });
  await Promise.resolve();
  assert.equal(h.handle.state(), 'editing');
  assert.equal(h.summaryText(), 'root@server.example.com:22 → 127.0.0.1:18872');
  assert.equal(h.button('launcher-retry').hidden, true);
});

test('4 探测中禁用：按钮文本「探测中…」且不得重复触发', async () => {
  const h = await boot();
  h.clickProbe();
  assert.equal(h.c.calls.probe.length, 1);
  assert.equal(h.handle.state(), 'probing');
  assert.equal(h.button('launcher-probe').disabled, true);
  assert.equal(h.button('launcher-probe').textContent, '探测中…');
  assert.equal(h.button('launcher-start').disabled, true);
  assert.ok(h.phaseText().includes('探测中'));
  // 探测中重复点击（含启动按钮）不产生第二次调用。
  h.clickProbe();
  h.clickProbe();
  h.clickStart();
  assert.equal(h.c.calls.probe.length, 1);
  assert.equal(h.c.calls.start.length, 0);

  h.c.probes[0]?.resolve({ ok: true, model: 'qwen3.8-27b', models: ['qwen3.8-27b'] });
  await Promise.resolve();
  assert.equal(h.handle.state(), 'editing');
  assert.equal(h.button('launcher-probe').disabled, false);
  assert.equal(h.button('launcher-probe').textContent, '测试连接');
  assert.equal(h.button('launcher-start').disabled, false);
  assert.equal(h.phaseText(), '连接成功，模型：qwen3.8-27b');
});

test('5 探测失败：错误码 + 可读修正提示（auth/ssh/port/not-ready 各自口径）', async () => {
  const cases: Array<{ code: 'auth-failed' | 'ssh-missing' | 'port-conflict' | 'not-ready'; hit: string }> = [
    { code: 'auth-failed', hit: '私钥' },
    { code: 'ssh-missing', hit: 'PET_NEXT_SSH_BIN' },
    { code: 'port-conflict', hit: '本地转发端口' },
    { code: 'not-ready', hit: '网络' },
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const item = cases[i];
    assert.ok(item, 'cases indexed');
    const h = await boot();
    h.clickProbe();
    h.c.probes[0]?.resolve({ ok: false, error: { code: item.code, message: 'x' } });
    await Promise.resolve();
    assert.equal(h.handle.state(), 'editing', `${item.code} 后应回到可修正状态`);
    assert.ok(h.phaseText().includes(item.code), `${item.code} 应显示错误码`);
    assert.ok(h.phaseText().includes(item.hit), `${item.code} 应含修正提示`);
    assert.ok(h.phaseText().startsWith('连接失败'), `${item.code} 前缀`);
  }
});

test('6 表单非法点探测：逐字段标错、不发 probe、config-invalid 提示', async () => {
  const h = await boot({ ok: true, config: null });
  h.clickProbe();
  assert.equal(h.c.calls.probe.length, 0);
  assert.ok(h.phaseText().includes('config-invalid'));
  assert.equal(h.fieldError('host').textContent, '必填：SSH 服务器地址');
  assert.equal(h.fieldError('port').textContent, '必填：1-65535 的整数端口');
  const row = find(h.page, (el) => el.dataset.field === 'host');
  assert.equal(row?.dataset.invalid, 'true');
  // 补齐后错误清除且可发起探测。
  h.setField('host', 'h1');
  h.setField('port', '22');
  h.setField('user', 'u');
  h.setField('localPort', '18873');
  h.setField('remoteHost', '127.0.0.1');
  h.setField('remotePort', '18872');
  assert.equal(h.fieldError('host').textContent, '');
  assert.equal(h.summaryText(), 'u@h1:22 → 127.0.0.1:18872');
  h.clickProbe();
  assert.equal(h.c.calls.probe.length, 1);
});

test('7 启动中禁用：save → start 链路按序，成功显示已启动且按钮保持禁用', async () => {
  const h = await boot();
  h.clickStart();
  assert.equal(h.handle.state(), 'starting');
  assert.equal(h.button('launcher-start').disabled, true);
  assert.equal(h.button('launcher-probe').disabled, true);
  assert.ok(h.phaseText().includes('保存'));
  assert.equal(h.c.calls.save.length, 1);
  assert.equal(h.c.calls.start.length, 0);

  h.c.saves[0]?.resolve({ ok: true });
  await Promise.resolve();
  assert.equal(h.c.calls.start.length, 1);
  assert.ok(h.phaseText().includes('正在建立连接并启动'));
  assert.deepEqual(h.c.calls.start[0]?.options, { experience: 'standard', chatContext: false });

  h.c.starts[0]?.resolve({ ok: true, baseUrl: 'http://127.0.0.1:18873', model: 'qwen3.8-27b', options: { experience: 'standard', chatContext: false, model: 'qwen3.8-27b' } });
  await Promise.resolve();
  assert.equal(h.handle.state(), 'running');
  assert.equal(h.phaseText(), '已启动，正在进入桌宠…');
  assert.equal(h.button('launcher-start').disabled, true);
  assert.equal(h.button('launcher-probe').disabled, true);
});

test('8 启动失败可重试：显示错误码修正提示，允许修正后再次启动', async () => {
  const h = await boot();
  h.clickStart();
  h.c.saves[0]?.resolve({ ok: true });
  await Promise.resolve();
  h.c.starts[0]?.resolve({ ok: false, error: { code: 'not-ready', message: 'x' } });
  await Promise.resolve();
  assert.equal(h.handle.state(), 'editing');
  assert.ok(h.phaseText().startsWith('启动失败（not-ready）'));
  assert.equal(h.button('launcher-start').disabled, false);

  h.setField('localPort', '18874');
  h.clickStart();
  assert.equal(h.c.calls.save.length, 2);
  h.c.saves[1]?.resolve({ ok: true });
  await Promise.resolve();
  assert.equal(h.c.calls.start.length, 2);
  assert.deepEqual(h.c.calls.start[1]?.config, { ...CONFIG, localPort: 18874 });
});

test('9 保存失败停留：不调 start、显示保存失败、回到编辑态', async () => {
  const h = await boot();
  h.clickStart();
  h.c.saves[0]?.resolve({ ok: false, error: { code: 'write-failed', message: 'x' } });
  await Promise.resolve();
  assert.equal(h.c.calls.start.length, 0);
  assert.equal(h.handle.state(), 'editing');
  assert.ok(h.phaseText().startsWith('保存配置失败（write-failed）'));
  assert.ok(h.phaseText().includes('磁盘'));
  assert.equal(h.button('launcher-start').disabled, false);
});

test('10 选项缺省与显式选择：standard/off 缺省，改选后 start 收到所选值，选项本身不触发调用', async () => {
  const h = await boot();
  assert.equal(h.page.dataset.experience, 'standard');
  assert.equal(h.page.dataset.context, 'off');
  assert.deepEqual(defaultStartOptions(), { experience: 'standard', chatContext: false });

  const companion = h.radio('launcher-experience-companion');
  companion.checked = true;
  companion.dispatch('change');
  const context = find(h.page, (el) => el.attrs['id'] === 'launcher-context');
  assert.ok(context);
  context.checked = true;
  context.dispatch('change');
  assert.equal(h.page.dataset.experience, 'companion');
  assert.equal(h.page.dataset.context, 'on');
  // 切换选项不产生任何模型调用。
  assert.equal(h.c.calls.probe.length, 0);
  assert.equal(h.c.calls.start.length, 0);

  h.clickStart();
  h.c.saves[0]?.resolve({ ok: true });
  await Promise.resolve();
  assert.deepEqual(h.c.calls.start[0]?.options, { experience: 'companion', chatContext: true });
});

test('11 回车提交当前动作：Enter 触发启动链；Shift+Enter 与中文组合输入不触发', async () => {
  const h = await boot();
  const form = find(h.page, (el) => el.tagName === 'form');
  assert.ok(form);
  const ev = form?.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
  assert.equal(ev?.defaultPrevented, true);
  assert.equal(h.c.calls.save.length, 1);

  form?.dispatch('keydown', { key: 'Enter', shiftKey: true });
  form?.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: true });
  assert.equal(h.c.calls.save.length, 1);

  // 清掉第一轮再验证组合状态路径。
  h.c.saves[0]?.resolve({ ok: true });
  await Promise.resolve();
  h.c.starts[0]?.resolve({ ok: false, error: { code: 'busy', message: 'x' } });
  await Promise.resolve();
  const host = h.field('host');
  host.dispatch('compositionstart');
  form?.dispatch('keydown', { key: 'Enter', shiftKey: false });
  assert.equal(h.c.calls.save.length, 1);
  host.dispatch('compositionend');
  form?.dispatch('keydown', { key: 'Enter', shiftKey: false });
  assert.equal(h.c.calls.save.length, 2);
});

test('12 unmount：移除 DOM；在途结果迟到不抛错', async () => {
  const h = await boot();
  h.clickProbe();
  h.handle.unmount();
  assert.equal(h.page.parentNode, null);
  h.c.probes[0]?.resolve({ ok: true, model: 'm', models: ['m'] });
  await Promise.resolve();
  assert.equal(h.handle.state(), 'probing'); // 卸载后状态不再变化
});

test('纯函数：parsePortField/validateForm/buildConfig/configToForm/summaryFor/错误文案边界', () => {
  assert.equal(parsePortField('22').ok, true);
  const trimmed = parsePortField(' 22 ');
  assert.ok(trimmed.ok && trimmed.port === 22);
  assert.equal(parsePortField('0').ok, false);
  assert.equal(parsePortField('65536').ok, false);
  assert.equal(parsePortField('65535').ok, true);
  assert.equal(parsePortField('1.5').ok, false);
  assert.equal(parsePortField('abc').ok, false);
  assert.equal(parsePortField('').ok, false);

  const values = configToForm(CONFIG);
  assert.deepEqual(values, {
    host: 'server.example.com',
    port: '22',
    user: 'root',
    identityFile: '/home/me/.ssh/id_ed25519',
    localPort: '18873',
    remoteHost: '127.0.0.1',
    remotePort: '18872',
  });
  assert.equal(Object.keys(validateForm(values)).length, 0);

  const built = buildConfig(values);
  assert.equal(built.ok, true);
  if (built.ok) assert.deepEqual(built.config, CONFIG);

  // identityFile 空串 → 不带该字段（undefined）。
  const noIdentity = buildConfig({ ...values, identityFile: '  ' });
  assert.equal(noIdentity.ok && noIdentity.config.identityFile, undefined);

  const bad = buildConfig({ ...values, host: ' ', port: '99999' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.host, '必填：SSH 服务器地址');
    assert.equal(bad.errors.port, '必填：1-65535 的整数端口');
    assert.equal(bad.errors.user, undefined);
  }

  assert.equal(summaryFor(CONFIG), 'root@server.example.com:22 → 127.0.0.1:18872');
  assert.equal(summaryFor({ ...CONFIG, identityFile: '/x' }).includes('/x'), false, '摘要不含私钥路径');

  assert.ok(launcherHintFor('ssh-missing').includes('PET_NEXT_SSH_BIN'));
  assert.ok(launcherHintFor('port-conflict').includes('本地转发端口'));
  assert.ok(launcherHintFor('unknown-code' as 'auth-failed').includes('重试'), '未知码给通用提示');
  assert.equal(launcherErrorText('连接', 'auth-failed'), '连接失败（auth-failed）：认证失败：检查私钥路径与服务器授权后重试');

  assert.equal(enterShouldSubmit({ key: 'Enter', shiftKey: false }, false), true);
  assert.equal(enterShouldSubmit({ key: 'Enter', shiftKey: true }, false), false);
  assert.equal(enterShouldSubmit({ key: 'Enter', shiftKey: false, isComposing: true }, false), false);
  assert.equal(enterShouldSubmit({ key: 'Enter', shiftKey: false }, true), false);
  assert.equal(enterShouldSubmit({ key: 'a', shiftKey: false }, false), false);
});
