/**
 * 宿主可选的 assessor 来源（集成负责人所有）：
 * - baseline-menu-first：只为验证异步管道，原样选择规则菜单第一项；capability=false，不得当作能力结果。
 * - file-queue：真实请求/响应文件队列协议。宿主写 requests/<id>.json，外部推理单元（新会话、只看该请求）
 *   写 responses/<id>.json；超时/解析错误/中止均为真实失败，不生成占位。
 * - module:<path>：动态加载能力模块（capability/model 等），模块导出
 *     createAssessor(ctx) => AsyncAssessor | Promise<AsyncAssessor>
 *     createMemoryPacketProvider?(ctx) => MemoryPacketProvider
 *
 * @module pet-next/experiments/task-followup/runtime/assessors
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ASSESSMENT_PROTOCOL,
  parseDrafts,
  type AssessmentResponse,
  type AssessmentSnapshot,
  type AsyncAssessor,
  type MemoryPacket,
  type MemoryPacketProvider,
} from './assessment.ts'

export interface AssessorContext {
  readonly workspaceRoot: string
  readonly stateDir: string
}

export interface LoadedAssessor {
  readonly assessor: AsyncAssessor
  readonly packets?: MemoryPacketProvider
  readonly spec: string
}

export const baselineMenuFirstAssessor: AsyncAssessor = {
  id: 'baseline-menu-first',
  capability: false,
  async assess(snapshot: AssessmentSnapshot): Promise<AssessmentResponse> {
    const first = snapshot.actionMenu[0]
    const drafts = first
      ? [{ intent: first.kind === 'defer' ? ('wait' as const) : first.kind === 'record_only' ? ('none' as const) : first.kind === 'ask_user' ? ('ask_now' as const) : ('act' as const), actionId: first.actionId, reasonText: `baseline-menu-first: ${first.reasonText}`, ...(first.notBefore ? { notBefore: first.notBefore } : {}) }]
      : [{ intent: 'none' as const, reasonText: 'baseline-menu-first: empty menu' }]
    const rawOutput = JSON.stringify({ drafts })
    return { drafts, raw: { provider: 'builtin', model: 'none (baseline-menu-first, not a model)', rawOutput } }
  },
}

export function fileQueueAssessor(queueDir: string, pollMs = 500): AsyncAssessor {
  const requests = join(queueDir, 'requests')
  const responses = join(queueDir, 'responses')
  mkdirSync(requests, { recursive: true })
  mkdirSync(responses, { recursive: true })
  return {
    id: 'file-queue',
    capability: true,
    assess(snapshot: AssessmentSnapshot, packet: MemoryPacket, signal: AbortSignal): Promise<AssessmentResponse> {
      const id = snapshot.identity.requestId
      const requestPath = join(requests, `${id}.json`)
      const tmp = `${requestPath}.tmp-${process.pid}`
      // 请求只含该次快照与记忆包；不含 caseId/split/gold。
      writeFileSync(tmp, JSON.stringify({ protocol: ASSESSMENT_PROTOCOL, requestId: id, snapshot, packet, respondTo: join(responses, `${id}.json`) }, null, 2), 'utf8')
      renameSync(tmp, requestPath)
      const responsePath = join(responses, `${id}.json`)
      return new Promise((resolvePromise, reject) => {
        const timer = setInterval(() => {
          if (signal.aborted) {
            clearInterval(timer)
            reject(signal.reason ?? new Error('aborted'))
            return
          }
          if (!existsSync(responsePath)) return
          clearInterval(timer)
          try {
            const parsed = JSON.parse(readFileSync(responsePath, 'utf8')) as Partial<AssessmentResponse>
            const drafts = parseDrafts(parsed.drafts)
            const raw = parsed.raw ?? { provider: 'file-queue', model: 'unknown', rawOutput: readFileSync(responsePath, 'utf8') }
            resolvePromise({ drafts, raw: { ...raw, model: raw.model || 'unknown' } })
          } catch (error) {
            const message = (error as Error).message
            reject(new Error(message.startsWith('parse_error') ? message : `parse_error: ${message}`))
          }
        }, pollMs)
      })
    },
  }
}

/** 解析 --assessor 规格：none | baseline-menu-first | file-queue[:dir] | module:<path>。 */
export async function loadAssessor(spec: string | undefined, ctx: AssessorContext): Promise<LoadedAssessor | null> {
  if (!spec || spec === 'none') return null
  if (spec === 'baseline-menu-first') return { assessor: baselineMenuFirstAssessor, spec }
  if (spec === 'file-queue' || spec.startsWith('file-queue:')) {
    const dir = spec === 'file-queue' ? join(ctx.stateDir, 'assessment-queue') : resolve(ctx.workspaceRoot, spec.slice('file-queue:'.length))
    return { assessor: fileQueueAssessor(dir), spec }
  }
  if (spec.startsWith('module:')) {
    const target = spec.slice('module:'.length)
    const abs = isAbsolute(target) ? target : resolve(process.cwd(), target)
    const mod = (await import(pathToFileURL(abs).href)) as {
      createAssessor?: (context: AssessorContext) => AsyncAssessor | Promise<AsyncAssessor>
      createMemoryPacketProvider?: (context: AssessorContext) => MemoryPacketProvider | Promise<MemoryPacketProvider>
    }
    if (typeof mod.createAssessor !== 'function') throw new Error(`assessor module ${abs} 未导出 createAssessor`)
    const assessor = await mod.createAssessor(ctx)
    if (!assessor || typeof assessor.assess !== 'function' || typeof assessor.id !== 'string') throw new Error(`assessor module ${abs} 返回的对象不符合 AsyncAssessor`)
    const packets = mod.createMemoryPacketProvider ? await mod.createMemoryPacketProvider(ctx) : undefined
    return { assessor, ...(packets ? { packets } : {}), spec }
  }
  throw new Error(`未知 assessor 规格：${spec}（可用 none | baseline-menu-first | file-queue[:dir] | module:<path>）`)
}
