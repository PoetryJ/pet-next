/**
 * 记忆一致性实验的冻结契约 v1。
 *
 * 本文件只放类型、常量与确定性纯函数；reducer、patch 校验、存储、策略的实现分别在
 * ledger/、storage/、policies/、maintenance/ 内。任何一方不得在这里加实现分支。
 *
 * 三条不可退让的语义（见 COMMON.txt）：
 * 1) 生成 / 软件呈现 / 用户确认 / 工具完成 是四个独立事实，互不证明。
 * 2) 原始事件与派生笔记分开；取消与更正立即生效，不等后台整理。
 * 3) 相同 eventId 同载荷幂等，同 id 不同载荷必须显式冲突，不能静默覆盖。
 *
 * 预算只以 JS UTF-16 code units 与 UTF-8 bytes 命名；本轮没有真实 tokenizer，
 * 因此任何字段都不得叫 token 或换算成 API 费用。
 *
 * @module pet-next/experiments/memory-consistency/contracts
 */
import { createHash } from 'node:crypto';

/** 事件结构版本。载荷形状变化必须升大版本，不能就地改语义。 */
export const EVENT_SCHEMA_VERSION = 'memory-event/v1' as const;
/** 状态结构版本。快照与日志重放都要核对它。 */
export const STATE_SCHEMA_VERSION = 'memory-state/v1' as const;
/** 补丁结构版本。 */
export const PATCH_SCHEMA_VERSION = 'memory-patch/v1' as const;
/** 结果文件版本。run.mjs 与 eval 共用。 */
export const RESULT_SCHEMA_VERSION = 'memory-result/v1' as const;
/** 门禁结果信封版本。run.mjs 只认这个版本；缺字段一律判失败。 */
export const GATE_SCHEMA_VERSION = 'memory-gate/v1' as const;

/** 事件来源。产品侧只有这三类写入者。 */
export type EventSource = 'user' | 'runtime' | 'model';

/**
 * 事件种类。
 * - user.statement：用户原话（可带 scripted 抽取，标 scripted）。
 * - response.generated：模型/历史已生成一条回答（入史成功）。
 * - response.presented：回答被软件呈现到某个通道；不证明用户读到。
 * - user.acknowledged：用户明确确认（看到/关闭）；不证明工具成功。
 * - tool.result：工具执行结算；不证明呈现。
 * - task.changed：任务状态变化；authority 区分权威变更与自然语言候选。
 * - request.cancelled：单次请求取消；不是长期任务撤销。
 * - request.failed：单次请求失败。
 * - session.reset：会话代际结束；不是用户撤销长期任务。
 */
export type EventKind =
  | 'user.statement'
  | 'response.generated'
  | 'response.presented'
  | 'user.acknowledged'
  | 'tool.result'
  | 'task.changed'
  | 'request.cancelled'
  | 'request.failed'
  | 'session.reset';

export const EVENT_KINDS: readonly EventKind[] = [
  'user.statement',
  'response.generated',
  'response.presented',
  'user.acknowledged',
  'tool.result',
  'task.changed',
  'request.cancelled',
  'request.failed',
  'session.reset',
];

/** 呈现通道。unknown 表示软件无法确认呈现，不能当成已读。 */
export type PresentedChannel = 'ui' | 'api' | 'unknown';
/** 用户确认类型。 */
export type AckKind = 'seen' | 'dismissed';
/** 工具结算结果。unknown 不得自动升为 ok/error。 */
export type ToolOutcome = 'ok' | 'error' | 'unknown';
/** 任务变化类型。 */
export type TaskChange = 'created' | 'revised' | 'cancelled' | 'completed';
/**
 * 任务变化的权威性。
 * - explicit：产品侧权威状态机写入（模拟事件，synthetic 场景由测试构造）。
 * - scripted-candidate：脚本从自然语言抽取的候选，不能凭金标变成权威撤销。
 */
export type TaskAuthority = 'explicit' | 'scripted-candidate';

/** 笔记状态。candidate 不进当前事实；invalidated 必须保留原因。 */
export type NoteStatus = 'candidate' | 'active' | 'invalidated';

/** 笔记生成方式。本轮只允许确定性脚本或人工，绝不伪称模型摘要。 */
export type NoteGenerator = 'scripted' | 'operator' | 'unknown';

/** 事件载荷。按 kind 取用字段，其余忽略；形状由 ledger 的运行时守卫校验。 */
export interface EventPayload {
  readonly text?: string;
  /** user.statement 的确定性抽取结果，显式标注 scripted，不声称语义理解。 */
  readonly scripted?: ScriptedExtraction | null;
  readonly channel?: PresentedChannel;
  readonly ack?: AckKind;
  readonly toolName?: string;
  readonly outcome?: ToolOutcome;
  readonly detail?: string;
  readonly change?: TaskChange;
  readonly authority?: TaskAuthority;
  /** task.changed 可显式给出 subjectKey；缺省约定为 task:<taskId>。 */
  readonly subjectKey?: string;
  readonly reason?: string;
}

/** 脚本抽取。subjectKey 是被讨论对象（任务/偏好/工具槽位）的稳定键。 */
export interface ScriptedExtraction {
  readonly subjectKey: string;
  readonly valueText: string;
  readonly kindHint: 'preference' | 'task' | 'fact';
}

/**
 * 原始观察事件。sequence 是接收顺序，决定回放顺序；
 * occurredAt/observedAt 只作描述，不能决定谁覆盖谁。
 */
export interface MemoryEvent {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly source: EventSource;
  readonly kind: EventKind;
  /** kind 为 response.* / user.acknowledged / tool.result / request.* 时必填。 */
  readonly requestId?: string;
  /** kind 为 response.generated / response.presented / user.acknowledged 时必填。 */
  readonly responseId?: string;
  /** kind 为 task.changed 时必填。 */
  readonly taskId?: string;
  /** kind 为 task.changed 时必填，单调递增；旧 revision 不能覆盖新 revision。 */
  readonly taskRevision?: number;
  readonly payload: EventPayload;
}

/** 派生笔记。原始事件不可被笔记覆盖，失效必须保留来源与原因。 */
export interface Note {
  readonly noteId: string;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly parentNoteIds: readonly string[];
  /** 依赖节点 -> 依赖版本快照。节点 id 见 depIdForEvent / depIdForSubject / depIdForNote。 */
  readonly dependencyVersions: Readonly<Record<string, number>>;
  readonly status: NoteStatus;
  readonly invalidationReason?: string;
  readonly generator: NoteGenerator;
  readonly subjectKey?: string;
  /** 笔记自身版本，每次重写 +1。 */
  readonly version: number;
  readonly createdByOpId?: string;
  readonly invalidatedByOpId?: string;
}

/** 会话视图。reset 关闭一个代际，不撤销长期任务。 */
export interface SessionView {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly closed: boolean;
  readonly resetByEventId?: string;
  readonly resetSequence?: number;
  readonly eventCount: number;
}

/** 请求视图。四个阶段各自独立，任一为 true 不推出其它。 */
export interface RequestView {
  readonly requestKey: string;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly requestId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly generated: boolean;
  readonly presented: boolean;
  readonly acknowledged: boolean;
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly toolOutcome: ToolOutcome | 'none';
  readonly responseIds: readonly string[];
  /** 取消只作用于本请求；不做任务撤销。 */
  readonly cancelEventId?: string;
  readonly failReason?: string;
}

/** 任务视图。revision 单调，权威性与候选分离。 */
export interface TaskView {
  readonly taskKey: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly change: TaskChange;
  readonly authority: TaskAuthority;
  readonly lastEventId: string;
  readonly lastSequence: number;
  readonly subjectKey?: string;
  /** 候选变更不能改写权威状态，只记录在 candidates 供诊断。 */
  readonly candidates: readonly TaskCandidate[];
}

/** 候选任务变更记录。不进入权威 current-state。 */
export interface TaskCandidate {
  readonly eventId: string;
  readonly sequence: number;
  readonly change: TaskChange;
  readonly reason: string;
}

/** 已被接受的 patch 摘要，用于幂等与冲突判定。 */
export interface AppliedOp {
  readonly opId: string;
  readonly commitOrder: number;
  readonly digest: string;
  readonly stateVersion: number;
}

/** 事件身份冲突记录：同 eventId 不同载荷。 */
export interface ConflictRecord {
  readonly eventId: string;
  readonly firstSequence: number;
  readonly secondSequence: number;
  readonly digestFirst: string;
  readonly digestSecond: string;
}

/** 被拒绝的 patch 记录。拒绝必须留原因，不能暗中自动重试。 */
export interface RejectionRecord {
  readonly opId: string;
  readonly code: PatchVerdictCode;
  readonly sequence: number;
  readonly detail: string;
}

/** 权威状态。纯 reduce 的返回值，任何策略不得就地修改。 */
export interface MemoryState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  /** 每接受一个事件或一条 patch 自增；不因无关事件而阻止合法提交。 */
  readonly globalVersion: number;
  readonly lastSequence: number;
  readonly events: readonly MemoryEvent[];
  readonly eventIndex: Readonly<Record<string, number>>;
  /** subjectKey -> 版本。新陈述令同 subject 版本 +1，旧依赖随之失效。 */
  readonly subjectVersions: Readonly<Record<string, number>>;
  readonly sessions: Readonly<Record<string, SessionView>>;
  readonly requests: Readonly<Record<string, RequestView>>;
  readonly tasks: Readonly<Record<string, TaskView>>;
  readonly notes: Readonly<Record<string, Note>>;
  /** 反向依赖索引：被依赖节点 -> 直接依赖它的笔记。 */
  readonly dependents: Readonly<Record<string, readonly string[]>>;
  readonly appliedOps: Readonly<Record<string, AppliedOp>>;
  readonly conflicts: readonly ConflictRecord[];
  readonly rejectedPatches: readonly RejectionRecord[];
}

/** 补丁里的笔记草稿。不含 status/version：由单写者在应用时决定。 */
export interface NoteDraft {
  readonly noteId: string;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly parentNoteIds: readonly string[];
  readonly dependencyVersions: Readonly<Record<string, number>>;
  readonly generator: NoteGenerator;
  readonly subjectKey?: string;
}

/** 补丁里的失效指令。原因必填，不能空；目标版本必须在 dependencyVersions 里声明。 */
export interface NoteInvalidate {
  readonly noteId: string;
  readonly reason: string;
}

/** B 构造、A 应用。producer 只用于诊断，不参与验收。 */
export interface MemoryPatch {
  readonly schemaVersion: typeof PATCH_SCHEMA_VERSION;
  readonly opId: string;
  /** 构造者看到的 globalVersion；A 必须从来源重算，不信自报版本。 */
  readonly snapshotVersion: number;
  readonly dependencyVersions: Readonly<Record<string, number>>;
  readonly notesToUpsert: readonly NoteDraft[];
  readonly notesToInvalidate: readonly NoteInvalidate[];
  readonly producer: 'full-rebuild' | 'incremental' | 'manual' | 'unknown';
}

/** 判定码。每个失败码都要有对应失败轨迹，不能只给一个布尔。 */
export type PatchVerdictCode =
  | 'ok'
  | 'invalid_shape'
  | 'unknown_source'
  | 'source_not_observed'
  | 'state_not_allowed'
  | 'dependency_stale'
  | 'dependency_undeclared'
  | 'version_mismatch'
  | 'cycle'
  | 'op_replay'
  | 'op_conflict';

/** 结构化拒绝原因。detail 面向人读，topic 面向机器比对。 */
export interface PatchRejectionReason {
  readonly topic: 'source' | 'status' | 'dependency' | 'version' | 'graph' | 'op' | 'shape';
  readonly detail: string;
  readonly noteId?: string;
  readonly dependencyId?: string;
}

/** 校验结论。recomputedDependencies 是 A 从来源重算的结果，不是 patch 自报值。 */
export interface PatchVerdict {
  readonly accepted: boolean;
  readonly code: PatchVerdictCode;
  readonly reasons: readonly PatchRejectionReason[];
  readonly recomputedDependencies: Readonly<Record<string, number>>;
}

/** 预算。两种计量分别命名，不能混算。 */
export interface Budget {
  readonly utf16Units: number;
  readonly utf8Bytes: number;
}

/** 编译上下文时的查询。 */
export interface ContextQuery {
  readonly text: string;
  /** 可选：只取这些 subject 的笔记。不给就按策略自选。 */
  readonly subjectKeys?: readonly string[];
}

/** 上下文诊断。只给评分器，不能进入策略消费者可见文本。 */
export interface ContextDiagnostic {
  readonly code:
    | 'budget_exceeded'
    | 'omitted_for_budget'
    | 'excluded_invalidated'
    | 'excluded_candidate'
    | 'scripted_derivation'
    | 'unknown_state'
    | 'empty';
  readonly detail: string;
  readonly noteId?: string;
}

/** 编译结果。text 是实际送给消费者的序列化内容，来源说明与状态标签都计入预算。 */
export interface CompiledContext {
  readonly schemaVersion: 'memory-context/v1';
  readonly policyId: PolicyId;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly diagnostics: readonly ContextDiagnostic[];
  readonly usage: { readonly utf16Units: number; readonly utf8Bytes: number };
  readonly budget: Budget;
  /** true 表示策略无法在预算内完成，调用方必须显式失败，不得静默截断掩盖。 */
  readonly exceeded: boolean;
}

/** 四种策略。recent-turns 与 state-ledger 是弱基线，不是研究结论。 */
export type PolicyId = 'recent-turns' | 'state-ledger' | 'layered-notes' | 'dependency-notes';

export const POLICY_IDS: readonly PolicyId[] = [
  'recent-turns',
  'state-ledger',
  'layered-notes',
  'dependency-notes',
];

/** 策略输入。只含当时已开放内容；不含 pairId、类别、金标、未来事件。 */
export interface PolicyInput {
  readonly events: readonly MemoryEvent[];
  readonly state: MemoryState;
  readonly query: ContextQuery;
  readonly budget: Budget;
}

/** 策略接口。实现方不得读取文件名、标签或测试期望。 */
export interface MemoryPolicy {
  readonly id: PolicyId;
  compile(input: PolicyInput): CompiledContext;
}

/** reduce 的选项。open 上限用来实现「只开放到当时 sequence」。 */
export interface ReduceOptions {
  /** 只回放 sequence <= openUntilSequence 的事件。 */
  readonly openUntilSequence?: number;
}

/** reduce 结果。rejectedEvents 记录形状/时序非法的事件，不静默丢弃。 */
export interface ReduceResult {
  readonly state: MemoryState;
  readonly rejectedEvents: readonly { readonly eventId: string; readonly reason: string }[];
}

/** 纯 reducer 签名。 */
export type Reducer = (events: readonly MemoryEvent[], options?: ReduceOptions) => ReduceResult;

/** patch 校验签名。 */
export type PatchValidator = (state: MemoryState, patch: MemoryPatch) => PatchVerdict;

/** 存储错误码。冻结后 A 不得改名。 */
export type StoreErrorCode =
  | 'duplicate_event'
  | 'event_conflict'
  | 'patch_conflict'
  | 'patch_rejected'
  | 'op_replay'
  | 'io_error'
  | 'corrupt_log'
  | 'schema_unknown'
  | 'manifest_mismatch'
  | 'tail_incomplete'
  | 'writer_busy'
  | 'not_found'
  | 'not_supported';

export const STORE_ERROR_CODES: readonly StoreErrorCode[] = [
  'duplicate_event',
  'event_conflict',
  'patch_conflict',
  'patch_rejected',
  'op_replay',
  'io_error',
  'corrupt_log',
  'schema_unknown',
  'manifest_mismatch',
  'tail_incomplete',
  'writer_busy',
  'not_found',
  'not_supported',
];

/** 成功结果。durable=true 表示事务记录已落盘后才返回。 */
export interface StoreOk<T> {
  readonly ok: true;
  readonly value: T;
  /** 已确认落盘；false 只允许出现在纯内存模式。 */
  readonly durable: boolean;
}

/** 失败结果。diagnostics 保留原始字节位置等上下文。 */
export interface StoreErr {
  readonly ok: false;
  readonly code: StoreErrorCode;
  readonly detail: string;
  readonly offset?: number;
}

export type StoreResult<T> = StoreOk<T> | StoreErr;

/** append 返回值。 */
export interface AppendValue {
  readonly eventId: string;
  readonly sequence: number;
  readonly globalVersion: number;
  /** duplicate 表示同 id 同载荷重复到达，未重复生效。 */
  readonly disposition: 'appended' | 'duplicate';
}

/** commitPatch 返回值。 */
export interface CommitValue {
  readonly opId: string;
  readonly commitOrder: number;
  readonly globalVersion: number;
  readonly disposition: 'applied' | 'replayed';
  readonly invalidatedNoteIds: readonly string[];
}

/** 快照清单。恢复时逐项核对。 */
export interface CheckpointManifest {
  readonly schemaVersion: 'memory-checkpoint/v1';
  readonly checkpointId: string;
  readonly stateVersion: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  /** 日志文件位置与截至字节偏移。 */
  readonly logFile: string;
  readonly logBytes: number;
  readonly logSha256: string;
  /** 快照自校验。 */
  readonly stateSha256: string;
  readonly createdAt: string;
  readonly previousCheckpointId?: string;
}

/** 尾部隔离记录：原字节单独落盘，日志截断到修复点。 */
export interface TailQuarantine {
  /** 隔离文件名（相对于存储目录）。 */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** load 返回值。恢复报告要能说明尾部是否被隔离、是否已可安全写入。 */
export interface LoadValue {
  readonly state: MemoryState;
  readonly eventCount: number;
  readonly appliedPatchCount: number;
  readonly checkpointId?: string;
  readonly isolatedTailBytes: number;
  /** 有坏尾时给出隔离文件；没有坏尾则缺省。 */
  readonly tailQuarantine?: TailQuarantine;
  readonly diagnostics: readonly string[];
}

/** 存储接口。策略不得直写磁盘，也不得绕过它改权威状态。 */
export interface MemoryStore {
  append(event: MemoryEvent): StoreResult<AppendValue>;
  commitPatch(patch: MemoryPatch): StoreResult<CommitValue>;
  load(): StoreResult<LoadValue>;
  checkpoint(): StoreResult<CheckpointManifest>;
  /** 关闭写者。之后任何写都要 writer_busy/已关闭错误。 */
  close(): StoreResult<{ readonly closed: true }>;
}

/** 会话键：同一 sessionId 的不同代际不能互相污染。 */
export function sessionKey(sessionId: string, sessionEpoch: number): string {
  return `${sessionId}#${sessionEpoch}`;
}

/** 请求键：身份是 sessionId+sessionEpoch+requestId。 */
export function requestKey(sessionId: string, sessionEpoch: number, requestId: string): string {
  return `${sessionId}#${sessionEpoch}#${requestId}`;
}

/** 任务键：taskId 在 session 内唯一，revision 独立。 */
export function taskKey(sessionId: string, taskId: string): string {
  return `${sessionId}::${taskId}`;
}

/** 依赖节点：事件来源。 */
export function depIdForEvent(eventId: string): string {
  return `event:${eventId}`;
}

/** 依赖节点：subject 当前版本。 */
export function depIdForSubject(subjectKey: string): string {
  return `subject:${subjectKey}`;
}

/** 依赖节点：笔记自身版本。 */
export function depIdForNote(noteId: string): string {
  return `note:${noteId}`;
}

/** 空状态。globalVersion=0 表示还没有任何事件。 */
export function emptyState(): MemoryState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    globalVersion: 0,
    lastSequence: 0,
    events: [],
    eventIndex: {},
    subjectVersions: {},
    sessions: {},
    requests: {},
    tasks: {},
    notes: {},
    dependents: {},
    appliedOps: {},
    conflicts: [],
    rejectedPatches: [],
  };
}

/** 确定性序列化：对象键排序，数组保持顺序。用于摘要与等价比较。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
}

/** 统计 JS UTF-16 code units。 */
export function countUtf16(text: string): number {
  return text.length;
}

/** 统计 UTF-8 bytes。不叫 token。 */
export function countUtf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 预算用量。 */
export function measureUsage(text: string): { readonly utf16Units: number; readonly utf8Bytes: number } {
  return { utf16Units: countUtf16(text), utf8Bytes: countUtf8(text) };
}

/** 是否超出预算。任一维超限即超限，取严。 */
export function exceedsBudget(usage: { utf16Units: number; utf8Bytes: number }, budget: Budget): boolean {
  return usage.utf16Units > budget.utf16Units || usage.utf8Bytes > budget.utf8Bytes;
}

/** 事件载荷摘要。用于同 id 冲突判定与幂等比对。 */
export function eventDigest(event: MemoryEvent): string {
  return canonicalJson({
    eventId: event.eventId,
    sessionId: event.sessionId,
    sessionEpoch: event.sessionEpoch,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    observedAt: event.observedAt,
    source: event.source,
    kind: event.kind,
    requestId: event.requestId ?? null,
    responseId: event.responseId ?? null,
    taskId: event.taskId ?? null,
    taskRevision: event.taskRevision ?? null,
    payload: event.payload,
  });
}

/** 除 sequence 外的载荷摘要：同 eventId 换个 sequence 重发仍算同载荷。 */
export function eventPayloadDigest(event: MemoryEvent): string {
  return canonicalJson({
    sessionId: event.sessionId,
    sessionEpoch: event.sessionEpoch,
    source: event.source,
    kind: event.kind,
    requestId: event.requestId ?? null,
    responseId: event.responseId ?? null,
    taskId: event.taskId ?? null,
    taskRevision: event.taskRevision ?? null,
    payload: event.payload,
  });
}

/**
 * patch 摘要。同 opId 同载荷幂等，不同载荷冲突。
 * snapshotVersion 是构造时的观察值，不属于「意图」，所以不进摘要：
 * 一次网络重试只要笔记内容与依赖声明不变，就仍算同载荷。
 */
export function patchDigest(patch: MemoryPatch): string {
  return canonicalJson({
    opId: patch.opId,
    dependencyVersions: patch.dependencyVersions,
    notesToUpsert: patch.notesToUpsert,
    notesToInvalidate: patch.notesToInvalidate,
  });
}

/** SHA-256 十六进制摘要。日志与快照校验用。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 载荷哈希：幂等与冲突判定的稳定键。 */
export function payloadHash(event: MemoryEvent): string {
  return sha256Hex(eventPayloadDigest(event));
}

/** 事件是否带该 kind 必需的识别字段。形状守卫的第一层。 */
export function requiredIdsPresent(event: MemoryEvent): boolean {
  switch (event.kind) {
    case 'response.generated':
    case 'response.presented':
    case 'user.acknowledged':
    case 'tool.result':
    case 'request.cancelled':
    case 'request.failed':
      if (event.requestId === undefined) return false;
      if (event.kind === 'tool.result' || event.kind === 'request.cancelled' || event.kind === 'request.failed') {
        return true;
      }
      return event.responseId !== undefined;
    case 'task.changed':
      return event.taskId !== undefined && event.taskRevision !== undefined;
    case 'user.statement':
    case 'session.reset':
      return true;
    default:
      return false;
  }
}

/**
 * 门禁结果信封。run.mjs 用它判断「这次结果是不是这次跑的」：
 * schema / gateId / runId / sourceCommit 全对且 passed_gate 为真才算通过。
 * 只检查子进程退出码不足以判断（空脚本 exit 0 会假通过）。
 */
export interface GateEnvelope {
  readonly schemaVersion: typeof GATE_SCHEMA_VERSION;
  readonly gateId: 'G1' | 'P1' | 'P2';
  /** 本次运行 id；由 run.mjs 生成并传入，禁止复用上一次的产物。 */
  readonly runId: string;
  /** 被测源码身份：git HEAD，或在无 .git 的归档中显式声明。 */
  readonly sourceCommit: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly passed_gate: boolean;
}

/**
 * 成本计数。约定：
 * - eventsVisited 是「实际访问事件对象的次数」，遍历一次全量就 +N，不能只算命中；
 * - uniqueEventsTouched 是去重后的条数；
 * - indexBuilds / indexLookups 是索引本身的建立与查询次数；
 * - bytesRead 是被读取对象的序列化字节，不是补丁大小。
 * 任何报告不得把 eventsVisited 叫作「扫描命中数」，也不得把 uniqueEventsTouched 当工作量。
 */
export interface CostCounters {
  readonly eventsVisited: number;
  readonly uniqueEventsTouched: number;
  readonly indexBuilds: number;
  readonly indexLookups: number;
  readonly notesExamined: number;
  readonly notesRebuilt: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}
