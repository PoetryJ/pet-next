#!/usr/bin/env node
/**
 * 离线边界静态审计：
 * - 代码里不得出现模型端点、API key、GPU、非本机 HTTP 客户端调用；
 * - R3.1 实验目录相对基线零 diff；
 * - 上游 15 文件指纹一致。
 *
 * 只读检查，不联网。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const REPO = resolve(ROOT, '..', '..')
const BASE = '90fb4cd244ecae832377bd847ca185284ef976f0'

const FORBIDDEN = [
  { pattern: /18872/, label: 'model endpoint 18872' },
  { pattern: /api\.openai\.com|api\.deepseek\.com|dashscope|anthropic\.com/i, label: 'remote model endpoint' },
  { pattern: /OPENAI_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY/, label: 'model api key' },
  { pattern: /\bcuda\b|nvidia-smi|torch\.cuda/i, label: 'GPU usage' },
  { pattern: /\bfetch\(|https?\.request\(|axios\(/i, label: 'network client call' },
]

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'out', 'tooling', 'upstream', 'demo'].includes(name)) continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) out.push(...walk(path))
    else if (/\.(ts|mjs|js)$/.test(name) && name !== 'audit.mjs') out.push(path)
  }
  return out
}

let failures = 0
const findings = []
const files = walk(ROOT)
for (const path of files) {
  const text = readFileSync(path, 'utf8')
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) {
      findings.push({ file: relative(ROOT, path), rule: rule.label })
      failures += 1
    }
  }
}
console.log(`code files scanned: ${files.length}`)
console.log(`forbidden findings: ${findings.length}`)
for (const finding of findings) console.log(`FAIL ${finding.file} :: ${finding.rule}`)

const r31 = execFileSync('git', ['-C', join(REPO, '..'), 'diff', '--name-only', BASE, '--', 'pet-next/experiments/memory-consistency'], {
  encoding: 'utf8',
}).trim()
console.log(`R3.1 diff files: ${r31 ? r31.split('\n').length : 0}`)
if (r31) failures += 1

const provenance = execFileSync(process.execPath, [join(ROOT, 'upstream', 'check-provenance.mjs')], { encoding: 'utf8' })
const provenanceLine = provenance.trim().split('\n').at(-1)
console.log(`provenance: ${provenanceLine}`)
if (!provenanceLine?.includes('"failures":0')) failures += 1

console.log(JSON.stringify({ failures, findings, r31DiffFiles: r31 ? r31.split('\n').length : 0 }))
process.exit(failures === 0 ? 0 : 1)
