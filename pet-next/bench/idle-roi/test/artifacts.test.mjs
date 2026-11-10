import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildProvenance,
  normalizeAssetsSubpath,
  resolveAssetsDir,
  resolveAssetsDirDetailed,
  resolveArmSource,
  stageCommittedAssets,
  verifyAssetsDir,
} from '../lib/artifacts.mjs';

// 纯文件系统回归：自造 git 仓库 + 最小 manifest + 假 webm 字节；不启动 Electron、不读真实素材。
const TMP_DIRS = [];
function tmpRoot(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `idle-roi-assets-${label}-`));
  TMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const sha = (value) => createHash('sha256').update(value).digest('hex');
const shaOf = (file) => sha(readFileSync(file));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function newRepo(label) {
  const root = tmpRoot(label);
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'pet-next'), { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(path.join(repo, 'pet-next/README.md'), '# pet-next\n');
  return { root, repo };
}

function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/**
 * 写一份最小素材：manifest（sourceSha256/candidateSha256 + revision[v].F/C）+ O/F/C 假字节。
 * `candidateSha` 可覆盖成“错的”，用来造 SHA 不符；`omit` 用来造缺文件。
 */
function writeAssets(repo, relativeDir, { version = 'v1', o, f, c, candidateSha = null, omit = [] } = {}) {
  const dir = path.join(repo, 'pet-next', relativeDir);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    kind: 'idle-roi',
    sourcePath: 'assets/idle.webm',
    sourceSha256: sha(Buffer.from(o, 'utf8')),
    candidateSha256: candidateSha ?? sha(Buffer.from(c, 'utf8')),
    revision: {
      [version]: {
        F: { file: 'F.webm', bytes: Buffer.byteLength(f, 'utf8'), sha256: sha(Buffer.from(f, 'utf8')) },
        C: { file: 'C.webm', bytes: Buffer.byteLength(c, 'utf8'), sha256: sha(Buffer.from(c, 'utf8')) },
      },
    },
  };
  if (!omit.includes('manifest')) writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!omit.includes('O')) writeFileSync(path.join(dir, 'O.webm'), o);
  if (!omit.includes('F')) writeFileSync(path.join(dir, 'F.webm'), f);
  if (!omit.includes('C')) writeFileSync(path.join(dir, 'C.webm'), c);
  writeFileSync(path.join(dir, 'notes.md'), `# ${relativeDir}\n`);
  return manifest;
}

/** v1 提交 → v2 提交 → 仅文档提交（HEAD 与素材提交分开，provenance 两个字段必须不同）。 */
function standardRepo() {
  const { root, repo } = newRepo('fixture');
  writeAssets(repo, 'experiments/idle-roi/out', { version: 'v1', o: 'O-v1', f: 'F-v1', c: 'C-v1' });
  const v1 = commit(repo, 'assets v1');
  writeAssets(repo, 'experiments/idle-roi/out-v2', { version: 'v2', o: 'O-v2', f: 'F-v2', c: 'C-v2' });
  const v2 = commit(repo, 'assets v2');
  writeFileSync(path.join(repo, 'pet-next/docs.md'), 'docs only\n');
  const head = commit(repo, 'docs after assets');
  return { root, repo, v1, v2, head };
}

describe('subpath 校验', () => {
  test('合法路径规范化；pet-next/ 前缀可省略', () => {
    const a = normalizeAssetsSubpath('experiments/idle-roi/out-v2');
    assert.equal(a.ok, true);
    assert.equal(a.archivePath, 'pet-next/experiments/idle-roi/out-v2');
    assert.deepEqual(a.components, ['experiments', 'idle-roi', 'out-v2']);
    const b = normalizeAssetsSubpath('pet-next/experiments/idle-roi/out');
    assert.equal(b.ok, true);
    assert.equal(b.subpath, 'experiments/idle-roi/out');
  });

  test('绝对/盘符/反斜杠/.. /空/通配 全部拒绝', () => {
    for (const bad of [
      '/etc/passwd',
      'C:\\windows\\system32',
      'C:/windows/system32',
      'experiments\\idle-roi\\out',
      'file:///etc/passwd',
      '../README.md',
      'pet-next/../README.md',
      'experiments/idle-roi/out/../out-v2',
      '',
      '   ',
      './',
      'pet-next/',
      'experiments//idle-roi',
      'experiments/idle-roi/out/',
      'experiments/idle-roi/*',
    ]) {
      const result = normalizeAssetsSubpath(bad);
      assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`);
      assert.equal(result.code, 'invalid-subpath');
    }
  });
});

describe('stageCommittedAssets：显式 subpath 必须准确', () => {
  test('fresh v2：assetsDir 由本次 subpath 唯一决定，来源字段从实际字节算出', () => {
    const { root, repo, v2, head } = standardRepo();
    const dest = path.join(root, 'fresh');
    const staged = stageCommittedAssets({ repo, ref: v2, dest, subpath: 'experiments/idle-roi/out-v2' });
    assert.equal(staged.ok, true, staged.error);
    assert.equal(staged.assetsDir, path.join(dest, 'experiments/idle-roi/out-v2'));
    assert.equal(staged.commit, v2);
    assert.equal(staged.subpath, 'pet-next/experiments/idle-roi/out-v2');
    assert.equal(staged.files.length, 5); // manifest + O + F + C + notes
    assert.equal(staged.verification.measured.candidateSha, sha(Buffer.from('C-v2', 'utf8')));
    assert.equal(staged.verification.measured.sourceVideoSha, sha(Buffer.from('O-v2', 'utf8')));
    assert.equal(staged.verification.checks.cMatchesCandidate, true);
    assert.equal(staged.verification.checks.fMatchesManifest, true);

    // 没有显式 subpath 时：唯一候选 → 就是同一个目录
    const scan = resolveAssetsDirDetailed(dest);
    assert.equal(scan.ok, true);
    assert.equal(scan.dir, staged.assetsDir);
    assert.equal(scan.source, 'scan');

    const provenance = buildProvenance({ archive: staged, codeRepo: repo });
    assert.equal(provenance.assetCommit, v2);
    assert.equal(provenance.evaluationCodeCommit, head);
    assert.notEqual(provenance.assetCommit, provenance.evaluationCodeCommit);
    assert.equal(provenance.sourceVideoSha, sha(Buffer.from('O-v2', 'utf8')));
    assert.equal(provenance.candidateSha, sha(Buffer.from('C-v2', 'utf8')));
    assert.equal(provenance.manifestSha256, shaOf(path.join(staged.assetsDir, 'manifest.json')));
    assert.equal(provenance.files.length, 5);
    for (const file of provenance.files) assert.equal(file.sha256, shaOf(path.join(staged.assetsDir, file.relative)));
  });

  test('同 dest 先 v1 后 v2：第二次拿到 v2，旧 v1 与外来文件都不被清理', () => {
    const { root, repo, v1, v2 } = standardRepo();
    const dest = path.join(root, 'mixed');
    const first = stageCommittedAssets({ repo, ref: v1, dest, subpath: 'experiments/idle-roi/out' });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.assetsDir, path.join(dest, 'experiments/idle-roi/out'));
    const sentinel = path.join(dest, 'sentinel.txt');
    writeFileSync(sentinel, 'keep me\n');

    const second = stageCommittedAssets({ repo, ref: v2, dest, subpath: 'pet-next/experiments/idle-roi/out-v2' });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.assetsDir, path.join(dest, 'experiments/idle-roi/out-v2'));
    assert.equal(second.verification.measured.candidateSha, sha(Buffer.from('C-v2', 'utf8')));
    assert.equal(shaOf(path.join(second.assetsDir, 'C.webm')), sha(Buffer.from('C-v2', 'utf8')));
    // 旧 v1 原样保留，外来文件也保留
    assert.equal(shaOf(path.join(first.assetsDir, 'C.webm')), sha(Buffer.from('C-v1', 'utf8')));
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep me\n');

    // 没有显式 subpath：两个候选 → 报 ambiguous，绝不选“第一个”
    assert.equal(resolveAssetsDir(dest), null);
    const scan = resolveAssetsDirDetailed(dest);
    assert.equal(scan.ok, false);
    assert.equal(scan.code, 'ambiguous-assets-dir');
    assert.equal(scan.candidates.length, 2);

    // 再取一次 v1 也必须回到 v1（不能沿用上一次的目录）
    const third = stageCommittedAssets({ repo, ref: v1, dest, subpath: 'experiments/idle-roi/out' });
    assert.equal(third.ok, true, third.error);
    assert.equal(third.assetsDir, first.assetsDir);
    assert.equal(third.verification.measured.candidateSha, sha(Buffer.from('C-v1', 'utf8')));
    assert.equal(shaOf(path.join(dest, 'experiments/idle-roi/out-v2/C.webm')), sha(Buffer.from('C-v2', 'utf8')));
  });
});

  test('subpath 复核模式：两参精确命中，单参不猜', () => {
    const { root, repo, v1, v2 } = standardRepo();
    const dest = path.join(root, 'mixed-review');
    stageCommittedAssets({ repo, ref: v1, dest, subpath: 'experiments/idle-roi/out' });
    stageCommittedAssets({ repo, ref: v2, dest, subpath: 'pet-next/experiments/idle-roi/out-v2' });
    // 单参：多候选 → null（不再选回旧 out/）
    assert.equal(resolveAssetsDir(dest), null);
    // 两参：精确返回本次 subpath 对应目录，不扫描
    assert.equal(resolveAssetsDir(dest, { subpath: 'experiments/idle-roi/out-v2' }), path.join(dest, 'experiments/idle-roi/out-v2'));
    assert.equal(resolveAssetsDir(dest, { subpath: 'pet-next/experiments/idle-roi/out' }), path.join(dest, 'experiments/idle-roi/out'));
    const detail = resolveAssetsDirDetailed(dest, { subpath: 'experiments/idle-roi/out-v2' });
    assert.equal(detail.ok, true);
    assert.equal(detail.source, 'explicit-subpath');
    // 非法 / 不存在
    assert.equal(resolveAssetsDirDetailed(dest, { subpath: '../README.md' }).code, 'invalid-subpath');
    assert.equal(resolveAssetsDirDetailed(dest, { subpath: 'experiments/idle-roi/out-v3' }).code, 'subpath-not-found');
    assert.equal(resolveAssetsDir(dest, { subpath: 'experiments/idle-roi/out-v3' }), null);
  });

describe('非法/缺失路径与空产物：一律非零失败', () => {
  test('../README.md、绝对路径、反斜杠、不存在子树 都不返回 ok', () => {
    const { root, repo } = standardRepo();
    const dest = path.join(root, 'reject');
    const cases = [
      ['../README.md', 'invalid-subpath'],
      ['/etc/passwd', 'invalid-subpath'],
      ['C:/windows/system32', 'invalid-subpath'],
      ['experiments\\idle-roi\\out', 'invalid-subpath'],
      ['experiments/idle-roi/out/../out-v2', 'invalid-subpath'],
      ['', 'invalid-subpath'],
      ['experiments/idle-roi/nonexistent', 'archive-failed'],
      // 合法相对路径但指向文件：解出来不是素材目录
      ['pet-next/README.md', 'assets-dir-missing'],
    ];
    for (const [subpath, code] of cases) {
      const staged = stageCommittedAssets({ repo, ref: 'HEAD', dest, subpath });
      assert.equal(staged.ok, false, `不应 ok：${JSON.stringify(subpath)}`);
      assert.equal(staged.code, code, `code 不符：${JSON.stringify(subpath)} → ${staged.code}`);
      assert.equal(typeof staged.error, 'string');
      assert.ok(staged.error.length > 0);
      assert.equal(staged.files.length, 0);
    }
    // 不合法的 ref 也不能当素材
    const badRef = stageCommittedAssets({ repo, ref: 'does-not-exist', dest, subpath: 'experiments/idle-roi/out' });
    assert.equal(badRef.ok, false);
    assert.equal(badRef.code, 'bad-ref');
  });

  test('无 manifest / 缺 C / 空目录：空产物不得 ok', () => {
    const { root, repo } = newRepo('partial');
    writeAssets(repo, 'experiments/idle-roi/out-empty', { version: 'v1', o: 'O', f: 'F', c: 'C', omit: ['manifest'] });
    writeAssets(repo, 'experiments/idle-roi/out-no-c', { version: 'v1', o: 'O', f: 'F', c: 'C', omit: ['C'] });
    const ref = commit(repo, 'partial assets');

    const noManifest = stageCommittedAssets({ repo, ref, dest: path.join(root, 'd1'), subpath: 'experiments/idle-roi/out-empty' });
    assert.equal(noManifest.ok, false);
    assert.equal(noManifest.code, 'manifest-missing');

    const noCandidate = stageCommittedAssets({ repo, ref, dest: path.join(root, 'd2'), subpath: 'experiments/idle-roi/out-no-c' });
    assert.equal(noCandidate.ok, false);
    assert.equal(noCandidate.code, 'missing-file');
    assert.match(noCandidate.error, /C\.webm/);

    // 空目录（没有任何候选 manifest）不能被扫描“猜”出路径
    const emptyDest = path.join(root, 'empty-dest');
    mkdirSync(emptyDest, { recursive: true });
    assert.equal(resolveAssetsDir(emptyDest), null);
    assert.equal(resolveAssetsDirDetailed(emptyDest).code, 'manifest-not-found');
    assert.equal(verifyAssetsDir(emptyDest).ok, false);
    assert.equal(verifyAssetsDir(path.join(root, 'nope')).ok, false);
  });
});

describe('SHA 记账', () => {
  test('manifest 声明的 SHA 与字节不符 → stage 失败；事后篡改 → 复算也失败', () => {
    const bad = newRepo('badsha');
    writeAssets(bad.repo, 'experiments/idle-roi/out', {
      version: 'v1',
      o: 'O',
      f: 'F',
      c: 'C-bytes',
      candidateSha: sha(Buffer.from('C-other', 'utf8')),
    });
    const ref = commit(bad.repo, 'bad sha');
    const staged = stageCommittedAssets({ repo: bad.repo, ref, dest: path.join(bad.root, 'd'), subpath: 'experiments/idle-roi/out' });
    assert.equal(staged.ok, false);
    assert.equal(staged.code, 'sha-mismatch');
    assert.match(staged.error, /candidateSha256/);
    assert.equal(staged.verification.ok, false);
    assert.equal(staged.verification.checks.cMatchesCandidate, false);

    // 事后篡改：provenance 必须反映实际字节，而不是沿用 stage 时的旧 SHA
    const good = newRepo('tamper');
    writeAssets(good.repo, 'experiments/idle-roi/out', { version: 'v1', o: 'O', f: 'F', c: 'C' });
    const okRef = commit(good.repo, 'good');
    const okStage = stageCommittedAssets({ repo: good.repo, ref: okRef, dest: path.join(good.root, 'd'), subpath: 'experiments/idle-roi/out' });
    assert.equal(okStage.ok, true, okStage.error);
    writeFileSync(path.join(okStage.assetsDir, 'C.webm'), 'tampered');
    const reverified = verifyAssetsDir(okStage.assetsDir);
    assert.equal(reverified.ok, false);
    assert.equal(reverified.code, 'sha-mismatch');
    const provenance = buildProvenance({ assetsDir: okStage.assetsDir, codeRepo: good.repo });
    assert.equal(provenance.candidateSha, sha(Buffer.from('tampered', 'utf8')));
    assert.equal(provenance.checks.cMatchesCandidate, false);
  });
});

describe('臂解析', () => {
  test('给出本次素材目录后，缺 C 不回退到仓库里的旧 out/C.webm', () => {
    const root = tmpRoot('arm');
    const dir = path.join(root, 'assets-v2');
    mkdirSync(dir, { recursive: true });
    const manifest = {
      sourceSha256: sha(Buffer.from('O', 'utf8')),
      candidateSha256: sha(Buffer.from('C', 'utf8')),
    };
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(dir, 'O.webm'), 'O');
    writeFileSync(path.join(dir, 'F.webm'), 'F-new');
    const c = resolveArmSource('C', {}, manifest, dir);
    assert.equal(c.exists, false);
    assert.equal(c.path, null);
    const f = resolveArmSource('F', {}, manifest, dir);
    assert.equal(f.exists, true);
    assert.equal(f.sha256, sha(Buffer.from('F-new', 'utf8')));
    const o = resolveArmSource('O', {}, manifest, dir);
    assert.equal(o.exists, true);
    assert.equal(o.shaMatched, true);
  });
});

// ---- 真实 v2 至少跑一次：直接从基线提交 b9c2f61 抽字节，不依赖工作区 ----
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const REAL_REF = 'b9c2f619b10e33416f03225d092b2138145ecc68';
const REAL_V2_C = '81c8a2f26d024bc6e34429c98dbea50978ec5696d4abed3b23ed2031339b8f4e';
const REAL_V2_F = 'b1c3e8cf5392158ec5e9d3714ba21b5b72555572793867e1e99552d65fc43673';
const REAL_V1_C = '08a80ac4274d9e1e84145e99043a07e13cbfb521ddeb68f20c47603d4d647e0c';
const REAL_O = '6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a';

function hasCommit(repo, ref) {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('真实素材（b9c2f61）', () => {
  test(
    'fresh v2 与同 dest v1→v2 各自取到准确字节',
    { skip: hasCommit(REPO_ROOT, REAL_REF) ? false : `${REAL_REF} 不在 ${REPO_ROOT}` },
    () => {
      const root = tmpRoot('real');
      const dest = path.join(root, 'staged');
      const v2 = stageCommittedAssets({ repo: REPO_ROOT, ref: REAL_REF, dest, subpath: 'experiments/idle-roi/out-v2' });
      assert.equal(v2.ok, true, v2.error);
      assert.equal(v2.assetsDir, path.join(dest, 'experiments/idle-roi/out-v2'));
      assert.equal(v2.commit, REAL_REF);
      assert.equal(v2.verification.measured.candidateSha, REAL_V2_C);
      assert.equal(v2.verification.measured.sourceVideoSha, REAL_O);
      assert.equal(v2.verification.measured.fullCanvasSha, REAL_V2_F);
      assert.equal(v2.verification.checks.fMatchesManifest, true);
      assert.equal(v2.files.length, 5);

      // 同 dest 再取 v1：仍各自准确，且 v2 字节没被覆盖
      const v1 = stageCommittedAssets({ repo: REPO_ROOT, ref: REAL_REF, dest, subpath: 'experiments/idle-roi/out' });
      assert.equal(v1.ok, true, v1.error);
      assert.equal(v1.verification.measured.candidateSha, REAL_V1_C);
      assert.equal(shaOf(path.join(dest, 'experiments/idle-roi/out-v2/C.webm')), REAL_V2_C);

      // 无显式 subpath：两个候选 → ambiguous（旧 out/ 不会被当成 v2）
      assert.equal(resolveAssetsDir(dest), null);
      assert.equal(resolveAssetsDirDetailed(dest).code, 'ambiguous-assets-dir');

      const provenance = buildProvenance({ archive: v2, codeRepo: REPO_ROOT });
      assert.equal(provenance.assetCommit, REAL_REF);
      assert.equal(provenance.candidateSha, REAL_V2_C);
      assert.equal(provenance.sourceVideoSha, REAL_O);
      assert.equal(provenance.fullCanvasSha, REAL_V2_F);
      assert.match(String(provenance.evaluationCodeCommit), /^[0-9a-f]{40}$/);
      assert.equal(provenance.files.length, 5);
    },
  );
});
