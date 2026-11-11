#!/usr/bin/env node
/**
 * 派生笔记用例（只服务 P1 的泄漏审计与 D2 的依赖链回归）。
 *
 * 为什么单独放一个目录：现有的 24 对开发轨迹里没有「父笔记 + 子笔记」，
 * 泄漏审计就会因为 notes 全空而"看不见泄漏"。这里补两条含父子的轨迹，
 * 不并入 dev 集，避免改变 G1 的 48/143 基线。
 *
 * 运行：node --experimental-strip-types cases/build-derived.mjs [--check]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statement } from '../testing/factory.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'derived');
const check = process.argv.includes('--check');

const notes = {
  parent: {
    noteId: 'parent-weekly',
    text: '周报用简体中文',
    sourceEventIds: ['e1'],
    parentNoteIds: [],
    dependencyVersions: {},
    generator: 'scripted',
    subjectKey: 'pref:weekly-report',
  },
  child: {
    noteId: 'child-weekly-format',
    text: '周报格式：简体中文 + 先给结论',
    sourceEventIds: ['e1'],
    parentNoteIds: ['parent-weekly'],
    dependencyVersions: {},
    generator: 'scripted',
  },
};

const tracks = [
  {
    trackId: 'A7-v1',
    pairId: 'A7',
    class: 'dependency-graph',
    variant: 'v1',
    keyCondition: '父子笔记同批建立后都保持 active',
    sourceCategory: 'synthetic',
    executionCategory: 'scripted',
    note: '派生笔记覆盖用例；不含 pairId/期望标签。',
    events: [statement(1, 'e1', '周报用简体中文，先给结论', 'pref:weekly-report', '简体中文')],
    patches: [
      {
        patchId: 'p1',
        buildAtSequence: 1,
        applyAtSequence: 1,
        reusePriorOpId: null,
        dropSubjectDependency: false,
        notesToUpsert: [notes.parent, notes.child],
        notesToInvalidate: [],
      },
    ],
  },
  {
    trackId: 'A7-v2',
    pairId: 'A7',
    class: 'dependency-graph',
    variant: 'v2',
    keyCondition: '父笔记更新后，旧子笔记必须失效',
    sourceCategory: 'synthetic',
    executionCategory: 'scripted',
    note: '派生笔记覆盖用例；不含 pairId/期望标签。',
    events: [
      statement(1, 'e1', '周报用简体中文，先给结论', 'pref:weekly-report', '简体中文'),
      statement(2, 'e2', '周报改成英文', 'pref:weekly-report', '英文'),
    ],
    patches: [
      {
        patchId: 'p1',
        buildAtSequence: 1,
        applyAtSequence: 1,
        reusePriorOpId: null,
        dropSubjectDependency: false,
        notesToUpsert: [notes.parent, notes.child],
        notesToInvalidate: [],
      },
      {
        patchId: 'p2',
        buildAtSequence: 2,
        applyAtSequence: 2,
        reusePriorOpId: null,
        dropSubjectDependency: false,
        notesToUpsert: [
          {
            ...notes.parent,
            text: '周报用英文',
            sourceEventIds: ['e1', 'e2'],
          },
        ],
        notesToInvalidate: [],
      },
    ],
  },
];

const files = new Map(tracks.map((track) => [`${track.trackId}.json`, `${JSON.stringify(track, null, 2)}\n`]));
const manifest = {
  schemaVersion: 'memory-cases/v1',
  generator: 'cases/build-derived.mjs',
  counts: { tracks: tracks.length, pairs: 1 },
  files: [...files.keys()].map((name) => ({ name, sha256: createHash('sha256').update(files.get(name)).digest('hex') })),
};

if (check) {
  const existing = existsSync(OUT) ? readdirSync(OUT).filter((name) => name !== 'manifest.json').sort() : [];
  const expected = [...files.keys()].sort();
  const same = existing.length === expected.length && expected.every((name) => readFileSync(join(OUT, name), 'utf8') === files.get(name));
  if (!same) {
    process.stderr.write('derived cases drifted; rerun without --check\n');
    process.exit(1);
  }
  process.stdout.write(`derived cases ok: ${tracks.length} tracks\n`);
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
for (const [name, content] of files) writeFileSync(join(OUT, name), content, 'utf8');
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${tracks.length} derived tracks to ${OUT}\n`);
