/**
 * 独立评分：只读捕获到的 provider 请求，不看内部 compile 文本。
 *
 * 指标（见 SPEC 七）：必要证据可见、过期来源未当选、重启等价、预算合规、
 * stub 尝试与真实网络次数。不评价固定回复文本，不算「答案准确率」。
 *
 * @module pet-next/experiments/memory-consistency/product-shadow/score
 */
import { MEMORY_HEADER, MEMORY_FOOTER } from './adapter.ts';
import type { ArmId, AssertionResult, StoryExpectation, StoryRun } from './contracts.ts';

/** 把一条请求的全部 message 内容拼起来（只用于查来源/文本是否可见）。 */
export function visibleText(run: StoryRun, index = -1): string {
  const request = index < 0 ? run.requests[run.requests.length - 1] : run.requests[index];
  if (request === undefined) return '';
  return request.messages.map((message) => message.content).join('\n');
}

/** 最后一轮请求；没有则 undefined。 */
export function finalRequest(run: StoryRun) {
  return run.requests[run.requests.length - 1];
}

function hit(text: string, needle: string): boolean {
  return needle !== '' && text.includes(needle);
}

/** 对一个故事的两臂求断言。 */
export function scoreStory(storyId: string, expectation: StoryExpectation, runs: readonly StoryRun[]): AssertionResult[] {
  const out: AssertionResult[] = [];
  const m = runs.find((run) => run.armId === 'M');
  const h = runs.find((run) => run.armId === 'H');
  const mText = m === undefined ? '' : visibleText(m);
  const hText = h === undefined ? '' : visibleText(h);

  const push = (arm: ArmId, id: string, ok: boolean, expected: unknown, actual: unknown, note?: string): void => {
    out.push({ storyId, armId: arm, id, ok, expected, actual, ...(note === undefined ? {} : { note }) });
  };

  push(
    'M',
    'required-sources-visible',
    expectation.mustIncludeSourceIds.every((sourceId) => hit(mText, sourceId)),
    expectation.mustIncludeSourceIds,
    expectation.mustIncludeSourceIds.filter((sourceId) => !hit(mText, sourceId)),
  );
  push(
    'M',
    'required-text-visible',
    expectation.mustIncludeText.every((text) => hit(mText, text)),
    expectation.mustIncludeText,
    expectation.mustIncludeText.filter((text) => !hit(mText, text)),
  );
  push(
    'M',
    'stale-text-not-current',
    expectation.mustNotIncludeText.every((text) => !hit(mText, text)),
    `absent: ${expectation.mustNotIncludeText.join('|')}`,
    expectation.mustNotIncludeText.filter((text) => hit(mText, text)),
  );
  push(
    'H',
    'stale-text-not-current',
    expectation.mustNotIncludeText.every((text) => !hit(hText, text)),
    `absent: ${expectation.mustNotIncludeText.join('|')}`,
    expectation.mustNotIncludeText.filter((text) => hit(hText, text)),
  );
  push(
    'M',
    'stale-sources-not-current',
    expectation.mustNotIncludeSourceIds.every((sourceId) => !hit(mText, sourceId)),
    `absent: ${expectation.mustNotIncludeSourceIds.join('|')}`,
    expectation.mustNotIncludeSourceIds.filter((sourceId) => hit(mText, sourceId)),
  );
  push(
    'H',
    'no-memory-block',
    !hit(hText, MEMORY_HEADER) && !hit(hText, MEMORY_FOOTER),
    'absent',
    hit(hText, MEMORY_HEADER) ? 'memory header leaked into H' : 'ok',
  );
  push(
    'M',
    'memory-block-present',
    hit(mText, MEMORY_HEADER) && hit(mText, MEMORY_FOOTER),
    'header+footer',
    { header: hit(mText, MEMORY_HEADER), footer: hit(mText, MEMORY_FOOTER) },
  );

  const budgetOk = (run: StoryRun | undefined) =>
    run !== undefined &&
    run.requests.every((request) => request.utf16 <= expectation.budget.utf16 && request.utf8 <= expectation.budget.utf8);
  for (const run of runs) {
    push(
      run.armId,
      'budget-compliant',
      budgetOk(run),
      expectation.budget,
      run.requests.map((request) => ({ utf16: request.utf16, utf8: request.utf8 })),
    );
  }

  for (const run of runs) {
    push(run.armId, 'no-real-network', run.realNetworkCalls === 0, 0, run.realNetworkCalls);
    push(run.armId, 'stub-attempts-counted', run.stubCalls >= 1, '>=1', run.stubCalls);
  }

  if (expectation.budgetPressureUtf16 !== undefined) {
    const last = m === undefined ? undefined : finalRequest(m);
    push(
      'M',
      'budget-pressure-exercised',
      last !== undefined && last.utf16 >= expectation.budgetPressureUtf16,
      `utf16>=${expectation.budgetPressureUtf16}`,
      last?.utf16 ?? null,
    );
    const trimmed = m === undefined ? [] : m.trims.filter((item) => item.droppedNotes.length > 0 || item.droppedHistory > 0);
    push('M', 'budget-trimming-recorded', trimmed.length > 0, '>=1 trim', trimmed.length);
  }

  if (expectation.restartEquivalent) {
    for (const run of runs) {
      const before = run.fingerprints.find((item) => item.at.startsWith('before-restart'));
      const after = run.fingerprints.find((item) => item.at.startsWith('after-restart'));
      push(
        run.armId,
        'restart-equivalent',
        before !== undefined && after !== undefined && before.sha === after.sha,
        'same-state-fingerprint',
        { before: before?.sha ?? null, after: after?.sha ?? null },
      );
    }
    // 重启后仍能拿到当前证据。
    push('M', 'restart-keeps-evidence', expectation.mustIncludeSourceIds.every((sourceId) => hit(mText, sourceId)), expectation.mustIncludeSourceIds, mText.includes('sourceIds'));
  }

  return out;
}

/** 汇总指标（只报 SPEC 允许的那几个）。 */
export function summarize(runs: readonly StoryRun[], results: readonly AssertionResult[]) {
  const stories = [...new Set(runs.map((run) => run.storyId))];
  const mRuns = runs.filter((run) => run.armId === 'M');
  const staleHits = results.filter((item) => item.id === 'stale-text-not-current' || item.id === 'stale-sources-not-current').filter((item) => !item.ok).length;
  return {
    stories: stories.length,
    runs: runs.length,
    assertions: results.length,
    failed: results.filter((item) => !item.ok).length,
    requiredVisibleRate: mRuns.length === 0 ? 0 : Number((mRuns.filter((run) => run.requests.length > 0).length / mRuns.length).toFixed(3)),
    staleCurrentHits: staleHits,
    restartEqual: results.filter((item) => item.id === 'restart-equivalent').every((item) => item.ok),
    budgetCompliant: results.filter((item) => item.id === 'budget-compliant').every((item) => item.ok),
    stubCalls: runs.reduce((sum, run) => sum + run.stubCalls, 0),
    realNetworkCalls: runs.reduce((sum, run) => sum + run.realNetworkCalls, 0),
    requests: runs.reduce((sum, run) => sum + run.requests.length, 0),
    maxUtf16: Math.max(0, ...runs.flatMap((run) => run.requests.map((request) => request.utf16))),
    maxUtf8: Math.max(0, ...runs.flatMap((run) => run.requests.map((request) => request.utf8))),
    bytes: runs.reduce((sum, run) => sum + run.requests.reduce((n, request) => n + request.utf8, 0), 0),
  };
}
