/**
 * 门禁脚本的公共入口：跨平台 CLI 判定 + 结果信封。
 *
 * 为什么不再用 `import.meta.url === \`file://${process.argv[1]}\``：
 * 路径里有空格/中文时 import.meta.url 是百分号编码的，字符串永远不相等，
 * 脚本会静默 exit 0 —— Windows 就是这样"全套 PASS 但没有任何结果文件"的。
 *
 * @module pet-next/experiments/memory-consistency/runner/gate
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATE_SCHEMA_VERSION, type GateEnvelope } from '../contracts.ts';

/**
 * 把 argv 路径转成 file URL，并统一解码/分隔符。
 *
 * pathToFileURL 依赖宿主平台：在 POSIX 上遇到 `C:\x\y.ts` 会当成相对路径。
 * 这里显式识别 Windows 风格路径，保证同一段代码在两个平台都能判断入口。
 */
function normalizeFileUrl(pathOrUrl: string): string {
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(pathOrUrl) || pathOrUrl.includes('\\');
  let url: string;
  if (pathOrUrl.startsWith('file:')) {
    url = pathOrUrl;
  } else if (windowsStyle) {
    url = `file:///${pathOrUrl.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  } else {
    url = pathToFileURL(pathOrUrl).href;
  }
  return decodeURIComponent(url).replace(/\\/g, '/').replace(/^file:\/{2,}/, '');
}

/** 判断当前模块是否被当作脚本直接执行（跨平台、跨含空格/中文路径）。 */
export function isMainModule(argvPath: string | undefined, moduleUrl: string): boolean {
  if (argvPath === undefined || argvPath === '') return false;
  try {
    const left = normalizeFileUrl(argvPath);
    const right = normalizeFileUrl(moduleUrl);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  } catch {
    return false;
  }
}

/** 本次运行的元信息。run.mjs 通过环境变量传入。 */
export interface GateMeta {
  readonly runId: string;
  readonly sourceCommit: string;
  readonly startedAt: string;
}

/**
 * 从环境读取运行身份。
 * 缺省值故意写成 unknown：run.mjs 会因此拒绝该结果，而不是当成有效通过。
 */
export function gateMeta(env: NodeJS.ProcessEnv = process.env): GateMeta {
  return {
    runId: env.MEMORY_RUN_ID ?? 'unknown',
    sourceCommit: env.MEMORY_SOURCE_COMMIT ?? 'unknown',
    startedAt: env.MEMORY_GATE_STARTED_AT ?? new Date().toISOString(),
  };
}

/** 写出带信封的结果文件。 */
export function writeGateReport(
  outDir: string,
  file: string,
  gateId: GateEnvelope['gateId'],
  report: Record<string, unknown>,
  meta: GateMeta,
): GateEnvelope {
  const envelope: GateEnvelope = {
    schemaVersion: GATE_SCHEMA_VERSION,
    gateId,
    runId: meta.runId,
    sourceCommit: meta.sourceCommit,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
    passed_gate: report['passed_gate'] === true,
  };
  writeFileSync(join(outDir, file), `${JSON.stringify({ envelope, ...report }, null, 2)}\n`, 'utf8');
  return envelope;
}
