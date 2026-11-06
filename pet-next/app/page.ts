/**
 * 页面装配：把手势、会话、媒体元素和预加载桥连起来。
 * 预览未点名时走已验收的单槽会话。双槽、行为和候选素材只在对应令牌下创建。
 * @module pet-next/app/page
 */
import { domScreenPointToDip } from '../adapters/window/pointer-point.ts';
import { DAILY_CADENCE, DEMO_CADENCE } from '../contracts/behavior.ts';
import { parsePreview, PREVIEW_QUERY } from '../contracts/preview.ts';
import { IDLE_PAUSE_QUERY } from '../contracts/idle-suspension.ts';
import { attachIdleSuspension, type IdleSuspensionHandle } from './idle-suspension.ts';
import {
  CHAT_LOCAL_TOKEN,
  CHAT_PREVIEW_QUERY,
  CHAT_PREVIEW_TOKEN,
  type ChatDisplayInfo,
  type ChatSendRequest,
  type ChatSendResult,
} from '../contracts/chat.ts';
import { createBehaviorPet, type BehaviorPet } from './behavior-pet.ts';
import './bridge.ts';
import { mountChatPanel } from './chat-panel.ts';
import { createFeedbackController, type FeedbackController } from './feedback.ts';
import { createFeedbackView } from './feedback-view.ts';
import { attachPetMedia, type PetMedia } from './pet-media.ts';
import { previewDataset } from './preview-gate.ts';
import { createPetController, parseClipRequest, type PetController } from './wire.ts';

const DRAG_THRESHOLD_PX = 5;
const LOAD_TIMEOUT_MS = 8000;
const CANDIDATE_REACTION = new URL('../assets/candidates/reaction/reaction.webm', location.href).href;
const SHORT_REACTION = new URL('../assets/candidates/reaction/short.webm', location.href).href;

const params = new URLSearchParams(location.search);
const selection = parsePreview(params.get(PREVIEW_QUERY));
// M3-9：只有主进程显式注入 `idlePause=1`（开关打开且单槽）才装配；缺省零对象、零监听。
const idlePause = params.get(IDLE_PAUSE_QUERY) === '1';
const idleUrl = params.get('idle') ?? new URL('../assets/idle.webm', location.href).href;
const shippedReaction = new URL('../assets/reaction.webm', location.href).href;
const reactionUrl = params.get('reaction') ?? (selection.short ? SHORT_REACTION : selection.candidate ? CANDIDATE_REACTION : shippedReaction);

const video = document.querySelector('#clip');
const standby = document.querySelector('#clip-next');
const placeholder = document.querySelector('#placeholder');
const petEl = document.querySelector('#pet');
if (
  !(video instanceof HTMLVideoElement) ||
  !(standby instanceof HTMLVideoElement) ||
  !(placeholder instanceof HTMLImageElement) ||
  !(petEl instanceof HTMLElement)
) {
  throw new Error('pet markup missing');
}

const previewMark = previewDataset(location.search);
if (previewMark !== null) {
  document.documentElement.dataset.previewRequested = previewMark.previewRequested;
  document.documentElement.dataset.previewActive = previewMark.previewActive;
}

// M3-6：反馈控制器必须能被拖动回调与聊天面板共用，故提前声明。
const holder: {
  controller?: PetController;
  behavior?: BehaviorPet;
  feedback?: FeedbackController;
  /** M3-9：只有显式预览开关打开时存在。 */
  idleSuspension?: IdleSuspensionHandle;
} = {};

// M3-0/M3-1：仅在聊天令牌（preview=demo / local=真实模型）下挂载面板；普通桌宠入口保持既有行为。
const chatMode = params.get(CHAT_PREVIEW_QUERY);
if (chatMode === CHAT_PREVIEW_TOKEN || chatMode === CHAT_LOCAL_TOKEN) {
  const bridge = (window as unknown as {
    petChat?: {
      send(payload: ChatSendRequest): Promise<ChatSendResult>;
      cancel(id: string): void;
      /** M3-3：新对话——取消在途＋清空主进程历史（无载荷，页面不提交状态）。 */
      reset(): void;
      info?(): Promise<unknown>;
    };
  }).petChat;
  if (bridge === undefined) {
    throw new Error('chat requested but petChat bridge missing');
  }
  // 只读展示信息（mode/model）；取不到时按演示模式兜底，绝不把失败伪装成成功。
  const infoPromise: Promise<ChatDisplayInfo> = bridge.info
    ? bridge.info().then(
        (raw) => (typeof raw === 'object' && raw !== null ? (raw as ChatDisplayInfo) : { mode: 'demo' }),
        () => ({ mode: 'demo' }),
      )
    : Promise.resolve({ mode: 'demo' });
  void infoPromise.then((info) => {
    // M3-6：仅 experience=companion 时创建反馈对象；关闭时原路径零对象。
    if (info.experience !== 'companion') {
      mountChatPanel(document.body, bridge, info);
      return;
    }
    const view = createFeedbackView();
    const feedback = createFeedbackController({
      inner: bridge,
      view,
      // 回应只经唯一 behavior 入口（app/behavior-pet.ts 的 reaction）；未开行为时自然空转。
      onReact: () => holder.behavior?.reaction(),
    });
    holder.feedback = feedback;
    // 模式状态明确：页面根标记体验口径，供人工/E2E 只读判定（关闭时不写）。
    document.documentElement.dataset.experience = info.experience;
    mountChatPanel(document.body, feedback.client, info, { feedbackElement: view.element });
  });
}

/** bench-observe 打点：单行 JSON，时间戳统一 performance.now() 域。 */
function benchLog(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...payload, ts: performance.now() }));
}

const media: PetMedia = attachPetMedia({
  playback: selection.playback,
  primary: video,
  standby,
  placeholder,
  timeoutMs: LOAD_TIMEOUT_MS,
  reactionUrl,
  idlePause,
  onStatus(event) {
    if (selection.benchObserve) {
      benchLog({ event: 'bench-media', status: event.status, requestId: event.requestId });
    }
    if (holder.behavior) {
      holder.behavior.onMedia(event);
      return;
    }
    const parsed = parseClipRequest(event.requestId);
    const controller = holder.controller;
    if (!parsed || !controller) return;
    if (event.status === 'ended') controller.notify({ type: 'clip-ended', requestId: parsed.requestId, clip: parsed.clip });
    if (event.status === 'failed') {
      controller.notify({ type: 'clip-failed', requestId: parsed.requestId, clip: parsed.clip });
    }
  },
});

// M3-9：先接快照再 boot——"启动时窗口已隐藏"也能在首个 idle 兑现后立即暂停；
// 开关关闭时这里不创建对象，也不注册任何监听。
if (idlePause) {
  holder.idleSuspension = attachIdleSuspension({ media, bridge: window.petWindowVisibility });
}

const surface = {
  moveBy(dx: number, dy: number) {
    window.pet.moveBy(dx, dy);
  },
  quit() {
    holder.idleSuspension?.dispose();
    media.dispose();
    window.pet.quit();
  },
  setVisual(visual: string, requestId: string) {
    document.documentElement.dataset.visual = visual;
    document.documentElement.dataset.request = requestId;
    if (previewMark !== null) {
      console.log(JSON.stringify({ event: 'preview', visual, requestId }));
    }
  },
  setTrace(trace: readonly string[]) {
    document.documentElement.dataset.trace = trace.join(',');
  },
  setDragging(dragging: boolean) {
    document.body.classList.toggle('dragging', dragging);
    // M3-6：拖动优先——拖中完成只给结果提示，不排回应。
    holder.feedback?.drag(dragging);
  },
};

if (selection.behavior) {
  // bench-observe 时给行为会话包一层媒体：非待机播放请求发出即打 bench-click（带 requestId）。
  const behaviorMedia: PetMedia = selection.benchObserve
    ? {
        begin(request) {
          if (request.clip !== 'idle') {
            benchLog({ event: 'bench-click', requestId: request.requestId, clip: request.clip });
          }
          media.begin(request);
        },
        showPlaceholder() {
          media.showPlaceholder();
        },
        dispose() {
          media.dispose();
        },
        setHidden(hidden: boolean) {
          media.setHidden(hidden);
        },
        idleSuspensionState() {
          return media.idleSuspensionState();
        },
      }
    : media;
  const behavior = createBehaviorPet({
    media: behaviorMedia,
    idleUrl,
    reactionUrl,
    cadence: selection.behaviorCadence === 'demo' ? DEMO_CADENCE : DAILY_CADENCE,
    dragThresholdPx: DRAG_THRESHOLD_PX,
    moveBy: surface.moveBy,
    quit() {
      window.pet.quit();
    },
    setVisual: surface.setVisual,
    setTrace: surface.setTrace,
    setDragging: surface.setDragging,
  });
  holder.behavior = behavior;
  behavior.boot();
} else {
  const controller = createPetController({
    assets: { idleUrl, reactionUrl },
    dragThresholdPx: DRAG_THRESHOLD_PX,
    ports: {
      play(request) {
        const requestId = `${request.clip}:${request.requestId}`;
        if (selection.benchObserve && request.clip !== 'idle') {
          benchLog({ event: 'bench-click', requestId, clip: request.clip });
        }
        media.begin({
          requestId,
          clip: request.clip,
          url: request.url,
          once: request.once,
        });
      },
      showPlaceholder() {
        media.showPlaceholder();
      },
      moveBy: surface.moveBy,
      quit: surface.quit,
      setVisual(visual, requestId) {
        surface.setVisual(visual, String(requestId));
        surface.setTrace(holder.controller?.trace ?? []);
      },
      setDragging: surface.setDragging,
    },
  });
  holder.controller = controller;
  controller.boot();
}

petEl.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  try {
    petEl.setPointerCapture(ev.pointerId);
  } catch {
    // 合成指针没有底层捕获时仍按坐标判定。
  }
  dispatchPointer(ev, 'pointerdown');
});

petEl.addEventListener('pointermove', (ev) => {
  dispatchPointer(ev, 'pointermove');
});

petEl.addEventListener('pointerup', (ev) => {
  dispatchPointer(ev, 'pointerup');
});

petEl.addEventListener('pointercancel', (ev) => {
  activePet().pointer({ type: 'pointercancel', pointerId: ev.pointerId });
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') activePet().quit();
  if ((ev.key === 'f' || ev.key === 'F') && holder.behavior) holder.behavior.failNext();
});

function activePet(): { pointer(event: Parameters<PetController['pointer']>[0]): void; quit(): void } {
  if (holder.behavior) return holder.behavior;
  if (holder.controller) return holder.controller;
  throw new Error('pet session missing');
}

function dispatchPointer(ev: PointerEvent, type: 'pointerdown' | 'pointermove' | 'pointerup'): void {
  const dip = domScreenPointToDip({ x: ev.screenX, y: ev.screenY });
  activePet().pointer({ type, pointerId: ev.pointerId, x: dip.x, y: dip.y });
}
