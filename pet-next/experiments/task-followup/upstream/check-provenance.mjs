#!/usr/bin/env node
/** 校验 vendored 上游 15 文件与固定 commit 的 SHA 一致；不一致 exit 1。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const provenance = JSON.parse(readFileSync(join(HERE, 'PROVENANCE.json'), 'utf8'))
let failures = 0
for (const [name, expected] of Object.entries(provenance.vendoredFiles)) {
  const actual = createHash('sha256').update(readFileSync(join(HERE, 'src', 'core', name))).digest('hex')
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${actual.slice(0, 12)}`)
}
const license = createHash('sha256').update(readFileSync(join(HERE, 'LICENSE'))).digest('hex')
const licenseOk = license === provenance.licenseSha256
if (!licenseOk) failures += 1
console.log(`${licenseOk ? 'OK  ' : 'FAIL'} LICENSE ${license.slice(0, 12)}`)
console.log(JSON.stringify({ upstreamCommit: provenance.upstreamCommit, files: Object.keys(provenance.vendoredFiles).length, failures }))
process.exit(failures === 0 ? 0 : 1)
