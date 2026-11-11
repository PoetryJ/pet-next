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

/**
 * 冻结的断言（先写、后跑；hash 进 expected/manifest.json）。
 *
 * R3.1 目标轮身份契约（F1 修复）：评分必须绑定 `finalTurnIndex` 指定的目标轮，
 * 禁止「取 requests 数组末项」的回退——先前成功请求不得掩盖目标轮缺失/失败。
 */
export interface StoryExpectation {
  /** 目标轮（最终问题轮）的下标，从 0 起。评分与 demo 一律以该轮为准。 */
  readonly finalTurnIndex: number;
  /** 目标轮用户输入的冻结原文：目标请求最后一条 user 消息必须以它逐字结尾。 */
  readonly finalQuestion: string;
  /** M 臂目标请求必须出现的 sourceIds（当前证据）。 */
  readonly mustIncludeSourceIds: readonly string[];
  /** M 臂目标请求必须出现的文本片段。 */
  readonly mustIncludeText: readonly string[];
  /** 两臂目标请求都不得把旧值当当前记忆（文本片段）。 */
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
  /** 预算压力下限：M 目标请求的 UTF16 必须 ≥ 该值，否则说明没测到预算边界。 */
  readonly budgetPressureUtf16?: number;
  /**
   * 指定轮的请求可见文本必须包含给定片段（两臂）。
   * R3.1 F2：证明证据「确实进入过历史」，如 S1 首轮偏好出现在随后轮的请求里。
   */
  readonly turnMustIncludeText?: readonly { readonly turnIndex: number; readonly text: string }[];
  /**
   * 目标请求的历史部分（最后一条 user 消息之前的所有消息）不得包含的完整轮文本。
   * R3.1 F2：证明产品默认淘汰确实发生，如 S1 首轮偏好在最终历史中已被挤出。
   */
  readonly finalHistoryMustExcludeText?: readonly string[];
  /**
   * 允许的非 ok 轮（精确匹配 turnIndex 与 status），如 S7 的预期中途取消。
   * 列表外的任何非 ok 轮（含目标轮）都判失败。
   */
  readonly allowedNonOkTurns?: readonly { readonly turnIndex: number; readonly status: string }[];
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
  /**
   * 每轮会话结果（ok/error/cancelled）。
   * R3.1：error 轮保留产品返回的 `code`（too-long/busy/timeout/provider-error…），
   * 失败码原样留证，不得被先前成功请求掩盖。
   */
  readonly turns: readonly {
    readonly index: number;
    readonly status: string;
    readonly code?: string;
    readonly text?: string;
    readonly note?: string;
  }[];
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
