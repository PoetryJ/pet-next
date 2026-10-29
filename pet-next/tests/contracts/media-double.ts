/**
 * 双槽契约替身。通知只按 `contracts/media-slot.ts` 对外发出。
 * 准备结果由受控 Promise 兑现，超时由假时钟拨动。不读取单槽内核。
 * @module pet-next/tests/contracts/media-double
 */
import { MEDIA_SLOT_COUNT, type MediaSlotIndex, type SlotFailureReason, type SlotPlayRequest, type SlotToken, type TwoSlotAdapter, type TwoSlotNotice, type TwoSlotOptions } from '../../contracts/media-slot.ts';
import { deferred, type FakeClock } from './controlled.ts';

type SlotPhase = 'empty' | 'preparing' | 'preheated' | 'shown' | 'paused' | 'ended';

interface SlotState {
  generation: number;
  requestId: string | null;
  phase: SlotPhase;
  role: 'play' | 'preheat' | null;
  firstFrame: boolean;
}

interface Inflight {
  requestId: string;
  token: SlotToken;
  role: 'play' | 'preheat';
  timer: number | null;
  /** 测试已经兑现过这次准备。超时本身不占这个标记，迟到的成功仍走受控 Promise。 */
  userSettled: boolean;
  applied: boolean;
}

export type PrepareResult =
  | { ok: true }
  | {
      ok: false;
      reason: SlotFailureReason;
    };

export interface MediaHarness {
  readonly adapter: TwoSlotAdapter;
  readonly notices: readonly TwoSlotNotice[];
  readonly clock: FakeClock;
  settlePrepare(requestId: string, result: PrepareResult): void;
  emitEnded(token: SlotToken, requestId: string): void;
  emitFirstFrame(token: SlotToken, requestId: string): void;
  tokenFor(requestId: string): SlotToken;
  clearNotices(): void;
}

export interface ContractMediaOptions extends TwoSlotOptions {
  mode: TwoSlotAdapter['mode'];
  clock: FakeClock;
  /** 准备阶段超时。到点由 `clock.advance` 发出 `timeout`，不是墙钟。 */
  timeoutMs: number;
}

/**
 * 按公开契约回应 `begin` / `preheat` / `dispose`。
 * 真实 B 的 `TwoSlotFactory` 没有时钟和加载缝，所以这份替身还不能代替 B。
 */
export function createContractMedia(options: ContractMediaOptions): MediaHarness {
  const { mode, clock, timeoutMs, onNotice } = options;
  const notices: TwoSlotNotice[] = [];
  const slots: [SlotState, SlotState] = [emptySlot(), emptySlot()];
  const inflight = new Map<string, Inflight>();
  const tokens = new Map<string, SlotToken>();
  const seen = new Set<string>();
  let disposed = false;
  let latestPlayId: string | null = null;
  let visibleRequestId: string | null = null;
  let visibleSlot: MediaSlotIndex | null = null;

  function emit(notice: TwoSlotNotice): void {
    notices.push(notice);
    onNotice(notice);
  }

  function slotAt(index: MediaSlotIndex): SlotState {
    const slot = slots[index];
    if (!slot) throw new Error(`missing slot ${index}`);
    return slot;
  }

  function current(token: SlotToken, requestId: string): SlotState | null {
    if (disposed) return null;
    const slot = slotAt(token.slot);
    if (slot.generation !== token.generation || slot.requestId !== requestId) return null;
    return slot;
  }

  function apply(flight: Inflight, result: PrepareResult): void {
    if (flight.applied) return;
    flight.applied = true;
    const slot = current(flight.token, flight.requestId);
    if (!slot || slot.phase !== 'preparing') return;
    if (flight.role === 'play' && flight.requestId !== latestPlayId) {
      slot.phase = 'empty';
      slot.role = null;
      slot.requestId = null;
      return;
    }
    if (!result.ok) {
      slot.phase = 'empty';
      slot.role = null;
      emit({
        type: 'failed',
        token: flight.token,
        requestId: flight.requestId,
        reason: result.reason,
        keptRequestId: visibleRequestId,
      });
      return;
    }
    emit({ type: 'prepared', token: flight.token, requestId: flight.requestId });
    if (flight.role === 'preheat') {
      slot.phase = 'preheated';
      return;
    }
    if (visibleSlot !== null && visibleSlot !== flight.token.slot) {
      const previous = slotAt(visibleSlot);
      if (previous.phase === 'shown') previous.phase = 'paused';
    }
    slot.phase = 'shown';
    slot.firstFrame = false;
    visibleRequestId = flight.requestId;
    visibleSlot = flight.token.slot;
    emit({ type: 'shown', token: flight.token, requestId: flight.requestId });
    emit({ type: 'playing', token: flight.token, requestId: flight.requestId });
  }

  function arm(flight: Inflight): void {
    flight.timer = clock.set(() => {
      flight.timer = null;
      apply(flight, { ok: false, reason: 'timeout' });
    }, timeoutMs);
  }

  function disarmStale(slotIndex: MediaSlotIndex, generation: number): void {
    for (const flight of inflight.values()) {
      if (flight.token.slot !== slotIndex || flight.token.generation === generation) continue;
      if (flight.timer === null) continue;
      clock.clear(flight.timer);
      flight.timer = null;
    }
  }

  /**
   * 空槽优先。没有空槽时复用非可见槽，避免开出第三个槽。
   * 可见槽继续留到新请求核对通过后再切换。
   */
  function allocate(): MediaSlotIndex {
    for (let index = 0; index < MEDIA_SLOT_COUNT; index += 1) {
      const slotIndex = index as MediaSlotIndex;
      if (slotAt(slotIndex).phase === 'empty') return slotIndex;
    }
    for (let index = 0; index < MEDIA_SLOT_COUNT; index += 1) {
      const slotIndex = index as MediaSlotIndex;
      if (slotIndex !== visibleSlot && slotAt(slotIndex).phase !== 'shown') return slotIndex;
    }
    return visibleSlot === 0 ? 1 : 0;
  }

  function beginPrepare(request: SlotPlayRequest, role: 'play' | 'preheat'): void {
    if (disposed) return;
    if (seen.has(request.requestId)) return;
    if (role === 'preheat' && request.clip !== 'reaction') return;
    seen.add(request.requestId);
    if (role === 'play') latestPlayId = request.requestId;
    const slotIndex = allocate();
    const slot = slotAt(slotIndex);
    slot.generation += 1;
    slot.requestId = request.requestId;
    slot.phase = 'preparing';
    slot.role = role;
    slot.firstFrame = false;
    const token: SlotToken = { slot: slotIndex, generation: slot.generation };
    tokens.set(request.requestId, token);
    disarmStale(slotIndex, slot.generation);
    const flight: Inflight = { requestId: request.requestId, token, role, timer: null, userSettled: false, applied: false };
    inflight.set(request.requestId, flight);
    arm(flight);
  }

  const adapter: TwoSlotAdapter = {
    mode,
    begin(request) {
      beginPrepare(request, 'play');
    },
    preheat(request) {
      beginPrepare(request, 'preheat');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const flight of inflight.values()) {
        if (flight.timer !== null) clock.clear(flight.timer);
        flight.timer = null;
      }
    },
  };

  return {
    adapter,
    get notices() {
      return notices;
    },
    clock,
    settlePrepare(requestId, result) {
      const flight = inflight.get(requestId);
      if (!flight) throw new Error(`no prepare for ${requestId}`);
      if (flight.userSettled) return;
      flight.userSettled = true;
      if (flight.timer !== null) clock.clear(flight.timer);
      flight.timer = null;
      const gate = deferred<PrepareResult>();
      void gate.promise.then((value) => {
        apply(flight, value);
      });
      gate.resolve(result);
    },
    emitEnded(token, requestId) {
      const slot = current(token, requestId);
      if (!slot || slot.phase !== 'shown' || slot.role === 'preheat') return;
      if (visibleRequestId !== requestId) return;
      slot.phase = 'ended';
      emit({ type: 'ended', token, requestId });
    },
    emitFirstFrame(token, requestId) {
      const slot = current(token, requestId);
      if (!slot || slot.phase !== 'shown' || slot.firstFrame) return;
      if (visibleRequestId !== requestId) return;
      slot.firstFrame = true;
      emit({ type: 'first-frame', token, requestId });
    },
    tokenFor(requestId) {
      const token = tokens.get(requestId);
      if (!token) throw new Error(`no token for ${requestId}`);
      return token;
    },
    clearNotices() {
      notices.length = 0;
    },
  };
}

function emptySlot(): SlotState {
  return { generation: 0, requestId: null, phase: 'empty', role: null, firstFrame: false };
}
