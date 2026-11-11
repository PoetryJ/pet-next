/**
 * 真实会话路径回放：产品 history/session → 实验包装 → 产品 Qwen 适配器 → 捕获桩。
 *
 * 只读导入产品模块；不改产品行为，也不复制它们的实现。
 * 事件与补丁由故事脚本显式注入（scripted），不声称模型自动抽取。
 *
 * @module pet-next/experiments/memory-consistency/product-shadow/runner
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QWEN_SYSTEM_PROMPT } from '../../../contracts/chat.ts';
import { createChatHistory } from '../../../core/chat/history.ts';
import { createChatSession } from '../../../core/chat/session.ts';
import { createQwenChatProvider } from '../../../adapters/chat/qwen-provider.ts';
import {
  PATCH_SCHEMA_VERSION,
  canonicalJson,
  depIdForNote,
  type MemoryEvent,
  type MemoryPatch,
  type MemoryState,
} from '../contracts.ts';
import { recomputeDependencies } from '../ledger/patch.ts';
import { reduce } from '../ledger/reduce.ts';
import { JsonlStore } from '../storage/store.ts';
import {
  MESSAGE_BUDGET,
  buildMemoryBlock,
  composeUserText,
  projectMessages,
  measureMessages,
  selectNotes,
  trimToBudget,
  type SelectionRecord,
} from './adapter.ts';
import { createCaptureHarness, type CaptureHarness } from './capture.ts';
import type { ArmId, CapturedRequest, StoryFile, StoryPatch, StoryRun } from './contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

/** 只读导入的产品文件：运行后记录指纹，证明用的是产品实现。 */
export const PRODUCT_FILES = [
  'core/chat/history.ts',
  'core/chat/session.ts',
  'core/chat/types.ts',
  'adapters/chat/qwen-provider.ts',
  'contracts/chat.ts',
] as const;

/** 计算产品源码指纹。 */
export function productSourceHashes(repoRoot = REPO): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of PRODUCT_FILES) {
    out[file] = createHash('sha256').update(readFileSync(join(repoRoot, 'pet-next', file))).digest('hex');
  }
  return out;
}

/** 把故事里的笔记草稿变成合法补丁（依赖由状态重算，不信自报）。 */
function materializePatch(stateAtBuild: MemoryState, spec: StoryPatch): MemoryPatch {
  const dependencyVersions: Record<string, number> = {};
  for (const note of spec.notes) {
    const draft = {
      noteId: note.noteId,
      text: note.text,
      sourceEventIds: [...note.sourceEventIds],
      parentNoteIds: [...(note.parentNoteIds ?? [])],
      dependencyVersions: {},
      generator: 'scripted' as const,
      ...(note.subjectKey === undefined ? {} : { subjectKey: note.subjectKey }),
    };
    for (const [depId, version] of Object.entries(recomputeDependencies(stateAtBuild, draft).dependencies)) {
      dependencyVersions[depId] = version;
    }
  }
  for (const item of spec.invalidates ?? []) {
    const target = stateAtBuild.notes[item.noteId];
    if (target !== undefined) dependencyVersions[depIdForNote(item.noteId)] = target.version;
  }
  return {
    schemaVersion: PATCH_SCHEMA_VERSION,
    opId: `op-${spec.patchId}`,
    snapshotVersion: stateAtBuild.globalVersion,
    dependencyVersions,
    notesToUpsert: spec.notes.map((note) => ({
      noteId: note.noteId,
      text: note.text,
      sourceEventIds: [...note.sourceEventIds],
      parentNoteIds: [...(note.parentNoteIds ?? [])],
      dependencyVersions: {},
      generator: 'scripted' as const,
      ...(note.subjectKey === undefined ? {} : { subjectKey: note.subjectKey }),
    })),
    notesToInvalidate: (spec.invalidates ?? []).map((item) => ({ noteId: item.noteId, reason: item.reason })),
    producer: 'manual',
  };
}

function fingerprint(state: MemoryState): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex').slice(0, 16);
}

/** 一次故事 × 臂的执行上下文。 */
interface Session {
  store: JsonlStore;
  history: ReturnType<typeof createChatHistory>;
  chat: ReturnType<typeof createChatSession>;
  capture: CaptureHarness;
  restore: () => void;
}

/**
 * 跑一个故事的一个臂。
 *
 * 每轮：session.send → 包装器（M 才注入记忆）→ 产品 provider 序列化 → 捕获桩。
 * 重启点：close store → reopen → 重建 history/session（历史清空，长程记忆保留）。
 *
 * R3.1 负控：`options.providerFailAtTurn` 让指定轮的产品 fetch 抛错（provider-error），
 * 请求不发出、捕获桩不计数；评分必须判目标轮失败，而非被先前成功请求掩盖。
 */
export async function runStory(
  story: StoryFile,
  arm: ArmId,
  runId: string,
  options: { readonly providerFailAtTurn?: number } = {},
): Promise<StoryRun> {
  const storeDir = mkdtempSync(join(tmpdir(), `shadow-${story.storyId}-${arm}-`));
  const opened = JsonlStore.open(storeDir);
  if (!opened.ok) throw new Error(`store open failed: ${opened.code} ${opened.detail}`);
  let store = opened.value;

  const capture = createCaptureHarness({ defer: true });
  const restore = capture.installSentinel();
  let currentTurn = -1;
  const providerFetch =
    options.providerFailAtTurn === undefined
      ? capture.fetchImpl
      : (async (input: unknown, init?: unknown) => {
          if (currentTurn === options.providerFailAtTurn) {
            throw new Error(`injected provider failure at turn ${String(options.providerFailAtTurn)}`);
          }
          return capture.fetchImpl(input as RequestInfo, init as RequestInit | undefined);
        }) as unknown as typeof fetch;
  const provider = createQwenChatProvider({
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'shadow-offline-stub',
    fetchImpl: providerFetch,
  });

  const selectionRecords: SelectionRecord[] = [];
  // 纯函数契约反例（trimToBudget 上限）：非产品会话失败，仅审计记录，不参与评分判定。
  const budgetFailures: string[] = [];
  const trims: { turnIndex: number; droppedHistory: number; droppedNotes: readonly string[]; utf16: number; utf8: number }[] = [];
  const fingerprints: { at: string; sha: string; notes: number; active: number }[] = [];
  const requests: CapturedRequest[] = [];
  const turns: { index: number; status: string; code?: string; text?: string; note?: string }[] = [];

  /** M 的包装器：调用前选记忆、裁预算、核对投影。 */
  const complete = async (input: {
    id: string;
    text: string;
    signal: AbortSignal;
    history?: readonly { user: string; assistant: string }[];
  }): Promise<string> => {
    if (arm === 'H') {
      return provider.complete({ id: input.id, text: input.text, signal: input.signal, history: input.history });
    }
    const state = store.getState();
    const selection = selectNotes(state, input.text);
    selectionRecords.length = 0;
    selectionRecords.push(...selection.records);
    const trimmed = trimToBudget(input.text, input.history ?? [], selection.selected);
    trims.push({
      turnIndex: currentTurn,
      droppedHistory: trimmed.droppedHistory,
      droppedNotes: trimmed.droppedNotes,
      utf16: trimmed.measured.utf16,
      utf8: trimmed.measured.utf8,
    });
    // 调用前投影必须与实际请求一致；不一致在这里就失败，而不是事后解释。
    const expected = projectMessages(trimmed.history, trimmed.userText, QWEN_SYSTEM_PROMPT);
    const measured = measureMessages(expected);
    if (measured.utf16 !== trimmed.measured.utf16 || measured.utf8 !== trimmed.measured.utf8) {
      throw new Error('projection mismatch before call');
    }
    return provider.complete({ id: input.id, text: trimmed.userText, signal: input.signal, history: trimmed.history });
  };

  const buildSession = (): Session => {
    const history = createChatHistory();
    const chat = createChatSession({ complete, history });
    return { store, history, chat, capture, restore };
  };

  let current = buildSession();


  const recordRequest = (turnIndex: number): void => {
    const call = capture.last();
    if (call === undefined) return;
    requests.push({
      storyId: story.storyId,
      armId: arm,
      turnIndex,
      url: call.url,
      bodyText: call.bodyText,
      bodySha256: call.sha256,
      messages: call.messages,
      utf16: call.utf16,
      utf8: call.utf8,
      stubCalls: capture.stats.stubCalls,
      realNetworkCalls: capture.stats.realNetworkCalls,
    });
  };

  try {
    // 1) 事件与补丁按 sequence 交付（patch 在 buildAt 时构建、applyAt 时提交）。
    const events = story.events as MemoryEvent[];
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    const pending = story.patches.filter((patch) => patch.applyAtSequence !== null);
    const tail = story.patches.filter((patch) => patch.applyAtSequence === null);

    const deliver = (spec: StoryPatch): void => {
      const stateAtBuild = reduce(sorted, { openUntilSequence: spec.buildAtSequence }).state;
      const patch = materializePatch(stateAtBuild, spec);
      const committed = store.commitPatch(patch);
      turns.push({
        index: -1,
        status: committed.ok ? `patch:${committed.value.disposition}` : `patch:${committed.code}`,
        note: spec.patchId,
      });
    };

    for (const event of sorted) {
      const appended = store.append(event);
      if (!appended.ok) {
        turns.push({ index: -1, status: `event:${appended.code}`, note: event.eventId });
        continue;
      }
      for (const spec of pending.filter((patch) => patch.applyAtSequence === event.sequence)) deliver(spec);
    }
    for (const spec of tail) deliver(spec);

    fingerprints.push({
      at: 'start',
      sha: fingerprint(store.getState()),
      notes: Object.keys(store.getState().notes).length,
      active: Object.values(store.getState().notes).filter((note) => note.status === 'active').length,
    });

    // 2) 对话轮。
    const restartAfter = story.restart?.afterTurn;
    for (let index = 0; index < story.turns.length; index += 1) {
      const turn = story.turns[index];
      if (turn === undefined) continue;
      const id = `chat-${story.storyId.toLowerCase()}-${arm.toLowerCase()}-${index + 1}`;
      currentTurn = index;
      const before = capture.stats.stubCalls;
      const pendingSend = current.chat.send({ id, text: turn.user });
      if (turn.cancel === true) current.chat.cancel(id);
      const result = await pendingSend;
      const sent = capture.stats.stubCalls - before;
      turns.push({
        index,
        status: result.status,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.text === undefined ? {} : { text: result.text }),
        note: `stub=${sent}`,
      });
      if (sent > 0) recordRequest(index);
      if (restartAfter !== undefined && index === restartAfter) {
        fingerprints.push({
          at: `before-restart-${index}`,
          sha: fingerprint(store.getState()),
          notes: Object.keys(store.getState().notes).length,
          active: Object.values(store.getState().notes).filter((note) => note.status === 'active').length,
        });
        store.close();
        const reopened = JsonlStore.open(storeDir);
        if (!reopened.ok) throw new Error(`restart failed: ${reopened.code} ${reopened.detail}`);
        store = reopened.value;
        current = buildSession();
        fingerprints.push({
          at: `after-restart-${index}`,
          sha: fingerprint(store.getState()),
          notes: Object.keys(store.getState().notes).length,
          active: Object.values(store.getState().notes).filter((note) => note.status === 'active').length,
        });
      }
    }

    // 3) 预算失败路径：trimToBudget 纯函数契约反例（非产品会话）。
    //    会话内不可达的说明：产品会话输入上限 500 字符，加上 system 与已裁历史后的
    //    固定开销远小于 4000 UTF16 预算，因此超限只能由直接构造的巨大问题触发；
    //    这里记录的 BudgetExceeded 是裁剪函数契约证据，不参与评分判定。
    try {
      const huge = '超'.repeat(MESSAGE_BUDGET.utf16);
      trimToBudget(huge, [], []);
      budgetFailures.push('unexpected: huge question did not fail');
    } catch (error) {
      budgetFailures.push(error instanceof Error ? error.message : String(error));
    }
  } finally {
    restore();
    try {
      store.close();
    } catch {
      // 已关闭时忽略。
    }
  }

  return {
    storyId: story.storyId,
    armId: arm,
    runId,
    storeDir,
    turns,
    requests,
    selection: arm === 'M' ? selectionRecords : [],
    fingerprints,
    budgetFailures,
    trims,
    stubCalls: capture.stats.stubCalls,
    realNetworkCalls: capture.stats.realNetworkCalls,
    sourceHashes: productSourceHashes(),
    state: store.getState(),
    patches: [],
  };
}

/** 清理临时 store 目录。 */
export function cleanupRun(run: StoryRun): void {
  try {
    rmSync(run.storeDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响证据。
  }
}

/** 导出给测试：记忆块的最终形态。 */
export function previewUserText(block: string, question: string): string {
  return composeUserText(block, question);
}

export { buildMemoryBlock, MESSAGE_BUDGET };
