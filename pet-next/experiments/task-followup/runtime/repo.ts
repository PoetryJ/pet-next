/**
 * 上游 Repositories 端口的 SQLite 实现。
 *
 * 聚合以 JSON 文档存储；每个 Engine 命令由 `atomic()` 包成一个事务，单写者串行。
 * 这与上游内存仓库语义一致（读回新对象、写回整体聚合），但持久化到磁盘，
 * 因此能跨进程重启恢复。不声称通用 exactly-once，也不声称性能优势。
 *
 * @module pet-next/experiments/task-followup/runtime/repo
 */
import type {
  Decision,
  Repositories,
  Thread,
  Ticket,
  Trigger,
  TriggerDisposition,
} from '../upstream/src/core/index.ts'
import { latestAssignment } from '../upstream/src/core/index.ts'
import type { FollowupDb } from './db.ts'

const KIND = {
  trigger: 'trigger',
  disposition: 'trigger_disposition',
  thread: 'thread',
  ticket: 'ticket',
  decision: 'decision',
} as const

export class SqliteRepositories implements Repositories {
  constructor(private readonly db: FollowupDb) {}

  atomic<T>(work: () => T): T {
    return this.db.atomic(work)
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.read<Trigger>(KIND.trigger, id),
    save: (trigger: Trigger): void => this.write(KIND.trigger, trigger.id, trigger),
    disposition: (id: string): TriggerDisposition | undefined => this.read<TriggerDisposition>(KIND.disposition, id),
    saveDisposition: (id: string, value: TriggerDisposition): void => this.write(KIND.disposition, id, value),
  }

  readonly threads = {
    get: (key: string): Thread | undefined => this.read<Thread>(KIND.thread, key),
    save: (thread: Thread): void => this.write(KIND.thread, thread.key, thread),
    list: (): Thread[] => this.list<Thread>(KIND.thread),
    active: (): Thread[] => this.list<Thread>(KIND.thread).filter((thread) => thread.pending.length > 0 || thread.evaluating !== undefined),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.read<Ticket>(KIND.ticket, id),
    save: (ticket: Ticket): void => this.write(KIND.ticket, ticket.id, ticket),
    list: (): Ticket[] => this.list<Ticket>(KIND.ticket),
    open: (): Ticket[] => this.tickets.list().filter((ticket) => !ticket.ended),
    active: (): Ticket[] =>
      this.tickets
        .list()
        .filter(
          (ticket) =>
            ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? ''),
        ),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.read<Decision>(KIND.decision, id),
    save: (decision: Decision): void => this.write(KIND.decision, decision.id, decision),
    byThread: (key: string): Decision[] => this.list<Decision>(KIND.decision).filter((decision) => decision.threadKey === key),
  }

  private read<T>(kind: string, key: string): T | undefined {
    const json = this.db.getDoc(kind, key)
    return json === undefined ? undefined : (JSON.parse(json) as T)
  }

  private write(kind: string, key: string, value: unknown): void {
    this.db.saveDoc(kind, key, JSON.stringify(value))
  }

  private list<T>(kind: string): T[] {
    return this.db.listDocs(kind).map((json) => JSON.parse(json) as T)
  }
}
