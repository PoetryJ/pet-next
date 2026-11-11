/**
 * R3 桌宠真实会话路径的离线对照：冻结接口。
 *
 * 这里的类型只描述「实验外壳」与「捕获记录」，不复刻产品实现。
 * 产品模块（core/chat/history.ts、session.ts、adapters/chat/qwen-provider.ts、
 * contracts/chat.ts）只读导入；任何消息都由产品 provider 自己序列化。
 *
 * @module pet-next/experiments/memory-consistency/product-shadow/contracts
 */
import type { MemoryPatch, MemoryState } from '../contracts.ts';

/** 两臂：H=仅产品有界历史；M=同一路径 + 记忆上下文。 */
export type ArmId = 'H' | 'M';

/** 一轮对话脚本。stub 只做占位回复，不参与评分。 */
export interface StoryTurn {
  readonly user: string;
  readonly stub: string;
  /** 发送后立刻取消：用于检验「取消不得入史」。 */
  readonly cancel?: boolean;
}

/** 笔记草稿（与补丁里的 notesToUpsert 同形，但去掉依赖声明，由 runner 重算）。 */
export interface StoryNote {
  readonly noteId: string;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly parentNoteIds?: readonly string[];
  readonly subjectKey?: string;
}

/** 迟到/按时补丁脚本。applyAtSequence=null 表示全部事件之后再交付。 */
export interface StoryPatch {
  readonly patchId: string;
  readonly buildAtSequence: number;
  readonly applyAtSequence: number | null;
  readonly notes: readonly StoryNote[];
  readonly invalidates?: readonly { readonly noteId: string; readonly reason: string }[];
  /** 是否强制应用（负控：让旧补丁落地，检验最终请求是否仍使用旧值）。 */
  readonly forceApply?: boolean;
}

/** 重启点：在该轮之后 close store、重建 history/session。 */
export interface RestartSpec {
  readonly afterTurn: number;
}

/** 冻结的断言（先写、后跑；hash 进 expected/manifest.json）。 */
export interface StoryExpectation {
  /** M 臂最终请求必须出现的 sourceIds（当前证据）。 */
  readonly mustIncludeSourceIds: readonly string[];
  /** M 臂最终请求必须出现的文本片段。 */
  readonly mustIncludeText: readonly string[];
  /** 两臂最终请求都不得把旧值当当前记忆（文本片段）。 */
  readonly mustNotIncludeText: readonly string[];
  /** 两臂都不得出现这些 sourceIds（被更正/撤销的来源）。 */
  readonly mustNotIncludeSourceIds: readonly string[];
  /** H 臂不得出现记忆块标记；M 臂必须出现。 */
  readonly memoryBlock: 'absent-in-H' | 'present-in-M';
  /** 两次重启前后，最终请求的记忆块必须一致。 */
  readonly restartEquivalent: boolean;
  /** 预算（UTF16 / UTF8）。 */
  readonly budget: { readonly utf16: number; readonly utf8: number };
  /** 该故事是否允许 M 与 H 请求体完全相同（无可用记忆时）。 */
  readonly allowIdentical?: boolean;
  /** 预算压力下限：M 最终请求的 UTF16 必须 ≥ 该值，否则说明没测到预算边界。 */
  readonly budgetPressureUtf16?: number;
}

/** 一个固定故事。 */
export interface StoryFile {
  readonly storyId: string;
  readonly title: string;
  readonly question: string;
  /** 事件按 sequence 递增；形状与 cases/dev 的 events 相同。 */
  readonly events: readonly unknown[];
  readonly patches: readonly StoryPatch[];
  readonly turns: readonly StoryTurn[];
  readonly restart?: RestartSpec;
  readonly expect: StoryExpectation;
}

/** 捕获到的一次真实 provider 请求。 */
export interface CapturedRequest {
  readonly storyId: string;
  readonly armId: ArmId;
  readonly turnIndex: number;
  readonly url: string;
  readonly bodyText: string;
  readonly bodySha256: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly utf16: number;
  readonly utf8: number;
  readonly stubCalls: number;
  readonly realNetworkCalls: number;
}

/** 一次 run 的记录。 */
export interface StoryRun {
  readonly storyId: string;
  readonly armId: ArmId;
  readonly runId: string;
  readonly storeDir: string;
  /** 每轮会话结果（ok/error/cancelled）。 */
  readonly turns: readonly { readonly index: number; readonly status: string; readonly text?: string; readonly note?: string }[];
  /** 捕获到的请求（每轮一条，含被取消/失败前已发出的）。 */
  readonly requests: readonly CapturedRequest[];
  /** 记忆选择记录：选中/丢弃与原因。 */
  readonly selection: readonly {
    readonly noteId: string;
    readonly rankedScore: number;
    readonly selected: boolean;
    readonly reason: string;
  }[];
  /** 重启前后的状态指纹。 */
  readonly fingerprints: readonly { readonly at: string; readonly sha: string; readonly notes: number; readonly active: number }[];
  readonly budgetFailures: readonly string[];
  /** 每轮裁剪记录：丢了几个完整轮、哪些笔记（预算证据）。 */
  readonly trims: readonly {
    readonly turnIndex: number;
    readonly droppedHistory: number;
    readonly droppedNotes: readonly string[];
    readonly utf16: number;
    readonly utf8: number;
  }[];
  readonly stubCalls: number;
  readonly realNetworkCalls: number;
  /** 运行期注入的产品源码指纹。 */
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly state: MemoryState;
  readonly patches: readonly MemoryPatch[];
}

/** 断言结果。 */
export interface AssertionResult {
  readonly storyId: string;
  readonly armId: ArmId;
  readonly id: string;
  readonly ok: boolean;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly note?: string;
}
