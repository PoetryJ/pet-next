/**
 * 端侧语音播报：只有「用户在本端点了按钮」才出声。
 *
 * 手动入口（右键菜单的碎碎念 / 对话）在发起端打一个一次性标记；回复落到 say 叶子时，
 * 同一端消费并播放。两端各有一份实例，没发起的端没有标记，所以不会双播——不需要互斥。
 * 周期碎碎念、斜杠命令、第三方广播都不打标记，一律静默。
 * 不负责合成与缓存：那些在宿主侧（`/voice/speak`）。
 * @module dsh-pet/src/shared/voice
 */
import { ROUTE_PATH } from './constants.ts';

/** 待播标记的有效期（ms）：生成失败时，标记不至于挂到下一句上去。 */
const PENDING_TTL_MS = 30_000;

/** 当前音色；空串 = 不指定，由宿主用默认音色。 */
let voiceName = '';
/** 播报总开关；只有成品配置明确为 true 才播。 */
let voiceEnabled = false;
/** 待播标记的时间戳；`null` = 本端没有待播。 */
let pendingAtMs: number | null = null;
/** 接口基址：网页端是同源前缀，桌面端由 `setVoiceBase` 换成 bridge 地址。 */
let voiceBase = ROUTE_PATH;
/** 配置是否已就绪；网页端由 `setVoiceConfig` 置位，桌面端首次播放时懒加载。 */
let configLoaded = false;
/** 当前播报状态；`idle` = 这一句与语音无关（周期碎碎念等），气泡上不出现任何图标。 */
let voiceState: VoiceState = 'idle';
/** 状态订阅者：两端的说话气泡据此渲染图标。 */
const stateListeners = new Set<(state: VoiceState) => void>();

/** 语音播报对外的三种状态；只用于展示，不接受外部驱动。 */
export type VoiceState = 'idle' | 'loading' | 'ready';

/** 切换状态并通知订阅者；同值不重复通知。 */
function setVoiceState(next: VoiceState): void {
  if (voiceState === next) return;
  voiceState = next;
  for (const listener of stateListeners) listener(next);
}

/**
 * 读当前播报状态；桌面端在重绘气泡时直接取（它没有 react 的订阅机制）。
 * @returns `idle` / `loading` / `ready`。
 */
export function getVoiceState(): VoiceState {
  return voiceState;
}

/**
 * 订阅播报状态；订阅时会立刻收到当前值。
 * @param listener - 状态变化回调。
 * @returns 取消订阅；组件卸载/气泡关闭时必须调用。
 */
export function subscribeVoiceState(listener: (state: VoiceState) => void): () => void {
  stateListeners.add(listener);
  listener(voiceState);
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * 换掉接口基址；桌面端在模块加载时调一次（`file://` 页面不能用相对路径）。
 * @param base - 已含前缀的地址，如 `dsh-pet-bridge://dsh-pet/dsh-pet-7340`。
 */
export function setVoiceBase(base: unknown): void {
  if (typeof base === 'string' && base) voiceBase = base;
}

/**
 * 记录成品配置里的语音设置；两端在读到 `/config` 时各调一次。
 * 调用即视为配置已就绪，后续播放不再自己去拉。
 * @param name - 音色 id（非字符串按未指定处理）。
 * @param enabled - 播报总开关（严格 `=== true` 才算开启）。
 */
export function setVoiceConfig(name: unknown, enabled: unknown): void {
  voiceName = typeof name === 'string' ? name : '';
  voiceEnabled = enabled === true;
  configLoaded = true;
}

/** 打一个「下一句归本端播」的标记；只对紧接着的一次说话生效。 */
export function markVoicePending(): void {
  pendingAtMs = Date.now();
}

/** 撤掉待播标记；请求失败时用，避免它被下一句内容误消费。 */
export function clearVoicePending(): void {
  pendingAtMs = null;
}

/**
 * 若存在未过期的待播标记，合成并播放这一句。
 *
 * 标记是**一次性**的：读到的瞬间就清掉，无论后面播不播得出来——否则一次失败会让
 * 后续每一句都被误播。
 *
 * @param text - 说话叶子里的文本。
 */
export function playPendingVoice(text: string): void {
  if (pendingAtMs === null) {
    // 这一句与语音无关（周期碎碎念 / 命令 / 广播）：气泡上不该留任何图标
    setVoiceState('idle');
    return;
  }
  const isExpired = Date.now() - pendingAtMs > PENDING_TTL_MS;
  pendingAtMs = null;
  if (isExpired || !text) {
    setVoiceState('idle');
    return;
  }
  void speakIfEnabled(text); // 不 await：播放是旁路，不能挡住气泡与动画
}

/** 确认配置后再播；桌面端首次调用会顺手拉一次 `/config`。 */
async function speakIfEnabled(text: string): Promise<void> {
  await loadConfigOnce();
  if (!voiceEnabled) {
    setVoiceState('idle');
    return;
  }
  setVoiceState('loading');
  await speak(text);
}

/** 懒加载成品配置；失败按「不播」处理，且只试一次（避免每句都发请求）。 */
async function loadConfigOnce(): Promise<void> {
  if (configLoaded) return;
  configLoaded = true;
  try {
    const response = await fetch(voiceBase + '/config', { cache: 'no-store' });
    const body = (await response.json()) as { main?: Record<string, unknown> } | null;
    const main = body?.main;
    voiceName = typeof main?.voiceName === 'string' ? main.voiceName : '';
    voiceEnabled = main?.voiceEnabled === true;
  } catch {
    /* 拉不到就保持关闭：宁可没声音，也不乱播 */
  }
}

/** 手动点播时正在响的那个音频；新的一句先掐掉旧的，避免两句话叠在一起。 */
let manualAudio: HTMLAudioElement | null = null;

/** 手动点播对外暴露的阶段；`idle` = 没在放（含被打断与失败）。 */
export type SpeakPhase = 'idle' | 'loading' | 'playing';

/** 手动点播的世代号：新的点播会作废旧请求的阶段回调，避免旧回调清掉新状态。 */
let manualSeq = 0;

/**
 * 手动播报一句（对话面板的喇叭按钮用）。
 *
 * 与自动播报有两点不同：不看待播标记（用户点的就是这一句），也不受总开关限制——
 * 开关管的是「自动念不念」，用户主动点播是明确意图。音色仍取配置值。
 *
 * @param text - 要念的正文。
 * @param onPhase - 阶段回调：请求合成时 `loading`、音频就绪开始播时 `playing`、结束或失败 `idle`。
 */
export function speakText(text: string, onPhase?: (phase: SpeakPhase) => void): void {
  if (!text) return;
  void playManual(text, onPhase);
}

/** 请求合成并播放手动点播；失败静默，不打断面板交互。 */
async function playManual(text: string, onPhase?: (phase: SpeakPhase) => void): Promise<void> {
  const token = ++manualSeq;
  await loadConfigOnce();
  if (manualAudio) {
    manualAudio.pause();
    manualAudio = null;
  }
  if (token !== manualSeq) return; // 等配置期间又被点了一次：这次直接让位
  onPhase?.('loading');
  try {
    const response = await fetch(voiceBase + '/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voiceName ? { voice: voiceName } : {}) }),
    });
    if (token !== manualSeq) return;
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio')) {
      onPhase?.('idle');
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    if (token !== manualSeq) return;
    const audio = new Audio(objectUrl);
    audio.onended = () => {
      URL.revokeObjectURL(objectUrl);
      if (manualAudio === audio) {
        manualAudio = null;
        onPhase?.('idle');
      }
    };
    audio.onerror = () => URL.revokeObjectURL(objectUrl);
    manualAudio = audio;
    onPhase?.('playing');
    await audio.play();
  } catch {
    /* 手动点播失败静默：面板里还有文字，不能弹错误打断阅读 */
    if (token === manualSeq) onPhase?.('idle');
  }
}

/** 请求合成并播放；任何一步失败都静默收场，状态回 idle（气泡上不留假图标）。 */
async function speak(text: string): Promise<void> {
  try {
    const response = await fetch(voiceBase + '/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voiceName ? { voice: voiceName } : {}) }),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio')) {
      setVoiceState('idle');
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const audio = new Audio(objectUrl);
    // 播完或出错都要释放，否则每句留一个 blob 引用
    audio.onended = () => URL.revokeObjectURL(objectUrl);
    audio.onerror = () => URL.revokeObjectURL(objectUrl);
    // 音频就绪即置 ready：喇叭表示「这句有语音」，不跟播放进度绑定
    setVoiceState('ready');
    await audio.play();
  } catch {
    /* 语音失败静默：气泡已经显示，不能反过来打断渲染 */
    setVoiceState('idle');
  }
}
