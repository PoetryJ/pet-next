/**
 * 四种同源策略。共同点：
 * - 输入只有原始事件、权威状态、查询与预算；没有 pairId、类别、金标、未来事件。
 * - 统一的序列化格式与超限行为：装不下就停并记诊断，绝不悄悄截断或加隐藏输入。
 * - 预算按实际送出的文本计（UTF-16 code units / UTF-8 bytes 两维取严）。
 *
 * 差别只在「用什么组织当前事实」：
 * recent-turns 只用近期事件；state-ledger 用有效笔记平铺；
 * layered-notes 按层分组并保留父子缩进；dependency-notes 额外给出依赖与失效原因。
 *
 * @module pet-next/experiments/memory-consistency/policies/compile
 */
import {
  measureUsage,
  type CompiledContext,
  type ContextDiagnostic,
  type Budget,
  type MemoryEvent,
  type MemoryPolicy,
  type MemoryState,
  type Note,
  type PolicyId,
  type PolicyInput,
} from '../contracts.ts';

/** 一条可见条目。来源 id 与状态标签都属于消费者可见内容，必须计入预算。 */
export interface ContextItem {
  readonly label: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

/**
 * 统一装填：头部必留，其余按顺序装，装不下就停。
 * 若连头部都超限，直接报 budget_exceeded，不返回半截正文。
 */
export function assemble(
  policyId: PolicyId,
  header: string,
  items: readonly ContextItem[],
  budget: Budget,
  seedDiagnostics: readonly ContextDiagnostic[] = [],
): CompiledContext {
  const diagnostics: ContextDiagnostic[] = [...seedDiagnostics];
  const headerText = `${header}\n`;
  const headerUsage = measureUsage(headerText);
  if (headerUsage.utf16Units > budget.utf16Units || headerUsage.utf8Bytes > budget.utf8Bytes) {
    return {
      schemaVersion: 'memory-context/v1',
      policyId,
      text: '',
      sourceIds: [],
      diagnostics: [...diagnostics, { code: 'budget_exceeded', detail: `header needs ${headerUsage.utf16Units}u/${headerUsage.utf8Bytes}b` }],
      usage: { utf16Units: 0, utf8Bytes: 0 },
      budget,
      exceeded: true,
    };
  }

  let text = headerText;
  const sourceIds: string[] = [];
  let omitted = 0;
  for (const item of items) {
    const line = `- ${item.label}: ${item.text}${item.sourceIds.length === 0 ? '' : ` (src: ${item.sourceIds.join(',')})`}\n`;
    const next = text + line;
    const usage = measureUsage(next);
    if (usage.utf16Units > budget.utf16Units || usage.utf8Bytes > budget.utf8Bytes) {
      omitted += 1;
      continue;
    }
    text = next;
    for (const id of item.sourceIds) {
      if (!sourceIds.includes(id)) sourceIds.push(id);
    }
  }
  if (omitted > 0) {
    diagnostics.push({ code: 'omitted_for_budget', detail: `${omitted} item(s) did not fit the declared budget` });
  }
  const usage = measureUsage(text);
  if (items.length === 0) {
    diagnostics.push({ code: 'empty', detail: 'no item available for this query' });
  }
  return {
    schemaVersion: 'memory-context/v1',
    policyId,
    text,
    sourceIds,
    diagnostics,
    usage,
    budget,
    exceeded: false,
  };
}

function activeNotes(state: MemoryState): readonly Note[] {
  return Object.values(state.notes)
    .filter((note) => note.status === 'active')
    .sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
}

function withinQuery(note: Note, subjectKeys: readonly string[] | undefined): boolean {
  if (subjectKeys === undefined || subjectKeys.length === 0) return true;
  return note.subjectKey !== undefined && subjectKeys.includes(note.subjectKey);
}

/** 近期完整轮历史：只用事件，不看笔记。弱基线。 */
function renderRecentTurns(input: PolicyInput): CompiledContext {
  const relevant: readonly MemoryEvent[] = input.events.filter((event) => {
    if (event.sequence > input.state.lastSequence) return false;
    return (
      event.kind === 'user.statement' ||
      event.kind === 'response.generated' ||
      event.kind === 'response.presented' ||
      event.kind === 'tool.result' ||
      event.kind === 'task.changed'
    );
  });
  const items: ContextItem[] = [];
  for (const event of [...relevant].slice(-24)) {
    const label = `#${event.sequence} ${event.kind}`;
    let body: string;
    switch (event.kind) {
      case 'user.statement':
        body = event.payload.text ?? '';
        break;
      case 'response.generated':
        body = event.payload.text ?? '';
        break;
      case 'response.presented':
        body = `channel=${event.payload.channel ?? 'unknown'}`;
        break;
      case 'tool.result':
        body = `${event.payload.toolName ?? 'tool'}=${event.payload.outcome ?? 'unknown'}`;
        break;
      case 'task.changed':
        body = `${event.taskId ?? 'task'}=${event.payload.change ?? 'unknown'}@r${event.taskRevision ?? 0}`;
        break;
      default:
        body = '';
    }
    items.push({ label, text: body, sourceIds: [event.eventId] });
  }
  return assemble('recent-turns', 'policy=recent-turns v1', items, input.budget);
}

/** 简单有效状态账本：当前有效笔记平铺，检索按 subject 过滤。 */
function renderStateLedger(input: PolicyInput): CompiledContext {
  const notes = activeNotes(input.state).filter((note) => withinQuery(note, input.query.subjectKeys));
  const diagnostics: ContextDiagnostic[] = [];
  const invalidated = Object.values(input.state.notes).filter((note) => note.status === 'invalidated').length;
  if (invalidated > 0) {
    diagnostics.push({ code: 'excluded_invalidated', detail: `${invalidated} invalidated note(s) excluded` });
  }
  const items = notes.map((note) => ({
    label: `[${note.subjectKey ?? note.noteId}]`,
    text: note.text,
    sourceIds: note.sourceEventIds,
  }));
  return assemble('state-ledger', 'policy=state-ledger v1', items, input.budget, diagnostics);
}

/** 分层笔记：按 subject 前缀分层，父笔记下的派生笔记缩进显示。 */
function renderLayeredNotes(input: PolicyInput): CompiledContext {
  const notes = activeNotes(input.state).filter((note) => withinQuery(note, input.query.subjectKeys));
  const byParent = new Map<string | undefined, Note[]>();
  for (const note of notes) {
    const parent = note.parentNoteIds[0];
    const bucket = byParent.get(parent) ?? [];
    bucket.push(note);
    byParent.set(parent, bucket);
  }
  const layerOf = (note: Note): string => {
    const key = note.subjectKey ?? '';
    if (key.startsWith('pref:')) return 'preference';
    if (key.startsWith('task:')) return 'task';
    return 'other';
  };
  const ordered = ['preference', 'task', 'other'];
  const items: ContextItem[] = [];
  for (const layer of ordered) {
    const inLayer = notes.filter((note) => layerOf(note) === layer);
    if (inLayer.length === 0) continue;
    items.push({ label: `layer=${layer}`, text: `${inLayer.length} note(s)`, sourceIds: [] });
    for (const note of inLayer) {
      const depth = note.parentNoteIds.length === 0 ? 0 : 1;
      items.push({
        label: `${'  '.repeat(depth)}[${note.noteId}]`,
        text: note.text,
        sourceIds: note.sourceEventIds,
      });
    }
  }
  const diagnostics: ContextDiagnostic[] = [];
  const candidates = Object.values(input.state.notes).filter((note) => note.status === 'candidate').length;
  if (candidates > 0) {
    diagnostics.push({ code: 'excluded_candidate', detail: `${candidates} candidate note(s) excluded` });
  }
  return assemble('layered-notes', 'policy=layered-notes v1', items, input.budget, diagnostics);
}

/** 依赖约束笔记：有效笔记带依赖版本，另附最近失效原因，便于核对来源。 */
function renderDependencyNotes(input: PolicyInput): CompiledContext {
  const notes = activeNotes(input.state).filter((note) => withinQuery(note, input.query.subjectKeys));
  const items: ContextItem[] = [];
  for (const note of notes) {
    const deps = Object.entries(note.dependencyVersions)
      .filter(([depId]) => depId.startsWith('subject:') || depId.startsWith('note:'))
      .map(([depId, version]) => `${depId.replace(/^(subject|note):/, '')}@${version}`)
      .join(' ');
    items.push({
      label: `[${note.noteId}]`,
      text: `${note.text}${deps === '' ? '' : ` deps=${deps}`}`,
      sourceIds: note.sourceEventIds,
    });
  }
  const invalidated = Object.values(input.state.notes)
    .filter((note) => note.status === 'invalidated')
    .sort((a, b) => (a.noteId < b.noteId ? -1 : 1));
  for (const note of invalidated) {
    items.push({
      label: `[${note.noteId}] invalidated`,
      text: `${note.text} reason=${note.invalidationReason ?? 'unknown'}`,
      sourceIds: note.sourceEventIds,
    });
  }
  const diagnostics: ContextDiagnostic[] = [
    { code: 'scripted_derivation', detail: 'notes are deterministic scripted derivations, not model summaries' },
  ];
  return assemble('dependency-notes', 'policy=dependency-notes v1', items, input.budget, diagnostics);
}

/** 四个策略实现。 */
export const POLICIES: readonly MemoryPolicy[] = [
  { id: 'recent-turns', compile: renderRecentTurns },
  { id: 'state-ledger', compile: renderStateLedger },
  { id: 'layered-notes', compile: renderLayeredNotes },
  { id: 'dependency-notes', compile: renderDependencyNotes },
];

/** 按 id 取策略，找不到直接抛。 */
export function policyById(id: PolicyId): MemoryPolicy {
  const found = POLICIES.find((policy) => policy.id === id);
  if (found === undefined) throw new Error(`unknown policy: ${id}`);
  return found;
}
