/**
 * 产品纯模块回放：只读导入 core/chat 的 history 与 session，注入受控时钟/Promise，
 * 把「产品实际发生的事实」记录成记忆事件，再交给账本看身份与生命周期对不对。
 *
 * 边界（必须随结果一起报告）：
 * - 没有启动 Electron、没有 fetch、没有 provider 进程；complete 是注入的 Promise。
 * - 因此这不是真实 Qwen 生成，也不是真实 UI 呈现；产品当前没有呈现 ack 通道，
 *   所以 response.presented 一律不生成，presented 只会是 false/unknown。
 * - 不改产品文件；发现疑点只保留最小复现和原状。
 *
 * @module pet-next/experiments/memory-consistency/product-replay/replay
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatHistory, type ChatHistoryStore } from '../../../core/chat/history.ts';
import { createChatSession } from '../../../core/chat/session.ts';
import type { ChatSession } from '../../../core/chat/types.ts';
import { EVENT_SCHEMA_VERSION, sha256Hex, type EventKind, type EventPayload, type MemoryEvent } from '../contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = join(HERE, '..', '..', '..');
const BASE_TIME = Date.UTC(2026, 10, 10, 13, 0, 0);

/** 回放场景的分类标签。sourceCategory 与 executionCategory 分开记。 */
export interface ScenarioMeta {
  readonly scenarioId: string;
  readonly title: string;
  readonly sourceCategory: 'product-replay';
  readonly executionCategory: 'stub';
  readonly proves: string;
  readonly doesNotProve: string;
}

/** 场景执行结果。 */
export interface ScenarioResult {
  readonly meta: ScenarioMeta;
  readonly productStatus: string;
  readonly productCode?: string;
  readonly historyTurns: number;
  readonly historyChars: number;
  readonly events: readonly MemoryEvent[];
  readonly notes: readonly string[];
}

/** 产品代码指纹，证明回放绑定了哪一版模块。 */
export function productCodeHashes(): { readonly history: string; readonly session: string; readonly types: string } {
  const hash = (relative: string): string => sha256Hex(readFileSync(join(PRODUCT_ROOT, relative), 'utf8'));
  return {
    history: hash('core/chat/history.ts'),
    session: hash('core/chat/session.ts'),
    types: hash('core/chat/types.ts'),
  };
}

/** 事件记录器：sequence 连续，时间由序号推导，保证可复现。 */
class Recorder {
  private seq = 0;
  private epoch = 1;
  readonly events: MemoryEvent[] = [];

  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  nextEpoch(): void {
    this.epoch += 1;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  push(kind: EventKind, payload: EventPayload, ids: { requestId?: string; responseId?: string } = {}): void {
    this.seq += 1;
    this.events.push({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: `pr-${this.sessionId}-${String(this.seq).padStart(3, '0')}`,
      sessionId: this.sessionId,
      sessionEpoch: this.epoch,
      sequence: this.seq,
      occurredAt: new Date(BASE_TIME + this.seq * 1000).toISOString(),
      observedAt: new Date(BASE_TIME + this.seq * 1000 + 1).toISOString(),
      source: kind === 'user.statement' || kind === 'user.acknowledged' ? 'user' : kind === 'response.generated' ? 'model' : 'runtime',
      kind,
      ...(ids.requestId === undefined ? {} : { requestId: ids.requestId }),
      ...(ids.responseId === undefined ? {} : { responseId: ids.responseId }),
      payload,
    });
  }
}

interface Harness {
  readonly session: ChatSession;
  readonly history: ChatHistoryStore;
  readonly clock: { now: number };
}

function makeHarness(complete: (input: { id: string; text: string }) => Promise<string>, timeoutMs = 60): Harness {
  const history = createChatHistory();
  const clock = { now: 0 };
  const session = createChatSession({
    complete,
    now: () => clock.now,
    timeoutMs,
    history,
  });
  return { session, history, clock };
}

function meta(scenarioId: string, title: string, proves: string, doesNotProve: string): ScenarioMeta {
  return { scenarioId, title, sourceCategory: 'product-replay', executionCategory: 'stub', proves, doesNotProve };
}

/** S1 成功：生成成功入史，但没有呈现证据。 */
async function successScenario(): Promise<ScenarioResult> {
  const harness = makeHarness(async () => '好的，我先给草稿。');
  const recorder = new Recorder('pr-success');
  recorder.push('user.statement', { text: '帮我整理周报。', scripted: { subjectKey: 'task:weekly-report', valueText: '整理周报', kindHint: 'task' } });
  const result = await harness.session.send({ id: 'chat-req-1', text: '帮我整理周报。' });
  if (result.status === 'ok') {
    // 产品入史发生在返回 ok 之前；对外没有呈现通道，故不伪造 presented。
    recorder.push('response.generated', { text: result.text }, { requestId: 'chat-req-1', responseId: 'resp-chat-req-1' });
  }
  return {
    meta: meta('S1', '成功交付一轮', '生成成功会入史，但记忆里只能确认 generated', '呈现与已读（产品无 ack 通道）'),
    productStatus: result.status,
    ...(result.status === 'ok' ? {} : { productCode: result.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['产品入史与界面采纳是两个阶段；本场景只有前者。'],
  };
}

/** S2 取消在途：立即 cancelled，迟到结果不入史。 */
async function cancelScenario(): Promise<ScenarioResult> {
  let release: ((text: string) => void) | undefined;
  const harness = makeHarness(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const recorder = new Recorder('pr-cancel');
  recorder.push('user.statement', { text: '写一段长文。' });
  const pending = harness.session.send({ id: 'chat-req-2', text: '写一段长文。' });
  harness.session.cancel('chat-req-2');
  const result = await pending;
  release?.('迟到的一大段文本。');
  await new Promise((resolve) => setTimeout(resolve, 5));
  recorder.push('request.cancelled', { reason: 'user_cancel' }, { requestId: 'chat-req-2' });
  return {
    meta: meta('S2', '取消在途请求', '取消立即结算且迟到结果不入史；取消只作用于该请求', '任务撤销（产品没有长期任务模型）'),
    productStatus: result.status,
    ...(result.status === 'ok' ? {} : { productCode: result.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['provider 的迟到文本被会话状态机隔离，因此没有 generated 事件。'],
  };
}

/** S3 超时：总超时先于 provider，记 request.failed(timeout)。 */
async function timeoutScenario(): Promise<ScenarioResult> {
  const harness = makeHarness(() => new Promise<string>(() => undefined), 10);
  const recorder = new Recorder('pr-timeout');
  const pending = harness.session.send({ id: 'chat-req-3', text: '慢慢想。' });
  harness.clock.now += 1000;
  const result = await pending;
  recorder.push('request.failed', { reason: result.status === 'error' ? result.code : 'unknown' }, { requestId: 'chat-req-3' });
  return {
    meta: meta('S3', '总超时', '超时是一个独立结算事实，不等于用户取消', '真实网络超时分布'),
    productStatus: result.status,
    ...(result.status === 'ok' ? {} : { productCode: result.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['注入时钟推进后由真实 timer 醒来判定，未等待 15s 默认超时。'],
  };
}

/** S4 provider 失败。 */
async function providerErrorScenario(): Promise<ScenarioResult> {
  const harness = makeHarness(async () => {
    throw new Error('stub failure');
  });
  const recorder = new Recorder('pr-provider-error');
  const pending = harness.session.send({ id: 'chat-req-4', text: '随便说点什么。' });
  const result = await pending;
  recorder.push('request.failed', { reason: result.status === 'error' ? result.code : 'unknown' }, { requestId: 'chat-req-4' });
  return {
    meta: meta('S4', 'provider 失败', '失败是独立事实，不会伪造成成功或已呈现', '真实服务端错误分类'),
    productStatus: result.status,
    ...(result.status === 'ok' ? {} : { productCode: result.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['注入的 complete 直接 reject。'],
  };
}

/** S5 会话重置：取消在途并清空历史。 */
async function resetScenario(): Promise<ScenarioResult> {
  const harness = makeHarness(
    (input) =>
      input.id === 'chat-req-5b'
        ? new Promise<string>(() => undefined)
        : Promise.resolve('第一轮的答复。'),
  );
  const recorder = new Recorder('pr-reset');
  const first = await harness.session.send({ id: 'chat-req-5a', text: '第一轮问题。' });
  if (first.status === 'ok') {
    recorder.push('response.generated', { text: first.text }, { requestId: 'chat-req-5a', responseId: 'resp-5a' });
  }
  const pending = harness.session.send({ id: 'chat-req-5b', text: '第二轮问题。' });
  harness.session.reset();
  const second = await pending;
  recorder.push('request.cancelled', { reason: 'session_reset' }, { requestId: 'chat-req-5b' });
  recorder.push('session.reset', { reason: 'user_new_session' });
  return {
    meta: meta('S5', '新对话/重置', '重置取消在途并清空短期历史；不等于撤销长期偏好', '长期偏好删除（本模块没有偏好存储）'),
    productStatus: second.status,
    ...(second.status === 'ok' ? {} : { productCode: second.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['history.clear() 只清短期轮次，与记忆层长期笔记无关。'],
  };
}

/** S6 同 id 跨代际复用。 */
async function crossEpochScenario(): Promise<ScenarioResult> {
  const harness = makeHarness(async () => '答复。');
  const recorder = new Recorder('pr-epoch');
  const first = await harness.session.send({ id: 'chat-reuse', text: '第一次。' });
  if (first.status === 'ok') {
    recorder.push('response.generated', { text: first.text }, { requestId: 'chat-reuse', responseId: 'resp-epoch-1' });
  }
  harness.session.reset();
  recorder.push('session.reset', { reason: 'user_new_session' });
  recorder.nextEpoch();
  const second = await harness.session.send({ id: 'chat-reuse', text: '第二次。' });
  if (second.status === 'ok') {
    recorder.push('response.generated', { text: second.text }, { requestId: 'chat-reuse', responseId: 'resp-epoch-2' });
  }
  return {
    meta: meta('S6', '同 requestId 跨代际复用', '产品允许同 id 在新会话复用，记忆层必须按代际分开', '真实多窗口并发'),
    productStatus: second.status,
    ...(second.status === 'ok' ? {} : { productCode: second.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['两代际各一条 generated，两个独立请求身份。'],
  };
}

/** S7 历史边界：4 轮 / 2000 字符。 */
async function historyBoundScenario(): Promise<ScenarioResult> {
  // 长文本放在 assistant 侧：产品对 user 输入另有 500 字符上限，混用会测到别的规则。
  const harness = makeHarness(async (input) => (input.id === 'chat-big' ? '长'.repeat(1990) : '答复。'));
  const recorder = new Recorder('pr-bounds');
  for (let i = 1; i <= 5; i += 1) {
    const id = `chat-b${i}`;
    const result = await harness.session.send({ id, text: `第 ${i} 个问题，长度固定。` });
    if (result.status === 'ok') {
      recorder.push('response.generated', { text: result.text }, { requestId: id, responseId: `resp-b${i}` });
    }
  }
  const turnsAfterFive = harness.history.turns();
  const big = await harness.session.send({ id: 'chat-big', text: '请给一段长文。' });
  if (big.status === 'ok') {
    recorder.push('response.generated', { text: big.text }, { requestId: 'chat-big', responseId: 'resp-big' });
  }
  return {
    meta: meta('S7', '短期历史上界', '4 轮 / 2000 字符是短期窗口，超界即淘汰，不代表记忆层也丢', '记忆层容量'),
    productStatus: big.status,
    ...(big.status === 'ok' ? {} : { productCode: big.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: [`连续 5 轮后保留 ${turnsAfterFive} 轮；单轮自身超上限时历史按产品规则清空。`],
  };
}

/** S8 忙：第二请求不进入 provider。 */
async function busyScenario(): Promise<ScenarioResult> {
  const harness = makeHarness(
    () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('慢慢来。'), 20);
      }),
  );
  const recorder = new Recorder('pr-busy');
  const first = harness.session.send({ id: 'chat-busy-1', text: '先问一个。' });
  const second = await harness.session.send({ id: 'chat-busy-2', text: '再问一个。' });
  const firstResult = await first;
  if (firstResult.status === 'ok') {
    recorder.push('response.generated', { text: firstResult.text }, { requestId: 'chat-busy-1', responseId: 'resp-busy-1' });
  }
  return {
    meta: meta('S8', '至多一在途', '被 busy 拒绝的请求没有进入 provider，因此没有请求身份', '多窗口并发'),
    productStatus: second.status,
    ...(second.status === 'ok' ? {} : { productCode: second.code }),
    historyTurns: harness.history.turns(),
    historyChars: harness.history.chars(),
    events: recorder.events,
    notes: ['busy 不产生记忆事件；只有真正被接受的请求才登记。'],
  };
}

/** 全部场景。顺序固定，便于逐条复跑。 */
export const SCENARIOS: readonly { readonly id: string; readonly run: () => Promise<ScenarioResult> }[] = [
  { id: 'S1', run: successScenario },
  { id: 'S2', run: cancelScenario },
  { id: 'S3', run: timeoutScenario },
  { id: 'S4', run: providerErrorScenario },
  { id: 'S5', run: resetScenario },
  { id: 'S6', run: crossEpochScenario },
  { id: 'S7', run: historyBoundScenario },
  { id: 'S8', run: busyScenario },
];

/** 跑全部场景。 */
export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await scenario.run());
  }
  return results;
}
