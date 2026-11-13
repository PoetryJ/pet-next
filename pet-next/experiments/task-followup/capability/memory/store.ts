/**
 * 能力线记忆存储：追加写原话、抽取条目、撤回记录。
 *
 * 不新建数据库框架：直接用 node:sqlite（与 runtime/db.ts 相同驱动），表名统一 cap_ 前缀。
 * 集成负责人可以把宿主已打开的 DatabaseSync 传进来（单写者），也可以给独立文件路径。
 * 所有写入都追加到 cap_log，memoryCursor = cap_log 最大 id，供 assessment 版本校验。
 */
import { DatabaseSync } from 'node:sqlite'
import type { MemoryItem, Turn } from './types.ts'

export interface LogRow {
  readonly cursor: number
  readonly kind: 'turn' | 'item' | 'retract_turn' | 'retract_item' | 'extraction'
  readonly ref: string
  /** 受影响的作用域 id（task id / project id / 'global'），用于判断游标前进是否与某任务相关 */
  readonly scopes: readonly string[]
  readonly at: string
}

export interface ExtractionLogRow {
  readonly requestId: string
  readonly status: 'pending' | 'applied' | 'failed' | 'uncovered'
  readonly detail: string
  readonly turnIds: readonly string[]
}

export class CapabilityMemoryStore {
  readonly db: DatabaseSync
  private readonly owned: boolean

  constructor(target: string | DatabaseSync) {
    if (typeof target === 'string') {
      this.db = new DatabaseSync(target)
      this.owned = true
    } else {
      this.db = target
      this.owned = false
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cap_log (cursor INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, scopes TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, task_ids TEXT NOT NULL, project_id TEXT, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_turn_retractions (turn_id TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_items (item_id TEXT PRIMARY KEY, json TEXT NOT NULL, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_item_retractions (item_id TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_extractions (request_id TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT NOT NULL, turn_ids TEXT NOT NULL, cursor INTEGER NOT NULL);
    `)
  }

  close(): void {
    if (this.owned) this.db.close()
  }

  private log(kind: LogRow['kind'], ref: string, scopes: readonly string[], at: string): number {
    const r = this.db.prepare('INSERT INTO cap_log (kind, ref, scopes, at) VALUES (?, ?, ?, ?)').run(kind, ref, JSON.stringify(scopes), at)
    return Number(r.lastInsertRowid)
  }

  cursor(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS c FROM cap_log').get() as { c: number }
    return Number(row.c)
  }

  logSince(cursor: number): LogRow[] {
    return (this.db.prepare('SELECT cursor, kind, ref, scopes, at FROM cap_log WHERE cursor > ? ORDER BY cursor').all(cursor) as any[]).map((r) => ({
      cursor: Number(r.cursor), kind: r.kind, ref: r.ref, scopes: JSON.parse(r.scopes), at: r.at,
    }))
  }

  /** 原话幂等追加：同 turnId 同内容重复写入返回原游标；同 id 不同内容拒绝（原话不可改写）。 */
  appendTurn(turn: Turn): { cursor: number; duplicate: boolean } {
    const existing = this.db.prepare('SELECT * FROM cap_turns WHERE turn_id = ?').get(turn.turnId) as any
    if (existing) {
      if (existing.text !== turn.text || existing.role !== turn.role || existing.session_id !== turn.sessionId) {
        throw new Error(`turn_immutable: ${turn.turnId} already recorded with different content`)
      }
      return { cursor: Number(existing.cursor), duplicate: true }
    }
    const scopes = turn.taskIds.length > 0 ? [...turn.taskIds] : ['global']
    const cursor = this.log('turn', turn.turnId, scopes, turn.at)
    this.db.prepare('INSERT INTO cap_turns (turn_id, session_id, seq, at, role, text, task_ids, project_id, cursor) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(turn.turnId, turn.sessionId, turn.seq, turn.at, turn.role, turn.text, JSON.stringify(turn.taskIds), turn.projectId ?? null, cursor)
    return { cursor, duplicate: false }
  }

  turns(): Turn[] {
    return (this.db.prepare('SELECT * FROM cap_turns ORDER BY seq, at, turn_id').all() as any[]).map((r) => ({
      turnId: r.turn_id, sessionId: r.session_id, seq: Number(r.seq), at: r.at, role: r.role, text: r.text,
      taskIds: JSON.parse(r.task_ids), projectId: r.project_id ?? null,
    }))
  }

  turn(turnId: string): Turn | undefined {
    return this.turns().find((t) => t.turnId === turnId)
  }

  retractTurn(turnId: string, at: string, reason: string): number {
    const t = this.turn(turnId)
    if (!t) throw new Error(`unknown_turn: ${turnId}`)
    const prior = this.db.prepare('SELECT cursor FROM cap_turn_retractions WHERE turn_id = ?').get(turnId) as any
    if (prior) return Number(prior.cursor)
    const cursor = this.log('retract_turn', turnId, t.taskIds.length > 0 ? [...t.taskIds] : ['global'], at)
    this.db.prepare('INSERT INTO cap_turn_retractions (turn_id, at, reason, cursor) VALUES (?,?,?,?)').run(turnId, at, reason, cursor)
    return cursor
  }

  retractedTurns(): Map<string, { at: string; reason: string }> {
    const m = new Map<string, { at: string; reason: string }>()
    for (const r of this.db.prepare('SELECT * FROM cap_turn_retractions').all() as any[]) m.set(r.turn_id, { at: r.at, reason: r.reason })
    return m
  }

  appendItem(item: MemoryItem): number {
    const existing = this.db.prepare('SELECT cursor FROM cap_items WHERE item_id = ?').get(item.itemId) as any
    if (existing) return Number(existing.cursor)
    const scopes = [item.scope.level === 'global' ? 'global' : item.scope.id!]
    const cursor = this.log('item', item.itemId, scopes, item.recordedAt)
    this.db.prepare('INSERT INTO cap_items (item_id, json, cursor) VALUES (?,?,?)').run(item.itemId, JSON.stringify(item), cursor)
    return cursor
  }

  items(): MemoryItem[] {
    return (this.db.prepare('SELECT json FROM cap_items ORDER BY cursor').all() as any[]).map((r) => JSON.parse(r.json))
  }

  retractItem(itemId: string, at: string, reason: string): number {
    const item = this.items().find((i) => i.itemId === itemId)
    if (!item) throw new Error(`unknown_item: ${itemId}`)
    const prior = this.db.prepare('SELECT cursor FROM cap_item_retractions WHERE item_id = ?').get(itemId) as any
    if (prior) return Number(prior.cursor)
    const cursor = this.log('retract_item', itemId, [item.scope.level === 'global' ? 'global' : item.scope.id!], at)
    this.db.prepare('INSERT INTO cap_item_retractions (item_id, at, reason, cursor) VALUES (?,?,?,?)').run(itemId, at, reason, cursor)
    return cursor
  }

  retractedItems(): Map<string, { at: string; reason: string }> {
    const m = new Map<string, { at: string; reason: string }>()
    for (const r of this.db.prepare('SELECT * FROM cap_item_retractions').all() as any[]) m.set(r.item_id, { at: r.at, reason: r.reason })
    return m
  }

  recordExtraction(row: ExtractionLogRow, at: string): void {
    const existing = this.db.prepare('SELECT status FROM cap_extractions WHERE request_id = ?').get(row.requestId) as any
    const cursor = this.log('extraction', row.requestId, [], at)
    if (existing) {
      this.db.prepare('UPDATE cap_extractions SET status = ?, detail = ?, cursor = ? WHERE request_id = ?').run(row.status, row.detail, cursor, row.requestId)
    } else {
      this.db.prepare('INSERT INTO cap_extractions (request_id, status, detail, turn_ids, cursor) VALUES (?,?,?,?,?)')
        .run(row.requestId, row.status, row.detail, JSON.stringify(row.turnIds), cursor)
    }
  }

  extractions(): ExtractionLogRow[] {
    return (this.db.prepare('SELECT * FROM cap_extractions ORDER BY cursor').all() as any[]).map((r) => ({
      requestId: r.request_id, status: r.status, detail: r.detail, turnIds: JSON.parse(r.turn_ids),
    }))
  }

  /** 已被任何已应用抽取覆盖的原话 id */
  extractedTurnIds(): Set<string> {
    const s = new Set<string>()
    for (const e of this.extractions()) if (e.status === 'applied') for (const t of e.turnIds) s.add(t)
    return s
  }
}
