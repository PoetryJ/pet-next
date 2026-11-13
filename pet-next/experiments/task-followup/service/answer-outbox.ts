import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface AnswerPayload {
  ticketId: string
  attentionId: string
  decisionId: string
  taskRevision: number
  optionId: string
}
export interface AnswerResponse { status: number; json: unknown }
export interface AnswerOutboxRecord {
  id: string
  payload: AnswerPayload
  state: 'pending' | 'resolved'
  createdAt: string
  response?: AnswerResponse
}

const SCHEMA = 'pet-followup-answer-outbox/v1'
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function canonicalPayload(value: AnswerPayload): AnswerPayload {
  if (!value || ['ticketId', 'attentionId', 'decisionId', 'optionId'].some(k => typeof value[k as keyof AnswerPayload] !== 'string' || !value[k as keyof AnswerPayload])
      || !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1) throw new Error('answer_payload_invalid')
  return { ticketId: value.ticketId, attentionId: value.attentionId, decisionId: value.decisionId, taskRevision: value.taskRevision, optionId: value.optionId }
}
const payloadId = (payload: AnswerPayload): string => `answer-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`

/** Single-writer client outbox. It preserves a user's exact authorization;
 * the host remains responsible for visibility, expiry and version validation.
 * A transport failure may happen after the host accepted the request, so a
 * later retry still submits only the same identity-bound payload. */
export class AnswerOutbox {
  private readonly path: string
  private records: AnswerOutboxRecord[] = []
  private inFlight: Promise<AnswerOutboxRecord[]> | null = null

  constructor(filePath: string) {
    this.path = resolve(filePath)
    if (!existsSync(this.path)) return
    const stored = JSON.parse(readFileSync(this.path, 'utf8')) as { schema?: string; records?: AnswerOutboxRecord[] }
    if (stored.schema !== SCHEMA || !Array.isArray(stored.records)) throw new Error('answer_outbox_file_invalid')
    const seen = new Set<string>()
    this.records = stored.records.map(record => {
      const payload = canonicalPayload(record.payload)
      if (record.id !== payloadId(payload) || seen.has(payload.attentionId) || !Number.isFinite(Date.parse(record.createdAt))
          || !['pending', 'resolved'].includes(record.state)
          || (record.state === 'pending' && record.response !== undefined)
          || (record.state === 'resolved' && (!record.response || !Number.isInteger(record.response.status) || record.response.status < 100 || record.response.status > 599))) throw new Error('answer_outbox_record_invalid')
      seen.add(payload.attentionId)
      return copy({ ...record, payload })
    })
  }

  enqueue(value: AnswerPayload, atISO: string): AnswerOutboxRecord {
    const payload = canonicalPayload(value), id = payloadId(payload)
    const existing = this.records.find(r => r.payload.attentionId === payload.attentionId)
    if (existing) {
      if (existing.id !== id) throw new Error('answer_authorization_conflict: this attention already has a different saved choice')
      return copy(existing)
    }
    if (!Number.isFinite(Date.parse(atISO))) throw new Error('answer_created_at_invalid')
    const record: AnswerOutboxRecord = { id, payload, state: 'pending', createdAt: atISO }
    this.records.push(record)
    try { this.persist() } catch (error) { this.records.pop(); throw error }
    return copy(record)
  }

  list(): AnswerOutboxRecord[] { return copy(this.records) }

  flush(send: (payload: AnswerPayload) => Promise<AnswerResponse>): Promise<AnswerOutboxRecord[]> {
    if (this.inFlight) return this.inFlight
    // Deferring execution ensures inFlight is installed even if send throws
    // synchronously or another caller flushes during the first invocation.
    const work = Promise.resolve().then(async () => {
      const pending = this.records.filter(r => r.state === 'pending')
      for (const record of pending) {
        let response: AnswerResponse
        try { response = await send(copy(record.payload)) } catch { continue }
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('answer_http_response_invalid')
        // All actual HTTP statuses terminate delivery, including host rejection.
        // No response is reinterpreted as authorization for a different card.
        record.response = copy(response)
        record.state = 'resolved'
        this.persist()
      }
      return this.list()
    })
    const flight = work.finally(() => { if (this.inFlight === flight) this.inFlight = null })
    this.inFlight = flight
    return flight
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | null = null
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ schema: SCHEMA, records: this.records }, null, 2) + '\n', 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(temporary, this.path)
    } finally {
      if (fd !== null) closeSync(fd)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}
