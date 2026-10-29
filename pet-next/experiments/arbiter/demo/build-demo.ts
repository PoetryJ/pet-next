/**
 * 用两种工厂回放同一段输入，生成可切换的演示页。
 * 页面只引用现有素材，不启动桌宠。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArbiterDecision, ArbiterInput } from '../../../contracts/arbiter.ts';
import { createBaseline } from '../baseline/index.ts';
import { createStateMachine } from '../state-machine/index.ts';
import { replayFactory, type ReplayFactory } from '../check/replay.ts';
import { demoInputs } from './scenario.ts';

/** 演示里的一条决策。 */
export interface DemoDecision {
  outcome: ArbiterDecision['outcome'];
  reason: ArbiterDecision['reason'];
  eventId: string | null;
  actionId: string | null;
}

/** 演示的一步。 */
export interface DemoFrame {
  index: number;
  nowMs: number;
  inputLabel: string;
  queueLength: number;
  decisions: readonly DemoDecision[];
  /** 有执行时播 reaction，否则播 idle。 */
  clip: 'reaction' | 'idle';
  showsDiscard: boolean;
}

/** 页面里的两套回放。 */
export interface DemoModel {
  baseline: readonly DemoFrame[];
  stateMachine: readonly DemoFrame[];
}

/** 写出演示页的结果。 */
export interface DemoBuild {
  code: number;
  message: string;
  htmlPath: string;
  model: DemoModel | null;
}

const demoDir = fileURLToPath(new URL('../out/demo/', import.meta.url));

/**
 * 回放两种实现并写出演示页。
 *
 * @param options - 可换工厂和输出目录。缺省写到 `experiments/arbiter/out/demo`。
 * @returns `0` 两种回放都标出了执行、等待和丢弃；`1` 缺了某类结果或回放抛错；`2` 基线仍未实现。
 */
export async function buildDemo(options: { outDir?: string; baseline?: ReplayFactory; stateMachine?: ReplayFactory } = {}): Promise<DemoBuild> {
  const outDir = options.outDir ?? demoDir;
  const inputs = demoInputs();
  const baseline = replayFactory(options.baseline ?? createBaseline, inputs);
  if (baseline.unimplemented) {
    return { code: 2, message: 'baseline 尚未实现。演示没有打开桌宠。', htmlPath: path.join(outDir, 'index.html'), model: null };
  }
  if (baseline.error !== null) {
    return { code: 1, message: `baseline 回放失败：${baseline.error}`, htmlPath: path.join(outDir, 'index.html'), model: null };
  }
  const stateMachine = replayFactory(options.stateMachine ?? createStateMachine, inputs);
  if (stateMachine.unimplemented) {
    return { code: 1, message: 'state-machine 尚未实现，演示不能切换两种策略。', htmlPath: path.join(outDir, 'index.html'), model: null };
  }
  if (stateMachine.error !== null) {
    return { code: 1, message: `state-machine 回放失败：${stateMachine.error}`, htmlPath: path.join(outDir, 'index.html'), model: null };
  }
  const model: DemoModel = {
    baseline: toFrames(inputs, baseline.steps),
    stateMachine: toFrames(inputs, stateMachine.steps),
  };
  const missing = missingOutcomes(model);
  await mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'index.html');
  const html = renderDemoPage(model, '../../../../assets/');
  await writeFile(htmlPath, html, 'utf8');
  await writeFile(path.join(outDir, 'trace.json'), `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  if (missing !== null) {
    return { code: 1, message: missing, htmlPath, model };
  }
  return {
    code: 0,
    message: `演示页：${htmlPath}\n切换基线和状态机查看每步的执行、等待或丢弃，以及 reason。加 --serve 可在本机打开。这一页不启动桌宠。`,
    htmlPath,
    model,
  };
}

/** 给本机服务用的页面。素材走 `/assets/`。 */
export function renderServedPage(model: DemoModel): string {
  return renderDemoPage(model, '/assets/');
}

function toFrames(inputs: readonly ArbiterInput[], steps: readonly { decisions: readonly ArbiterDecision[]; queueLength: number }[]): DemoFrame[] {
  return inputs.map((input, index) => {
    const step = steps[index];
    const decisions = (step?.decisions ?? []).map((decision) => ({
      outcome: decision.outcome,
      reason: decision.reason,
      eventId: decision.eventId,
      actionId: decision.actionId,
    }));
    return {
      index,
      nowMs: input.nowMs,
      inputLabel: labelInput(input),
      queueLength: step?.queueLength ?? 0,
      decisions,
      clip: decisions.some((decision) => decision.outcome === 'execute') ? 'reaction' : 'idle',
      showsDiscard: decisions.some((decision) => decision.outcome === 'discard'),
    };
  });
}

function labelInput(input: ArbiterInput): string {
  if (input.type === 'complete') return `complete ${input.actionId} @ ${input.nowMs}ms`;
  return `deliver ${input.event.source} ${input.event.id} seq=${input.event.seq} @ ${input.nowMs}ms`;
}

function missingOutcomes(model: DemoModel): string | null {
  for (const implementation of ['baseline', 'stateMachine'] as const) {
    const frames = model[implementation];
    if (!frames.some((frame) => frame.decisions.some((decision) => decision.outcome === 'execute'))) {
      return `${implementation} 没有执行决策`;
    }
    if (!frames.some((frame) => frame.decisions.some((decision) => decision.outcome === 'wait'))) {
      return `${implementation} 没有等待决策`;
    }
    if (!frames.some((frame) => frame.decisions.some((decision) => decision.outcome === 'discard'))) {
      return `${implementation} 没有丢弃决策`;
    }
  }
  return null;
}

function renderDemoPage(model: DemoModel, assetPrefix: string): string {
  const payload = JSON.stringify(model).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="data:," />
  <title>仲裁实验演示</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 16px/1.5 sans-serif; background: #f4f1ea; color: #1c1915; }
    main { max-width: 880px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0 0 12px; }
    .stage { display: grid; grid-template-columns: 280px 1fr; gap: 20px; align-items: start; }
    .pet { background: repeating-conic-gradient(#d9d3c7 0% 25%, #f7f4ee 0% 50%) 50% / 24px 24px; border-radius: 12px; min-height: 280px; position: relative; }
    video, img.badge { width: 100%; height: 280px; object-fit: contain; }
    img.badge { position: absolute; width: 72px; height: 72px; right: 8px; bottom: 8px; }
    label { display: block; margin-bottom: 8px; }
    select, button { font: inherit; }
    button { margin-right: 8px; }
    ol { padding-left: 20px; }
    li { cursor: pointer; }
    li[aria-current="step"] { font-weight: 700; }
    .execute { color: #0b6b3a; }
    .wait { color: #8a4b08; }
    .discard { color: #8d1d1d; }
    @media (max-width: 720px) { .stage { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>仲裁实验演示</h1>
    <p>切换基线和状态机，查看每一步是执行、等待还是丢弃，以及 reason。画面用现有素材。这一页不启动桌宠，数字也不是线上收益。</p>
    <div class="stage">
      <div class="pet">
        <video id="clip" muted playsinline></video>
        <img id="badge" class="badge" alt="" hidden />
      </div>
      <div>
        <label>策略 <select id="implementation"><option value="baseline">baseline</option><option value="state-machine">state-machine</option></select></label>
        <p id="summary"></p>
        <button type="button" id="prev">上一步</button>
        <button type="button" id="next">下一步</button>
        <button type="button" id="play">播放</button>
        <ol id="steps"></ol>
      </div>
    </div>
  </main>
  <script id="demo-model" type="application/json">${payload}</script>
  <script>
    const model = JSON.parse(document.getElementById('demo-model').textContent);
    const assets = { idle: ${JSON.stringify(`${assetPrefix}idle.webm`)}, reaction: ${JSON.stringify(`${assetPrefix}reaction.webm`)}, placeholder: ${JSON.stringify(`${assetPrefix}placeholder.png`)} };
    const outcomeLabel = { execute: '执行', wait: '等待', discard: '丢弃' };
    const reasonLabel = {
      started: '开始执行',
      'queued-same-rank': '同级排队',
      'queued-lower-rank': '较低优先级排队',
      preempted: '被抢占',
      expired: '过期丢弃',
      duplicate: '重复投递',
      'stale-completion': '过期的完成回调',
      'drag-blocks-auto': '拖动期间不启动自动动作',
      completed: '执行完成'
    };
    const clip = document.getElementById('clip');
    const badge = document.getElementById('badge');
    const summary = document.getElementById('summary');
    const list = document.getElementById('steps');
    const picker = document.getElementById('implementation');
    let frames = model.baseline;
    let cursor = 0;
    let timer = 0;
    function implementationKey() { return picker.value === 'state-machine' ? 'stateMachine' : 'baseline'; }
    function decisionText(decision) {
      const why = reasonLabel[decision.reason] || decision.reason;
      const who = decision.eventId || decision.actionId || '无事件';
      return outcomeLabel[decision.outcome] + ' / ' + decision.reason + '（' + why + '，' + who + '）';
    }
    function renderList() {
      list.replaceChildren();
      frames.forEach(function (frame, index) {
        const item = document.createElement('li');
        const kinds = frame.decisions.map(function (decision) { return decision.outcome; }).join(' ');
        item.textContent = frame.inputLabel + ' → ' + frame.decisions.map(decisionText).join('；');
        item.className = kinds;
        if (index === cursor) item.setAttribute('aria-current', 'step');
        item.addEventListener('click', function () { cursor = index; show(); });
        list.appendChild(item);
      });
    }
    function show() {
      const frame = frames[cursor];
      if (!frame) return;
      const src = frame.clip === 'reaction' ? assets.reaction : assets.idle;
      clip.loop = frame.clip === 'idle';
      if (clip.getAttribute('src') !== src) clip.src = src;
      else { try { clip.currentTime = 0; } catch (error) { /* 尚未加载时忽略。 */ } }
      clip.play().catch(function () {});
      badge.hidden = !frame.showsDiscard;
      badge.alt = frame.showsDiscard ? '丢弃' : '';
      badge.src = assets.placeholder;
      summary.textContent = picker.value + '：模拟时刻 ' + frame.nowMs + 'ms，等待队列 ' + frame.queueLength + '。' + frame.decisions.map(decisionText).join('；');
      renderList();
    }
    function stop() { if (timer) { clearInterval(timer); timer = 0; } }
    picker.addEventListener('change', function () { frames = model[implementationKey()]; cursor = 0; stop(); show(); });
    document.getElementById('prev').addEventListener('click', function () { cursor = Math.max(0, cursor - 1); show(); });
    document.getElementById('next').addEventListener('click', function () { cursor = Math.min(frames.length - 1, cursor + 1); show(); });
    document.getElementById('play').addEventListener('click', function () {
      if (timer) { stop(); return; }
      timer = setInterval(function () {
        if (cursor >= frames.length - 1) { stop(); return; }
        cursor += 1;
        show();
      }, 800);
    });
    show();
  </script>
</body>
</html>
`;
}
