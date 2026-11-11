/**
 * 本地 inbox 观察器：真实目录 watch → 校验文件与 SHA → 转成事件。
 *
 * 规则（C1）：
 * - 原子临时文件 rename 后再读；partial JSON 只记录“未就绪”，不标成功；
 * - 同一结果文件 SHA 去重；同 runId 新 revision 为更正；
 * - 乱序旧 revision 不覆盖新值（由 runtime 判定，watch 只负责如实转换）；
 * - 关闭进程期间落盘的文件在启动扫描时补读，并靠 runtime 的 eventId/SHA 去重。
 *
 * @module pet-next/experiments/task-followup/tools/watch
 */
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { sha256Bytes } from '../contracts.ts'
import type { ArtifactPayload, ObservedArtifact } from '../contracts.ts'

export const RESULT_SCHEMA = 'pet-followup-result/v1' as const

export type FindingStatus = 'observed' | 'not_ready' | 'invalid_shape' | 'artifact_mismatch'

export interface WatchFinding {
  readonly status: FindingStatus
  readonly path: string
  readonly detail: string
  readonly observed?: ObservedArtifact
}

export interface ReadResultOptions {
  readonly root: string
  readonly path: string
  readonly observedAt: string
}

/** 读取并校验一个 result.json；只有全部校验通过才产出 ObservedArtifact。 */
export function readResultFile(options: ReadResultOptions): WatchFinding {
  const root = resolve(options.root)
  const abs = isAbsolute(options.path) ? resolve(options.path) : resolve(root, options.path)
  if (!inside(root, abs)) return { status: 'invalid_shape', path: options.path, detail: 'path outside workspace' }
  if (!existsSync(abs)) return { status: 'not_ready', path: options.path, detail: 'file missing' }
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (error) {
    return { status: 'not_ready', path: options.path, detail: `read failed: ${(error as Error).message}` }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  } catch (error) {
    // partial JSON：只记录未就绪，不标成功。
    return { status: 'not_ready', path: options.path, detail: `partial json: ${(error as Error).message}` }
  }
  const shape = validateShape(parsed)
  if (!shape.ok) return { status: 'invalid_shape', path: options.path, detail: shape.detail }
  const payload = parsed as unknown as ArtifactPayload & { schema: string }
  const artifactPath = payload.artifactPath
  if (artifactPath) {
    const artifactAbs = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(root, artifactPath)
    if (!inside(root, artifactAbs)) return { status: 'invalid_shape', path: options.path, detail: 'artifact path outside workspace' }
    if (!existsSync(artifactAbs)) return { status: 'artifact_mismatch', path: options.path, detail: `artifact missing: ${artifactPath}` }
    const artifactSha = sha256Bytes(readFileSync(artifactAbs))
    if (artifactSha !== payload.artifactSha) {
      return { status: 'artifact_mismatch', path: options.path, detail: `artifact sha ${artifactSha.slice(0, 12)} != ${payload.artifactSha.slice(0, 12)}` }
    }
  }
  const resultFileSha = sha256Bytes(bytes)
  return {
    status: 'observed',
    path: options.path,
    detail: `result ${payload.runId} r${payload.revision} ${payload.status}`,
    observed: {
      sourceId: `inbox/${payload.experimentId}/${payload.runId}`,
      sourceRevision: `r${payload.revision}`,
      path: relative(root, abs),
      sha256: resultFileSha,
      payload: { ...payload, resultFileSha },
      observedAt: options.observedAt,
    },
  }
}

interface ShapeCheck {
  readonly ok: boolean
  readonly detail: string
}

function validateShape(value: Record<string, unknown>): ShapeCheck {
  if (value.schema !== RESULT_SCHEMA) return { ok: false, detail: `schema ${String(value.schema)} != ${RESULT_SCHEMA}` }
  for (const key of ['experimentId', 'runId', 'artifactSha']) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) return { ok: false, detail: `${key} missing` }
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) return { ok: false, detail: 'revision must be a positive integer' }
  if (!['succeeded', 'failed', 'partial'].includes(String(value.status))) return { ok: false, detail: `status ${String(value.status)} invalid` }
  const metrics = value.metrics as Record<string, unknown> | undefined
  if (!metrics || typeof metrics !== 'object') return { ok: false, detail: 'metrics missing' }
  for (const key of ['total', 'passed', 'failed']) {
    if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key] as number)) return { ok: false, detail: `metrics.${key} invalid` }
  }
  if (value.artifactPath !== null && typeof value.artifactPath !== 'string') return { ok: false, detail: 'artifactPath must be string or null' }
  return { ok: true, detail: 'ok' }
}

export interface WatchOptions {
  readonly root: string
  readonly dir: string
  readonly ticketId: string
  readonly now: () => string
  readonly ingest: (ticketId: string, observed: ObservedArtifact) => { disposition: string; detail: string }
  readonly log?: (finding: WatchFinding) => void
}

export interface ScanReport {
  readonly scanned: number
  readonly observed: number
  readonly duplicates: number
  readonly notReady: number
  readonly invalid: number
  readonly findings: readonly WatchFinding[]
}

export class InboxWatcher {
  private readonly options: WatchOptions
  private readonly seen = new Set<string>()
  private watcher: FSWatcher | undefined

  constructor(options: WatchOptions) {
    this.options = options
  }

  /** 全量扫描：启动补读与运行期都走同一路径。 */
  scanOnce(): ScanReport {
    const findings: WatchFinding[] = []
    let observed = 0
    let duplicates = 0
    let notReady = 0
    let invalid = 0
    let scanned = 0
    const dir = resolve(this.options.dir)
    if (!existsSync(dir)) {
      return { scanned: 0, observed: 0, duplicates: 0, notReady: 0, invalid: 0, findings }
    }
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const name of files) {
      const path = join(dir, name)
      try {
        if (!statSync(path).isFile()) continue
      } catch {
        continue
      }
      scanned += 1
      const finding = readResultFile({ root: this.options.root, path, observedAt: this.options.now() })
      findings.push(finding)
      this.options.log?.(finding)
      if (finding.status !== 'observed' || !finding.observed) {
        if (finding.status === 'not_ready') notReady += 1
        else invalid += 1
        continue
      }
      const key = `${finding.observed.sha256}`
      if (this.seen.has(key)) {
        duplicates += 1
        continue
      }
      const outcome = this.options.ingest(this.options.ticketId, finding.observed)
      if (outcome.disposition === 'duplicate') duplicates += 1
      else observed += 1
      this.seen.add(key)
    }
    return { scanned, observed, duplicates, notReady, invalid, findings }
  }

  /** 真实 watch；返回停止函数。回调只触发重扫，不做业务判断。 */
  start(onReport?: (report: ScanReport) => void): () => void {
    const dir = resolve(this.options.dir)
    let timer: NodeJS.Timeout | undefined
    const run = (): void => {
      const report = this.scanOnce()
      onReport?.(report)
    }
    run()
    this.watcher = watch(dir, { persistent: false }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, 200)
    })
    return () => {
      if (timer) clearTimeout(timer)
      this.watcher?.close()
      this.watcher = undefined
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = undefined
  }
}

function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
