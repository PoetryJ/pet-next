/**
 * M3-3 当前会话的有界历史：只保存最近成功交付的完整轮次，主进程/核心内存持有。
 * 边界：最多 CHAT_HISTORY_MAX_TURNS 个完整轮次，且历史 user+assistant 合计字符
 * 不超过 CHAT_HISTORY_MAX_CHARS（JS .length 字符预算，不是 token 预算）。
 * 淘汰只按“最老完整轮”进行，绝不留半轮；单轮自身超字符上限时按规则清空（见 push）。
 * 纯数据结构：不依赖 DOM/网络/Electron；快照不可变，供请求接受时注入 Provider。
 * @module pet-next/core/chat/history
 */

/** 冻结上界：最多保留的完整轮次数。 */
export const CHAT_HISTORY_MAX_TURNS = 4;
/** 冻结上界：历史 user+assistant 合计字符数（.length）。 */
export const CHAT_HISTORY_MAX_CHARS = 2000;

/** 一轮成功对话的不可变记录（与 contracts/chat.ts 冻结形状一致；core 自含副本）。 */
export interface ChatHistoryEntry {
  readonly user: string;
  readonly assistant: string;
}

/** 有界历史仓库：session 在成功交付后 push、发请求前 snapshot、重置时 clear。 */
export interface ChatHistoryStore {
  /** 记录一轮已成功交付的对话；随后按上界淘汰最老完整轮。 */
  push(user: string, assistant: string): void;
  /** 请求接受时的不可变快照：条目与数组均冻结，后续 push/clear 不影响已发出的快照。 */
  snapshot(): readonly ChatHistoryEntry[];
  /** 清空全部历史（新对话）。 */
  clear(): void;
  /** 当前保留轮数（诊断/测试用）。 */
  turns(): number;
  /** 当前历史 user+assistant 合计字符数（诊断/测试用）。 */
  chars(): number;
}

function totalChars(entries: readonly ChatHistoryEntry[]): number {
  let sum = 0;
  for (const entry of entries) sum += entry.user.length + entry.assistant.length;
  return sum;
}

export function createChatHistory(options?: { maxTurns?: number; maxChars?: number }): ChatHistoryStore {
  const maxTurns = options?.maxTurns ?? CHAT_HISTORY_MAX_TURNS;
  const maxChars = options?.maxChars ?? CHAT_HISTORY_MAX_CHARS;
  let entries: ChatHistoryEntry[] = [];

  return {
    push(user: string, assistant: string): void {
      const entry: ChatHistoryEntry = Object.freeze({ user, assistant });
      entries = [...entries, entry];
      // 只按“最老完整轮”淘汰：先满足轮数上界，再满足字符上界；
      // 若最新一轮自身已超字符上界，则连它一起淘汰（宁空不过界，绝不留半轮）。
      while (entries.length > 0 && (entries.length > maxTurns || totalChars(entries) > maxChars)) {
        entries = entries.slice(1);
      }
    },
    snapshot(): readonly ChatHistoryEntry[] {
      return Object.freeze([...entries]);
    },
    clear(): void {
      entries = [];
    },
    turns(): number {
      return entries.length;
    },
    chars(): number {
      return totalChars(entries);
    },
  };
}
