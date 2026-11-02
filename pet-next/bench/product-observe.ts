/**
 * 产品真实回应观测的纯计算：从产品页事件序列推出单条样本结果。
 *
 * 事件来源（都带页面 performance.now() 时间戳 ts）：
 * - bench-input：产品 pointer 入口（产品侧接线后由 app/page.ts 发；此前由 bench 注入观察器发，带 injected:true）。
 * - bench-click / bench-media：产品已有 bench-observe 打点（requestId 同源）。
 * - bench-frame：rVFC 呈帧元数据（同上，注入版带 injected:true，产品版可带 requestId）。
 *
 * 判据（可解释、可复算）：固定素材 sha256 + 固定帧号。素材内明确回应帧由
 * assets-pipeline/response-onset.ts 逐帧运动规则离线测得；产品内观测到
 * "本次请求的第一个 mediaTime ≥ onsetFrame/fps 的呈帧"才算回应兑现。
 * 未到目标帧、装载失败、超时、被新输入取代、旧请求帧一律不算成功（记 null + endState）。
 *
 * 口径：软件输入 + rVFC = 软件呈帧证据，不是物理屏幕/物理输入延迟。
 */
import type { OnsetMeasurement } from './onset.ts';

export type PageEvent = { event: string } & Record<string, unknown>;

export type ProductEndState =
  | 'response-observed'
  | 'load-failed'
  | 'ended-before-target'
  | 'cancelled'
  | 'superseded'
  | 'no-play-request'
  | 'no-input'
  | 'idle-missing'
  | 'timeout';

/** 回应判据：固定帧号 + 素材哈希 + 规则来源。 */
export interface ResponseCriterion {
  assetSha256: string;
  fps: number;
  onsetFrame: number | null;
  onsetMs: number | null;
  /** 首个 mediaTime ≥ 该值（秒）的呈帧记为回应兑现。null 表示无判据（负控等）。 */
  targetMediaTimeSec: number | null;
  /** 首帧认定窗口：src=reaction 且 mediaTime ≤ 该值（秒）的第一个呈帧。 */
  firstFrameMaxMediaTimeSec: number;
  /** 回应素材的页面 src（file url），用于把呈帧归属到本次回应请求。 */
  reactionSrc: string;
  rule: 'assets-pipeline/response-onset.ts';
}

export function criterionFor(onset: OnsetMeasurement, reactionSrc: string, assetSha256: string): ResponseCriterion {
  return {
    assetSha256,
    fps: onset.fps,
    onsetFrame: onset.onsetFrame,
    onsetMs: onset.onsetMs,
    targetMediaTimeSec: onset.onsetFrame === null ? null : onset.onsetFrame / onset.fps,
    firstFrameMaxMediaTimeSec: 0.5,
    reactionSrc,
    rule: 'assets-pipeline/response-onset.ts',
  };
}

export interface ProductClickSample {
  label: string;
  sample: number;
  requestId: string | null;
  /** 页面域原始时间戳（毫秒，per-document performance.now()）。 */
  inputPointerdownMs: number | null;
  inputPointerupMs: number | null;
  clickIssuedMs: number | null;
  /** 观察：输入（pointerdown）→ play() 兑现。 */
  playResolvedMs: number | null;
  /** 观察：输入→回应素材首个呈帧（rVFC）。 */
  firstFrameObservedMs: number | null;
  firstFrameMediaTimeSec: number | null;
  /** 观察：输入→目标回应帧（mediaTime ≥ onsetFrame/fps）。未到为 null。 */
  responseObservedMs: number | null;
  responseObservedMediaTimeSec: number | null;
  responseObservedFrameIndex: number | null;
  endState: ProductEndState;
  criterion: ResponseCriterion;
  collection: {
    input: 'software (webContents.sendInputEvent mouseDown/mouseUp)';
    frameEvidence: 'requestVideoFrameCallback metadata (software present)';
    clock: 'page performance.now() (per-document)';
    productEvents: 'console.log bench-* (bench-observe)';
    injectedObserverUsed: boolean;
    note: string;
  };
}

interface Selected {
  inputs: PageEvent[];
  clicks: PageEvent[];
  frames: PageEvent[];
}

/** 产品自带事件优先；注入观察器只兜底（同类事件存在产品版时忽略 injected 版）。 */
function select(events: readonly PageEvent[]): Selected {
  const of = (name: string, keepInjected: boolean): PageEvent[] =>
    events.filter((e) => e['event'] === name && (keepInjected || e['injected'] !== true));
  const hasProductInput = of('bench-input', true).some((e) => e['injected'] !== true);
  const hasProductFrame = of('bench-frame', true).some((e) => e['injected'] !== true);
  return {
    inputs: of('bench-input', !hasProductInput),
    clicks: of('bench-click', true),
    frames: of('bench-frame', !hasProductFrame),
  };
}

function ts(event: PageEvent | undefined): number | null {
  const value = event?.['ts'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function num(event: PageEvent | undefined, key: string): number | null {
  const value = event?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(event: PageEvent | undefined, key: string): string | null {
  const value = event?.[key];
  return typeof value === 'string' ? value : null;
}

/** 从一次样本的事件序列计算结果。pending 表示还没到终态。 */
export function evaluateSample(
  label: string,
  sampleIndex: number,
  events: readonly PageEvent[],
  criterion: ResponseCriterion,
): ProductClickSample & { pending: boolean } {
  const selected = select(events);
  const media = events.filter((e) => e['event'] === 'bench-media');
  const pointerdown = selected.inputs.find((e) => e['kind'] === 'pointerdown');
  const pointerup = selected.inputs.find((e) => e['kind'] === 'pointerup');
  const cancel = selected.inputs.find((e) => e['kind'] === 'pointercancel');
  const cancelled = cancel !== undefined;
  const secondInput =
    pointerdown !== undefined
      ? selected.inputs.find((e) => e['kind'] === 'pointerdown' && (ts(e) ?? 0) > (ts(pointerdown) ?? 0))
      : undefined;
  const click = selected.clicks[0];
  const requestId = str(click, 'requestId');
  const inputTs = ts(pointerdown);
  const clickTs = ts(click);
  const invalidationTimes = [ts(secondInput), ts(cancel)].filter((t): t is number => t !== null);
  const validUntil = invalidationTimes.length > 0 ? Math.min(...invalidationTimes) : null;
  const sinceInput = (t: number | null): number | null => (inputTs === null || t === null ? null : t - inputTs);

  const resolved =
    requestId === null
      ? undefined
      : media.find((e) => e['status'] === 'resolved' && e['requestId'] === requestId);
  const failed =
    requestId === null
      ? undefined
      : media.find((e) => e['status'] === 'failed' && e['requestId'] === requestId);
  const ended =
    requestId === null
      ? undefined
      : media.find((e) => e['status'] === 'ended' && e['requestId'] === requestId);

  // 帧必须落在本次请求的有效区间内；覆盖/取消后的同素材帧不能归到旧请求。
  const requestFrames = selected.frames.filter((e) => {
    const t = ts(e);
    if (
      t === null ||
      clickTs === null ||
      inputTs === null ||
      t < clickTs ||
      t < inputTs ||
      (validUntil !== null && t >= validUntil)
    ) {
      return false;
    }
    const frameRequestId = e['requestId'];
    if (typeof frameRequestId === 'string') return frameRequestId === requestId;
    return str(e, 'src') === criterion.reactionSrc;
  });
  const firstFrame = requestFrames.find((e) => {
    const mediaTime = num(e, 'mediaTime');
    return mediaTime !== null && mediaTime <= criterion.firstFrameMaxMediaTimeSec;
  });
  const halfFrameSec = criterion.fps > 0 ? 0.5 / criterion.fps : 0;
  const response =
    criterion.targetMediaTimeSec === null
      ? undefined
      : requestFrames.find((e) => {
          const mediaTime = num(e, 'mediaTime');
          return mediaTime !== null && mediaTime >= criterion.targetMediaTimeSec! - halfFrameSec;
        });

  const responseMediaTime = num(response, 'mediaTime');
  const endState: ProductEndState =
    response !== undefined
      ? 'response-observed'
      : cancelled
        ? 'cancelled'
        : pointerdown === undefined
          ? 'no-input'
          : click === undefined
            ? secondInput !== undefined
              ? 'superseded'
              : 'no-play-request'
            : failed !== undefined
              ? 'load-failed'
              : ended !== undefined
                ? 'ended-before-target'
                : secondInput !== undefined
                  ? 'superseded'
                  : 'timeout';

  return {
    label,
    sample: sampleIndex,
    requestId,
    inputPointerdownMs: inputTs,
    inputPointerupMs: ts(pointerup),
    clickIssuedMs: clickTs,
    playResolvedMs: sinceInput(ts(resolved)),
    firstFrameObservedMs: sinceInput(ts(firstFrame)),
    firstFrameMediaTimeSec: num(firstFrame, 'mediaTime'),
    responseObservedMs: endState === 'response-observed' ? sinceInput(ts(response)) : null,
    responseObservedMediaTimeSec: endState === 'response-observed' ? responseMediaTime : null,
    responseObservedFrameIndex:
      endState === 'response-observed' && responseMediaTime !== null && criterion.fps > 0
        ? Math.round(responseMediaTime * criterion.fps)
        : null,
    endState,
    criterion,
    collection: {
      input: 'software (webContents.sendInputEvent mouseDown/mouseUp)',
      frameEvidence: 'requestVideoFrameCallback metadata (software present)',
      clock: 'page performance.now() (per-document)',
      productEvents: 'console.log bench-* (bench-observe)',
      injectedObserverUsed: selected.inputs.every((e) => e['injected'] === true) || selected.frames.every((e) => e['injected'] === true),
      note: '软件输入 + rVFC 软件呈帧证据；不含物理输入设备与物理屏幕呈现延迟',
    },
    pending: endState === 'timeout',
  };
}
