/**
 * 受控本地工具：inspect_artifact / compare_metrics / write_analysis。
 *
 * 只有这三个工具；没有任意 shell、没有远程接口、没有模型调用。
 * 所有路径必须落在受控工作区内；写入用临时文件 + rename，产物带 SHA。
 * 结果由回执证明，不靠 worker 口头说“完成”。
 *
 * R4.1：write_analysis 只读 runtime 核验过的不可变快照（内容 SHA = inputRef.resultFileSha），
 * 并在回执里记录同一组输入身份；不再“验完再按可变路径重读”。
 *
 * @module pet-next/experiments/task-followup/tools
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalJson, sha256Bytes, stableId } from '../contracts.ts'
import type { ToolContext, ToolExecution, ToolName, ToolPort, ToolRequest, ToolReceipt } from '../contracts.ts'

const MAX_READ_BYTES = 8 * 1024 * 1024

export interface LocalToolsOptions {
  readonly root: string
}

interface SampleRow {
  readonly id: string
  readonly pass: boolean
  readonly note?: string
}

export class LocalTools implements ToolPort {
  private readonly root: string

  constructor(options: LocalToolsOptions) {
    this.root = resolve(options.root)
    mkdirSync(join(this.root, 'inbox'), { recursive: true })
    mkdirSync(join(this.root, 'artifacts'), { recursive: true })
  }

  execute(request: ToolRequest, context: ToolContext): ToolExecution {
    const startedAt = context.now
    try {
      switch (request.tool) {
        case 'inspect_artifact':
          return this.inspect(request, context, startedAt)
        case 'compare_metrics':
          return this.compare(request, context, startedAt)
        case 'write_analysis':
          return this.writeAnalysis(request, context, startedAt)
        default:
          return this.failure(request.tool, context, startedAt, `unknown tool ${String(request.tool)}`, false, 0)
      }
    } catch (error) {
      // 路径越界/IO 异常都是确定性失败，不产生未知副作用。
      return this.failure(request.tool, context, startedAt, `tool rejected: ${(error as Error).message}`, false, 0)
    }
  }

  private inspect(request: ToolRequest, context: ToolContext, startedAt: string): ToolExecution {
    const path = this.resolveSafe(String(request.args.path ?? ''))
    if (!existsSync(path) || !statSync(path).isFile()) {
      return this.failure('inspect_artifact', context, startedAt, `missing file ${this.rel(path)}`, false, 0)
    }
    const bytes = this.readLimited(path)
    const sha = sha256Bytes(bytes)
    let jsonValid = false
    let metricSummary: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
      jsonValid = true
      if (parsed.metrics && typeof parsed.metrics === 'object') metricSummary = parsed.metrics as Record<string, unknown>
    } catch {
      jsonValid = false
    }
    return this.success(
      'inspect_artifact',
      context,
      startedAt,
      {
        path: this.rel(path),
        bytes: bytes.length,
        sha256: sha,
        jsonValid,
        metrics: metricSummary,
      },
      null,
      null,
      bytes.length,
      `inspected ${this.rel(path)}`,
      { inputsVerified: sha === context.inputRef.resultFileSha },
    )
  }

  private compare(request: ToolRequest, context: ToolContext, startedAt: string): ToolExecution {
    const currentPath = this.resolveSafe(String(request.args.currentPath ?? ''))
    const baselinePath = this.resolveSafe(String(request.args.baselinePath ?? ''))
    if (!existsSync(currentPath) || !existsSync(baselinePath)) {
      return this.failure('compare_metrics', context, startedAt, 'missing current or baseline metrics file', false, 0)
    }
    const currentBytes = this.readLimited(currentPath)
    const baselineBytes = this.readLimited(baselinePath)
    const current = JSON.parse(currentBytes.toString('utf8')) as { metrics?: Record<string, number> }
    const baseline = JSON.parse(baselineBytes.toString('utf8')) as { metrics?: Record<string, number> }
    const currentMetrics = current.metrics ?? {}
    const baselineMetrics = baseline.metrics ?? {}
    const delta: Record<string, number> = {}
    for (const key of Object.keys(currentMetrics)) {
      const before = baselineMetrics[key] ?? 0
      delta[key] = Number(currentMetrics[key]) - Number(before)
    }
    return this.success(
      'compare_metrics',
      context,
      startedAt,
      {
        currentPath: this.rel(currentPath),
        baselinePath: this.rel(baselinePath),
        delta,
      },
      null,
      null,
      currentBytes.length + baselineBytes.length,
      'metrics compared',
      { inputsVerified: sha256Bytes(currentBytes) === context.inputRef.resultFileSha },
    )
  }

  private writeAnalysis(request: ToolRequest, context: ToolContext, startedAt: string): ToolExecution {
    // 快照路径以 context 为准（runtime 派发时核验过）；args 里的同名字段仅作兼容。
    const snapshotArg = String(request.args.resultSnapshotPath ?? context.resultSnapshotPath ?? '')
    if (!snapshotArg) {
      return this.failure('write_analysis', context, startedAt, 'missing verified input snapshot', false, 0)
    }
    const snapshotPath = this.resolveSafe(snapshotArg)
    if (!existsSync(snapshotPath)) {
      return this.failure('write_analysis', context, startedAt, `input snapshot missing: ${this.rel(snapshotPath)}`, false, 0)
    }
    const bytes = this.readLimited(snapshotPath)
    const resultSha = sha256Bytes(bytes)
    if (resultSha !== context.inputRef.resultFileSha) {
      return this.failure(
        'write_analysis',
        context,
        startedAt,
        `input snapshot sha ${resultSha.slice(0, 12)} != expected ${context.inputRef.resultFileSha.slice(0, 12)}`,
        false,
        bytes.length,
      )
    }
    let parsed: {
      runId?: string
      revision?: number
      status?: string
      metrics?: { total?: number; passed?: number; failed?: number }
      samples?: SampleRow[]
      artifactSha?: string
      artifactPath?: string
    }
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      return this.failure('write_analysis', context, startedAt, `result JSON invalid: ${(error as Error).message}`, false, bytes.length)
    }
    if (parsed.runId !== undefined && parsed.runId !== context.inputRef.runId) {
      return this.failure('write_analysis', context, startedAt, `runId ${String(parsed.runId)} != ${context.inputRef.runId}`, false, bytes.length)
    }
    if (parsed.revision !== undefined && Number(parsed.revision) !== context.inputRef.revision) {
      return this.failure(
        'write_analysis',
        context,
        startedAt,
        `revision ${String(parsed.revision)} != ${context.inputRef.revision}`,
        false,
        bytes.length,
      )
    }
    const samples = Array.isArray(parsed.samples) ? parsed.samples : []
    const failed = samples.filter((sample) => sample && sample.pass === false)
    const clusters = new Map<string, number>()
    for (const sample of failed) {
      const key = (sample.note ?? 'unlabelled').split(':')[0]!.trim() || 'unlabelled'
      clusters.set(key, (clusters.get(key) ?? 0) + 1)
    }
    const displayPath = context.inputRef.resultPath ?? this.rel(snapshotPath)
    const lines: string[] = []
    lines.push(`# 失败样本分析（${parsed.runId ?? context.inputRef.runId} r${parsed.revision ?? context.inputRef.revision}）`)
    lines.push('')
    lines.push(`- 任务: ${context.ticketId}`)
    lines.push(`- 任务版本: r${context.inputRef.taskRevision}`)
    lines.push(`- 结果文件: ${displayPath}`)
    lines.push(`- 结果文件 SHA256: ${resultSha}`)
    lines.push(`- 结果 artifact: ${context.inputRef.artifactPath ?? 'none'}`)
    lines.push(`- 结果 artifact SHA256: ${context.inputRef.artifactSha}`)
    lines.push(`- 输入快照: ${this.rel(snapshotPath)}`)
    lines.push(`- 状态: ${parsed.status ?? 'unknown'}`)
    lines.push(`- 指标: total=${parsed.metrics?.total ?? '?'} passed=${parsed.metrics?.passed ?? '?'} failed=${parsed.metrics?.failed ?? '?'}`)
    lines.push(`- 样本数: ${samples.length}，失败样本: ${failed.length}`)
    lines.push('')
    lines.push('## 失败样本')
    if (failed.length === 0) lines.push('- 无失败样本')
    for (const sample of failed) lines.push(`- ${sample.id}: ${sample.note ?? '未标注'}`)
    lines.push('')
    lines.push('## 失败聚类')
    if (clusters.size === 0) lines.push('- 无')
    for (const [key, count] of [...clusters.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`- ${key}: ${count}`)
    }
    lines.push('')
    lines.push('## 下一步')
    lines.push('- 复核上述聚类对应的样本输入与预期输出。')
    lines.push('- 在分析分支上只改动与聚类相关的处理，不扩大到无关模块。')
    lines.push('')
    const content = lines.join('\n')
    const outputDir = join(this.root, 'artifacts', context.ticketId)
    mkdirSync(outputDir, { recursive: true })
    const outputPath = join(outputDir, `analysis-${parsed.runId ?? 'run'}-r${parsed.revision ?? 0}.md`)
    const tmpPath = `${outputPath}.tmp-${process.pid}`
    try {
      writeFileSync(tmpPath, content, 'utf8')
      renameSync(tmpPath, outputPath)
    } catch (error) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // 清理失败不影响恢复语义：回执会标记 needs_reconciliation。
      }
      return this.failure('write_analysis', context, startedAt, `write failed: ${(error as Error).message}`, true, bytes.length)
    }
    const outBytes = Buffer.byteLength(content, 'utf8')
    const outSha = sha256Bytes(Buffer.from(content, 'utf8'))
    return this.success(
      'write_analysis',
      context,
      startedAt,
      {
        outputPath: this.rel(outputPath),
        outputSha256: outSha,
        failedSamples: failed.length,
        clusters: Object.fromEntries(clusters),
        inputRef: context.inputRef,
        inputSnapshotPath: this.rel(snapshotPath),
        resultFileSha: resultSha,
      },
      this.rel(outputPath),
      outSha,
      bytes.length,
      `analysis written for ${failed.length} failing samples`,
      { inputsVerified: true, bytesWritten: outBytes },
    )
  }

  private success(
    tool: ToolName,
    context: ToolContext,
    startedAt: string,
    payload: Record<string, unknown>,
    outputPath: string | null,
    outputSha256: string | null,
    bytesRead: number,
    detail: string,
    options: { readonly inputsVerified: boolean; readonly bytesWritten?: number },
  ): ToolExecution {
    const receipt: ToolReceipt = {
      receiptId: stableId('rcpt', context.effectId, tool, outputSha256 ?? 'none'),
      effectId: context.effectId,
      attemptId: context.attemptId,
      ticketId: context.ticketId,
      taskRevision: context.taskRevision,
      assignmentId: context.assignmentId,
      tool,
      ok: true,
      outputPath,
      outputSha256,
      bytesWritten: options.bytesWritten ?? 0,
      bytesRead,
      startedAt,
      finishedAt: context.now,
      detail,
      needsReconciliation: false,
      inputRef: context.inputRef,
      inputsVerified: options.inputsVerified,
    }
    return { receipt, payload }
  }

  private failure(
    tool: ToolName,
    context: ToolContext,
    startedAt: string,
    detail: string,
    unknownOutcome: boolean,
    bytesRead: number,
  ): ToolExecution {
    const receipt: ToolReceipt = {
      receiptId: stableId('rcpt', context.effectId, tool, 'failed', detail),
      effectId: context.effectId,
      attemptId: context.attemptId,
      ticketId: context.ticketId,
      taskRevision: context.taskRevision,
      assignmentId: context.assignmentId,
      tool,
      ok: false,
      outputPath: null,
      outputSha256: null,
      bytesWritten: 0,
      bytesRead,
      startedAt,
      finishedAt: context.now,
      detail,
      needsReconciliation: unknownOutcome,
      inputRef: context.inputRef,
      inputsVerified: false,
    }
    return { receipt, payload: { error: detail, needsReconciliation: unknownOutcome } }
  }

  private readLimited(path: string): Buffer {
    const info = statSync(path)
    if (info.size > MAX_READ_BYTES) throw new Error(`file too large: ${info.size} > ${MAX_READ_BYTES}`)
    return readFileSync(path)
  }

  private resolveSafe(input: string): string {
    if (!input) throw new Error('empty path')
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.root, input)
    if (!this.inside(abs)) throw new Error(`path outside workspace: ${input}`)
    return abs
  }

  private inside(abs: string): boolean {
    const rel = relative(this.root, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  private rel(path: string): string {
    return relative(this.root, path)
  }

  /** 工作区内相对路径的绝对路径，供 driver 复核产物。 */
  absolute(path: string): string {
    return this.resolveSafe(path)
  }

  /** 只读目录，用于 seed 命令；属工具层，不暴露给模型。 */
  get workspaceRoot(): string {
    return this.root
  }

  inboxDir(): string {
    return join(this.root, 'inbox')
  }

  artifactsDir(): string {
    return join(this.root, 'artifacts')
  }

  ensureExperimentInbox(experimentId: string): string {
    const dir = join(this.inboxDir(), experimentId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 保证父目录存在；seed/watch 共用。 */
  ensureParent(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
  }

  /** 输入快照目录：runtime 写入，工具只读。 */
  snapshotDir(): string {
    return join(this.root, 'state', 'inputs')
  }

  /** 计算输入身份指纹，供日志与交付核对。 */
  static inputFingerprint(input: unknown): string {
    return sha256Bytes(Buffer.from(canonicalJson(input), 'utf8'))
  }
}
