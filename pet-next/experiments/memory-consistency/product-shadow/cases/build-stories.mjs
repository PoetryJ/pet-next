#!/usr/bin/env node
/**
 * 生成 8 个固定故事（事件/补丁/对话脚本）与对应 expected。
 *
 * 预期先于执行写死：本脚本产出 cases/stories.json 与 expected/assertions.json，
 * 再由 expected/manifest.json 记录两者 sha256。跑结果不能回改这里。
 *
 * 用法：node product-shadow/cases/build-stories.mjs [--check]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_CASES = join(HERE, 'stories.json');
const OUT_EXPECTED = join(HERE, '..', 'expected', 'assertions.json');
const OUT_MANIFEST = join(HERE, '..', 'expected', 'manifest.json');

const BUDGET = { utf16: 4000, utf8: 12000 };
const stub = '离线占位回复';

/** 事件构造：与 testing/factory.ts 逐字段同形（时间由 sequence 推导，可复现）。 */
const BASE_TIME = Date.parse('2026-11-10T12:00:00.000Z');

function ev(kind, seq, eventId, extra = {}, source = 'user') {
  return {
    schemaVersion: 'memory-event/v1',
    eventId,
    sessionId: 'sess-shadow',
    sessionEpoch: 1,
    sequence: seq,
    occurredAt: new Date(BASE_TIME + seq * 1000).toISOString(),
    observedAt: new Date(BASE_TIME + seq * 1000 + 5).toISOString(),
    source,
    kind,
    payload: {},
    ...extra,
  };
}

function statement(seq, id, text, subjectKey, valueText) {
  return ev('user.statement', seq, id, {
    payload: {
      text,
      scripted: {
        subjectKey,
        valueText,
        kindHint: subjectKey.startsWith('task:') ? 'task' : 'preference',
      },
    },
  });
}

function taskChanged(seq, id, taskId, revision, change, authority = 'explicit') {
  return ev('task.changed', seq, id, { taskId, taskRevision: revision, payload: { change, authority } }, 'runtime');
}

const note = (noteId, text, sourceEventIds, subjectKey) => ({ noteId, text, sourceEventIds, ...(subjectKey ? { subjectKey } : {}) });

const stories = [
  {
    storyId: 'S1',
    title: '偏好在多轮后被短历史淘汰，重新提问仍需要该证据',
    question: '我周报想要什么格式来着？',
    events: [statement(1, 'e1', '周报要中文，先给草稿。', 'pref:weekly-report', '中文草稿')],
    patches: [
      { patchId: 'p1', buildAtSequence: 1, applyAtSequence: 1, notes: [note('n:pref:weekly-report', '周报偏好：中文、先给草稿', ['e1'], 'pref:weekly-report')] },
    ],
    turns: [
      { user: '今天天气不错', stub },
      { user: '讲个冷笑话', stub },
      { user: '我有点困', stub },
      { user: '推荐一首歌', stub },
      { user: '我周报想要什么格式来着？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e1'],
      mustIncludeText: ['先给草稿'],
      mustNotIncludeText: [],
      mustNotIncludeSourceIds: [],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S2',
    title: '偏好被明确更正，旧值不能作为当前有效记忆',
    question: '周报现在怎么发？',
    events: [
      statement(1, 'e1', '周报先给草稿。', 'pref:weekly-report', '先给草稿'),
      statement(2, 'e2', '改成直接发送。', 'pref:weekly-report', '直接发送'),
    ],
    patches: [
      { patchId: 'p1', buildAtSequence: 1, applyAtSequence: 1, notes: [note('n:pref:weekly-report', '周报偏好：先给草稿', ['e1'], 'pref:weekly-report')] },
      { patchId: 'p2', buildAtSequence: 2, applyAtSequence: 2, notes: [note('n:pref:weekly-report', '周报偏好：直接发送', ['e2'], 'pref:weekly-report')] },
    ],
    turns: [
      { user: '早', stub },
      { user: '周报现在怎么发？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e2'],
      mustIncludeText: ['直接发送'],
      mustNotIncludeText: ['先给草稿'],
      mustNotIncludeSourceIds: ['e1'],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S3',
    title: '待办被撤销，旧 active 承诺不得重新注入',
    question: '周报任务现在什么状态？',
    events: [
      statement(1, 'e1', '记一下周报任务。', 'task:weekly-report', '周报'),
      taskChanged(2, 'e2', 'weekly-report', 1, 'created'),
      taskChanged(3, 'e3', 'weekly-report', 2, 'cancelled'),
    ],
    patches: [
      { patchId: 'p1', buildAtSequence: 2, applyAtSequence: 2, notes: [note('n:task:weekly-report', '周报任务：已创建（created@r1）', ['e2'], 'task:weekly-report')] },
      { patchId: 'p2', buildAtSequence: 3, applyAtSequence: 3, notes: [note('n:task:weekly-report', '周报任务：已撤销（cancelled@r2）', ['e3'], 'task:weekly-report')] },
    ],
    turns: [
      { user: '任务还在吗', stub },
      { user: '周报任务现在什么状态？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e3'],
      mustIncludeText: ['cancelled@r2'],
      mustNotIncludeText: ['created@r1'],
      mustNotIncludeSourceIds: ['e2'],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S4',
    title: '无关偏好更正不误伤另一条仍有效的事实',
    question: '周报要什么格式？',
    events: [
      statement(1, 'e1', '周报先给草稿。', 'pref:weekly-report', '先给草稿'),
      statement(2, 'e2', '签名用简短一点。', 'pref:bio', '简短'),
      statement(3, 'e3', '签名再详细些。', 'pref:bio', '详细'),
    ],
    patches: [
      {
        patchId: 'p1',
        buildAtSequence: 2,
        applyAtSequence: 2,
        notes: [
          note('n:pref:weekly-report', '周报偏好：先给草稿', ['e1'], 'pref:weekly-report'),
          note('n:pref:bio', '签名偏好：简短', ['e2'], 'pref:bio'),
        ],
      },
      { patchId: 'p2', buildAtSequence: 3, applyAtSequence: 3, notes: [note('n:pref:bio', '签名偏好：详细', ['e3'], 'pref:bio')] },
    ],
    turns: [
      { user: '随便聊聊', stub },
      { user: '周报要什么格式？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e1'],
      mustIncludeText: ['先给草稿'],
      mustNotIncludeText: ['签名偏好：简短'],
      mustNotIncludeSourceIds: [],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S5',
    title: 'reset/new session 与 store 关闭重开：长程记忆恢复、epoch 隔离',
    question: '我偏好用什么语言？',
    events: [statement(1, 'e1', '我习惯用中文。', 'pref:language', '中文')],
    patches: [
      { patchId: 'p1', buildAtSequence: 1, applyAtSequence: 1, notes: [note('n:pref:language', '语言偏好：中文', ['e1'], 'pref:language')] },
    ],
    turns: [
      { user: '你好', stub },
      { user: '我偏好用什么语言？', stub },
    ],
    restart: { afterTurn: 0 },
    expect: {
      mustIncludeSourceIds: ['e1'],
      mustIncludeText: ['中文'],
      mustNotIncludeText: [],
      mustNotIncludeSourceIds: [],
      memoryBlock: 'present-in-M',
      restartEquivalent: true,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S6',
    title: '旧笔记补丁在更正后迟到：被拒且最终请求不得使用旧笔记',
    question: '周报怎么发？',
    events: [
      statement(1, 'e1', '周报先给草稿。', 'pref:weekly-report', '先给草稿'),
      statement(2, 'e2', '改成直接发送。', 'pref:weekly-report', '直接发送'),
    ],
    patches: [
      { patchId: 'p1', buildAtSequence: 1, applyAtSequence: 1, notes: [note('n:pref:weekly-report', '周报偏好：先给草稿', ['e1'], 'pref:weekly-report')] },
      { patchId: 'p2', buildAtSequence: 2, applyAtSequence: 2, notes: [note('n:pref:weekly-report', '周报偏好：直接发送', ['e2'], 'pref:weekly-report')] },
      { patchId: 'p3-stale', buildAtSequence: 1, applyAtSequence: 2, notes: [note('n:pref:weekly-report-2', '周报偏好：先给草稿', ['e1'], 'pref:weekly-report')] },
    ],
    turns: [
      { user: '早', stub },
      { user: '周报怎么发？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e2'],
      mustIncludeText: ['直接发送'],
      mustNotIncludeText: ['先给草稿'],
      mustNotIncludeSourceIds: ['e1'],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S7',
    title: '请求被取消：不能推导用户已确认，迟到回复不得恢复旧会话历史',
    question: '我时区设的是哪？',
    events: [statement(1, 'e1', '我在东京。', 'pref:timezone', '东京')],
    patches: [
      { patchId: 'p1', buildAtSequence: 1, applyAtSequence: 1, notes: [note('n:pref:timezone', '时区偏好：东京', ['e1'], 'pref:timezone')] },
    ],
    turns: [
      { user: '这条会被取消，别记进历史', stub, cancel: true },
      { user: '我时区设的是哪？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e1'],
      mustIncludeText: ['东京'],
      mustNotIncludeText: ['这条会被取消'],
      mustNotIncludeSourceIds: [],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
  {
    storyId: 'S8',
    title: '接近预算上限的长来源ID/中文/emoji：两种字节口径合规、来源完整',
    question: '我周报的排版偏好是什么？',
    events: [
      statement(1, 'e-long-source-identifier-0001', '周报用中文排版，标题加粗，数据用表格，附一句总结。', 'pref:weekly-layout', '中文排版+表格'),
      statement(2, 'e-long-source-identifier-0002', `${'无关的长篇背景说明🙂'.repeat(60)}`, 'pref:background', '长背景'),
      statement(3, 'e-long-source-identifier-0003', `${'另一段无关的读书笔记📚'.repeat(60)}`, 'pref:reading', '读书笔记'),
    ],
    patches: [
      {
        patchId: 'p1',
        buildAtSequence: 3,
        applyAtSequence: 3,
        notes: [
          note('n:pref:weekly-layout', '周报排版：中文排版+表格', ['e-long-source-identifier-0001'], 'pref:weekly-layout'),
          note('n:pref:background', `背景说明：${'无关的长篇背景说明🙂'.repeat(200)}`, ['e-long-source-identifier-0002'], 'pref:background'),
          note('n:pref:reading', `读书笔记：${'另一段无关的读书笔记📚'.repeat(200)}`, ['e-long-source-identifier-0003'], 'pref:reading'),
        ],
      },
    ],
    turns: [
      { user: '在吗', stub },
      { user: '聊点别的', stub },
      { user: '今天几号', stub },
      { user: '随便说点什么', stub },
      { user: '我周报的排版偏好是什么？', stub },
    ],
    expect: {
      mustIncludeSourceIds: ['e-long-source-identifier-0001'],
      budgetPressureUtf16: 2000,
      mustIncludeText: ['中文排版+表格'],
      mustNotIncludeText: [],
      mustNotIncludeSourceIds: [],
      memoryBlock: 'present-in-M',
      restartEquivalent: false,
      budget: BUDGET,
    },
  },
];

const payload = { schemaVersion: 'shadow-stories/v1', generatedBy: 'product-shadow/cases/build-stories.mjs', stories };
const expected = {
  schemaVersion: 'shadow-expected/v1',
  writtenBeforeExecution: true,
  note: '先冻结本文件与 stories.json 的 sha256，再运行；结果不能回改。',
  assertions: Object.fromEntries(stories.map((story) => [story.storyId, { title: story.title, question: story.question, expect: story.expect }])),
};

const casesText = `${JSON.stringify(payload, null, 2)}\n`;
const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
const sha = (text) => createHash('sha256').update(text).digest('hex');

if (process.argv.includes('--check')) {
  const okCases = existsSync(OUT_CASES) && readFileSync(OUT_CASES, 'utf8') === casesText;
  const okExpected = existsSync(OUT_EXPECTED) && readFileSync(OUT_EXPECTED, 'utf8') === expectedText;
  const manifest = existsSync(OUT_MANIFEST) ? JSON.parse(readFileSync(OUT_MANIFEST, 'utf8')) : null;
  const okManifest =
    manifest !== null && manifest.storiesSha256 === sha(casesText) && manifest.expectedSha256 === sha(expectedText);
  process.stdout.write(`${okCases && okExpected && okManifest ? 'OK' : 'DRIFT'} cases=${okCases} expected=${okExpected} manifest=${okManifest}\n`);
  process.exit(okCases && okExpected && okManifest ? 0 : 1);
}

writeFileSync(OUT_CASES, casesText, 'utf8');
writeFileSync(OUT_EXPECTED, expectedText, 'utf8');
writeFileSync(
  OUT_MANIFEST,
  `${JSON.stringify(
    {
      schemaVersion: 'shadow-expected-manifest/v1',
      storiesSha256: sha(casesText),
      expectedSha256: sha(expectedText),
      count: stories.length,
      budget: BUDGET,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
process.stdout.write(`wrote ${stories.length} stories\n`);
