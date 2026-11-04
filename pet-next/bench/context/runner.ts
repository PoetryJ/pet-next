/**
 * M3-4 C：18 次真实对照 runner（3 场景 × 3 轮 × context off/on 两臂）。
 *
 * 铁律（验收单冻结）：
 * - 请求必须经当前真实 session + Qwen Provider（本文件 import 产品代码，绝不另拼一套逻辑）；
 * - 每臂独立新 session；S3 两臂第三问前执行同一 reset 事件；
 * - 发 POST 前持久记账（attempt 行），重启续账：已有 attempt 的 seq 直接跳过，绝不重发；
 * - 失败/超时/取消同样计数；不自动重试、不热身、禁止按结果换题重跑；
 * - fixture 模式（默认）零真实调用；live 模式需 --live 显式开关且服务健康预检通过。
 *
 * 用法（仓库根 pet-next/）：
 *   node --experimental-strip-types bench/context/runner.ts                 # fixture 模式（fake，零真实调用）
 *   node --experimental-strip-types bench/context/runner.ts --live          # 真实 18 次（需 127.0.0.1:18872 健康）
 *   环境变量：PET_NEXT_LIVE_RUN_ID（默认 m3-4-live-eval，续账沿用同一 runId）
 *
 * 产物：bench/context/runs/<runId>/{ledger.ndjson, cases.ndjson, config.json, summary.json}
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createQwenChatProvider } from '../../adapters/chat/qwen-provider.ts';
import { QWEN_MAX_TOKENS, QWEN_SYSTEM_PROMPT, QWEN_TEMPERATURE } from '../../contracts/chat.ts';
import { createChatHistory } from '../../core/chat/history.ts';
import { createChatSession } from '../../core/chat/session.ts';
import type { ChatSession } from '../../core/chat/types.ts';
import { PLAN, SCENARIOS, fixturesHash } from './fixtures.ts';

export const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUNS_DIR = path.join(PET_ROOT, 'bench/context/runs');
export const LIVE_BASE_URL = 'http://127.0.0.1:18872/v1';
export const TARGET_MODEL = 'qwen3.8-27b';
/** 新增额度：18 次 POST（负责人已批准；失败也计）。旧账本 29/30 不在本文件管辖。 */
export const BUDGET_POSTS = 18;

type Arm = 'off' | 'on';
type FetchLike = typeof fetch;

interface LedgerEvent {
  v: 1;
  kind: 'attempt' | 'settled' | 'skip-replay' | 'run-end';
  seq: number;
  case: string;
  arm: Arm;
  round: number;
  at: string;
  status?: string;
  http?: number | 'unknown';
  note?: string;
}

interface CapturedHttp {
  seq: number;
  url: string;
  bytes: number;
  body: string;
  http: number | 'error' | 'unknown';
  error?: string;
  at: string;
}

export interface CaseRecord {
  seq: number;
  case: string;
  arm: Arm;
  round: number;
  userText: string;
  resetBeforeRound: boolean;
  historyInjected: number;
  request: { url: string; bytes: number; body: unknown };
  result: { status: string; text?: string; code?: string };
  meta: { http?: number; latencyMs?: number; usage?: unknown; usageUnknown?: boolean; truncated?: boolean; error?: string } | null;
  fullLatencyMs: number;
  at: string;
}

export interface RunOptions {
  mode: 'fixture' | 'live';
  runId: string;
  /** 仅自测注入（默认 BUDGET_POSTS=18，验收冻结值不得改）。 */
  maxPosts?: number;
  /** 自测注入假 fetch；live 模式忽略。 */
  fetchImpl?: FetchLike;
  /** live 健康预检使用的 fetch（自测可注入）。 */
  probeFetch?: FetchLike;
}

export interface RunSummary {
  runId: string;
  mode: string;
  attempts: number;
  skippedReplay: number;
  settled: { ok: number; error: number; cancelled: number; other: number };
  cases: Array<Pick<CaseRecord, 'seq' | 'case' | 'arm' | 'round' | 'result'> & { bytes: number; usage?: unknown }>;
}

/** fixture 假回复：按请求内是否出现前文关键词回显——只让管道产物呈现可评形态，不代表模型能力。 */
function fixtureReply(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
  const messages = parsed.messages ?? [];
  const current = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const earlier = messages.slice(0, -1).map((m) => m.content).join('\n');
  if (current.includes('还记得我叫什么名字吗')) {
    return earlier.includes('林小满') ? '你叫林小满。' : '抱歉，我没有看到你提过名字。';
  }
  if (current.includes('我现在最喜欢的颜色是什么')) {
    if (earlier.includes('橙色')) return '你最喜欢的是橙色。';
    if (earlier.includes('绿色')) return '我记得你说过是绿色。';
    return '你没有告诉过我。';
  }
  if (current.includes('我养的宠物叫什么名字')) {
    return earlier.includes('豆包') ? '你养的猫叫豆包。' : '我没有听到你提过宠物的名字。';
  }
  if (current.includes('橙')) return '好的，橙色，记住了。';
  if (current.includes('绿色')) return '绿色，不错。';
  return '好的，我知道了。';
}

function fixtureFetch(): FetchLike {
  return (_url, init) => {
    const body = String(init?.body ?? '{}');
    const content = fixtureReply(body);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
}

function readLedgerAttempts(ledgerPath: string): Set<number> {
  const done = new Set<number>();
  if (!existsSync(ledgerPath)) return done;
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as LedgerEvent;
      if (event.kind === 'attempt') done.add(event.seq);
    } catch {
      /* 半行忽略（写入中断），该 seq 视为未消费——宁可少记不多记 */
    }
  }
  return done;
}

/**
 * M3-5 A：已有 run 的只读判定（fail-closed）。
 * - new：目录不存在，正常开新 run；
 * - complete：账本/cases/summary 一一对应且 settled 数已达上限 → 只读复核（零新增 POST、零覆盖）；
 * - partial：一致但未达上限（中断）→ 拒绝续跑；
 * - inconsistent：任何行不可解析 / 计数不对应 / 缺关键文件 → 拒绝续跑。
 * 不做 checkpoint 恢复、不静默跳过坏行、不另开新 run 自动重试。
 */
export type ExistingRunVerdict =
  | { kind: 'new' }
  | { kind: 'complete'; summary: RunSummary }
  | { kind: 'partial'; attempted: number; settled: number }
  | { kind: 'inconsistent'; reasons: string[] };

export function reviewExistingRun(runDir: string, maxPosts: number): ExistingRunVerdict {
  if (!existsSync(runDir)) return { kind: 'new' };
  const reasons: string[] = [];
  const ledgerPath = path.join(runDir, 'ledger.ndjson');
  const casesPath = path.join(runDir, 'cases.ndjson');
  const summaryPath = path.join(runDir, 'summary.json');
  if (!existsSync(ledgerPath)) {
    return { kind: 'inconsistent', reasons: ['run 目录已存在但缺 ledger.ndjson——无法判断已消费额度'] };
  }

  const attemptSeqs = new Set<number>();
  const settledBySeq = new Map<number, string>();
  const ledgerLines = readFileSync(ledgerPath, 'utf8').split('\n');
  for (let i = 0; i < ledgerLines.length; i += 1) {
    const line = ledgerLines[i];
    if (line.trim() === '') continue;
    let event: LedgerEvent;
    try {
      event = JSON.parse(line) as LedgerEvent;
    } catch {
      return { kind: 'inconsistent', reasons: [`ledger 第 ${i + 1} 行不可解析——fail-closed 拒绝`] };
    }
    if (event.kind === 'attempt') {
      if (attemptSeqs.has(event.seq)) reasons.push(`attempt seq=${event.seq} 重复`);
      attemptSeqs.add(event.seq);
    } else if (event.kind === 'settled') {
      if (settledBySeq.has(event.seq)) reasons.push(`settled seq=${event.seq} 重复`);
      settledBySeq.set(event.seq, event.status ?? 'unknown');
    }
  }
  for (const seq of attemptSeqs) {
    if (!settledBySeq.has(seq)) reasons.push(`seq=${seq} 有 attempt 无 settled（中断在途）`);
  }
  for (const seq of settledBySeq.keys()) {
    if (!attemptSeqs.has(seq)) reasons.push(`seq=${seq} 有 settled 无 attempt（账本损坏）`);
  }

  const caseSeqs = new Set<number>();
  if (existsSync(casesPath)) {
    const caseLines = readFileSync(casesPath, 'utf8').split('\n');
    for (let i = 0; i < caseLines.length; i += 1) {
      const line = caseLines[i];
      if (line.trim() === '') continue;
      let record: { seq?: unknown };
      try {
        record = JSON.parse(line) as { seq?: unknown };
      } catch {
        return { kind: 'inconsistent', reasons: [`cases 第 ${i + 1} 行不可解析——fail-closed 拒绝`] };
      }
      if (typeof record.seq === 'number') {
        if (caseSeqs.has(record.seq)) reasons.push(`cases seq=${record.seq} 重复`);
        caseSeqs.add(record.seq);
      }
    }
    for (const seq of settledBySeq.keys()) {
      if (!caseSeqs.has(seq)) reasons.push(`seq=${seq} 有 settled 无 cases 记录`);
    }
    for (const seq of caseSeqs) {
      if (!settledBySeq.has(seq)) reasons.push(`cases seq=${seq} 无对应 settled`);
    }
  } else {
    reasons.push('缺 cases.ndjson');
  }

  let summary: RunSummary | null = null;
  if (existsSync(summaryPath)) {
    try {
      const parsed = JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
      summary = parsed;
      if (parsed.attempts !== attemptSeqs.size) {
        reasons.push(`summary.attempts=${parsed.attempts} ≠ 账本 attempt 数 ${attemptSeqs.size}`);
      }
      const expected = { ok: 0, error: 0, cancelled: 0, other: 0 };
      for (const status of settledBySeq.values()) {
        if (status === 'ok' || status === 'error' || status === 'cancelled') expected[status] += 1;
        else expected.other += 1;
      }
      for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
        if (parsed.settled[key] !== expected[key]) {
          reasons.push(`summary.settled.${key}=${parsed.settled[key]} ≠ 账本 ${expected[key]}`);
        }
      }
    } catch {
      reasons.push('summary.json 不可解析');
    }
  } else {
    reasons.push('缺 summary.json');
  }

  if (reasons.length > 0) return { kind: 'inconsistent', reasons };
  const settledTotal = settledBySeq.size;
  if (settledTotal >= maxPosts && summary !== null) return { kind: 'complete', summary };
  return { kind: 'partial', attempted: attemptSeqs.size, settled: settledTotal };
}

function gitHead(): string {
  const result = spawnSync('git', ['-C', PET_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return (result.stdout ?? '').trim() || 'unknown';
}

/** live 预检：GET /v1/models 必须含目标模型 id；不含或不可达 → 拒跑（不消费任何额度）。 */
async function healthCheck(fetchImpl: FetchLike): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${LIVE_BASE_URL}/models`, { method: 'GET' });
  } catch (error) {
    throw new Error(`live 预检失败：${LIVE_BASE_URL}/models 不可达——拒绝执行，未消费额度`, { cause: error });
  }
  if (!response.ok) throw new Error(`live 预检失败：/models HTTP ${response.status}——拒绝执行，未消费额度`);
  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = (payload.data ?? []).map((item) => item.id ?? '');
  if (!ids.includes(TARGET_MODEL)) {
    throw new Error(`live 预检失败：/models 不含 ${TARGET_MODEL}（实际 ${JSON.stringify(ids)}）——拒绝执行，未消费额度`);
  }
}

export async function runEvaluation(options: RunOptions): Promise<RunSummary> {
  const maxPosts = options.maxPosts ?? BUDGET_POSTS;
  // M3-5 A：fail-closed 先于一切（含 live 预检）——本地只读判定，零消费、零覆盖。
  const verdict = reviewExistingRun(path.join(RUNS_DIR, options.runId), maxPosts);
  if (verdict.kind === 'complete') {
    console.log(
      `[context-runner] run=${options.runId} 已完整（attempts=${verdict.summary.attempts}，settled=${JSON.stringify(verdict.summary.settled)}）——只读复核：不新增 POST、不覆盖任何文件`,
    );
    return verdict.summary;
  }
  if (verdict.kind === 'partial') {
    throw new Error(
      `run=${options.runId} 不完整（attempt ${verdict.attempted} / settled ${verdict.settled}，上限 ${maxPosts}）——拒绝续跑（fail-closed）：不静默跳过、不覆盖、不自动另开 run；请人工核对后换新 runId`,
    );
  }
  if (verdict.kind === 'inconsistent') {
    throw new Error(`run=${options.runId} 账本不一致——拒绝续跑（fail-closed）：\n- ${verdict.reasons.join('\n- ')}`);
  }
  // fixture 模式默认假 fetch（零真实调用）；live 模式默认全局 fetch（真实网络）。
  const realFetch: FetchLike = options.fetchImpl ?? (options.mode === 'fixture' ? fixtureFetch() : (url, init) => fetch(url, init));
  const runDir = path.join(RUNS_DIR, options.runId);
  mkdirSync(runDir, { recursive: true });
  const ledgerPath = path.join(runDir, 'ledger.ndjson');
  const casesPath = path.join(runDir, 'cases.ndjson');

  if (options.mode === 'live') await healthCheck(options.probeFetch ?? realFetch);

  const attempted = readLedgerAttempts(ledgerPath);
  if (attempted.size > maxPosts) throw new Error(`账本已有 ${attempted.size} 次 attempt，超过上限 ${maxPosts}——人工核对`);
  const config = {
    v: 1,
    mode: options.mode,
    runId: options.runId,
    head: gitHead(),
    fixturesHash: fixturesHash(),
    plan: PLAN,
    frozenParams: { QWEN_MAX_TOKENS, QWEN_TEMPERATURE, QWEN_SYSTEM_PROMPT, stream: false, timeoutMs: 15_000, thinking: false },
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const appendLedger = (event: LedgerEvent): void => {
    appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`);
  };
  const captured: CapturedHttp[] = [];
  let seq = 0;
  const summary: RunSummary = {
    runId: options.runId,
    mode: options.mode,
    attempts: 0,
    skippedReplay: 0,
    settled: { ok: 0, error: 0, cancelled: 0, other: 0 },
    cases: [],
  };

  for (const group of PLAN) {
    const scenario = SCENARIOS.find((item) => item.id === group.case) ?? (() => {
      throw new Error(`未知场景 ${group.case}`);
    })();
    const useContext = group.arm === 'on';
    const history = useContext ? createChatHistory() : undefined;
    // 预算序号（每轮一个 POST）与捕获序号解耦：fetch 闭包只读 currentSeq。
    let currentSeq = 0;
    const recordingFetch: FetchLike = (url, init) => {
      const body = String(init?.body ?? '');
      const record: CapturedHttp = {
        seq: currentSeq,
        url: String(url),
        bytes: Buffer.byteLength(body, 'utf8'),
        body,
        http: 'unknown',
        at: new Date().toISOString(),
      };
      captured.push(record);
      return Promise.resolve(realFetch(url, init)).then(
        (response) => {
          record.http = response.status;
          return response;
        },
        (error: unknown) => {
          record.http = 'error';
          record.error = String(error);
          throw error;
        },
      );
    };
    const provider = createQwenChatProvider({ baseUrl: LIVE_BASE_URL, model: TARGET_MODEL, fetchImpl: recordingFetch });
    const session: ChatSession = createChatSession({
      complete: (input) => provider.complete(input),
      ...(history !== undefined ? { history } : {}),
    });

    for (let round = 1; round <= 3; round += 1) {
      const userText = scenario.turns[round - 1] ?? (() => {
        throw new Error('缺轮次文本');
      })();
      const resetBeforeRound = scenario.resetBeforeThird && round === 3;
      seq += 1;
      currentSeq = seq;
      if (attempted.has(seq)) {
        // 续账：该 seq 已发过 POST——绝不重发，只记跳过。
        appendLedger({ v: 1, kind: 'skip-replay', seq, case: group.case, arm: group.arm, round, at: new Date().toISOString(), note: '重启续账：已消费，不重发' });
        summary.skippedReplay += 1;
        continue;
      }
      if (summary.attempts >= maxPosts) {
        appendLedger({ v: 1, kind: 'run-end', seq, case: group.case, arm: group.arm, round, at: new Date().toISOString(), note: `额度 ${maxPosts} 已用尽，停止（未超发）` });
        writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        return summary;
      }
      if (resetBeforeRound) session.reset();
      const historyInjected = history !== undefined ? history.snapshot().length : 0;
      // 发 POST 前持久记账（先落盘再发请求：进程若死，额度已计）。
      appendLedger({ v: 1, kind: 'attempt', seq, case: group.case, arm: group.arm, round, at: new Date().toISOString() });
      summary.attempts += 1;
      const startedAt = Date.now();
      const result = await session.send({ id: `chat-m3d4-${group.case.toLowerCase()}-${group.arm}-${round}`, text: userText });
      const fullLatencyMs = Date.now() - startedAt;
      const httpRecord = captured.at(-1);
      const meta = provider.lastMeta;
      appendLedger({
        v: 1,
        kind: 'settled',
        seq,
        case: group.case,
        arm: group.arm,
        round,
        at: new Date().toISOString(),
        status: result.status,
        http: httpRecord?.http ?? 'unknown',
      });
      summary.settled[result.status === 'ok' ? 'ok' : result.status === 'error' ? 'error' : result.status === 'cancelled' ? 'cancelled' : 'other'] += 1;
      const record: CaseRecord = {
        seq,
        case: group.case,
        arm: group.arm,
        round,
        userText,
        resetBeforeRound,
        historyInjected,
        request: { url: httpRecord?.url ?? 'unknown', bytes: httpRecord?.bytes ?? Buffer.byteLength(httpRecord?.body ?? '', 'utf8'), body: httpRecord ? (JSON.parse(httpRecord.body) as unknown) : null },
        result: result.status === 'ok' ? { status: 'ok', text: result.text } : { status: result.status, code: result.code ?? 'unknown' },
        meta: meta === null ? null : { http: meta.status, latencyMs: meta.latencyMs, usage: meta.usage ?? (meta.usageUnknown ? 'unknown' : undefined), truncated: meta.truncated, error: meta.error },
        fullLatencyMs,
        at: new Date().toISOString(),
      };
      appendFileSync(casesPath, `${JSON.stringify(record)}\n`);
      summary.cases.push({ seq, case: group.case, arm: group.arm, round, result: record.result, bytes: record.request.bytes, usage: record.meta?.usage });
    }
  }
  appendLedger({ v: 1, kind: 'run-end', seq, case: '-', arm: 'off', round: 0, at: new Date().toISOString(), note: '计划完成' });
  writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--live') ? 'live' : 'fixture';
  const runId = process.env.PET_NEXT_LIVE_RUN_ID ?? (mode === 'live' ? 'm3-4-live-eval' : `fixture-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  console.log(`[context-runner] mode=${mode} runId=${runId} budget=${BUDGET_POSTS}`);
  const summary = await runEvaluation({ mode, runId });
  console.log(`[context-runner] attempts=${summary.attempts} skippedReplay=${summary.skippedReplay} settled=${JSON.stringify(summary.settled)}`);
  console.log(`[context-runner] 产物：${path.join(RUNS_DIR, runId)}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
