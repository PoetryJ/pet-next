#!/usr/bin/env node
/**
 * 新模板集构建器：8 对 × 2 = 16 条轨迹，用于检验开发集之外的叙事与操作顺序。
 *
 * 与 build-dev.mjs 的关系：形状与语义相同，但换了场景词、事件顺序与翻转点；
 * 这里刻意复制构造辅助函数而不 import 开发集构建器，避免两边一起改动时互相掩盖。
 *
 * 输入 hash 在写入时固定；期望标签在 eval/expected/new.json，独立于本文件。
 *
 * 用法：
 *   node experiments/memory-consistency/cases/build-new.mjs
 *   node experiments/memory-consistency/cases/build-new.mjs --check
 *
 * @module pet-next/experiments/memory-consistency/cases/build-new
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'new');
const BASE_TIME = Date.UTC(2026, 10, 10, 15, 0, 0);
const SESSION = 'sess-new';

function ev(kind, payload, extra = {}) {
  return { kind, payload, ...extra };
}

function note(noteId, text, sourceEventIds, subjectKey, parentNoteIds = []) {
  return {
    noteId,
    text,
    sourceEventIds,
    parentNoteIds,
    generator: 'scripted',
    ...(subjectKey === undefined ? {} : { subjectKey }),
  };
}

const statement = (text, subjectKey, valueText, extra = {}) =>
  ev(
    'user.statement',
    {
      text,
      ...(subjectKey === undefined
        ? {}
        : { scripted: { subjectKey, valueText: valueText ?? text, kindHint: subjectKey.startsWith('task:') ? 'task' : 'preference' } }),
    },
    extra,
  );
const generated = (text, extra = {}) => ev('response.generated', { text }, { source: 'model', ...extra });
const presented = (channel = 'ui', extra = {}) => ev('response.presented', { channel }, { source: 'runtime', ...extra });
const ack = (a, extra = {}) => ev('user.acknowledged', { ack: a }, extra);
const tool = (outcome, toolName, extra = {}) => ev('tool.result', { toolName, outcome }, { source: 'runtime', ...extra });
const task = (change, authority, extra = {}) => ev('task.changed', { change, authority }, { source: 'runtime', ...extra });

const PAIRS = [
  {
    pairId: 'N1',
    cls: 'state-update',
    keyCondition: '是否存在第二次同主题陈述（重述也会让旧笔记失效）',
    build(flip) {
      return {
        events: [
          statement('开会纪要先给提纲。', 'pref:minutes', '先给提纲'),
          ...(flip ? [] : [statement('纪要还是先给提纲。', 'pref:minutes', '先给提纲')]),
        ],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: [note('n1', '纪要先给提纲', ['e1'], 'pref:minutes')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'N2',
    cls: 'state-update',
    keyCondition: '迟到的撤销 revision（落后 vs 更新）',
    build(flip) {
      return {
        events: [
          task('created', 'explicit', { taskId: 'expense-42', taskRevision: 1 }),
          task('revised', 'explicit', { taskId: 'expense-42', taskRevision: 3 }),
          task('cancelled', 'explicit', { taskId: 'expense-42', taskRevision: flip ? 4 : 2 }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'N3',
    cls: 'generation-presentation',
    keyCondition: '第二条生成属于另一个请求还是同一请求',
    build(flip) {
      return {
        events: [
          generated('已为你查票。', { requestId: 'req-ticket-1', responseId: 'resp-t1' }),
          flip
            ? generated('还有一个方案。', { requestId: 'req-ticket-1', responseId: 'resp-t2' })
            : generated('还有一班车。', { requestId: 'req-ticket-2', responseId: 'resp-t2' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'N4',
    cls: 'generation-presentation',
    keyCondition: '确认指向的 responseId 是否已被观察到',
    build(flip) {
      return {
        events: [
          presented('ui', { requestId: 'req-fw-1', responseId: 'resp-fw-1' }),
          ack('seen', { requestId: 'req-fw-1', responseId: flip ? 'resp-fw-9' : 'resp-fw-1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'N5',
    cls: 'tool-result',
    keyCondition: '未知工具结果的重发是否同载荷',
    build(flip) {
      return {
        events: [
          tool('unknown', 'install_firmware', { requestId: 'req-install', id: 'e1' }),
          flip
            ? tool('ok', 'install_firmware', { requestId: 'req-install' })
            : tool('unknown', 'install_firmware', { requestId: 'req-install', id: 'e1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'N6',
    cls: 'tool-result',
    keyCondition: '第二个工具结果落在哪个请求上',
    build(flip) {
      return {
        events: [
          generated('开始分期计算。', { requestId: 'req-bill-1', responseId: 'resp-b1' }),
          tool('ok', 'calc', { requestId: 'req-bill-1' }),
          tool(flip ? 'error' : 'ok', 'calc', { requestId: flip ? 'req-bill-1' : 'req-bill-2' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'N7',
    cls: 'stale-patch',
    keyCondition: '补丁构建后新增陈述是否触及同一 subject',
    build(flip) {
      return {
        events: [
          statement('菜单翻译保留菜名原文。', 'pref:menu', '保留菜名原文'),
          statement(flip ? '菜单翻译保留菜名原文。' : '字体调大一点。', flip ? 'pref:menu' : 'pref:font', flip ? '保留菜名原文' : '大一点'),
        ],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 2,
            notesToUpsert: [note('n1', '菜单翻译保留原文', ['e1'], 'pref:menu')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'N8',
    cls: 'stale-patch',
    keyCondition: '子笔记提交前父笔记是否被重写',
    build(flip) {
      return {
        events: [statement('行程先定去程。', 'pref:trip', '先定去程')],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: [note('n-parent', '行程范围', ['e1'], 'pref:trip')],
            notesToInvalidate: [],
          },
          ...(flip
            ? [
                {
                  buildAtSequence: 1,
                  applyAtSequence: 1,
                  notesToUpsert: [note('n-parent', '行程范围（重写）', ['e1'], 'pref:trip')],
                  notesToInvalidate: [],
                },
              ]
            : []),
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: [note('n-child', '去程优先', ['e1'], undefined, ['n-parent'])],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
];

function materialize(pair, flip) {
  const variant = flip ? 'v2' : 'v1';
  const trackId = `${pair.pairId}-${variant}`;
  const raw = pair.build(flip);
  const events = raw.events.map((spec, index) => {
    const sequence = index + 1;
    return {
      schemaVersion: 'memory-event/v1',
      eventId: spec.id ?? `e${sequence}`,
      sessionId: SESSION,
      sessionEpoch: spec.sessionEpoch ?? 1,
      sequence,
      occurredAt: new Date(BASE_TIME + sequence * 60_000).toISOString(),
      observedAt: new Date(BASE_TIME + sequence * 60_000 + 5).toISOString(),
      source: spec.source ?? 'user',
      kind: spec.kind,
      ...(spec.requestId === undefined ? {} : { requestId: spec.requestId }),
      ...(spec.responseId === undefined ? {} : { responseId: spec.responseId }),
      ...(spec.taskId === undefined ? {} : { taskId: spec.taskId }),
      ...(spec.taskRevision === undefined ? {} : { taskRevision: spec.taskRevision }),
      payload: spec.payload,
    };
  });

  return {
    trackId,
    pairId: pair.pairId,
    class: pair.cls,
    variant,
    keyCondition: pair.keyCondition,
    sourceCategory: 'synthetic',
    executionCategory: 'scripted',
    note: '新模板输入轨迹；期望标签在 eval/expected/new.json，跑之前已冻结。',
    events,
    patches: raw.patches.map((spec, index) => ({
      patchId: `${trackId}-p${index + 1}`,
      buildAtSequence: spec.buildAtSequence,
      applyAtSequence: spec.applyAtSequence ?? null,
      reusePriorOpId: spec.reusePriorOpId ?? null,
      dropSubjectDependency: spec.dropSubjectDependency ?? false,
      notesToUpsert: spec.notesToUpsert,
      notesToInvalidate: spec.notesToInvalidate,
    })),
  };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function buildAll() {
  const tracks = [];
  for (const pair of PAIRS) {
    tracks.push(materialize(pair, false));
    tracks.push(materialize(pair, true));
  }
  return tracks;
}

function main() {
  const check = process.argv.includes('--check');
  const tracks = buildAll();
  const manifest = {
    schemaVersion: 'memory-case-manifest/v1',
    dataset: 'new-templates',
    generatedBy: 'cases/build-new.mjs',
    counts: { pairs: PAIRS.length, tracks: tracks.length },
    tracks: tracks.map((track) => {
      const body = JSON.stringify(track, null, 2);
      return {
        trackId: track.trackId,
        pairId: track.pairId,
        class: track.class,
        variant: track.variant,
        file: `${track.trackId}.json`,
        sha256: sha256(body),
      };
    }),
  };
  const manifestBody = JSON.stringify(manifest, null, 2);

  if (check) {
    let problems = 0;
    for (const track of tracks) {
      const path = join(OUT_DIR, `${track.trackId}.json`);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== JSON.stringify(track, null, 2)) {
        console.error(`missing or drifted: ${track.trackId}.json`);
        problems += 1;
      }
    }
    const manifestPath = join(OUT_DIR, 'manifest.json');
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestBody) {
      console.error('manifest drifted');
      problems += 1;
    }
    if (problems > 0) process.exit(1);
    console.log(`new templates ok: ${tracks.length} tracks, ${PAIRS.length} pairs`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const track of tracks) {
    writeFileSync(join(OUT_DIR, `${track.trackId}.json`), JSON.stringify(track, null, 2));
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), manifestBody);
  console.log(`wrote ${tracks.length} tracks to ${OUT_DIR}`);
}

main();
