/**
 * M3-5 C：试用源码包 / 验收证据包打包脚本（零第三方依赖）。
 * - 源码包 pet-next-trial-src-<shortsha>.zip：从 git 跟踪文件按白名单目录收集，
 *   黑名单二次过滤（node_modules/dist/logs/runtime/bench 运行数据/运行证据/
 *   身份密钥/env 快照/生成物），保证试用者拿到的是干净源码而非机器现场。
 * - 证据包 pet-next-trial-evidence-<date>.tar.gz：按参数化路径列表收集本轮验收证据。
 * - 输出 SHA256/文件数/体积；--record 追加记录到 docs/M3-5-PACKAGE.md。
 * zip 实现：优先系统 zip → 回退 python3 zipfile → 回退 tar.gz（如实记录格式）。
 * CLI：node scripts/make-trial-package.mjs [--out DIR] [--only-src] [--only-evidence]
 *      [--record] [--dry-run] [--evidence PATH ...]（PATH 相对 pet-next，可重复）
 * @module pet-next/scripts/make-trial-package
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PET_ROOT, '..');

/** 白名单（相对 pet-next/ 的顶层路径；目录=整目录收集跟踪文件）。 */
export const SRC_INCLUDE = [
  'adapters/', 'app/', 'assets/', 'assets-pipeline/', 'bench/context/', 'config/',
  'contracts/', 'core/', 'docs/', 'electron/', 'experiments/', 'scripts/', 'tests/',
  'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.preload.json',
  'eslint.config.js', 'README.md',
];

/** 黑名单模式（对 git 跟踪路径二次过滤；试用车不带任何机器现场与身份材料）。 */
export const FORBIDDEN_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)logs\//,
  /(^|\/)runtime\//,
  /(^|\/)bench\/runs[^/]+\//,
  /^tests\/chat-evidence\//,
  /^tests\/independent-.*\.check\.ts$/,
  /(^|\/)userdata\//,
  /\/(Cache|Code Cache|GPUCache|Crashpad|DawnGraphiteCache)\//,
  /environment\.json$/,
  /\.(pem|key)$/,
  /(^|\/)id_rsa/,
  /(^|\/)\.env/,
  /(^|\/)known_hosts$/,
  /\.pnpm-store\//,
];

export function isForbidden(relPath) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(relPath));
}

/** 收集源码清单：git ls-files 输出（可注入 lsFiles 字符串便于测试）→ {kept, excluded}。 */
export function collectTrialFiles(lsFilesText, include = SRC_INCLUDE) {
  const all = lsFilesText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const petPrefix = 'pet-next/';
  const kept = [];
  const excluded = [];
  for (const file of all) {
    if (!file.startsWith(petPrefix)) continue;
    const rel = file.slice(petPrefix.length);
    const matched = include.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));
    if (!matched) continue;
    (isForbidden(rel) ? excluded : kept).push(rel);
  }
  return { kept, excluded };
}

export function parsePackageArgs(argv) {
  const options = { out: null, onlySrc: false, onlyEvidence: false, record: false, dryRun: false, evidence: [] };
  const error = (message) => ({ ...options, error: message });
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      options.out = argv[(i += 1)];
      if (options.out === undefined) return error('--out 缺少值');
    } else if (arg === '--evidence') {
      const value = argv[(i += 1)];
      if (value === undefined) return error('--evidence 缺少值');
      options.evidence.push(value);
    } else if (arg === '--only-src') options.onlySrc = true;
    else if (arg === '--only-evidence') options.onlyEvidence = true;
    else if (arg === '--record') options.record = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else return error(`未知参数：${arg}`);
  }
  return options;
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { ok: result.status === 0 && !result.error, out: (result.stdout ?? '').trim(), error: result.error };
}

function gitLsFiles() {
  const result = sh('git', ['ls-files'], { cwd: REPO_ROOT });
  if (!result.ok) throw new Error(`git ls-files 失败：${String(result.error)}`);
  return result.out;
}

/** 压缩：zip → python3 zipfile → tar.gz（返回实际后缀与命令，如实记录）。 */
export function archiveWith(base, archivePathBase, files, injectables = {}) {
  const zip = injectables.zip ?? 'zip';
  const python3 = injectables.python3 ?? 'python3';
  const tar = injectables.tar ?? 'tar';
  const zipProbe = injectables.zipProbe ?? (() => sh(zip, ['-v']).ok);
  const pyProbe = injectables.pyProbe ?? (() => sh(python3, ['-c', 'import zipfile']).ok);
  const tarProbe = injectables.tarProbe ?? (() => sh(tar, ['--version']).ok);

  if (zipProbe()) {
    const out = `${archivePathBase}.zip`;
    const run = sh(zip, ['-q', out, ...files.map((file) => path.join(base, file))]);
    if (run.ok) return { file: out, format: 'zip' };
  }
  if (pyProbe()) {
    const out = `${archivePathBase}.zip`;
    const script = 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[-1], "w", zipfile.ZIP_DEFLATED) as z:\n  for name in sys.argv[1:-1]: z.write(name)\n';
    const run = sh(python3, ['-c', script, ...files.map((file) => path.join(base, file)), out], { maxBuffer: 64 * 1024 * 1024 });
    if (run.ok) return { file: out, format: 'zip(python3)' };
  }
  if (tarProbe()) {
    const out = `${archivePathBase}.tar.gz`;
    const run = sh(tar, ['-czf', out, ...files.map((file) => path.join(base, file))]);
    if (run.ok) return { file: out, format: 'tar.gz' };
  }
  throw new Error('无可用压缩后端（zip / python3 zipfile / tar 均不可用）');
}

function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function shortSha() {
  const result = sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT });
  if (!result.ok) throw new Error('git rev-parse 失败');
  return result.out;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sizeLabel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function makeSrcPackage(options) {
  const { kept, excluded } = collectTrialFiles(gitLsFiles());
  if (kept.length === 0) throw new Error('源码清单为空——拒绝打包（fail-closed）');
  if (excluded.some((file) => file.includes('id_rsa') || file.endsWith('.pem'))) {
    throw new Error('清单包含密钥类文件——拒绝打包（fail-closed）');
  }
  const base = `${options.out}/pet-next-trial-src-${shortSha()}`;
  console.log(`[trial-package] 源码：收集 ${kept.length} 个文件（黑名单排除 ${excluded.length} 个）`);
  if (options.dryRun) {
    console.log(kept.slice(0, 10).map((file) => `  + ${file}`).join('\n'));
    return { kept, excluded, archive: null };
  }
  const archive = archiveWith(PET_ROOT, base, kept);
  const size = statSync(archive.file).size;
  console.log(`[trial-package] ${archive.file}（${archive.format}，${sizeLabel(size)}，SHA256 ${sha256File(archive.file).slice(0, 16)}…）`);
  return { kept, excluded, archive: { ...archive, size, sha256: sha256File(archive.file) } };
}

function makeEvidencePackage(options) {
  const paths = options.evidence.map((rel) => rel.replace(/^pet-next\//, ''));
  const missing = paths.filter((rel) => !existsSync(path.join(PET_ROOT, rel)));
  if (missing.length > 0) throw new Error(`证据缺失，拒绝打包：${missing.join(', ')}`);
  if (paths.length === 0) throw new Error('证据清单为空——用 --evidence PATH 指定');
  const base = `${options.out}/pet-next-trial-evidence-${today()}`;
  console.log(`[trial-package] 证据：${paths.length} 个文件`);
  if (options.dryRun) {
    console.log(paths.map((file) => `  + ${file}`).join('\n'));
    return { kept: paths, archive: null };
  }
  const archive = archiveWith(PET_ROOT, base, paths);
  const size = statSync(archive.file).size;
  console.log(`[trial-package] ${archive.file}（${archive.format}，${sizeLabel(size)}，SHA256 ${sha256File(archive.file).slice(0, 16)}…）`);
  return { kept: paths, archive: { ...archive, size, sha256: sha256File(archive.file) } };
}

async function main() {
  const options = parsePackageArgs(process.argv.slice(2));
  if (options.error) {
    console.error(`[trial-package] 参数错误：${options.error}`);
    process.exit(2);
  }
  options.out = options.out ?? REPO_ROOT;
  const results = {};
  if (!options.onlyEvidence) results.src = makeSrcPackage(options);
  if (!options.onlySrc) results.evidence = makeEvidencePackage(options);
  if (options.record && !options.dryRun) {
    const lines = [`\n## 打包记录 ${new Date().toISOString()}\n`];
    if (results.src?.archive) {
      lines.push(`- 源码包：${path.basename(results.src.archive.file)}（${results.src.archive.format}，${results.src.kept.length} 文件，${sizeLabel(results.src.archive.size)}，SHA256 ${results.src.archive.sha256}）`);
    }
    if (results.evidence?.archive) {
      lines.push(`- 证据包：${path.basename(results.evidence.archive.file)}（${results.evidence.archive.format}，${results.evidence.kept.length} 文件，${sizeLabel(results.evidence.archive.size)}，SHA256 ${results.evidence.archive.sha256}）`);
    }
    appendFileSync(path.join(PET_ROOT, 'docs/M3-5-PACKAGE.md'), `${lines.join('\n')}\n`, 'utf8');
    console.log('[trial-package] 打包记录已追加到 docs/M3-5-PACKAGE.md');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
