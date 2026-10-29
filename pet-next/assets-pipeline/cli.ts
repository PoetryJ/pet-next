/**
 * `pnpm assets:check` 的入口。
 * 直接执行时检查源视频并写报告；被导入时不改退出码，也不改写成品素材。
 * 背景色字符串只记在报告里。
 * @module pet-next/assets-pipeline/cli
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../contracts/direct-run.ts';
import { runAssetCheck } from './run-check.ts';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCES = ['assets/idle.webm', 'assets/reaction.webm'];
const FLAGS = new Set(['--out', '--background-color', '--ffmpeg', '--ffprobe']);

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
  let failed = false;
  for (let index = 0; index < parsed.sources.length; index += 1) {
    const source = parsed.sources[index] ?? '';
    const report = await runAssetCheck({
      petRoot,
      sourceRelativePath: source,
      outDir: outDirFor(parsed.outDir, source, index),
      backgroundColorString: parsed.backgroundColorString,
      ffmpeg: parsed.ffmpeg,
      ffprobe: parsed.ffprobe,
    });
    if (report.verdict === 'fail') failed = true;
    console.error(`${report.verdict}\t${report.source.path}\t${path.join(parsed.outDir ?? defaultOut(source, index), 'report.json')}`);
  }
  process.exitCode = failed ? 1 : 0;
}

function outDirFor(explicit: string | null, source: string, index: number): string {
  if (explicit) return explicit;
  return defaultOut(source, index);
}

function defaultOut(source: string, index: number): string {
  if (index === 0) return path.join('assets-pipeline', 'out');
  return path.join('assets-pipeline', 'out', sourceStem(source));
}

function sourceStem(relativePath: string): string {
  const base = path.basename(relativePath, path.extname(relativePath)).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.length > 0 ? base : 'source';
}

interface ParsedArgs {
  readonly ok: true;
  readonly sources: readonly string[];
  readonly outDir: string | null;
  readonly backgroundColorString: string | null;
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { ok: false; message: string } {
  const sources: string[] = [];
  let outDir: string | null = null;
  let backgroundColorString: string | null = null;
  let ffmpeg: string | undefined;
  let ffprobe: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { ok: false, message: `${arg} 需要一个值` };
      index += 1;
      if (arg === '--out') outDir = value;
      if (arg === '--background-color') backgroundColorString = value;
      if (arg === '--ffmpeg') ffmpeg = value;
      if (arg === '--ffprobe') ffprobe = value;
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, message: `不认识的参数 ${arg}` };
    sources.push(arg);
  }
  if (outDir && sources.length > 1) return { ok: false, message: '--out 只能搭配一个源文件' };
  return {
    ok: true,
    sources: sources.length > 0 ? sources : DEFAULT_SOURCES,
    outDir,
    backgroundColorString,
    ffmpeg,
    ffprobe,
  };
}
