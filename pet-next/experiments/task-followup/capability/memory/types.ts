/**
 * capability/memory 公共类型。
 *
 * 设计要点（与旧 memory-bridge / P3 / N1 基线并存，不替换它们）：
 * - Turn 是用户/助手/工具原话，追加写入，不改写；撤回走 retraction 记录。
 * - MemoryItem 只能由“模型抽取结果 + 本地结构校验”产生；引用必须能在原话里逐字定位。
 * - authority 由引用原话的 role 推导，而不是相信模型自报：模型猜测不能变成用户偏好或完成事实。
 * - 当前/历史查询在读取时按 asOf 重新计算有效性，不在写入时覆盖旧版本。
 */

export type TurnRole = 'user' | 'assistant' | 'tool'

export interface Turn {
  readonly turnId: string
  readonly sessionId: string
  readonly seq: number
  /** ISO8601 带时区 */
  readonly at: string
  readonly role: TurnRole
  readonly text: string
  /** 说话时所处的任务上下文；空数组表示无任务上下文（可能是全局约定）。 */
  readonly taskIds: readonly string[]
  readonly projectId?: string | null
}

export type MemoryKind = 'fact' | 'preference' | 'commitment' | 'outcome'
export type ScopeLevel = 'global' | 'project' | 'task'
export type Authority = 'user' | 'tool' | 'assistant'
/** 模型可声明的状态；superseded/retracted 由本地链路计算，不接受模型直接写入。 */
export type ItemStatus = 'active' | 'hypothetical' | 'inferred' | 'conflict'

export interface QuoteSpan {
  readonly turnId: string
  /** 在 turn.text 中的 UTF-16 起止下标（半开区间） */
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface ItemScope {
  readonly level: ScopeLevel
  /** task/project 级必须给出 id；global 为 null */
  readonly id: string | null
}

export interface MemoryItem {
  readonly itemId: string
  readonly kind: MemoryKind
  /** 规范化字段名（模型给出，小写 camelCase），用于更正链与 requiredSlots 匹配 */
  readonly key: string
  readonly value: string | number | boolean | null
  /** 一句可读陈述（模型给出），只作检索与展示，权威仍是 quotes 原话 */
  readonly statement: string
  readonly scope: ItemScope
  readonly validFrom: string
  readonly validUntil: string | null
  readonly supersedes: readonly string[]
  readonly confidence: number
  readonly status: ItemStatus
  readonly authority: Authority
  readonly quotes: readonly QuoteSpan[]
  /** 该条目所依据原话中最大的 seq；未来信息过滤依据 */
  readonly recordedSeq: number
  readonly recordedAt: string
  /** 来源抽取请求（模型调用）id；测试夹具写 'test-fixture:*' */
  readonly origin: string
  /** 本地校验时附加的说明，例如 authority_downgraded */
  readonly checks: readonly string[]
}

export interface ReadForDecisionInput {
  readonly taskId: string
  readonly sessionId?: string | null
  /** 当前时刻；未来原话/条目一律不可见 */
  readonly asOf: string
  readonly asOfSeq?: number
  readonly intent: 'current' | 'historical'
  /** intent=historical 时查询的历史时刻 */
  readonly historicalAt?: string
  readonly question: string
  readonly requiredSlots: readonly string[]
  readonly budget: { readonly maxItems: number; readonly maxChars: number }
  readonly projectId?: string | null
}

export interface PacketItem {
  readonly itemId: string
  readonly kind: MemoryKind
  readonly key: string
  readonly value: string | number | boolean | null
  readonly statement: string
  readonly scope: ItemScope
  readonly validFrom: string
  readonly validUntil: string | null
  readonly status: ItemStatus | 'superseded' | 'retracted' | 'expired'
  readonly authority: Authority
  readonly confidence: number
  readonly evidenceTurnIds: readonly string[]
  readonly supersedes: readonly string[]
  readonly supersededBy: readonly string[]
}

export interface EvidenceRef {
  readonly turnId: string
  readonly sessionId: string
  readonly seq: number
  readonly at: string
  readonly role: TurnRole
  readonly taskIds: readonly string[]
  readonly quote: string
  readonly start: number
  readonly end: number
}

export interface ConflictEntry {
  readonly key: string
  readonly itemIds: readonly string[]
  readonly reason: string
}

export interface MemoryPacket {
  readonly schema: 'pet-capability-memory-packet/v1'
  readonly taskId: string
  readonly asOf: string
  readonly evaluatedAt: string
  readonly intent: 'current' | 'historical'
  readonly memoryCursor: number
  readonly currentFacts: readonly PacketItem[]
  readonly preferences: readonly PacketItem[]
  readonly commitments: readonly PacketItem[]
  readonly outcomes: readonly PacketItem[]
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly missing: readonly string[]
  readonly conflicts: readonly ConflictEntry[]
  readonly context: {
    /** 已被更正/过期的旧版本，仅供解释，不可作为行动依据 */
    readonly nonActionable: readonly PacketItem[]
    /** 最近的相关原话（未被抽取的也给出，防止抽取遗漏） */
    readonly recentTurns: readonly EvidenceRef[]
    readonly budgetUsed: { readonly items: number; readonly chars: number }
    readonly truncated: boolean
    readonly diagnostics: readonly string[]
  }
}
