/**
 * 条件计划存储：复用宿主已打开的 node:sqlite（单写者），表名统一 cond_ 前缀。
 *
 * 关键不变式（CONTRACT）：
 * - 先写新完整版本，再切换当前指针；历史编译全部保留。
 * - 承诺版本由指纹前进；结果 revision 变化不前进（只重算求值）。
 * - 旧版本在指针切换后立即不可行动：调用方必须比对 current(plan) 与 revision。
 *
 * @module capability/conditions/store
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ConditionEvalRecord, ConditionPlan, ConditionStore } from './plan-types.ts'
import type { Tri } from './kernel.ts'

interface PlanRow { compilation_key: string; task_id: string; json: string; created_at: string }

export class SqliteConditionStore implements ConditionStore {
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
      CREATE TABLE IF NOT EXISTS cond_plans (compilation_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cond_current (task_id TEXT PRIMARY KEY, compilation_key TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cond_revisions (task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cond_once (task_id TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task_id, key));
      CREATE TABLE IF NOT EXISTS cond_evals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
    `)
  }

  close(): void {
    if (this.owned) this.db.close()
  }

  get(compilationKey: string): ConditionPlan | null {
    const row = this.db.prepare('SELECT json FROM cond_plans WHERE compilation_key = ?').get(compilationKey) as { json: string } | undefined
    return row ? JSON.parse(row.json) as ConditionPlan : null
  }

  put(plan: ConditionPlan): void {
    const existing = this.db.prepare('SELECT json FROM cond_plans WHERE compilation_key = ?').get(plan.compilationKey) as { json: string } | undefined
    if (existing) {
      // 同一编译身份只能有一个产物；重复写入必须是相同字节，避免静默改写历史编译。
      if (existing.json !== JSON.stringify(plan)) throw new Error(`condition_plan_immutable: ${plan.compilationKey}`)
      return
    }
    this.db.prepare('INSERT INTO cond_plans (compilation_key, task_id, json, created_at) VALUES (?,?,?,?)')
      .run(plan.compilationKey, plan.taskId, JSON.stringify(plan), plan.compiledAt)
  }

  current(taskId: string): ConditionPlan | null {
    const row = this.db.prepare('SELECT compilation_key FROM cond_current WHERE task_id = ?').get(taskId) as { compilation_key: string } | undefined
    return row ? this.get(row.compilation_key) : null
  }

  setCurrent(taskId: string, compilationKey: string): void {
    const plan = this.get(compilationKey)
    if (!plan || plan.taskId !== taskId) throw new Error(`condition_plan_missing: ${taskId}/${compilationKey}`)
    this.db.prepare('INSERT INTO cond_current (task_id, compilation_key, at) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET compilation_key = excluded.compilation_key, at = excluded.at')
      .run(taskId, compilationKey, plan.compiledAt)
  }

  history(taskId: string): ConditionPlan[] {
    return (this.db.prepare('SELECT json FROM cond_plans WHERE task_id = ? ORDER BY rowid').all(taskId) as any[])
      .map((r: PlanRow) => JSON.parse(r.json) as ConditionPlan)
  }

  revision(taskId: string, fingerprint: string, at: string): number {
    const row = this.db.prepare('SELECT revision, fingerprint FROM cond_revisions WHERE task_id = ?').get(taskId) as { revision: number; fingerprint: string } | undefined
    if (!row) {
      this.db.prepare('INSERT INTO cond_revisions (task_id, revision, fingerprint, at) VALUES (?,?,?,?)').run(taskId, 1, fingerprint, at)
      return 1
    }
    if (row.fingerprint === fingerprint) return Number(row.revision)
    const next = Number(row.revision) + 1
    this.db.prepare('UPDATE cond_revisions SET revision = ?, fingerprint = ?, at = ? WHERE task_id = ?').run(next, fingerprint, at, taskId)
    return next
  }

  markOnce(taskId: string, key: string, at: string): boolean {
    const row = this.db.prepare('SELECT 1 AS hit FROM cond_once WHERE task_id = ? AND key = ?').get(taskId, key) as { hit: number } | undefined
    if (row) return false
    this.db.prepare('INSERT INTO cond_once (task_id, key, at) VALUES (?,?,?)').run(taskId, key, at)
    return true
  }

  wasDone(taskId: string, key: string): boolean {
    return !!this.db.prepare('SELECT 1 AS hit FROM cond_once WHERE task_id = ? AND key = ?').get(taskId, key)
  }

  recordEval(row: ConditionEvalRecord): void {
    this.db.prepare('INSERT INTO cond_evals (task_id, at, json) VALUES (?,?,?)').run(row.taskId, row.at, JSON.stringify(row))
  }

  lastEval(taskId: string): ConditionEvalRecord | null {
    const row = this.db.prepare('SELECT json FROM cond_evals WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as { json: string } | undefined
    return row ? JSON.parse(row.json) as ConditionEvalRecord : null
  }

  evals(taskId: string): ConditionEvalRecord[] {
    return (this.db.prepare('SELECT json FROM cond_evals WHERE task_id = ? ORDER BY id').all(taskId) as any[])
      .map((r: { json: string }) => JSON.parse(r.json) as ConditionEvalRecord)
  }
}

/** 用户承诺指纹：只看用户原话/条目的身份与值，不看结果 revision。改口/撤回才会变。 */
export function commitmentFingerprint(input: {
  readonly revision: number
  readonly commitmentItemIds: readonly string[]
  readonly commitmentValues: readonly string[]
  readonly latestUserTurnSha: string | null
}): string {
  const items = input.commitmentItemIds.map((id, i) => `${id}=${input.commitmentValues[i] ?? ''}`).sort()
  return JSON.stringify({ revision: input.revision, items, latestUserTurnSha: input.latestUserTurnSha })
}

/** 证据版本：结果 revision/sha + 用户承诺版本；同一证据版本上同一个干预只做一次。 */
export function evidenceKey(input: {
  readonly compilationKey: string
  readonly resultRevision: number | null
  readonly resultFileSha: string | null
  readonly commitmentRevision: number
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export function stateLabel(state: Tri): string {
  return state === 'true' ? '已满足' : state === 'false' ? '未满足' : '缺证据'
}
