/**
 * R3 接线层测试：只证明装配、预算与捕获正确，不评价回答质量。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MESSAGE_BUDGET, MEMORY_FOOTER, MEMORY_HEADER, QUESTION_MARKER, bigrams, buildMemoryBlock, composeUserText, relevanceScore, selectNotes, trimToBudget } from './adapter.ts';
import { createCaptureHarness, STUB_REPLY } from './capture.ts';
import { runStory, productSourceHashes } from './runner.ts';
import { scoreStory, visibleText } from './score.ts';
import type { StoryFile } from './contracts.ts';
import { emptyState, type MemoryState, type Note } from '../contracts.ts';

function note(id: string, text: string, subject: string, status: 'active' | 'invalidated' = 'active'): Note {
  return {
    noteId: id,
    text,
    sourceEventIds: [`${id}-e`],
    parentNoteIds: [],
    dependencyVersions: {},
    status,
    generator: 'scripted',
    subjectKey: subject,
    version: 1,
    createdByOpId: 'op-1',
    ...(status === 'invalidated' ? { invalidationReason: 'test' } : {}),
  };
}

function stateWith(notes: Note[]): MemoryState {
  return { ...emptyState(), notes: Object.fromEntries(notes.map((item) => [item.noteId, item])) };
}

const tinyStory: StoryFile = {
  storyId: 'T1',
  title: '测试用最小故事',
  question: '周报要什么格式？',
  events: [],
  patches: [],
  turns: [{ user: '你好', stub: STUB_REPLY }],
  expect: {
    finalTurnIndex: 0,
    finalQuestion: '你好',
    mustIncludeSourceIds: [],
    mustIncludeText: [],
    mustNotIncludeText: [],
    mustNotIncludeSourceIds: [],
    memoryBlock: 'present-in-M',
    restartEquivalent: false,
    budget: MESSAGE_BUDGET,
  },
};

describe('R3 记忆装配', () => {
  test('二元组与相关性：中文问题能命中中文笔记，无关笔记分数为 0', () => {
    assert.ok(bigrams('周报要什么格式').has('周报'));
    const relevant = note('n1', '周报偏好：中文草稿', 'pref:weekly-report');
    const unrelated = note('n2', '读书笔记：今天读了一本书', 'pref:reading');
    assert.ok(relevanceScore('周报要什么格式', relevant) > 0);
    assert.equal(relevanceScore('周报要什么格式', unrelated), 0);
  });

  test('只选 active 笔记；invalidated 记 dropped 且理由可见', () => {
    const state = stateWith([
      note('n1', '周报偏好：中文草稿', 'pref:weekly-report'),
      note('n2', '周报偏好：旧值', 'pref:weekly-report', 'invalidated'),
    ]);
    const selection = selectNotes(state, '周报要什么格式');
    assert.deepEqual(selection.selected.map((item) => item.noteId), ['n1']);
    const dropped = selection.records.find((item) => item.noteId === 'n2');
    assert.equal(dropped?.selected, false);
    assert.equal(dropped?.reason, 'invalidated');
  });

  test('记忆块格式：显式标记非用户发言、携带 sourceIds 与版本、问题逐字保留', () => {
    const state = stateWith([note('n1', '周报偏好：中文草稿', 'pref:weekly-report')]);
    const block = buildMemoryBlock(selectNotes(state, '周报格式').selected);
    assert.ok(block.startsWith(MEMORY_HEADER));
    assert.ok(block.endsWith(MEMORY_FOOTER));
    assert.match(block, /sourceIds: n1-e/);
    const userText = composeUserText(block, '周报要什么格式？');
    assert.ok(userText.endsWith(`${QUESTION_MARKER}\n周报要什么格式？`));
  });

  test('预算按「先丢最老历史、再丢最低分笔记」裁剪；裁不动则显式失败', () => {
    const longNote = note('n-long', `周报${'很长的说明'.repeat(400)}`, 'pref:weekly-report');
    const state = stateWith([longNote]);
    const history = [
      { user: '早', assistant: '早' },
      { user: '午', assistant: '午' },
    ];
    const trimmed = trimToBudget('周报', history, selectNotes(state, '周报').selected, { utf16: 1200, utf8: 3600 });
    assert.ok(trimmed.measured.utf16 <= 1200);
    assert.ok(trimmed.droppedHistory > 0 || trimmed.droppedNotes.length > 0);
    assert.throws(() => trimToBudget('超'.repeat(500), [], [], { utf16: 100, utf8: 300 }), /budget exceeded/);
  });
});

describe('R3 捕获与哨兵', () => {
  test('捕获桩记录请求体并返回固定占位回复', async () => {
    const harness = createCaptureHarness();
    const response = await harness.fetchImpl('http://127.0.0.1:9/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, STUB_REPLY);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0]?.messages[0]?.content, 'hi');
    assert.equal(harness.stats.realNetworkCalls, 0);
  });

  test('哨兵：真实 fetch 被拒绝并计数，还原后恢复', async () => {
    const harness = createCaptureHarness();
    const restore = harness.installSentinel();
    try {
      await assert.rejects(async () => {
        await (globalThis.fetch as unknown as (input: string) => Promise<unknown>)('https://example.com');
      }, /network sentinel/);
      assert.equal(harness.stats.realNetworkCalls, 1);
    } finally {
      restore();
    }
  });
});

describe('R3 真实路径回放', () => {
  test('M 臂注入记忆块、H 臂没有；两臂都走产品 provider 且真实网络为 0', async () => {
    const story: StoryFile = {
      ...tinyStory,
      events: [
        {
          schemaVersion: 'memory-event/v1',
          eventId: 'e1',
          sessionId: 'sess-t',
          sessionEpoch: 1,
          sequence: 1,
          occurredAt: '2026-11-10T12:00:01.000Z',
          observedAt: '2026-11-10T12:00:01.005Z',
          source: 'user',
          kind: 'user.statement',
          payload: { text: '周报要中文草稿', scripted: { subjectKey: 'pref:weekly-report', valueText: '中文草稿', kindHint: 'preference' } },
        },
      ],
      patches: [
        {
          patchId: 'p1',
          buildAtSequence: 1,
          applyAtSequence: 1,
          notes: [{ noteId: 'n:pref:weekly-report', text: '周报偏好：中文草稿', sourceEventIds: ['e1'], subjectKey: 'pref:weekly-report' }],
        },
      ],
      turns: [{ user: '周报要什么格式？', stub: STUB_REPLY }],
    };
    const h = await runStory(story, 'H', 'run-t');
    const m = await runStory(story, 'M', 'run-t');
    assert.equal(h.realNetworkCalls, 0);
    assert.equal(h.stubCalls, 1);
    assert.equal(m.stubCalls, 1);
    assert.equal(visibleText(h).includes(MEMORY_HEADER), false);
    assert.equal(visibleText(m).includes(MEMORY_HEADER), true);
    // 请求体是产品 provider 序列化的：system 必须来自产品常量。
    const body = JSON.parse(m.requests[0]?.bodyText ?? '{}') as { messages: { role: string; content: string }[] };
    assert.equal(body.messages[0]?.role, 'system');
    assert.ok((body.messages[0]?.content ?? '').includes('桌面宠物'));
    // 源码指纹覆盖产品文件。
    assert.ok(Object.keys(productSourceHashes()).length >= 5);
  });

  test('评分读回真实消息：把记忆块删掉后断言必须失败', async () => {
    const story: StoryFile = {
      ...tinyStory,
      events: [],
      patches: [],
      turns: [{ user: '你好', stub: STUB_REPLY }],
      expect: { ...tinyStory.expect, mustIncludeText: ['不存在的证据'] },
    };
    const run = await runStory(story, 'M', 'run-x');
    const results = scoreStory('T1', story.expect, [run]);
    assert.ok(results.some((item) => item.id === 'required-text-visible' && !item.ok));
  });
});

describe('R3.1 F1 目标轮身份与失败传播', () => {
  // 两轮：轮 0 成功、轮 1 失败。旧评分取末项，轮 1 无请求时会回退到轮 0 的请求并假通过；
  // 新评分必须按 finalTurnIndex=1 判定失败，且保留产品错误码。
  const twoTurn: StoryFile = {
    ...tinyStory,
    storyId: 'N1',
    turns: [
      { user: '你好', stub: STUB_REPLY },
      { user: '周报要什么格式？', stub: STUB_REPLY },
    ],
    expect: { ...tinyStory.expect, finalTurnIndex: 1, finalQuestion: '周报要什么格式？' },
  };

  test('501 字最终轮：产品拒绝，评分必须失败且带 too-long 码，先前的成功请求不得掩盖', async () => {
    const tooLong = { ...twoTurn, turns: [twoTurn.turns[0]!, { user: '超'.repeat(501), stub: STUB_REPLY }] };
    const h = await runStory(tooLong, 'H', 'run-n1');
    const m = await runStory(tooLong, 'M', 'run-n1');
    const results = scoreStory('N1', tooLong.expect, [h, m]);
    const failedIds = results.filter((item) => !item.ok).map((item) => `${item.armId}:${item.id}`);
    assert.ok(failedIds.includes('H:target-turn-requested'), `missing H:target-turn-requested in ${failedIds.join(',')}`);
    assert.ok(failedIds.includes('M:target-turn-requested'), 'M target request must be missing');
    const okTurn = results.find((item) => item.armId === 'M' && item.id === 'target-turn-ok');
    assert.equal(okTurn?.ok, false);
    assert.equal((okTurn?.actual as { code?: string | null } | undefined)?.code, 'too-long');
  });

  test('最终轮缺失：评分必须失败（不允许回退到上一轮请求）', async () => {
    const truncated = { ...twoTurn, turns: twoTurn.turns.slice(0, 1) };
    const h = await runStory(truncated, 'H', 'run-n2');
    const m = await runStory(truncated, 'M', 'run-n2');
    const results = scoreStory('N1', truncated.expect, [h, m]);
    assert.ok(results.some((item) => item.id === 'target-turn-requested' && !item.ok));
    assert.ok(results.some((item) => item.id === 'target-turn-ok' && !item.ok));
  });

  test('最终轮取消：status=cancelled，未列入 allowedNonOkTurns 时 fail', async () => {
    const cancelled = { ...twoTurn, turns: [twoTurn.turns[0]!, { ...twoTurn.turns[1]!, cancel: true }] };
    const h = await runStory(cancelled, 'H', 'run-n3');
    const m = await runStory(cancelled, 'M', 'run-n3');
    const results = scoreStory('N1', cancelled.expect, [h, m]);
    assert.ok(results.some((item) => item.id === 'target-turn-ok' && item.actual && (item.actual as { status?: string }).status === 'cancelled'));
    assert.ok(results.some((item) => item.id === 'turns-sound' && !item.ok));
  });

  test('指定的预期取消（allowedNonOkTurns）不算意外失败', async () => {
    const expectedCancel: StoryFile = {
      ...twoTurn,
      expect: { ...twoTurn.expect, allowedNonOkTurns: [{ turnIndex: 1, status: 'cancelled' }] },
    };
    const h = await runStory({ ...twoTurn, turns: [twoTurn.turns[0]!, { ...twoTurn.turns[1]!, cancel: true }] }, 'H', 'run-n4');
    const m = await runStory({ ...twoTurn, turns: [twoTurn.turns[0]!, { ...twoTurn.turns[1]!, cancel: true }] }, 'M', 'run-n4');
    const results = scoreStory('N1', expectedCancel.expect, [h, m]);
    const sound = results.filter((item) => item.id === 'turns-sound');
    assert.ok(sound.every((item) => item.ok), 'allowed cancellation must not be flagged as unexpected');
  });

  test('provider 抛错：目标轮 error 且带 provider-error 码', async () => {
    const h = await runStory(twoTurn, 'H', 'run-n5', { providerFailAtTurn: 1 });
    const m = await runStory(twoTurn, 'M', 'run-n5', { providerFailAtTurn: 1 });
    const results = scoreStory('N1', twoTurn.expect, [h, m]);
    const okTurn = results.find((item) => item.armId === 'M' && item.id === 'target-turn-ok');
    assert.equal(okTurn?.ok, false);
    assert.equal((okTurn?.actual as { code?: string | null } | undefined)?.code, 'provider-error');
    assert.equal(h.realNetworkCalls, 0);
  });
});

describe('R3.1 F2 真实写入与淘汰', () => {
  test('偏好经真实会话进入历史，再被四轮上限挤出：entered-history 通过、dropped-from-final-history 通过', async () => {
    const story: StoryFile = {
      ...tinyStory,
      storyId: 'N2',
      turns: [
        { user: '周报要中文，先给草稿。', stub: STUB_REPLY },
        { user: '今天天气不错', stub: STUB_REPLY },
        { user: '讲个冷笑话', stub: STUB_REPLY },
        { user: '我有点困', stub: STUB_REPLY },
        { user: '推荐一首歌', stub: STUB_REPLY },
        { user: '我周报想要什么格式来着？', stub: STUB_REPLY },
      ],
      expect: {
        ...tinyStory.expect,
        finalTurnIndex: 5,
        finalQuestion: '我周报想要什么格式来着？',
        turnMustIncludeText: [{ turnIndex: 1, text: '周报要中文，先给草稿。' }],
        finalHistoryMustExcludeText: ['周报要中文，先给草稿。'],
      },
    };
    const h = await runStory(story, 'H', 'run-f2');
    const m = await runStory(story, 'M', 'run-f2');
    const results = scoreStory('N2', story.expect, [h, m]);
    const entered = results.filter((item) => item.id.startsWith('entered-history'));
    const dropped = results.filter((item) => item.id === 'dropped-from-final-history');
    assert.ok(entered.length === 2 && entered.every((item) => item.ok), 'preference must be visible in turn-1 request');
    assert.ok(dropped.length === 2 && dropped.every((item) => item.ok), 'preference must be dropped from final history');
    // 若把偏好轮从会话中删掉（只留寒暄），entered-history 必须失败——证明断言真在检查写入。
    const withoutFirst = { ...story, expect: { ...story.expect, turnMustIncludeText: [{ turnIndex: 1, text: '周报要中文，先给草稿。' }] }, turns: [{ ...story.turns[0]!, user: '今天天气不错' }, ...story.turns.slice(1)] };
    const h2 = await runStory(withoutFirst, 'H', 'run-f2b');
    const m2 = await runStory(withoutFirst, 'M', 'run-f2b');
    const results2 = scoreStory('N2', withoutFirst.expect, [h2, m2]);
    assert.ok(results2.some((item) => item.id.startsWith('entered-history') && !item.ok), 'entered-history must fail when preference never entered history');
  });
});
