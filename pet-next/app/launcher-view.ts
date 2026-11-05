/**
 * M3-7 首次启动配置页（视图层）：纯注入、无框架，DOM 全用 createElement+textContent。
 * 状态机：loading →（load-error 可重试）→ editing ⇄ probing；editing → starting → running|editing。
 * 只消费 contracts/launcher.ts 冻结形状；window.petLauncher 类型声明放本文件，不改公共 preload/main。
 * @module pet-next/app/launcher-view
 */
import type {
  LauncherConfig,
  LauncherErrorCode,
  LauncherExperience,
  LauncherLoadResult,
  LauncherProbeResult,
  LauncherSaveResult,
  LauncherStartOptions,
  LauncherStartResult,
} from '../contracts/launcher.ts';

/** preload 暴露给 launcher 页的桥（签名 = contracts/launcher.ts LauncherController 的页面子集）。 */
export interface PetLauncherBridge {
  loadConfig(): Promise<LauncherLoadResult>;
  saveConfig(config: LauncherConfig): Promise<LauncherSaveResult>;
  probe(config: LauncherConfig, model?: string): Promise<LauncherProbeResult>;
  start(config: LauncherConfig, options: LauncherStartOptions): Promise<LauncherStartResult>;
}

declare global {
  interface Window {
    /** M3-7：preload 暴露；普通宠物页面不加载本模块，可缺省。 */
    petLauncher?: PetLauncherBridge;
  }
}

/** 页面状态机：读配置 →（失败可重试）→ 编辑 ⇄ 探测 → 启动中 → 已启动（主进程随后销毁窗口）。 */
export type LauncherPageState = 'loading' | 'load-error' | 'editing' | 'probing' | 'starting' | 'running';

/** 表单原始值（全 string，端口提交时解析；空表单即首启引导态）。 */
export interface LauncherFormValues {
  host: string;
  port: string;
  user: string;
  identityFile: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
}

export type LauncherFieldKey = keyof LauncherFormValues;
/** 逐字段错误信息；空对象 = 可提交。 */
export type LauncherFieldErrors = Partial<Record<LauncherFieldKey, string>>;

/** 端口校验（纯函数）：1-65535 整数。 */
export function parsePortField(value: string): { ok: true; port: number } | { ok: false } {
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return { ok: false };
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false };
  return { ok: true, port };
}

/** 表单校验（纯函数）：identityFile 可选，其余必填；返回逐字段中文错误。 */
export function validateForm(values: LauncherFormValues): LauncherFieldErrors {
  const errors: LauncherFieldErrors = {};
  if (values.host.trim() === '') errors.host = '必填：SSH 服务器地址';
  if (!parsePortField(values.port).ok) errors.port = '必填：1-65535 的整数端口';
  if (values.user.trim() === '') errors.user = '必填：SSH 用户名';
  if (values.remoteHost.trim() === '') errors.remoteHost = '必填：远端服务主机';
  if (!parsePortField(values.localPort).ok) errors.localPort = '必填：1-65535 的整数端口';
  if (!parsePortField(values.remotePort).ok) errors.remotePort = '必填：1-65535 的整数端口';
  return errors;
}

/** 表单 → 冻结契约配置（纯函数）：文本去空白，identityFile 空串转 undefined。 */
export function buildConfig(
  values: LauncherFormValues,
): { ok: true; config: LauncherConfig } | { ok: false; errors: LauncherFieldErrors } {
  const errors = validateForm(values);
  const port = parsePortField(values.port);
  const localPort = parsePortField(values.localPort);
  const remotePort = parsePortField(values.remotePort);
  if (Object.keys(errors).length > 0 || !port.ok || !localPort.ok || !remotePort.ok) return { ok: false, errors };
  const identity = values.identityFile.trim();
  return {
    ok: true,
    config: {
      host: values.host.trim(),
      port: port.port,
      user: values.user.trim(),
      ...(identity === '' ? {} : { identityFile: identity }),
      localPort: localPort.port,
      remoteHost: values.remoteHost.trim(),
      remotePort: remotePort.port,
    },
  };
}

/** 已存配置 → 表单值（纯函数）：加载回填用。 */
export function configToForm(config: LauncherConfig): LauncherFormValues {
  return {
    host: config.host,
    port: String(config.port),
    user: config.user,
    identityFile: config.identityFile ?? '',
    localPort: String(config.localPort),
    remoteHost: config.remoteHost,
    remotePort: String(config.remotePort),
  };
}

/** 状态区摘要（纯函数）：user@host:port → remoteHost:remotePort；不含私钥路径等任何凭据。 */
export function summaryFor(config: LauncherConfig): string {
  return `${config.user}@${config.host}:${config.port} → ${config.remoteHost}:${config.remotePort}`;
}

/** 错误码 → 中文可行动提示（纯函数）：只说该做什么，code 由调用方一并显示。 */
export function launcherHintFor(code?: LauncherErrorCode | null): string {
  switch (code) {
    case 'auth-failed':
      return '认证失败：检查私钥路径与服务器授权后重试';
    case 'ssh-missing':
      return '未找到 ssh：安装 OpenSSH 客户端，或设置 PET_NEXT_SSH_BIN 指向可执行文件';
    case 'port-conflict':
      return '本地端口被占用：更换「本地转发端口」后重试';
    case 'not-ready':
      return '隧道未就绪：检查网络与远端服务是否可达';
    case 'config-invalid':
      return '配置不合法：按标红字段逐项修正';
    case 'file-unreadable':
      return '配置文件读取失败：检查 ~/.pet-next/qwen-remote.json 权限后重试';
    case 'write-failed':
      return '配置写入失败：检查磁盘空间与目录权限后重试';
    case 'busy':
      return '上一操作仍在进行，请稍候';
    case 'service-unavailable':
      return '模型服务不可用：确认远端服务已启动';
    case 'disconnected':
      return '连接已断开：请重试';
    case 'cancelled':
      return '已取消：可重试';
    default:
      return '请检查配置后重试';
  }
}

/** 错误展示文案：中文动作提示在前，code 在后便于排查。 */
export function launcherErrorText(action: string, code: LauncherErrorCode): string {
  return `${action}失败（${code}）：${launcherHintFor(code)}`;
}

/** 缺省启动选项：沿用现有 trial 入口（standard / context off），选项本身不触发任何模型调用。 */
export function defaultStartOptions(): LauncherStartOptions {
  return { experience: 'standard', chatContext: false };
}

/** Enter 是否提交当前表单动作（纯函数）：Shift+Enter 与中文组合输入期间不提交。 */
export function enterShouldSubmit(input: { key: string; shiftKey: boolean; isComposing?: boolean }, composing: boolean): boolean {
  if (input.key !== 'Enter') return false;
  if (input.shiftKey) return false;
  if (composing) return false;
  if (input.isComposing === true) return false;
  return true;
}

/** 首启引导文案（无配置文件时显示）。 */
export const LAUNCHER_GUIDE_NOTE =
  '首次使用：填写服务器的 SSH 连接信息，先「测试连接」，通过后点「启动」进入桌宠。配置只保存在本机 ~/.pet-next/qwen-remote.json，不会上传。';
/** 表单未填完整时状态区的摘要占位。 */
export const LAUNCHER_SUMMARY_PENDING = '（连接信息尚未填完整）';

interface FieldSpec {
  key: LauncherFieldKey;
  label: string;
  placeholder: string;
}

/** 连接字段顺序（tab 顺序即 DOM 顺序）：私钥只存路径，绝不读取内容。 */
const FIELDS: readonly FieldSpec[] = [
  { key: 'host', label: 'SSH 服务器', placeholder: '如 192.168.1.10 或 example.com' },
  { key: 'port', label: 'SSH 端口', placeholder: '如 22' },
  { key: 'user', label: 'SSH 用户名', placeholder: '如 root' },
  { key: 'identityFile', label: '私钥路径（可选）', placeholder: '如 ~/.ssh/id_ed25519（仅保存路径，不读取内容）' },
  { key: 'localPort', label: '本地转发端口', placeholder: '如 18873' },
  { key: 'remoteHost', label: '远端服务主机', placeholder: '如 127.0.0.1' },
  { key: 'remotePort', label: '远端服务端口', placeholder: '如 18872' },
];

/** 挂载句柄：state 供测试/E2E 读取；unmount 移除 DOM 与事件。 */
export interface LauncherPageHandle {
  state(): LauncherPageState;
  unmount(): void;
}

/**
 * 挂载 launcher 页面到 root。加载即调 bridge.loadConfig()：有配置回填、无配置空表单+引导、
 * 失败显示错误与「重试」。probe/start 共用一个操作位：进行中重复触发直接忽略（busy 不排队）。
 */
export function mountLauncher(root: HTMLElement, bridge: PetLauncherBridge): LauncherPageHandle {
  const pageRoot = document.createElement('div');
  pageRoot.className = 'launcher';
  pageRoot.dataset.testid = 'launcher';
  pageRoot.dataset.state = 'loading';
  pageRoot.dataset.experience = 'standard';
  pageRoot.dataset.context = 'off';

  const title = document.createElement('h1');
  title.className = 'launcher-title';
  title.textContent = 'pet-next 首次启动配置';
  pageRoot.appendChild(title);

  const guide = document.createElement('p');
  guide.className = 'launcher-guide';
  guide.dataset.testid = 'launcher-guide';
  guide.hidden = true;
  guide.textContent = LAUNCHER_GUIDE_NOTE;
  pageRoot.appendChild(guide);

  const form = document.createElement('form');
  form.className = 'launcher-form';
  form.setAttribute('novalidate', 'novalidate');

  // 连接字段：label(文本) + input + 逐字段错误行。
  const inputs = new Map<LauncherFieldKey, HTMLInputElement>();
  const fieldErrors = new Map<LauncherFieldKey, HTMLElement>();
  const fieldRows = new Map<LauncherFieldKey, HTMLElement>();
  const fieldsBox = document.createElement('fieldset');
  fieldsBox.className = 'launcher-fields';
  const legend = document.createElement('legend');
  legend.textContent = '连接信息';
  fieldsBox.appendChild(legend);
  for (const spec of FIELDS) {
    const row = document.createElement('div');
    row.className = 'launcher-field';
    row.dataset.field = spec.key;
    const label = document.createElement('label');
    label.className = 'launcher-label';
    label.setAttribute('for', `launcher-input-${spec.key}`);
    const label_text = document.createElement('span');
    label_text.textContent = spec.label;
    label.appendChild(label_text);
    const input = document.createElement('input');
    input.className = 'launcher-input';
    input.setAttribute('id', `launcher-input-${spec.key}`);
    input.dataset.testid = `launcher-field-${spec.key}`;
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', spec.placeholder);
    input.setAttribute('autocomplete', 'off');
    label.appendChild(input);
    row.appendChild(label);
    const err = document.createElement('div');
    err.className = 'launcher-field-error';
    err.dataset.testid = `launcher-field-error-${spec.key}`;
    row.appendChild(err);
    inputs.set(spec.key, input);
    fieldErrors.set(spec.key, err);
    fieldRows.set(spec.key, row);
    fieldsBox.appendChild(row);
  }
  form.appendChild(fieldsBox);

  // 预览选项（显式选择，radio/checkbox 原生键盘可达；不触发任何模型调用）。
  const optionsBox = document.createElement('fieldset');
  optionsBox.className = 'launcher-options';
  const optionsLegend = document.createElement('legend');
  optionsLegend.textContent = '预览选项（进入桌宠前可改）';
  optionsBox.appendChild(optionsLegend);

  const expLegend = document.createElement('div');
  expLegend.className = 'launcher-option-group';
  expLegend.textContent = '体验：';
  const standardRadio = document.createElement('input');
  standardRadio.setAttribute('type', 'radio');
  standardRadio.setAttribute('name', 'launcher-experience');
  standardRadio.setAttribute('id', 'launcher-experience-standard');
  standardRadio.dataset.testid = 'launcher-experience-standard';
  standardRadio.checked = true;
  const standardLabel = document.createElement('label');
  standardLabel.setAttribute('for', standardRadio.id);
  standardLabel.textContent = '标准对照';
  const companionRadio = document.createElement('input');
  companionRadio.setAttribute('type', 'radio');
  companionRadio.setAttribute('name', 'launcher-experience');
  companionRadio.setAttribute('id', 'launcher-experience-companion');
  companionRadio.dataset.testid = 'launcher-experience-companion';
  const companionLabel = document.createElement('label');
  companionLabel.setAttribute('for', companionRadio.id);
  companionLabel.textContent = '伙伴模式（companion）';
  expLegend.appendChild(standardRadio);
  expLegend.appendChild(standardLabel);
  expLegend.appendChild(companionRadio);
  expLegend.appendChild(companionLabel);
  optionsBox.appendChild(expLegend);

  const ctxGroup = document.createElement('div');
  ctxGroup.className = 'launcher-option-group';
  const ctxText = document.createElement('span');
  ctxText.textContent = '会话上下文：';
  const contextCheck = document.createElement('input');
  contextCheck.setAttribute('type', 'checkbox');
  contextCheck.setAttribute('id', 'launcher-context');
  contextCheck.dataset.testid = 'launcher-context';
  const contextLabel = document.createElement('label');
  contextLabel.setAttribute('for', contextCheck.id);
  contextLabel.textContent = '开启（桌宠记住当前会话）';
  ctxGroup.appendChild(ctxText);
  ctxGroup.appendChild(contextCheck);
  ctxGroup.appendChild(contextLabel);
  optionsBox.appendChild(ctxGroup);
  form.appendChild(optionsBox);

  // 动作区：测试连接 / 启动。
  const actions = document.createElement('div');
  actions.className = 'launcher-actions';
  const probeBtn = document.createElement('button');
  probeBtn.setAttribute('type', 'button');
  probeBtn.className = 'launcher-button launcher-probe';
  probeBtn.dataset.testid = 'launcher-probe';
  probeBtn.textContent = '测试连接';
  const startBtn = document.createElement('button');
  startBtn.setAttribute('type', 'button');
  startBtn.className = 'launcher-button launcher-start';
  startBtn.dataset.testid = 'launcher-start';
  startBtn.textContent = '启动';
  actions.appendChild(probeBtn);
  actions.appendChild(startBtn);
  form.appendChild(actions);
  pageRoot.appendChild(form);

  // 状态区：摘要（不含任何凭据）+ 阶段/结果，恒可见。
  const status = document.createElement('div');
  status.className = 'launcher-status';
  status.dataset.testid = 'launcher-status';
  const summary = document.createElement('div');
  summary.className = 'launcher-summary';
  summary.dataset.testid = 'launcher-summary';
  summary.textContent = LAUNCHER_SUMMARY_PENDING;
  const phase = document.createElement('div');
  phase.className = 'launcher-phase';
  phase.dataset.testid = 'launcher-phase';
  phase.textContent = '正在读取配置…';
  status.appendChild(summary);
  status.appendChild(phase);
  pageRoot.appendChild(status);

  // load 失败时的重试入口（只在 load-error 态可见）。
  const retryBtn = document.createElement('button');
  retryBtn.setAttribute('type', 'button');
  retryBtn.className = 'launcher-button launcher-retry';
  retryBtn.dataset.testid = 'launcher-retry';
  retryBtn.textContent = '重试';
  retryBtn.hidden = true;
  pageRoot.appendChild(retryBtn);

  root.appendChild(pageRoot);

  let phaseState: LauncherPageState = 'loading';
  let composing = false;
  let disposed = false;
  // 操作序号：probe/start 共用；迟到结果按序号丢弃（重试/卸载后的旧 Promise 不得覆盖新状态）。
  let opSeq = 0;

  const listeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  function on(target: EventTarget, type: string, handler: (ev: Event) => void): void {
    const wrapped = handler as EventListener;
    target.addEventListener(type, wrapped);
    listeners.push({ target, type, handler: wrapped });
  }

  function formValues(): LauncherFormValues {
    return {
      host: inputs.get('host')?.value ?? '',
      port: inputs.get('port')?.value ?? '',
      user: inputs.get('user')?.value ?? '',
      identityFile: inputs.get('identityFile')?.value ?? '',
      localPort: inputs.get('localPort')?.value ?? '',
      remoteHost: inputs.get('remoteHost')?.value ?? '',
      remotePort: inputs.get('remotePort')?.value ?? '',
    };
  }

  /** 逐字段标错：errors 为空时全部清除；data-invalid 供样式标红。 */
  function markFieldErrors(errors: LauncherFieldErrors): void {
    for (const spec of FIELDS) {
      const err = fieldErrors.get(spec.key);
      const row = fieldRows.get(spec.key);
      const text = errors[spec.key];
      if (err) err.textContent = text ?? '';
      if (row) row.dataset.invalid = text === undefined ? 'false' : 'true';
    }
  }

  function currentOptions(): LauncherStartOptions {
    const experience: LauncherExperience = companionRadio.checked ? 'companion' : 'standard';
    return { experience, chatContext: contextCheck.checked };
  }

  function setState(next: LauncherPageState): void {
    phaseState = next;
    pageRoot.dataset.state = next;
    const busy = next !== 'editing';
    probeBtn.disabled = busy;
    startBtn.disabled = busy;
    probeBtn.textContent = next === 'probing' ? '探测中…' : '测试连接';
    retryBtn.hidden = next !== 'load-error';
  }

  /** 摘要实时跟随表单：有效才给完整链路，否则占位（绝不显示半截凭据式文本）。 */
  function syncSummary(): void {
    const built = buildConfig(formValues());
    summary.textContent = built.ok ? summaryFor(built.config) : LAUNCHER_SUMMARY_PENDING;
  }

  function syncOptionMarks(): void {
    pageRoot.dataset.experience = companionRadio.checked ? 'companion' : 'standard';
    pageRoot.dataset.context = contextCheck.checked ? 'on' : 'off';
  }

  function load(): void {
    if (disposed) return;
    setState('loading');
    phase.textContent = '正在读取配置…';
    bridge.loadConfig().then(
      (result) => {
        if (disposed) return;
        if (!result.ok) {
          phase.textContent = launcherErrorText('读取配置', result.error.code);
          setState('load-error');
          return;
        }
        const config = result.config;
        guide.hidden = config !== null;
        if (config !== null) {
          const values = configToForm(config);
          for (const spec of FIELDS) {
            const input = inputs.get(spec.key);
            if (input) input.value = values[spec.key];
          }
        }
        markFieldErrors({});
        syncSummary();
        syncOptionMarks();
        phase.textContent = '';
        setState('editing');
        const first = inputs.get('host');
        if (first) first.focus();
      },
      () => {
        if (disposed) return;
        // 桥抛异常与 ok:false 同口径：显示错误与重试，不静默。
        phase.textContent = launcherErrorText('读取配置', 'service-unavailable');
        setState('load-error');
      },
    );
  }

  /** 探测：表单非法则逐字段标错（config-invalid 口径）且不发起调用；进行中重复触发忽略。 */
  function probeAction(): void {
    if (disposed || phaseState !== 'editing') return;
    const built = buildConfig(formValues());
    if (!built.ok) {
      markFieldErrors(built.errors);
      phase.textContent = launcherErrorText('连接', 'config-invalid');
      return;
    }
    setState('probing');
    phase.textContent = '探测中…';
    const seq = ++opSeq;
    bridge.probe(built.config).then(
      (result) => {
        if (disposed || seq !== opSeq || phaseState !== 'probing') return;
        if (result.ok) {
          phase.textContent = `连接成功，模型：${result.model}`;
        } else {
          phase.textContent = launcherErrorText('连接', result.error.code);
          if (result.error.code === 'config-invalid') markFieldErrors(validateForm(formValues()));
        }
        setState('editing');
      },
      () => {
        if (disposed || seq !== opSeq || phaseState !== 'probing') return;
        phase.textContent = launcherErrorText('连接', 'service-unavailable');
        setState('editing');
      },
    );
  }

  /** 启动链：save 失败停在页面；save 成功才 start；start 成功进入 running（主进程随后销毁窗口）。 */
  function startAction(): void {
    if (disposed || phaseState !== 'editing') return;
    const built = buildConfig(formValues());
    if (!built.ok) {
      markFieldErrors(built.errors);
      phase.textContent = launcherErrorText('启动', 'config-invalid');
      return;
    }
    const options = currentOptions();
    setState('starting');
    phase.textContent = '正在保存配置…';
    const seq = ++opSeq;
    bridge.saveConfig(built.config).then(
      (saved) => {
        if (disposed || seq !== opSeq || phaseState !== 'starting') return;
        if (!saved.ok) {
          phase.textContent = launcherErrorText('保存配置', saved.error.code);
          setState('editing');
          return;
        }
        phase.textContent = '正在建立连接并启动…';
        bridge.start(built.config, options).then(
          (started) => {
            if (disposed || seq !== opSeq || phaseState !== 'starting') return;
            if (started.ok) {
              phase.textContent = '已启动，正在进入桌宠…';
              setState('running');
              return;
            }
            phase.textContent = launcherErrorText('启动', started.error.code);
            setState('editing');
          },
          () => {
            if (disposed || seq !== opSeq || phaseState !== 'starting') return;
            phase.textContent = launcherErrorText('启动', 'service-unavailable');
            setState('editing');
          },
        );
      },
      () => {
        if (disposed || seq !== opSeq || phaseState !== 'starting') return;
        phase.textContent = launcherErrorText('保存配置', 'write-failed');
        setState('editing');
      },
    );
  }

  /** 回车提交当前表单动作：启动为主动作（非法表单也会逐字段标错给出反馈）。 */
  function handleKeydown(ev: Event): void {
    const key = ev as KeyboardEvent;
    if (!enterShouldSubmit({ key: key.key, shiftKey: key.shiftKey, isComposing: key.isComposing }, composing)) return;
    ev.preventDefault();
    startAction();
  }

  on(probeBtn, 'click', probeAction);
  on(startBtn, 'click', startAction);
  on(retryBtn, 'click', load);
  on(form, 'keydown', handleKeydown);
  on(form, 'submit', (ev) => {
    ev.preventDefault();
    startAction();
  });
  for (const spec of FIELDS) {
    const input = inputs.get(spec.key);
    if (!input) continue;
    on(input, 'input', () => {
      markFieldErrors({});
      syncSummary();
    });
    on(input, 'compositionstart', () => {
      composing = true;
    });
    on(input, 'compositionend', () => {
      composing = false;
    });
  }
  for (const radio of [standardRadio, companionRadio]) {
    on(radio, 'change', syncOptionMarks);
  }
  on(contextCheck, 'change', syncOptionMarks);

  syncSummary();
  load();

  return {
    state() {
      return phaseState;
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      opSeq += 1; // 在途 probe/start 的迟到结果一律丢弃
      for (const item of listeners) item.target.removeEventListener(item.type, item.handler);
      listeners.length = 0;
      pageRoot.remove();
    },
  };
}
