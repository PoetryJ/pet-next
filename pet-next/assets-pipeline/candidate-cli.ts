/**
 * 生成 reaction 的 alpha 候选、三背景对照和交付记录。
 * 不改三份成品。被导入时不跑。
 * @module pet-next/assets-pipeline/candidate-cli
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../contracts/direct-run.ts';
import { hashFile } from './asset-report.ts';
import {
  buildProvenance,
  CANDIDATE_MANIFEST,
  CANDIDATE_OUTPUT,
  CANDIDATE_PLATES,
  CANDIDATE_PROVENANCE,
  CANDIDATE_SOURCE,
  candidateCommand,
  deliverReactionCandidate,
  ORIGINAL_REACTION_REPO_PATH,
  PLATE_FRAMES,
  SHIPPED_PLATE_FRAMES,
  SHIPPED_PLATES,
  SHIPPED_REACTION,
  writeComparisonPlates,
} from './deliver-candidate.ts';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = new Set(['--source', '--output', '--plates', '--compare', '--compare-out', '--manifest', '--provenance']);

if (isDirectRun(import.meta.url)) {
  void main();
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exitCode = 1;
    return;
  }
  const manifestPath = resolveRecord(parsed.manifest);
  const provenancePath = resolveRecord(parsed.provenance);
  if (!manifestPath || !provenancePath) {
    console.error('记录文件必须留在 pet-next 的 assets/candidates/ 或 assets-pipeline/ 里。');
    process.exitCode = 1;
    return;
  }
  const delivered = await deliverReactionCandidate({
    petRoot,
    sourceRelativePath: parsed.source,
    outputRelativePath: parsed.output,
    platesDirRelative: parsed.plates,
    plateFrameIndexes: PLATE_FRAMES,
    command: candidateCommand(parsed),
  });
  if (!delivered.ok) {
    console.error(delivered.limitation);
    process.exitCode = 1;
    return;
  }
  const compared = await writeComparisonPlates({
    petRoot,
    sourceRelativePath: parsed.compare,
    platesDirRelative: parsed.compareOut,
    frameIndexes: SHIPPED_PLATE_FRAMES,
  });
  if (!compared.ok) {
    console.error(compared.limitation);
    process.exitCode = 1;
    return;
  }
  const original = await hashFile(path.resolve(petRoot, '..', ORIGINAL_REACTION_REPO_PATH));
  if (!original) {
    console.error(`找不到母版 ${ORIGINAL_REACTION_REPO_PATH}`);
    process.exitCode = 1;
    return;
  }
  const provenance = buildProvenance(delivered.manifest, delivered.plateFrames, original.sha256, {
    path: parsed.compare,
    sha256: compared.sha256,
    frames: compared.frames,
  });
  if ('ok' in provenance) {
    console.error(provenance.limitation);
    process.exitCode = 1;
    return;
  }
  await writeFile(manifestPath, `${JSON.stringify(delivered.manifest, null, 2)}\n`);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.error(`pass\t${delivered.manifest.outputPath}\t${delivered.manifest.outputSha256}`);
}

function resolveRecord(relative: string): string | null {
  const absolute = path.resolve(petRoot, relative);
  const back = path.relative(petRoot, absolute);
  if (back.startsWith('..') || path.isAbsolute(back)) return null;
  const posix = back.split(path.sep).join('/');
  if (!posix.startsWith('assets/candidates/') && !posix.startsWith('assets-pipeline/')) return null;
  return absolute;
}

interface ParsedArgs {
  readonly ok: true;
  readonly source: string;
  readonly output: string;
  readonly plates: string;
  readonly compare: string;
  readonly compareOut: string;
  readonly manifest: string;
  readonly provenance: string;
}

export function parseCandidateArgs(argv: readonly string[]): ParsedArgs | { ok: false; message: string } {
  let source: string = CANDIDATE_SOURCE;
  let output: string = CANDIDATE_OUTPUT;
  let plates: string = CANDIDATE_PLATES;
  let compare: string = SHIPPED_REACTION;
  let compareOut: string = SHIPPED_PLATES;
  let manifest: string = CANDIDATE_MANIFEST;
  let provenance: string = CANDIDATE_PROVENANCE;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!FLAGS.has(arg)) {
      if (arg.startsWith('--')) return { ok: false, message: `不认识的参数 ${arg}` };
      return { ok: false, message: `多余的参数 ${arg}` };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return { ok: false, message: `${arg} 需要一个值` };
    index += 1;
    if (arg === '--source') source = value;
    if (arg === '--output') output = value;
    if (arg === '--plates') plates = value;
    if (arg === '--compare') compare = value;
    if (arg === '--compare-out') compareOut = value;
    if (arg === '--manifest') manifest = value;
    if (arg === '--provenance') provenance = value;
  }
  return { ok: true, source, output, plates, compare, compareOut, manifest, provenance };
}

function parseArgs(argv: readonly string[]): ParsedArgs | { ok: false; message: string } {
  return parseCandidateArgs(argv);
}
