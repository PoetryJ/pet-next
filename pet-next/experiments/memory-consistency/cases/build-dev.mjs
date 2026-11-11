#!/usr/bin/env node
/**
 * 开发契约集构建器：4 类 × 6 对 = 24 对 / 48 条轨迹。
 *
 * 每对的两个变体只翻转一个预定关键条件（见 keyCondition）。
 * 这里只产出「输入」：原始事件 + 补丁草稿（不含依赖版本，由 harness 从权威状态重算）。
 * 期望标签由 eval/expected/dev.json 独立持有，构建器不读它、也不写它。
 *
 * 用法：
 *   node experiments/memory-consistency/cases/build-dev.mjs            # 写入 cases/dev/
 *   node experiments/memory-consistency/cases/build-dev.mjs --check    # 只校验现有文件与生成结果一致
 *
 * @module pet-next/experiments/memory-consistency/cases/build-dev
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'dev');
const BASE_TIME = Date.UTC(2026, 10, 10, 12, 0, 0);
const SESSION = 'sess-dev';

/** 事件构造：sequence 由数组位置决定，eventId 默认 e<sequence>。 */
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
const tool = (outcome, toolName = 'write_file', extra = {}) => ev('tool.result', { toolName, outcome }, { source: 'runtime', ...extra });
const task = (change, authority, extra = {}) => ev('task.changed', { change, authority }, { source: 'runtime', ...extra });
const cancel = (extra = {}) => ev('request.cancelled', { reason: 'user_cancel' }, extra);
const reset = (extra = {}) => ev('session.reset', { reason: 'new_session' }, extra);

/**
 * 24 对定义。build(flip) 返回 { events, patches }。
 * flip=true 取 v2（翻转），false 取 v1。
 */
const PAIRS = [
  // ── A 类：状态更新 ───────────────────────────────────────────────
  {
    pairId: 'A1',
    cls: 'state-update',
    keyCondition: 'task.changed.authority（explicit vs scripted-candidate）',
    build(flip) {
      return {
        events: [
          statement('把周报整理一下。', 'task:weekly-report'),
          task('created', 'explicit', { taskId: 'weekly-report', taskRevision: 1 }),
          // 这句只作为原话证据，不带脚本抽取：本对唯一的翻转点必须落在 authority 上。
          statement('算了别做了。'),
          task('cancelled', flip ? 'scripted-candidate' : 'explicit', {
            taskId: 'weekly-report',
            taskRevision: 2,
          }),
        ],
        patches: [
          {
            buildAtSequence: 2,
            applyAtSequence: 2,
            notesToUpsert: [note('n1', '周报任务进行中', ['e1', 'e2'], 'task:weekly-report')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'A2',
    cls: 'state-update',
    keyCondition: '第二条陈述的 subjectKey（同一偏好 vs 无关偏好）',
    build(flip) {
      return {
        events: [
          statement('以后周报先给草稿。', 'pref:weekly-report', '先给草稿'),
          statement(flip ? '签名改短一点。' : '周报直接发出去吧。', flip ? 'pref:bio' : 'pref:weekly-report', flip ? '简短' : '直接发送'),
        ],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')],
            notesToInvalidate: [],
          },
          {
            buildAtSequence: 2,
            applyAtSequence: 2,
            notesToUpsert: [
              flip
                ? note('n2', '签名要简短', ['e2'], 'pref:bio')
                : note('n2', '周报直接发送', ['e2'], 'pref:weekly-report'),
            ],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'A3',
    cls: 'state-update',
    keyCondition: '补丁构建后新增事件是否触及同一 subject',
    build(flip) {
      return {
        events: [
          statement('以后周报先给草稿。', 'pref:weekly-report', '先给草稿'),
          statement(flip ? '周报直接发。' : '签名改短。', flip ? 'pref:weekly-report' : 'pref:bio', flip ? '直接发送' : '简短'),
        ],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 2,
            notesToUpsert: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'A4',
    cls: 'state-update',
    keyCondition: '复用 requestId 的代际（同 epoch vs 跨 epoch）',
    build(flip) {
      return {
        events: flip
          ? [
              generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
              reset(),
              presented('ui', { requestId: 'req-1', responseId: 'resp-1', sessionEpoch: 2 }),
            ]
          : [
              generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
              presented('ui', { requestId: 'req-1', responseId: 'resp-1' }),
            ],
        patches: [],
      };
    },
  },
  {
    pairId: 'A5',
    cls: 'state-update',
    keyCondition: '第四条事件的种类（session.reset vs task.changed cancelled）',
    build(flip) {
      return {
        events: [
          statement('以后都用中文。', 'pref:language', '中文'),
          task('created', 'explicit', { taskId: 'weekly-report', taskRevision: 1 }),
          task('created', 'explicit', { taskId: 'monthly-report', taskRevision: 1 }),
          flip
            ? task('cancelled', 'explicit', { taskId: 'weekly-report', taskRevision: 2 })
            : reset(),
        ],
        patches: [
          {
            buildAtSequence: 3,
            applyAtSequence: 3,
            notesToUpsert: [
              note('n1', '语言偏好：中文', ['e1'], 'pref:language'),
              note('n2', '周报任务进行中', ['e2'], 'task:weekly-report'),
              note('n3', '月报任务进行中', ['e3'], 'task:monthly-report'),
            ],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'A6',
    cls: 'state-update',
    keyCondition: '第四条事件的种类（request.cancelled vs task.changed cancelled）',
    build(flip) {
      return {
        events: [
          statement('整理周报。', 'task:weekly-report'),
          task('created', 'explicit', { taskId: 'weekly-report', taskRevision: 1 }),
          generated('草稿如下……', { requestId: 'req-1', responseId: 'resp-1' }),
          flip
            ? task('cancelled', 'explicit', { taskId: 'weekly-report', taskRevision: 2 })
            : cancel({ requestId: 'req-1' }),
        ],
        patches: [
          {
            buildAtSequence: 3,
            applyAtSequence: 3,
            notesToUpsert: [note('n1', '周报任务进行中', ['e1', 'e2'], 'task:weekly-report')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },

  // ── B 类：生成与呈现 ────────────────────────────────────────────
  {
    pairId: 'B1',
    cls: 'generation-presentation',
    keyCondition: '是否观察到 response.presented',
    build(flip) {
      return {
        events: flip
          ? [generated('好的。', { requestId: 'req-1', responseId: 'resp-1' })]
          : [
              generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
              presented('ui', { requestId: 'req-1', responseId: 'resp-1' }),
            ],
        patches: [],
      };
    },
  },
  {
    pairId: 'B2',
    cls: 'generation-presentation',
    keyCondition: '是否观察到用户确认',
    build(flip) {
      return {
        events: [
          generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
          presented('ui', { requestId: 'req-1', responseId: 'resp-1' }),
          ...(flip ? [ack('seen', { requestId: 'req-1', responseId: 'resp-1' })] : []),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'B3',
    cls: 'generation-presentation',
    keyCondition: '确认指向的 responseId（真实回答 vs 不存在回答）',
    build(flip) {
      return {
        events: [
          generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
          generated('补充一句。', { requestId: 'req-1', responseId: 'resp-2' }),
          ack('seen', { requestId: 'req-1', responseId: flip ? 'resp-9' : 'resp-1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'B4',
    cls: 'generation-presentation',
    keyCondition: '重发同一 eventId 时载荷是否一致',
    build(flip) {
      return {
        events: [
          generated('好的。', { requestId: 'req-1', responseId: 'resp-1', id: 'e1' }),
          generated(flip ? '换了一句话。' : '好的。', { requestId: 'req-1', responseId: 'resp-1', id: 'e1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'B5',
    cls: 'generation-presentation',
    keyCondition: '关闭代际后到达的事件是结清还是新事实',
    build(flip) {
      return {
        events: [
          generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
          reset(),
          flip
            ? statement('以后都用中文。', 'pref:language', '中文')
            : presented('ui', { requestId: 'req-1', responseId: 'resp-1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'B6',
    cls: 'generation-presentation',
    keyCondition: '第二段内容是新回答还是同一回答的呈现',
    build(flip) {
      return {
        events: [
          generated('好的。', { requestId: 'req-1', responseId: 'resp-1' }),
          flip
            ? presented('ui', { requestId: 'req-1', responseId: 'resp-1' })
            : generated('补充一句。', { requestId: 'req-1', responseId: 'resp-2' }),
        ],
        patches: [],
      };
    },
  },

  // ── C 类：工具结果 ──────────────────────────────────────────────
  {
    pairId: 'C1',
    cls: 'tool-result',
    keyCondition: '工具结算是 ok 还是 error',
    build(flip) {
      return {
        events: [
          generated('我来写文件。', { requestId: 'req-1', responseId: 'resp-1' }),
          presented('ui', { requestId: 'req-1', responseId: 'resp-1' }),
          tool(flip ? 'error' : 'ok', 'write_file', { requestId: 'req-1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'C2',
    cls: 'tool-result',
    keyCondition: '第三条是工具结算还是用户确认',
    build(flip) {
      return {
        events: [
          generated('我来写文件。', { requestId: 'req-1', responseId: 'resp-1' }),
          presented('ui', { requestId: 'req-1', responseId: 'resp-1' }),
          flip
            ? ack('seen', { requestId: 'req-1', responseId: 'resp-1' })
            : tool('ok', 'write_file', { requestId: 'req-1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'C3',
    cls: 'tool-result',
    keyCondition: '未知工具结果之后是否被改判',
    build(flip) {
      return {
        events: [
          tool('unknown', 'shell', { requestId: 'req-1' }),
          ...(flip ? [tool('ok', 'shell', { requestId: 'req-1' })] : []),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'C4',
    cls: 'tool-result',
    keyCondition: '第四条取消的是请求还是任务',
    build(flip) {
      return {
        events: [
          statement('整理周报。', 'task:weekly-report'),
          task('created', 'explicit', { taskId: 'weekly-report', taskRevision: 1 }),
          generated('开始整理。', { requestId: 'req-1', responseId: 'resp-1' }),
          flip ? task('cancelled', 'explicit', { taskId: 'weekly-report', taskRevision: 2 }) : cancel({ requestId: 'req-1' }),
          tool('ok', 'write_file', { requestId: 'req-1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'C5',
    cls: 'tool-result',
    keyCondition: '重复工具结果是否同载荷',
    build(flip) {
      return {
        events: [
          tool('ok', 'shell', { requestId: 'req-1', id: 'e1' }),
          flip ? tool('error', 'shell', { requestId: 'req-1' }) : tool('ok', 'shell', { requestId: 'req-1', id: 'e1' }),
        ],
        patches: [],
      };
    },
  },
  {
    pairId: 'C6',
    cls: 'tool-result',
    keyCondition: '工具结果落在原代际还是新代际',
    build(flip) {
      return {
        events: flip
          ? [
              generated('开始整理。', { requestId: 'req-1', responseId: 'resp-1' }),
              reset(),
              tool('ok', 'shell', { requestId: 'req-1', sessionEpoch: 2 }),
            ]
          : [
              generated('开始整理。', { requestId: 'req-1', responseId: 'resp-1' }),
              tool('ok', 'shell', { requestId: 'req-1' }),
            ],
        patches: [],
      };
    },
  },

  // ── D 类：后台旧补丁并发回写 ────────────────────────────────────
  {
    pairId: 'D1',
    cls: 'stale-patch',
    keyCondition: '第二个补丁的构建时刻（取消前 vs 取消后）',
    build(flip) {
      return {
        events: [
          statement('整理周报。', 'task:weekly-report'),
          task('created', 'explicit', { taskId: 'weekly-report', taskRevision: 1 }),
          task('cancelled', 'explicit', { taskId: 'weekly-report', taskRevision: 2 }),
        ],
        patches: [
          {
            buildAtSequence: 2,
            applyAtSequence: 2,
            notesToUpsert: [note('n1', '周报任务进行中', ['e1', 'e2'], 'task:weekly-report')],
            notesToInvalidate: [],
          },
          {
            buildAtSequence: flip ? 3 : 2,
            notesToUpsert: [note('n2', '周报任务已取消', ['e1', 'e3'], 'task:weekly-report')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'D2',
    cls: 'stale-patch',
    keyCondition: '补丁构建时是否已看到同 subject 的新陈述',
    build(flip) {
      return {
        events: [
          statement('以后周报先给草稿。', 'pref:weekly-report', '先给草稿'),
          statement('周报直接发。', 'pref:weekly-report', '直接发送'),
        ],
        patches: [
          {
            buildAtSequence: flip ? 2 : 1,
            applyAtSequence: 2,
            notesToUpsert: [note('n1', '周报处理方式', ['e1'], 'pref:weekly-report')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'D3',
    cls: 'stale-patch',
    keyCondition: '提交声明里是否包含 subject 依赖',
    build(flip) {
      return {
        events: [statement('以后周报先给草稿。', 'pref:weekly-report', '先给草稿')],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')],
            notesToInvalidate: [],
            dropSubjectDependency: flip,
          },
        ],
      };
    },
  },
  {
    pairId: 'D4',
    cls: 'stale-patch',
    keyCondition: '补丁内父笔记是否成环',
    build(flip) {
      return {
        events: [statement('整理周报。', 'task:weekly-report')],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: flip
              ? [
                  note('na', 'A', ['e1'], undefined, ['nb']),
                  note('nb', 'B', ['e1'], undefined, ['na']),
                ]
              : [
                  note('na', 'A', ['e1'], undefined, ['nb']),
                  note('nb', 'B', ['e1'], undefined, ['nc']),
                  note('nc', 'C', ['e1']),
                ],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'D5',
    cls: 'stale-patch',
    keyCondition: '同 opId 重发时载荷是否一致',
    build(flip) {
      return {
        events: [statement('以后周报先给草稿。', 'pref:weekly-report', '先给草稿')],
        patches: [
          {
            buildAtSequence: 1,
            applyAtSequence: 1,
            notesToUpsert: [note('n1', '周报先给草稿', ['e1'], 'pref:weekly-report')],
            notesToInvalidate: [],
          },
          {
            buildAtSequence: 1,
            reusePriorOpId: 0,
            notesToUpsert: [note('n1', flip ? '周报直接发送' : '周报先给草稿', ['e1'], 'pref:weekly-report')],
            notesToInvalidate: [],
          },
        ],
      };
    },
  },
  {
    pairId: 'D6',
    cls: 'stale-patch',
    keyCondition: '笔记来源事件是否存在',
    build(flip) {
      return {
        events: [statement('以后周报先给草稿。', 'pref:weekly-report', '先给草稿')],
        patches: [
          {
            buildAtSequence: 1,
            notesToUpsert: [
              note('n1', '周报先给草稿', [flip ? 'e9' : 'e1'], 'pref:weekly-report'),
            ],
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
    const occurredAt = new Date(BASE_TIME + sequence * 60_000).toISOString();
    return {
      schemaVersion: 'memory-event/v1',
      eventId: spec.id ?? `e${sequence}`,
      sessionId: SESSION,
      sessionEpoch: spec.sessionEpoch ?? 1,
      sequence,
      occurredAt,
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
    note: '输入轨迹；期望标签独立存放于 eval/expected/dev.json，策略输入不含 pairId/类别/期望。',
    events,
    patches: (raw.patches ?? []).map((spec, index) => ({
      // 补丁 id 不嵌轨迹名：名字属于评分标签，不能出现在策略可见状态里。
      patchId: `p${index + 1}`,
      buildAtSequence: spec.buildAtSequence,
      applyAtSequence: spec.applyAtSequence ?? null,
      reusePriorOpId: spec.reusePriorOpId ?? null,
      dropSubjectDependency: spec.dropSubjectDependency ?? false,
      notesToUpsert: spec.notesToUpsert,
      notesToInvalidate: spec.notesToInvalidate,
    })),
  };
}

function buildAll() {
  const tracks = [];
  for (const pair of PAIRS) {
    tracks.push(materialize(pair, false));
    tracks.push(materialize(pair, true));
  }
  return tracks;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function main() {
  const check = process.argv.includes('--check');
  const tracks = buildAll();
  const manifest = {
    schemaVersion: 'memory-case-manifest/v1',
    generatedBy: 'cases/build-dev.mjs',
    counts: {
      pairs: PAIRS.length,
      tracks: tracks.length,
      byClass: Object.fromEntries(
        ['state-update', 'generation-presentation', 'tool-result', 'stale-patch'].map((cls) => [
          cls,
          tracks.filter((track) => track.class === cls).length,
        ]),
      ),
    },
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
      if (!existsSync(path)) {
        console.error(`missing: ${track.trackId}.json`);
        problems += 1;
        continue;
      }
      const actual = readFileSync(path, 'utf8');
      if (actual !== JSON.stringify(track, null, 2)) {
        console.error(`drifted: ${track.trackId}.json`);
        problems += 1;
      }
    }
    const existing = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((name) => name.endsWith('.json')) : [];
    if (existing.length !== tracks.length + 1) {
      console.error(`file count ${existing.length} != ${tracks.length + 1}`);
      problems += 1;
    }
    const manifestPath = join(OUT_DIR, 'manifest.json');
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestBody) {
      console.error('manifest drifted');
      problems += 1;
    }
    if (problems > 0) {
      console.error(`git-check failed: ${problems} problem(s)`);
      process.exit(1);
    }
    console.log(`cases ok: ${tracks.length} tracks, ${PAIRS.length} pairs`);
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
