/**
 * 独立评分：只读捕获到的 provider 请求，不看内部 compile 文本。
 *
 * R3.1（F1 修复）：所有「最终请求」断言一律绑定 expectation.finalTurnIndex
 * 指定的目标轮，禁止「取 requests 数组末项」的回退——先前轮的成功请求
 * 不得掩盖目标轮缺失/失败。目标轮请求缺失/重复、轮状态非 ok、产品错误码
 * 非空，都判失败并写明轮号与失败码。
 *
 * R3.1（F2 断言）：turnMustIncludeText 证明证据确实进入过早期请求历史；
 * finalHistoryMustExcludeText 证明产品默认历史淘汰确实发生。
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

/**
 * 最后一轮请求；没有则 undefined。
 * R3.1 起仅供旧调用方兼容展示；评分一律用 targetRequestsOfTurn 绑定目标轮。
 */
export function finalRequest(run: StoryRun) {
  return run.requests[run.requests.length - 1];
}

/** 目标轮（turnIndex 绑定）的请求集合；同一轮只应有一条。 */
export function targetRequestsOfTurn(run: StoryRun, turnIndex: number) {
  return run.requests.filter((request) => request.turnIndex === turnIndex);
}

/** 目标轮的可见文本；请求缺失/重复时为空串，让后续断言自然失败（不回退别的轮）。 */
export function visibleTextOfTurn(run: StoryRun, turnIndex: number): string {
  const target = targetRequestsOfTurn(run, turnIndex);
  if (target.length !== 1) return '';
  return target[0]!.messages.map((message) => message.content).join('\n');
}

/**
 * 目标请求的「历史部分」：最后一条 user 消息之前的所有消息文本。
 * R3.1 F2：验证产品默认历史淘汰时，记忆块在最后一条 user 消息内，
 * 不属于历史，不会误伤 M 臂证据。
 */
export function historyTextOfTurn(run: StoryRun, turnIndex: number): string {
  const target = targetRequestsOfTurn(run, turnIndex);
  if (target.length !== 1) return '';
  const messages = target[0]!.messages;
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') {
      lastUser = index;
      break;
    }
  }
  return messages
    .slice(0, lastUser < 0 ? messages.length : lastUser)
    .map((message) => message.content)
    .join('\n');
}

/** 目标轮的会话记录（缺失时 undefined）。 */
export function turnOf(run: StoryRun, turnIndex: number) {
  return run.turns.find((turn) => turn.index === turnIndex);
}

function hit(text: string, needle: string): boolean {
  return needle !== '' && text.includes(needle);
}

const OK = 'ok';

/** 对一个故事的两臂求断言。 */
export function scoreStory(storyId: string, expectation: StoryExpectation, runs: readonly StoryRun[]): AssertionResult[] {
  const out: AssertionResult[] = [];
  const m = runs.find((run) => run.armId === 'M');
  const h = runs.find((run) => run.armId === 'H');
  const finalTurnIndex = expectation.finalTurnIndex;
  const mText = m === undefined ? '' : visibleTextOfTurn(m, finalTurnIndex);
  const hText = h === undefined ? '' : visibleTextOfTurn(h, finalTurnIndex);

  const push = (arm: ArmId, id: string, ok: boolean, expected: unknown, actual: unknown, note?: string): void => {
    out.push({ storyId, armId: arm, id, ok, expected, actual, ...(note === undefined ? {} : { note }) });
  };

  // —— 目标轮身份（F1 核心）：每臂必须有且仅有一条目标轮请求，且该轮 ok ——
  for (const run of runs) {
    const target = targetRequestsOfTurn(run, finalTurnIndex);
    push(run.armId, 'target-turn-requested', target.length === 1, 1, target.length, `turnIndex=${finalTurnIndex}`);
    const turn = turnOf(run, finalTurnIndex);
    push(
      run.armId,
      'target-turn-ok',
      turn?.status === OK,
      OK,
      { status: turn?.status ?? 'missing', code: turn?.code ?? null },
      `story=${storyId} arm=${run.armId} turn=${finalTurnIndex}`,
    );
    const lastUser = target.length === 1 ? target[0]!.messages[target[0]!.messages.length - 1] : undefined;
    push(
      run.armId,
      'target-question-verbatim',
      lastUser?.role === 'user' && lastUser.content.endsWith(expectation.finalQuestion),
      `ends with frozen question`,
      lastUser === undefined ? 'no target request' : lastUser.content.slice(-80),
    );
    const allowed = expectation.allowedNonOkTurns ?? [];
    const unexpected = run.turns
      .filter((turn) => turn.index >= 0 && turn.status !== OK)
      .filter((turn) => !allowed.some((entry) => entry.turnIndex === turn.index && entry.status === turn.status));
    push(
      run.armId,
      'turns-sound',
      unexpected.length === 0,
      'all chat turns ok (expected cancellations excluded)',
      unexpected.map((turn) => ({ index: turn.index, status: turn.status, code: turn.code ?? null })),
    );
  }

  push(
    'M',
    'required-sources-visible',
    expectation.mustIncludeSourceIds.every((sourceId) => hit(mText, sourceId)),
    expectation.mustIncludeSourceIds,
    expectation.mustIncludeSourceIds.filter((sourceId) => !hit(mText, sourceId)),
    mText === '' ? 'target request missing' : undefined,
  );
  push(
    'M',
    'required-text-visible',
    expectation.mustIncludeText.every((text) => hit(mText, text)),
    expectation.mustIncludeText,
    expectation.mustIncludeText.filter((text) => !hit(mText, text)),
    mText === '' ? 'target request missing' : undefined,
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

  // —— 进入过历史（F2）：早期轮请求必须含证据原文，两臂都成立 ——
  for (const requirement of expectation.turnMustIncludeText ?? []) {
    for (const run of runs) {
      const earlyText = visibleTextOfTurn(run, requirement.turnIndex);
      push(
        run.armId,
        `entered-history:turn${requirement.turnIndex}`,
        hit(earlyText, requirement.text),
        `contains: ${requirement.text}`,
        hit(earlyText, requirement.text) ? 'ok' : 'missing from early request',
      );
    }
  }
  // —— 淘汰发生（F2）：目标请求的历史部分不得含被挤出的轮文本 ——
  for (const dropped of expectation.finalHistoryMustExcludeText ?? []) {
    for (const run of runs) {
      const historyText = historyTextOfTurn(run, finalTurnIndex);
      push(
        run.armId,
        'dropped-from-final-history',
        !hit(historyText, dropped),
        `history excludes: ${dropped}`,
        hit(historyText, dropped) ? 'stale turn text still in history' : 'ok',
      );
    }
  }

  if (expectation.budgetPressureUtf16 !== undefined) {
    const mTarget = m === undefined ? [] : targetRequestsOfTurn(m, finalTurnIndex);
    push(
      'M',
      'budget-pressure-exercised',
      mTarget.length === 1 && mTarget[0]!.utf16 >= expectation.budgetPressureUtf16,
      `utf16>=${expectation.budgetPressureUtf16}`,
      mTarget.length === 1 ? mTarget[0]!.utf16 : null,
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

  // H 与 M 的目标请求必须不同（M 有记忆块）；除非冻结允许一致。
  const mFinalBody = m === undefined ? undefined : targetRequestsOfTurn(m, finalTurnIndex)[0]?.bodyText;
  const hFinalBody = h === undefined ? undefined : targetRequestsOfTurn(h, finalTurnIndex)[0]?.bodyText;
  if (!expectation.allowIdentical) {
    push('M', 'arms-differ', mFinalBody !== undefined && hFinalBody !== undefined && mFinalBody !== hFinalBody, 'differ', mFinalBody === hFinalBody ? 'identical' : 'differ');
  }

  return out;
}

/**
 * 汇总指标（只报 SPEC 允许的那几个）。
 *
 * R3.1 口径修正：requiredVisibleRate 不再表示「有任意请求的 M 臂比例」——
 * 该口径已拆为 requestCoverageRate（目标请求覆盖率）与 requiredVisible
 * （目标请求上必要证据逐项可见比例，需传入 expectedById）。
 */
export function summarize(
  runs: readonly StoryRun[],
  results: readonly AssertionResult[],
  expectedById?: ReadonlyMap<string, StoryExpectation>,
) {
  const stories = [...new Set(runs.map((run) => run.storyId))];
  const mRuns = runs.filter((run) => run.armId === 'M');
  const staleHits = results.filter((item) => item.id === 'stale-text-not-current' || item.id === 'stale-sources-not-current').filter((item) => !item.ok).length;
  const requestCoverageRate =
    mRuns.length === 0
      ? 0
      : Number(
          (
            mRuns.filter((run) => expectedById?.get(run.storyId) === undefined
              ? run.requests.length > 0
              : targetRequestsOfTurn(run, expectedById.get(run.storyId)!.finalTurnIndex).length === 1
            ).length / mRuns.length
          ).toFixed(3),
        );
  let requiredVisible: { numerator: number; denominator: number; rate: number } | undefined;
  if (expectedById !== undefined) {
    let numerator = 0;
    let denominator = 0;
    for (const run of mRuns) {
      const expect = expectedById.get(run.storyId);
      if (expect === undefined) continue;
      const text = visibleTextOfTurn(run, expect.finalTurnIndex);
      numerator += expect.mustIncludeSourceIds.filter((sourceId) => hit(text, sourceId)).length;
      numerator += expect.mustIncludeText.filter((fragment) => hit(text, fragment)).length;
      denominator += expect.mustIncludeSourceIds.length + expect.mustIncludeText.length;
    }
    requiredVisible = { numerator, denominator, rate: denominator === 0 ? 1 : Number((numerator / denominator).toFixed(3)) };
  }
  return {
    stories: stories.length,
    runs: runs.length,
    assertions: results.length,
    failed: results.filter((item) => !item.ok).length,
    requestCoverageRate,
    ...(requiredVisible === undefined ? {} : { requiredVisible }),
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
