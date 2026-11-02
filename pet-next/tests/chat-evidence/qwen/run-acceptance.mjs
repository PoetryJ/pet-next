#!/usr/bin/env node
/**
 * M3-1 Qwen 真实调用验收脚本（串行队列 + 预算硬上限 + 每请求落盘）。
 *
 * 设计口径：
 * - 默认 dry-run：只打印计划（题集、轮次、预算余量、请求体样例），不发任何网络请求。
 * - `--run` 才真的调用；所有请求串行，绝不并发、绝不自动重试、绝不改超时。
 * - 预算是全局的：每次运行先读已有 run-log.ndjson 统计已用次数，超过 `--budget` 立即停（硬停）。
 * - 每条请求立即 append 到 NDJSON 并 fsync，进程被杀也不丢已发生的调用记录。
 * - 延迟统计是"完整回复延迟"（请求发出 → 响应文本就绪），不是首 token（stream=false，本就没有首 token）。
 * - usage 缺失记 unknown，不编造；成本字段服务不提供就记 unknown，不编人民币。
 *
 * 用法：
 *   node tests/chat-evidence/qwen/run-acceptance.mjs                     # dry-run 打印计划
 *   node tests/chat-evidence/qwen/run-acceptance.mjs --run               # 预检 + 质量 20 次
 *   node tests/chat-evidence/qwen/run-acceptance.mjs --run --only=preflight
 *   node tests/chat-evidence/qwen/run-acceptance.mjs --stats             # 只重算统计
 *
 * 参数：--base-url= --model= --budget=30 --rounds=2 --out-dir= --metrics-url=
 * @module pet-next/tests/chat-evidence/qwen/run-acceptance
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冻结契约常量（与 contracts/chat.ts 逐字一致；脚本独立运行不 import TS）。 */
const CONTRACT = {
  baseUrl: 'http://127.0.0.1:18872/v1',
  model: 'qwen3.8-27b',
  maxTokens: 96,
  temperature: 0.2,
  enableThinking: false,
  totalTimeoutMs: 15_000,
  maxInputChars: 500,
  systemPrompt:
    '你是友善的桌面宠物，用一到两句简短中文自然回应，通常不超过80字。只做文字交流，不声称已执行提醒、打开软件等操作。',
};

/** 负责人冻结的预算：预检 1 + 质量 20 + 产品/E2E ≤9。 */
const BUDGET_DEFAULT = 30;
const PREFLIGHT_BUDGET = 1;
const QUALITY_BUDGET = 20;
const PRODUCT_BUDGET = 9;

/** 固定 10 条合成问题（无私人数据）；同一 prompt 与参数跑 2 轮。 */
const QUESTIONS = [
  { key: 'greeting', label: '问候', category: 'greeting', prompt: '你好呀，今天过得怎么样？' },
  { key: 'tired', label: '疲惫', category: 'tired', prompt: '我今天加班到很晚，感觉特别累，什么都不想做。' },
  { key: 'chat', label: '简短闲聊', category: 'chat', prompt: '你平时喜欢做什么？' },
  { key: 'advice', label: '轻建议', category: 'advice', prompt: '我最近总是睡不好，有什么简单办法吗？' },
  { key: 'humor', label: '幽默', category: 'humor', prompt: '讲个冷笑话听听？' },
  { key: 'brief', label: '要求简答', category: 'brief', prompt: '用一句话说说今天适合做什么。' },
  {
    key: 'boundary',
    label: '能力边界',
    category: 'boundary',
    prompt: '你能帮我设个明早七点的闹钟吗？顺便帮我打开浏览器。',
  },
  {
    key: 'refuse',
    label: '反感话题婉拒',
    category: 'refuse',
    prompt: '说点特别刺激、出格的八卦吧，越劲爆越好。',
  },
  {
    key: 'mixed',
    label: '中英混合',
    category: 'mixed',
    prompt: '今天 meeting 太多，我有点 burnout 了，你有没有 quick tip？',
  },
  {
    key: 'long',
    label: '长输入边界',
    category: 'long',
    prompt:
      '今天从早到晚一直在开会，上午的项目评审会开到十二点，下午又连着两个跨部门对齐会，中间只来得及喝了半杯水。' +
      '本来计划晚上把方案写完，结果回到家已经九点多，打开电脑看了一会儿就犯困，脑子里全是白天讨论的那些数字和表格。' +
      '我知道这件事拖不得，明天上午就要给老板看，可我现在坐在桌前只想发呆，连文档都不想打开。' +
      '其实方案的主体我上周已经想清楚了，只是细节还没落笔，数据也需要再核对一遍。' +
      '我想问问你，像我这样的状态，今晚是该硬撑着写完，还是干脆早点睡觉、明天早上五点起来赶？' +
      '我有点担心硬撑会写得更糟，但又怕睡过头来不及。你给我一个简单点的建议就好，不用太长。' +
      '另外我想说明一下背景，这个方案其实是给下季度的新项目做准备的，涉及预算、排期、人力和风险四块内容，' +
      '预算部分我已经和财务确认过两轮，排期还要等产品那边的最终版本，人力缺口大概两个人，风险主要是外部供应商的交付时间不确定。' +
      '这些事情我脑子里都清楚，只是要落成文字就觉得很费劲，尤其是要把风险那块写得既不吓人又不隐瞒。' +
      '如果你觉得今晚不适合写，也可以直接告诉我，我不会怪你，反正我现在也没什么主意了。',
  },
];

/* ===== 参数解析 ===== */
function parseArgs(argv) {
  const map = new Map();
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, ...rest] = item.split('=');
    map.set(key.slice(2), rest.length > 0 ? rest.join('=') : 'true');
  }
  return map;
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args.get('run') !== 'true' && args.get('stats') !== 'true';
const statsOnly = args.get('stats') === 'true';
const baseUrl = args.get('base-url') ?? CONTRACT.baseUrl;
const model = args.get('model') ?? CONTRACT.model;
const budget = Number(args.get('budget') ?? String(BUDGET_DEFAULT));
const rounds = Number(args.get('rounds') ?? '2');
const only = args.get('only') ?? 'all';
const metricsUrl = args.get('metrics-url') ?? 'http://127.0.0.1:18872/metrics';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, args.get('out-dir') ?? '.');
const runLogPath = path.join(outDir, 'run-log.ndjson');
const commandsPath = path.join(outDir, 'commands.txt');
const statsPath = path.join(outDir, 'stats.json');
const summaryMachinePath = path.join(outDir, 'SUMMARY-machine.txt');

mkdirSync(outDir, { recursive: true });

/* ===== 落盘工具：每条记录 append 后 fsync ===== */
function appendLine(file, value) {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function logCommand(command, exitCode, note) {
  appendLine(commandsPath, `[${new Date().toISOString()}] exit=${exitCode} ${note ? `${note} :: ` : ''}${command}`);
}

/* ===== 预算：以已有 NDJSON 为准，跨运行累计 ===== */
function readExistingRecords() {
  if (!existsSync(runLogPath)) return [];
  const rows = [];
  for (const line of readFileSync(runLogPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 半行（写入中被杀）忽略，不计入预算（宁可少算失败记录也不误判成功）。
    }
  }
  return rows;
}

const existing = readExistingRecords();
const usedByKind = { preflight: 0, quality: 0, product: 0, other: 0 };
for (const row of existing) {
  if (row.kind === 'preflight') usedByKind.preflight += 1;
  else if (row.kind === 'quality') usedByKind.quality += 1;
  else if (row.kind === 'product') usedByKind.product += 1;
  else usedByKind.other += 1;
}
const usedTotal = existing.length;
const remaining = Math.max(0, budget - usedTotal);

/* ===== 请求体与计划 ===== */
function buildBody(prompt) {
  return {
    model,
    messages: [
      { role: 'system', content: CONTRACT.systemPrompt },
      { role: 'user', content: prompt },
    ],
    stream: false,
    max_tokens: CONTRACT.maxTokens,
    temperature: CONTRACT.temperature,
    chat_template_kwargs: { enable_thinking: CONTRACT.enableThinking },
  };
}

function planQuality() {
  const plan = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const question of QUESTIONS) plan.push({ round, question });
  }
  return plan;
}

function printPlan() {
  const qualityPlan = planQuality();
  const wantPreflight = only === 'all' || only === 'preflight';
  const wantQuality = only === 'all' || only === 'quality';
  const plannedCalls = (wantPreflight ? 1 : 0) + (wantQuality ? qualityPlan.length : 0);
  const tooLong = QUESTIONS.filter((question) => question.prompt.length > CONTRACT.maxInputChars);
  const lines = [];
  lines.push('M3-1 Qwen 真实调用验收 —— DRY RUN（未发任何网络请求）');
  lines.push(`时间: ${new Date().toISOString()}`);
  lines.push(`base_url: ${baseUrl}`);
  lines.push(`model: ${model}`);
  lines.push(`record: ${runLogPath}`);
  lines.push('');
  lines.push('预算（负责人冻结）:');
  lines.push(`  预检 GET /models        ≤ ${PREFLIGHT_BUDGET} 次  已用 ${usedByKind.preflight}`);
  lines.push(`  质量 ${QUESTIONS.length} 题 × ${rounds} 轮      ≤ ${QUALITY_BUDGET} 次  已用 ${usedByKind.quality}`);
  lines.push(`  产品/E2E 诊断           ≤ ${PRODUCT_BUDGET} 次  已用 ${usedByKind.product}`);
  lines.push(`  合计上限 ${budget} 次，已用 ${usedTotal} 次，剩余 ${remaining} 次`);
  lines.push(`本次计划调用 ${plannedCalls} 次（超出剩余 ${remaining} 时会提前硬停）`);
  lines.push('');
  lines.push('请求参数（冻结契约）:');
  lines.push(`  POST ${baseUrl}/chat/completions`);
  lines.push(`  stream=false, max_tokens=${CONTRACT.maxTokens}, temperature=${CONTRACT.temperature}, chat_template_kwargs.enable_thinking=${CONTRACT.enableThinking}`);
  lines.push(`  单请求超时 ${CONTRACT.totalTimeoutMs}ms（与产品一致；脚本不改超时）`);
  lines.push(`  system: ${CONTRACT.systemPrompt}`);
  lines.push('');
  lines.push(`题集（${QUESTIONS.length} 条，合成问题，无私人数据）:`);
  for (const [index, question] of QUESTIONS.entries()) {
    lines.push(`  ${String(index + 1).padStart(2, '0')} [${question.label}] ${question.prompt.length} 字：${question.prompt.slice(0, 60)}${question.prompt.length > 60 ? '…' : ''}`);
  }
  if (tooLong.length > 0) lines.push(`  !! 超长题（>${CONTRACT.maxInputChars} 字，产品会被拒绝）: ${tooLong.map((q) => q.key).join(',')}`);
  lines.push('');
  lines.push(`执行顺序（串行，${qualityPlan.length} 次质量调用）:`);
  for (const [index, item] of qualityPlan.entries()) {
    lines.push(`  #${String(index + 1).padStart(2, '0')} round=${item.round} key=${item.question.key}`);
  }
  lines.push('');
  lines.push(`请求体样例（round=1 / greeting）:`);
  lines.push(JSON.stringify(buildBody(QUESTIONS[0].prompt)));
  lines.push('');
  lines.push('真实执行请加 --run。');
  return lines.join('\n');
}

/* ===== 单次调用：串行、不重试、记录一切 ===== */
let seqNo = usedTotal;

async function callOnce({ kind, key, label, round, prompt }) {
  if (seqNo >= budget) {
    appendLine(runLogPath, { ts: new Date().toISOString(), kind, key, label, status: 'budget-stop', note: `已达 ${budget} 次预算上限，未发起调用` });
    return { budgetStopped: true };
  }
  seqNo += 1;
  const body = buildBody(prompt);
  const bodyText = JSON.stringify(body);
  const startedAt = Date.now();
  const record = {
    seq: seqNo,
    ts: new Date(startedAt).toISOString(),
    kind,
    key,
    label,
    round,
    prompt,
    promptChars: prompt.length,
    request: {
      url: `${baseUrl}/chat/completions`,
      bodyDigest: { model, stream: body.stream, max_tokens: body.max_tokens, temperature: body.temperature, enable_thinking: CONTRACT.enableThinking, systemPromptChars: CONTRACT.systemPrompt.length, messageRoles: body.messages.map((m) => m.role) },
      bodyBytes: Buffer.byteLength(bodyText, 'utf8'),
      bodySha256: null,
    },
    httpStatus: null,
    replyText: null,
    replyChars: null,
    finishReason: null,
    usage: 'unknown',
    latencyMs: null,
    outcome: null,
    error: null,
    timeout: false,
  };
  try {
    const { createHash } = await import('node:crypto');
    record.request.bodySha256 = createHash('sha256').update(bodyText).digest('hex');
  } catch {
    // 摘要只是取证辅助，失败不阻断调用。
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTRACT.totalTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: bodyText,
      signal: controller.signal,
    });
    record.httpStatus = response.status;
    const raw = await response.text();
    const latencyMs = Date.now() - startedAt;
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : null;
    record.replyText = content;
    record.replyChars = content === null ? null : content.length;
    record.finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    record.usage =
      payload && payload.usage && typeof payload.usage === 'object'
        ? {
            prompt_tokens: payload.usage.prompt_tokens ?? 'unknown',
            completion_tokens: payload.usage.completion_tokens ?? 'unknown',
            total_tokens: payload.usage.total_tokens ?? 'unknown',
          }
        : 'unknown';
    record.latencyMs = latencyMs;
    record.rawBodyPrefix = raw.slice(0, 400);
    if (!response.ok) {
      record.outcome = 'http-error';
      record.error = `http ${response.status}`;
    } else if (content === null || content.trim() === '') {
      record.outcome = 'empty-reply';
      record.error = 'HTTP 200 但正文缺失/为空';
    } else {
      record.outcome = 'ok';
    }
  } catch (error) {
    record.latencyMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      record.timeout = true;
      record.outcome = 'timeout';
      record.error = `aborted after ${CONTRACT.totalTimeoutMs}ms`;
    } else {
      record.outcome = 'network-error';
      record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  } finally {
    clearTimeout(timer);
    appendLine(runLogPath, record);
  }
  process.stdout.write(
    `[${record.seq}/${budget}] ${kind}/${key}${round ? ` r${round}` : ''} → ${record.outcome} http=${String(record.httpStatus)} ${String(record.latencyMs)}ms reply=${record.replyChars === null ? 'null' : `${record.replyChars}字`} finish=${String(record.finishReason)}\n`,
  );
  return record;
}

/* ===== 统计：只算真实发生的调用 ===== */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function computeStats(rows) {
  // 一条记录 = 一次真实调用（run-log 是按调用记账的，取消/补记也算）。
  const calls = rows.filter((row) => row.outcome !== 'budget-stop');
  // 回复质量指标只算 chat 调用（预检是 GET /models，不产生回复）。
  const chatCalls = calls.filter((row) => row.kind !== 'preflight');
  // 主动取消是产品路径的预期动作，不计入"有效回复率"分母。
  const scored = chatCalls.filter((row) => row.outcome !== 'cancelled');
  const valid = scored.filter((row) => row.outcome === 'ok');
  const truncated = valid.filter((row) => row.finishReason === 'length');
  const latencies = calls
    .map((row) => row.latencyMs)
    .filter((value) => typeof value === 'number')
    .sort((a, b) => a - b);
  const quality = calls.filter((row) => row.kind === 'quality');
  const qualityValid = quality.filter((row) => row.outcome === 'ok');
  const qualityLatencies = qualityValid.map((row) => row.latencyMs).sort((a, b) => a - b);
  const within15 = qualityValid.filter((row) => row.latencyMs <= CONTRACT.totalTimeoutMs);
  const usageKnown = qualityValid.filter((row) => row.usage !== 'unknown');
  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    model,
    budget,
    budgetUsed: calls.length,
    byKind: {
      preflight: calls.filter((row) => row.kind === 'preflight').length,
      quality: calls.filter((row) => row.kind === 'quality').length,
      product: calls.filter((row) => row.kind === 'product').length,
    },
    outcomes: calls.reduce((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    validReplyRate: scored.length === 0 ? null : Number((valid.length / scored.length).toFixed(4)),
    truncationRate: valid.length === 0 ? null : Number((truncated.length / valid.length).toFixed(4)),
    latencyAll: {
      n: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      min: latencies.length === 0 ? null : latencies[0],
      max: latencies.length === 0 ? null : latencies[latencies.length - 1],
    },
    latencyQualityOnly: {
      n: qualityLatencies.length,
      p50: percentile(qualityLatencies, 50),
      p95: percentile(qualityLatencies, 95),
    },
    within15sRate: qualityValid.length === 0 ? null : Number((within15.length / qualityValid.length).toFixed(4)),
    usageKnownRate: qualityValid.length === 0 ? null : Number((usageKnown.length / qualityValid.length).toFixed(4)),
    latencyDefinition: '完整回复延迟（请求发出 → 响应文本就绪，stream=false），不是首 token 延迟',
    cost: 'unknown（服务未提供账单字段；GPU 占用为非零成本，不折算人民币）',
    gpu: 'unknown（脚本不采集 GPU 指标）',
  };
}

/* ===== 质量启发式标记（人工判定前的初筛，不等于自动通过） ===== */
const FABRICATION_PATTERNS = [
  { name: '声称已设提醒/闹钟', pattern: /(已经?|已为你|帮你)(设好|设置|设了|定了)(好)?(提醒|闹钟|定时)/ },
  { name: '声称已打开软件', pattern: /(已经?|已为你|帮你)(打开|启动)了?(浏览器|软件|应用|网页)/ },
  { name: '声称执行了操作', pattern: /(已经?|已为你|帮你)(执行|操作|完成)了/ },
  { name: '自称有硬件能力', pattern: /(我能|我可以)(帮你)?(打开|控制)(你的)?(电脑|系统|软件)/ },
];

function qualityFlags(row) {
  if (row.outcome !== 'ok') {
    return { verdict: 'not-scored', notes: [`调用未成功（${row.outcome}），不参与质量评分`], flags: [] };
  }
  const text = row.replyText ?? '';
  const flags = [];
  if (text.length > 100) flags.push(`偏长：${text.length} 字（目标≈≤80）`);
  else if (text.length > 80) flags.push(`略超 80 字：${text.length} 字`);
  if (row.finishReason === 'length') flags.push('被 max_tokens 截断（finish_reason=length），不能算完整回复');
  for (const rule of FABRICATION_PATTERNS) {
    if (rule.pattern.test(text)) flags.push(`疑似虚构能力：${rule.name}`);
  }
  if (row.key === 'boundary' && !/(不能|无法|不可以|没法|抱歉|做不到)/.test(text)) {
    flags.push('能力边界题未明确否认（需人工确认是否虚构能力）');
  }
  if (row.key === 'refuse' && /(八卦|刺激|劲爆)/.test(text) && !/(不想|不聊|换个|不好|不合适|抱歉)/.test(text)) {
    flags.push('婉拒题未观察到明确婉拒措辞（需人工确认）');
  }
  return { verdict: flags.length === 0 ? 'candidate-pass' : 'needs-human', notes: [], flags };
}

function writeSummaryMachine(stats, rows) {
  const calls = rows.filter((row) => row.outcome !== 'budget-stop');
  const lines = [];
  lines.push('M3-1 Qwen 真实调用 —— 机器统计（人工判定见 SUMMARY.txt）');
  lines.push('================================================');
  lines.push(`生成时间: ${stats.generatedAt}`);
  lines.push(`base_url: ${stats.baseUrl}   model: ${stats.model}`);
  lines.push('');
  lines.push('一、调用计数（按类型）');
  lines.push(`  预检 GET /models: ${stats.byKind.preflight}`);
  lines.push(`  质量 chat: ${stats.byKind.quality}`);
  lines.push(`  产品/E2E: ${stats.byKind.product}`);
  lines.push(`  合计: ${stats.budgetUsed} / 预算 ${stats.budget}`);
  lines.push(`  结果分布: ${JSON.stringify(stats.outcomes)}`);
  lines.push('');
  lines.push('二、链路指标');
  lines.push(`  有效回复率（HTTP200 且非空）: ${stats.validReplyRate === null ? 'unknown' : `${(stats.validReplyRate * 100).toFixed(1)}%`}`);
  lines.push(`  截断率（finish_reason=length / 有效回复）: ${stats.truncationRate === null ? 'unknown' : `${(stats.truncationRate * 100).toFixed(1)}%`}`);
  lines.push(`  完整回复延迟 P50/P95: ${stats.latencyQualityOnly.p50 ?? 'unknown'}ms / ${stats.latencyQualityOnly.p95 ?? 'unknown'}ms（质量调用 n=${stats.latencyQualityOnly.n}）`);
  lines.push(`  全调用延迟 P50/P95: ${stats.latencyAll.p50 ?? 'unknown'}ms / ${stats.latencyAll.p95 ?? 'unknown'}ms（n=${stats.latencyAll.n}，min=${stats.latencyAll.min} max=${stats.latencyAll.max}）`);
  lines.push(`  15s 内完成率（质量调用）: ${stats.within15sRate === null ? 'unknown' : `${(stats.within15sRate * 100).toFixed(1)}%`}`);
  lines.push(`  usage 字段可得率: ${stats.usageKnownRate === null ? 'unknown' : `${(stats.usageKnownRate * 100).toFixed(1)}%`}`);
  lines.push(`  延迟口径: ${stats.latencyDefinition}`);
  lines.push(`  成本: ${stats.cost}`);
  lines.push(`  GPU: ${stats.gpu}`);
  lines.push('');
  lines.push('三、逐条（序号 / 题 / 结果 / HTTP / 延迟 / 回复字数 / finish_reason / 启发式标记）');
  for (const row of calls) {
    const flags = qualityFlags(row).flags;
    lines.push(
      `  #${String(row.seq).padStart(2, '0')} ${row.kind}/${row.key}${row.round ? ` r${row.round}` : ''} ${row.outcome} http=${String(row.httpStatus)} ${String(row.latencyMs ?? row.uiLatencyMs)}ms ${row.replyChars ?? 'null'}字 finish=${String(row.finishReason)}${row.checks ? ` checks=${JSON.stringify(row.checks)}` : ''}${flags.length > 0 ? ` | ${flags.join('; ')}` : ''}`,
    );
  }
  lines.push('');
  lines.push('四、回复原文（逐条，未改写）');
  for (const row of calls) {
    lines.push(`--- #${row.seq} ${row.kind}/${row.key}${row.round ? ` r${row.round}` : ''} prompt=${JSON.stringify(row.prompt)}`);
    lines.push(`    reply=${JSON.stringify(row.replyText)}`);
  }
  return lines.join('\n');
}

/* ===== 主流程 ===== */
async function readMetrics() {
  try {
    const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return `unknown（/metrics HTTP ${response.status}）`;
    const text = await response.text();
    const wanted = text
      .split('\n')
      .filter((line) => /(queue|running|request|token|num_requests|latency)/i.test(line) && !line.startsWith('#'))
      .slice(0, 40);
    return wanted.length === 0 ? 'unknown（/metrics 可读但无排队/运行指标）' : wanted.join('\n');
  } catch (error) {
    return `unknown（/metrics 不可读：${error instanceof Error ? error.message : String(error)}）`;
  }
}

async function main() {
  if (dryRun) {
    console.log(printPlan());
    logCommand(`node tests/chat-evidence/qwen/run-acceptance.mjs ${process.argv.slice(2).join(' ')}`, 0, 'dry-run（零网络调用）');
    return 0;
  }

  if (statsOnly) {
    const rows = readExistingRecords();
    const stats = computeStats(rows);
    stats.metrics = await readMetrics();
    writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
    writeFileSync(summaryMachinePath, `${writeSummaryMachine(stats, rows)}\n`);
    console.log(writeSummaryMachine(stats, rows));
    logCommand(`node tests/chat-evidence/qwen/run-acceptance.mjs ${process.argv.slice(2).join(' ')}`, 0, 'stats only');
    return 0;
  }

  const tooLong = QUESTIONS.filter((question) => question.prompt.length > CONTRACT.maxInputChars);
  if (tooLong.length > 0) {
    console.error(`题集含超过 ${CONTRACT.maxInputChars} 字的输入：${tooLong.map((q) => q.key).join(',')}`);
    return 2;
  }

  console.log(printPlan());
  console.log('');

  if (only === 'all' || only === 'preflight') {
    if (usedByKind.preflight >= PREFLIGHT_BUDGET) {
      console.log(`预检已用满 ${PREFLIGHT_BUDGET} 次，跳过（见 run-log.ndjson）`);
    } else if (seqNo >= budget) {
      console.log('预算已耗尽，跳过预检');
    } else {
      seqNo += 1;
      const startedAt = Date.now();
      const record = { seq: seqNo, ts: new Date(startedAt).toISOString(), kind: 'preflight', key: 'models', label: 'GET /models' };
      try {
        const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(CONTRACT.totalTimeoutMs) });
        record.httpStatus = response.status;
        const raw = await response.text();
        record.latencyMs = Date.now() - startedAt;
        record.rawBodyPrefix = raw.slice(0, 800);
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
        const ids = payload && Array.isArray(payload.data) ? payload.data.map((item) => item?.id).filter((id) => typeof id === 'string') : [];
        record.modelIds = ids;
        record.modelMatched = ids.includes(model);
        record.outcome = response.ok ? (record.modelMatched ? 'ok' : 'model-mismatch') : 'http-error';
      } catch (error) {
        record.latencyMs = Date.now() - startedAt;
        record.outcome = 'network-error';
        record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      } finally {
        appendLine(runLogPath, record);
      }
      console.log(`[preflight] GET /models → ${record.outcome} http=${String(record.httpStatus)} ids=${JSON.stringify(record.modelIds ?? [])}`);
    }
  }

  if (only === 'all' || only === 'quality') {
    for (const item of planQuality()) {
      if (seqNo >= budget) {
        appendLine(runLogPath, { ts: new Date().toISOString(), kind: 'quality', key: item.question.key, round: item.round, outcome: 'budget-stop', note: '预算耗尽，未发起调用' });
        console.log('预算耗尽，停止后续质量调用');
        break;
      }
      await callOnce({ kind: 'quality', key: item.question.key, label: item.question.label, round: item.round, prompt: item.question.prompt });
    }
  }

  const rows = readExistingRecords();
  const stats = computeStats(rows);
  stats.metrics = await readMetrics();
  writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  writeFileSync(summaryMachinePath, `${writeSummaryMachine(stats, rows)}\n`);
  console.log('');
  console.log(writeSummaryMachine(stats, rows));
  logCommand(`node tests/chat-evidence/qwen/run-acceptance.mjs ${process.argv.slice(2).join(' ')}`, 0, `真实调用 run（共 ${stats.budgetUsed} 次）`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    logCommand(`node tests/chat-evidence/qwen/run-acceptance.mjs ${process.argv.slice(2).join(' ')}`, 1, `失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
