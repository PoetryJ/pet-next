/**
 * 合成实验数据生成器：原子写入 result.json 与 artifact，供 demo / eval 共用。
 * 只写受控工作区，不读取生产日志，不伪造用户真实委托。
 *
 * @module pet-next/experiments/task-followup/tools/seed
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Bytes, sha256Hex } from '../contracts.ts'

export interface SeedInput {
  readonly workspace: string
  readonly experimentId: string
  readonly runId: string
  readonly revision: number
  readonly status: 'succeeded' | 'failed' | 'partial'
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly corrupt?: boolean
  /** 同一 revision 的不同内容，用于制造证据冲突测试。 */
  readonly contentSalt?: string
}

export interface SeedOutput {
  readonly resultPath: string
  readonly artifactPath: string
  readonly artifactSha: string
  readonly resultFileSha: string
  readonly seed: SeedInput
}

export function seedResult(input: SeedInput): SeedOutput {
  const dir = join(input.workspace, 'inbox', input.experimentId)
  mkdirSync(dir, { recursive: true })
  const artifactName = `artifact-${input.runId}-r${input.revision}${input.contentSalt ? `-${input.contentSalt}` : ''}.txt`
  const artifactPath = join(dir, artifactName)
  const artifactContent = Buffer.from(
    `experiment=${input.experimentId}\nrun=${input.runId}\nrevision=${input.revision}\nstatus=${input.status}\nfailed=${input.failed}\nsalt=${input.contentSalt ?? ''}\n`,
    'utf8',
  )
  atomicWrite(artifactPath, artifactContent)
  const samples = Array.from({ length: Math.min(input.total, 40) }, (_, index) => {
    const isFailed = index < input.failed
    const notes = ['timeout: slow path', 'parse: bad token', 'assert: mismatch', 'memory: overflow']
    return { id: `s${index + 1}`, pass: !isFailed, ...(isFailed ? { note: notes[index % notes.length] } : {}) }
  })
  const result = {
    schema: 'pet-followup-result/v1',
    experimentId: input.experimentId,
    runId: input.runId,
    revision: input.revision,
    status: input.status,
    metrics: { total: input.total, passed: input.passed, failed: input.failed, score: input.total ? input.passed / input.total : null },
    artifactPath: `inbox/${input.experimentId}/${artifactName}`,
    artifactSha: sha256Bytes(artifactContent),
    note: `seed ${input.status} r${input.revision}${input.contentSalt ? ` ${input.contentSalt}` : ''}`,
    samples,
  }
  const resultPath = join(dir, 'result.json')
  const body = input.corrupt ? JSON.stringify(result).slice(0, 80) : JSON.stringify(result, null, 2)
  atomicWrite(resultPath, Buffer.from(body, 'utf8'))
  return { resultPath, artifactPath, artifactSha: result.artifactSha, resultFileSha: sha256Hex(body), seed: input }
}

export function atomicWrite(path: string, bytes: Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}
