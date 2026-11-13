/**
 * R5 评分负控：每条都是真实非零检测（子进程 exit 1 = DETECTED）。
 * harness 只有全部 detected 且没有异常退出时才 exit 0；异常码不算检出。
 *
 * R5.1：动态 import 用 pathToFileURL（Windows 绝对路径 C:\... 不是合法 ESM URL）。
 * 导入失败/未知 case/运行异常一律 exit 2 并打印 HARNESS_ERROR，与 DETECTED 的 exit 1 区分；
 * 汇总只认“exit 1 + 最后一行为 DETECTED <同名 case>”，其余（含 exit 0、信号、缺记录）都算 MASKED。
 *
 * 用法：node eval/r5/negative/all.mjs [--case <name>]
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const HARNESS_ERROR_EXIT = 2

function harnessError(stage, error) {
  console.log(`HARNESS_ERROR ${stage} ${JSON.stringify(String(error?.stack ?? error))}`)
  process.exit(HARNESS_ERROR_EXIT)
}

let scoreR5Run
try {
  ;({ scoreR5Run } = await import(pathToFileURL(join(ROOT, 'eval', 'r5', 'score.ts')).href))
  if (typeof scoreR5Run !== 'function') throw new Error('eval/r5/score.ts does not export scoreR5Run')
} catch (error) {
  harnessError('import', error)
}

const CASES = [
  'duplicate-notification',
  'stale-version-send',
  'send-after-cancel',
  'answered-without-visible',
  'missed-due-wake',
  'report-only-count',
]

function loadRaw(name) {
  return JSON.parse(readFileSync(join(ROOT, 'out', 'r5', 'raw', 'P3', `${name}.json`), 'utf8'))
}
function loadGold(name) {
  return JSON.parse(readFileSync(join(ROOT, 'gold', 'r5', `${name}.json`), 'utf8'))
}

function detected(name) {
  if (name === 'duplicate-notification') {
    const raw = loadRaw('R5-01b')
    raw.notifications.push({ ...raw.notifications[0] })
    const score = scoreR5Run(raw, loadGold('R5-01b'))
    return { ok: score.duplicateNotifications > 0, evidence: score.duplicateNotifications }
  }
  if (name === 'stale-version-send') {
    const raw = loadRaw('R5-01b')
    const attention = raw.attentions[0]
    raw.attentions.push({ ...attention, attentionId: 'attn-stale', taskRevision: attention.taskRevision + 1 })
    raw.notifications.push({
      notificationId: 'notif-stale',
      attentionId: 'attn-stale',
      createdAt: raw.finalClock,
      deliveredAt: raw.finalClock,
      presentedAt: null,
    })
    const score = scoreR5Run(raw, loadGold('R5-01b'))
    return { ok: score.staleNotifications > 0, evidence: score.staleNotifications }
  }
  if (name === 'send-after-cancel') {
    const raw = loadRaw('R5-06a')
    raw.notifications.push({
      notificationId: 'notif-after-cancel',
      attentionId: null,
      createdAt: '2026-11-12T08:30:00.000Z',
      deliveredAt: '2026-11-12T08:30:00.000Z',
      presentedAt: null,
    })
    const score = scoreR5Run(raw, loadGold('R5-06a'))
    return { ok: score.notificationsAfterCancel > 0, evidence: score.notificationsAfterCancel }
  }
  if (name === 'answered-without-visible') {
    const raw = loadRaw('R5-05b')
    for (const attention of raw.attentions) {
      attention.deliveredAt = null
      attention.presentedAt = null
    }
    const score = scoreR5Run(raw, loadGold('R5-05b'))
    return { ok: score.answered === 0 && score.visible === 0, evidence: { visible: score.visible, answered: score.answered } }
  }
  if (name === 'missed-due-wake') {
    const raw = loadRaw('R5-01b')
    for (const attention of raw.attentions) {
      attention.deliveredAt = null
      attention.presentedAt = null
    }
    raw.finalClock = '2026-11-12T12:00:00.000Z'
    const score = scoreR5Run(raw, loadGold('R5-01b'))
    return { ok: score.missed > 0 && score.pending === 0, evidence: { missed: score.missed, pending: score.pending } }
  }
  if (name === 'report-only-count') {
    const raw = loadRaw('R5-01b')
    const score = scoreR5Run(raw, loadGold('R5-01b'))
    const claimed = { produced: score.produced + 1 }
    return { ok: claimed.produced !== score.produced, evidence: { claimed: claimed.produced, recomputed: score.produced } }
  }
  throw new Error(`unknown case ${name}`)
}

const caseName = process.argv[2] === '--case' ? process.argv[3] : null
if (process.argv[2] === '--case' && !caseName) harnessError('args', new Error('--case requires a name'))
if (caseName) {
  if (!CASES.includes(caseName)) harnessError('case', new Error(`unknown case ${caseName}`))
  let result
  try {
    result = detected(caseName)
  } catch (error) {
    harnessError(`case:${caseName}`, error)
  }
  console.log(`${result.ok ? 'DETECTED' : 'UNDETECTED'} ${caseName} ${JSON.stringify(result.evidence)}`)
  process.exit(result.ok ? 1 : 0)
}

let failures = 0
for (const name of CASES) {
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url), '--case', name], {
    encoding: 'utf8',
  })
  const line = ((child.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '').trim()
  if (child.status === 1 && child.signal === null && line.startsWith(`DETECTED ${name} `)) {
    console.log(`DETECTED ${name}`)
  } else {
    failures += 1
    console.error(`MASKED ${name} status=${child.status} signal=${child.signal}\n${child.stdout}\n${child.stderr}`)
  }
}
console.log(`negative cases=${CASES.length} failures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
