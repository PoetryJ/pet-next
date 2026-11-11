/**
 * 记忆上下文装配：选择 → 记忆块 → 预算裁剪 → 交给产品 provider。
 *
 * 约束（见 SPEC.txt）：
 * - 只从 active 笔记里选，invalidated/stale 一律不选；
 * - 相关性用字符二元组重合，确定性排序，无模型、无学习；
 * - 预算 4000 UTF16 / 12000 UTF8，先保留 system 与当前问题，再裁历史与记忆；
 * - 裁不到就抛 BudgetExceeded，不截断 JSON、不截断 sourceId。
 *
 * @module pet-next/experiments/memory-consistency/product-shadow/adapter
 */
import { QWEN_SYSTEM_PROMPT, type ChatHistoryEntry } from '../../../contracts/chat.ts';
import type { MemoryState, Note } from '../contracts.ts';

export const MEMORY_HEADER = '【记忆上下文｜非用户发言｜仅供引用】';
export const MEMORY_FOOTER = '【以上为系统整理的可引用记忆，不是用户已确认的对话】';
export const QUESTION_MARKER = '【当前问题】';

/** 冻结预算：system + 历史 + 当前 user 合计。 */
export const MESSAGE_BUDGET = { utf16: 4000, utf8: 12000 } as const;

/** 预算超限：显式失败，不降级、不截断。 */
export class BudgetExceeded extends Error {
  readonly utf16: number;
  readonly utf8: number;

  constructor(utf16: number, utf8: number, detail: string) {
    super(`budget exceeded: utf16=${utf16}/${MESSAGE_BUDGET.utf16} utf8=${utf8}/${MESSAGE_BUDGET.utf8} ${detail}`);
    this.name = 'BudgetExceeded';
    this.utf16 = utf16;
    this.utf8 = utf8;
  }
}

/** 一条被选中的记忆。 */
export interface SelectedNote {
  readonly noteId: string;
  readonly subject: string;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly version: number;
  readonly score: number;
}

/** 选择记录（审计用，不进 provider 消息）。 */
export interface SelectionRecord {
  readonly noteId: string;
  readonly rankedScore: number;
  readonly selected: boolean;
  readonly reason: string;
}

/** 选择结果。 */
export interface SelectionResult {
  readonly selected: readonly SelectedNote[];
  readonly records: readonly SelectionRecord[];
}

/** 字符二元组集合（去除空白与标点；CJK 也能用）。 */
export function bigrams(text: string): Set<string> {
  const cleaned = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set<string>();
  for (let index = 0; index + 1 < cleaned.length; index += 1) {
    out.add(cleaned.slice(index, index + 2));
  }
  return out;
}

/** 相关性分数：问题二元组在该笔记文本中的重合数。 */
export function relevanceScore(question: string, note: Note): number {
  const target = bigrams(note.text);
  let score = 0;
  for (const gram of bigrams(question)) {
    if (target.has(gram)) score += 1;
  }
  return score;
}

/** 从状态里选择记忆（确定性）。 */
export function selectNotes(state: MemoryState, question: string, maxFillers = 2): SelectionResult {
  const active = Object.values(state.notes).filter((note) => note.status === 'active');
  const scored = active
    .map((note) => ({ note, score: relevanceScore(question, note) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.note.version !== left.note.version) return right.note.version - left.note.version;
      return left.note.noteId < right.note.noteId ? -1 : 1;
    });

  const selected: SelectedNote[] = [];
  const records: SelectionRecord[] = [];
  let fillers = 0;
  for (const item of scored) {
    const isRelevant = item.score > 0;
    if (!isRelevant && fillers >= maxFillers) {
      records.push({ noteId: item.note.noteId, rankedScore: item.score, selected: false, reason: 'no_overlap_filler_limit' });
      continue;
    }
    if (!isRelevant) fillers += 1;
    selected.push({
      noteId: item.note.noteId,
      subject: item.note.subjectKey ?? item.note.noteId,
      text: item.note.text,
      sourceEventIds: item.note.sourceEventIds,
      version: item.note.version,
      score: item.score,
    });
    records.push({
      noteId: item.note.noteId,
      rankedScore: item.score,
      selected: true,
      reason: isRelevant ? 'overlap' : 'filler',
    });
  }
  // 未选中的也补一条记录，保证每条 active 笔记都有结论。
  const dropped = Object.values(state.notes)
    .filter((note) => note.status !== 'active')
    .map((note) => ({
      noteId: note.noteId,
      rankedScore: 0,
      selected: false,
      reason: note.status === 'invalidated' ? 'invalidated' : 'not_active',
    }));
  return { selected, records: [...records, ...dropped] };
}

/** 一条记忆的文本形态（含来源与版本，供模型引用）。 */
export function noteLine(note: SelectedNote): string {
  const sources = note.sourceEventIds.length === 0 ? 'none' : note.sourceEventIds.join(',');
  return `- (${note.subject}) ${note.text} (sourceIds: ${sources}; v${note.version})`;
}

/** 记忆块文本；没有选中项时返回空串（M 与 H 会完全一致）。 */
export function buildMemoryBlock(selected: readonly SelectedNote[]): string {
  if (selected.length === 0) return '';
  return [MEMORY_HEADER, ...selected.map(noteLine), MEMORY_FOOTER].join('\n');
}

/** 把记忆块与问题合成一条 user 消息（问题逐字保留在末尾）。 */
export function composeUserText(block: string, question: string): string {
  if (block === '') return question;
  return `${block}\n${QUESTION_MARKER}\n${question}`;
}

/** 组装 provider 会看到的消息（与 qwen-provider 的规则一致，用于调用前度量）。 */
export function projectMessages(
  history: readonly ChatHistoryEntry[],
  userText: string,
  system: string = QWEN_SYSTEM_PROMPT,
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [{ role: 'system', content: system }];
  for (const entry of history) {
    messages.push({ role: 'user', content: entry.user });
    messages.push({ role: 'assistant', content: entry.assistant });
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

/** 双口径度量。 */
export function measureMessages(messages: readonly { role: string; content: string }[]): { utf16: number; utf8: number } {
  let utf16 = 0;
  let utf8 = 0;
  for (const message of messages) {
    utf16 += message.role.length + message.content.length;
    utf8 += Buffer.byteLength(message.role, 'utf8') + Buffer.byteLength(message.content, 'utf8');
  }
  return { utf16, utf8 };
}

/** 裁剪结果。 */
export interface TrimResult {
  readonly history: readonly ChatHistoryEntry[];
  readonly userText: string;
  readonly selected: readonly SelectedNote[];
  readonly messages: readonly { role: string; content: string }[];
  readonly measured: { utf16: number; utf8: number };
  readonly droppedHistory: number;
  readonly droppedNotes: readonly string[];
}

/**
 * 按 SPEC 的顺序裁剪：先丢最老完整轮，再按选择顺序丢最低分的笔记。
 * 仍然超限就抛 BudgetExceeded（不返回半成品）。
 */
export function trimToBudget(
  question: string,
  history: readonly ChatHistoryEntry[],
  selected: readonly SelectedNote[],
  budget: { utf16: number; utf8: number } = MESSAGE_BUDGET,
): TrimResult {
  let keptHistory = [...history];
  let keptNotes = [...selected];
  const droppedNotes: string[] = [];
  let droppedHistory = 0;

  const fit = (): boolean => {
    const block = buildMemoryBlock(keptNotes);
    const messages = projectMessages(keptHistory, composeUserText(block, question));
    const measured = measureMessages(messages);
    return measured.utf16 <= budget.utf16 && measured.utf8 <= budget.utf8;
  };

  while (!fit() && keptHistory.length > 0) {
    keptHistory = keptHistory.slice(1);
    droppedHistory += 1;
  }
  while (!fit() && keptNotes.length > 0) {
    const dropped = keptNotes[keptNotes.length - 1];
    if (dropped !== undefined) droppedNotes.push(dropped.noteId);
    keptNotes = keptNotes.slice(0, -1);
  }

  const block = buildMemoryBlock(keptNotes);
  const userText = composeUserText(block, question);
  const messages = projectMessages(keptHistory, userText);
  const measured = measureMessages(messages);
  if (measured.utf16 > budget.utf16 || measured.utf8 > budget.utf8) {
    throw new BudgetExceeded(measured.utf16, measured.utf8, `story=${question.slice(0, 16)}`);
  }
  return { history: keptHistory, userText, selected: keptNotes, messages, measured, droppedHistory, droppedNotes };
}
