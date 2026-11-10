/**
 * 离线证据时间线生成器。
 *
 * 关键约束：
 * - 所有时间线数据在构建时算好并内嵌成 JSON；页面只读结果，不在浏览器里再实现一遍 reducer。
 * - 事件文本一律走 textContent，不拼进 innerHTML。
 * - 单文件、无外部资源、无网络，双击即可打开。
 *
 * @module pet-next/experiments/memory-consistency/runner/demo
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, measureUsage, requestKey, taskKey, type MemoryPolicy, type MemoryState } from '../contracts.ts';
import { traceTrack } from '../eval/harness.ts';
import { loadTracks, DEV_TRACKS_DIR } from '../eval/dataset.ts';
import { reduce } from '../ledger/reduce.ts';
import { fullRebuild } from '../maintenance/rebuild.ts';
import { POLICIES } from '../policies/compile.ts';
import { runAllScenarios } from '../product-replay/replay.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, '..', 'out');

/** 演示场景：三条合成/脚本轨迹 + 一条产品纯模块回放。 */
const SHOWCASE = ['A1-v1', 'B1-v1', 'A6-v1'];

interface StepContext {
  readonly policyId: string;
  readonly text: string;
  readonly utf16: number;
  readonly utf8: number;
  readonly exceeded: boolean;
  readonly diagnostics: readonly string[];
  readonly sourceIds: readonly string[];
}

interface Step {
  readonly sequence: number;
  readonly eventId: string;
  readonly kind: string;
  readonly source: string;
  readonly text: string;
  readonly requests: readonly Record<string, unknown>[];
  readonly tasks: readonly Record<string, unknown>[];
  readonly notes: readonly Record<string, unknown>[];
  readonly contexts: readonly StepContext[];
  readonly maintenance: Record<string, number>;
  readonly rejected: readonly string[];
}

interface DemoScenario {
  readonly trackId: string;
  readonly title: string;
  readonly sourceCategory: string;
  readonly executionCategory: string;
  readonly keyCondition: string;
  readonly steps: readonly Step[];
}

function summariseState(state: MemoryState): {
  requests: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  notes: Record<string, unknown>[];
} {
  return {
    requests: Object.values(state.requests).map((view) => ({
      key: requestKey(view.sessionId, view.sessionEpoch, view.requestId),
      generated: view.generated,
      presented: view.presented,
      acknowledged: view.acknowledged,
      cancelled: view.cancelled,
      failed: view.failed,
      tool: view.toolOutcome,
    })),
    tasks: Object.values(state.tasks).map((task) => ({
      key: taskKey(task.sessionId, task.taskId),
      change: task.change,
      revision: task.revision,
      authority: task.authority,
      candidates: task.candidates.length,
    })),
    notes: Object.values(state.notes).map((note) => ({
      noteId: note.noteId,
      text: note.text,
      status: note.status,
      version: note.version,
      sources: note.sourceEventIds.join(','),
      reason: note.invalidationReason ?? '',
      deps: Object.entries(note.dependencyVersions).map(([key, version]) => `${key}@${version}`).join(' '),
    })),
  };
}

function eventText(event: { kind: string; payload: Record<string, unknown>; requestId?: string; taskId?: string; taskRevision?: number }): string {
  const payload = event.payload;
  const parts: string[] = [];
  if (typeof payload['text'] === 'string') parts.push(payload['text']);
  if (typeof payload['channel'] === 'string') parts.push(`channel=${payload['channel']}`);
  if (typeof payload['ack'] === 'string') parts.push(`ack=${payload['ack']}`);
  if (typeof payload['outcome'] === 'string') parts.push(`tool=${String(payload['toolName'] ?? '')} ${payload['outcome']}`);
  if (typeof payload['change'] === 'string') parts.push(`${payload['change']}(${String(payload['authority'] ?? '')})`);
  const scripted = payload['scripted'];
  if (scripted !== null && typeof scripted === 'object') {
    const record = scripted as Record<string, unknown>;
    parts.push(`scripted: ${String(record['subjectKey'])} = ${String(record['valueText'])}`);
  }
  if (event.requestId !== undefined) parts.push(`req=${event.requestId}`);
  if (event.taskId !== undefined) parts.push(`task=${event.taskId}@r${String(event.taskRevision ?? '')}`);
  return parts.join(' · ');
}

function contextsFor(state: MemoryState, events: MemoryState['events']): StepContext[] {
  return POLICIES.map((policy: MemoryPolicy) => {
    const context = policy.compile({ state, events, query: { text: '当前进展？' }, budget: { utf16Units: 2000, utf8Bytes: 6000 } });
    const usage = measureUsage(context.text);
    return {
      policyId: policy.id,
      text: context.text,
      utf16: usage.utf16Units,
      utf8: usage.utf8Bytes,
      exceeded: context.exceeded,
      diagnostics: context.diagnostics.map((item) => `${item.code}: ${item.detail}`),
      sourceIds: context.sourceIds,
    };
  });
}

async function buildScenario(trackId: string): Promise<DemoScenario> {
  const track = loadTracks(DEV_TRACKS_DIR).find((item) => item.trackId === trackId);
  if (track === undefined) throw new Error(`showcase track missing: ${trackId}`);
  const steps: Step[] = [];
  // 用与评测完全相同的执行器，演示里不会出现「第二套算法」。
  const trace = traceTrack(track);

  for (const stepState of trace.steps) {
    const event = track.events.find((item) => item.sequence === stepState.sequence);
    if (event === undefined) continue;
    const rebuilt = fullRebuild(stepState.state, `demo-${trackId}-${stepState.sequence}`);
    steps.push({
      sequence: stepState.sequence,
      eventId: event.eventId,
      kind: event.kind,
      source: event.source,
      text: eventText(event as never),
      ...summariseState(stepState.state),
      contexts: contextsFor(stepState.state, stepState.state.events),
      maintenance: {
        eventsScanned: rebuilt.stats.eventsScanned,
        notesExamined: rebuilt.stats.notesExamined,
        notesRebuilt: rebuilt.stats.notesRebuilt,
        bytesRead: rebuilt.stats.bytesRead,
        bytesWritten: rebuilt.stats.bytesWritten,
      },
      rejected: stepState.rejected.map((item) => `${item.eventId}: ${item.reason}`),
    });
  }

  // 补丁结论放到最后一步：轨迹里的 patch 是「后台回写」的关键证据。
  const lastStep = steps[steps.length - 1];
  if (lastStep !== undefined) {
    steps[steps.length - 1] = {
      ...lastStep,
      rejected: [...lastStep.rejected, ...trace.patchResults.map((item) => `${item.patchId}: ${item.disposition}/${item.code}`)],
    };
  }

  return {
    trackId: track.trackId,
    title: `${track.pairId} · ${track.keyCondition}`,
    sourceCategory: track.sourceCategory,
    executionCategory: track.executionCategory,
    keyCondition: track.keyCondition,
    steps,
  };
}

async function buildProductScenario(): Promise<DemoScenario> {
  const scenarios = await runAllScenarios();
  const cancel = scenarios.find((item) => item.meta.scenarioId === 'S2');
  if (cancel === undefined) throw new Error('product replay scenario S2 missing');
  const steps: Step[] = [];
  for (let k = 1; k <= cancel.events.length; k += 1) {
    const state = reduce(cancel.events, { openUntilSequence: k }).state;
    const event = cancel.events.find((item) => item.sequence === k);
    if (event === undefined) continue;
    steps.push({
      sequence: k,
      eventId: event.eventId,
      kind: event.kind,
      source: event.source,
      text: eventText(event as never),
      ...summariseState(state),
      contexts: contextsFor(state, state.events),
      maintenance: { eventsScanned: 0, notesExamined: 0, notesRebuilt: 0, bytesRead: 0, bytesWritten: 0 },
      rejected: [],
    });
  }
  return {
    trackId: 'PRODUCT-S2',
    title: '产品回放 S2 · 取消在途请求（注入 Promise，不是真实 Qwen）',
    sourceCategory: cancel.meta.sourceCategory,
    executionCategory: cancel.meta.executionCategory,
    keyCondition: cancel.meta.proves,
    steps,
  };
}

function statusOf(outDir: string, file: string): unknown {
  const path = join(outDir, file);
  if (!existsSync(path)) return { status: 'not_run' };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return {
    status: parsed['passed_gate'] === true ? 'pass' : parsed['passed_gate'] === false ? 'fail' : 'unknown',
    gate: parsed['gate'],
  };
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆一致性实验 · 离线证据时间线</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#fbfbfd; --muted:#6b7280; --line:#d5d7de; --ok:#0f7b3f; --bad:#b3261e; --warn:#8a5a00; --card:#ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8ea; --bg:#131316; --muted:#9aa0aa; --line:#33363d; --card:#1b1c20; --ok:#5fd39a; --bad:#f2776b; --warn:#e2b34a; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color:var(--fg); background:var(--bg); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); }
  h1 { font-size:16px; margin:0 0 6px; }
  .sub { color:var(--muted); font-size:12px; }
  .layout { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 76px); }
  nav { border-right:1px solid var(--line); padding:12px; }
  nav button { display:block; width:100%; text-align:left; padding:8px 10px; margin-bottom:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px; cursor:pointer; font-size:13px; }
  nav button.active { outline:2px solid var(--ok); }
  main { padding:16px 20px; overflow:auto; }
  .bar { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  .badge { font-size:11px; padding:2px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); }
  .badge.ok { color:var(--ok); border-color:var(--ok); }
  .badge.bad { color:var(--bad); border-color:var(--bad); }
  .badge.warn { color:var(--warn); border-color:var(--warn); }
  section { border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:12px; background:var(--card); }
  h2 { font-size:13px; margin:0 0 8px; color:var(--muted); font-weight:600; letter-spacing:.02em; }
  table { border-collapse:collapse; width:100%; font-size:12px; }
  th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
  pre { white-space:pre-wrap; word-break:break-word; margin:0; }
  .tabs { display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
  .tabs button { border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; font-size:12px; }
  .tabs button.active { border-color:var(--ok); color:var(--ok); }
  .meter { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin:4px 0 8px; }
  .meter > div { height:100%; background:var(--ok); width:0; }
  .meter.over > div { background:var(--bad); }
  .muted { color:var(--muted); }
  input[type=range] { width:100%; }
  .kv { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:6px 16px; font-size:12px; }
  .kv div span { color:var(--muted); margin-right:6px; }
</style>
</head>
<body>
<header>
  <h1>记忆一致性实验 · 离线证据时间线</h1>
  <div class="sub" id="meta"></div>
</header>
<div class="layout">
  <nav id="scenarios"></nav>
  <main>
    <div class="bar">
      <button id="prev">上一步</button>
      <button id="next">下一步</button>
      <span id="stepLabel" class="badge"></span>
      <span id="cat" class="badge"></span>
      <span id="exec" class="badge"></span>
    </div>
    <div id="trackTitle" class="sub" style="margin-bottom:10px"></div>
    <section>
      <h2>当前事件</h2>
      <div id="eventBox"></div>
    </section>
    <section>
      <h2>当时可见状态（只读构建时结果）</h2>
      <div id="stateBox"></div>
    </section>
    <section>
      <h2>当时实际送入策略的上下文</h2>
      <div class="tabs" id="policyTabs"></div>
      <div class="kv" id="budgetBox"></div>
      <div class="meter" id="meter16"><div></div></div>
      <div class="meter" id="meter8"><div></div></div>
      <pre id="contextBox"></pre>
      <div id="diagBox" class="sub" style="margin-top:8px"></div>
    </section>
    <section>
      <h2>维护工作量（该步骤全量重建）</h2>
      <div class="kv" id="maintBox"></div>
      <div id="rejectedBox" class="sub" style="margin-top:8px"></div>
    </section>
    <section>
      <h2>门禁摘要</h2>
      <div class="kv" id="gateBox"></div>
      <p class="sub" id="disclaimer"></p>
    </section>
  </main>
</div>
<script type="application/json" id="payload">__PAYLOAD__</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('payload').textContent);
  var state = { scenario: 0, step: 0, policy: 0 };
  var el = function (id) { return document.getElementById(id); };

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function text(tag, value, cls) {
    var node = document.createElement(tag);
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (cls) node.className = cls;
    return node;
  }

  function renderScenarioList() {
    var nav = el('scenarios');
    clear(nav);
    data.scenarios.forEach(function (scenario, index) {
      var button = text('button', scenario.trackId + ' · ' + scenario.sourceCategory);
      if (index === state.scenario) button.className = 'active';
      button.addEventListener('click', function () { state.scenario = index; state.step = 0; render(); });
      nav.appendChild(button);
    });
  }

  function renderMeta() {
    var meta = el('meta');
    clear(meta);
    meta.appendChild(text('span', data.generatedAt + ' · 构建时预计算，页面不含实验算法 · Node ' + data.node, ''));
  }

  function current() { return data.scenarios[state.scenario]; }

  function renderState(step) {
    var box = el('stateBox');
    clear(box);
    [['请求', step.requests, ['key','generated','presented','acknowledged','cancelled','failed','tool']],
     ['任务', step.tasks, ['key','change','revision','authority','candidates']],
     ['笔记', step.notes, ['noteId','status','version','text','sources','reason','deps']]].forEach(function (group) {
      var section = text('div');
      section.appendChild(text('h2', group[0]));
      if (group[1].length === 0) { section.appendChild(text('div', '（无）', 'muted')); box.appendChild(section); return; }
      var table = text('table');
      var head = text('tr');
      group[2].forEach(function (key) { head.appendChild(text('th', key)); });
      table.appendChild(head);
      group[1].forEach(function (row) {
        var tr = text('tr');
        group[2].forEach(function (key) {
          var td = text('td', row[key] === undefined || row[key] === '' ? '—' : row[key]);
          if (key === 'status') {
            td.className = row[key] === 'invalidated' ? 'badge bad' : row[key] === 'active' ? 'badge ok' : 'badge';
          }
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      section.appendChild(table);
      box.appendChild(section);
    });
  }

  function renderPolicies(step) {
    var tabs = el('policyTabs');
    clear(tabs);
    step.contexts.forEach(function (context, index) {
      var button = text('button', context.policyId);
      if (index === state.policy) button.className = 'active';
      button.addEventListener('click', function () { state.policy = index; render(); });
      tabs.appendChild(button);
    });
    var context = step.contexts[state.policy] || step.contexts[0];
    var budget = 2000;
    el('budgetBox').textContent = '';
    var kv = el('budgetBox');
    clear(kv);
    [['UTF-16 用量', context.utf16 + ' / ' + budget], ['UTF-8 用量', context.utf8 + ' / 6000'], ['是否超限', context.exceeded ? '是（显式失败）' : '否'], ['来源 id', context.sourceIds.join(', ') || '（无）']].forEach(function (pair) {
      var item = text('div'); item.appendChild(text('span', pair[0])); item.appendChild(text('b', pair[1])); kv.appendChild(item);
    });
    var meter16 = el('meter16');
    meter16.className = 'meter' + (context.utf16 > budget ? ' over' : '');
    meter16.firstElementChild.style.width = Math.min(100, Math.round((context.utf16 / budget) * 100)) + '%';
    var meter8 = el('meter8');
    meter8.className = 'meter' + (context.utf8 > 6000 ? ' over' : '');
    meter8.firstElementChild.style.width = Math.min(100, Math.round((context.utf8 / 6000) * 100)) + '%';
    el('contextBox').textContent = context.text;
    el('diagBox').textContent = context.diagnostics.length === 0 ? '诊断：无' : '诊断：' + context.diagnostics.join(' | ');
  }

  function renderEvent(step) {
    var box = el('eventBox');
    clear(box);
    var kv = text('div', undefined, 'kv');
    [['#', step.sequence], ['eventId', step.eventId], ['kind', step.kind], ['source', step.source]].forEach(function (pair) {
      var item = text('div'); item.appendChild(text('span', pair[0])); item.appendChild(text('b', String(pair[1]))); kv.appendChild(item);
    });
    box.appendChild(kv);
    var line = text('p', step.text);
    line.style.marginBottom = '0';
    box.appendChild(line);
  }

  function renderMaint(step) {
    var kv = el('maintBox');
    clear(kv);
    [['扫描事件', step.maintenance.eventsScanned], ['检查槽位', step.maintenance.notesExamined], ['重写笔记', step.maintenance.notesRebuilt],
     ['读取字节', step.maintenance.bytesRead], ['写入字节', step.maintenance.bytesWritten]].forEach(function (pair) {
      var item = text('div'); item.appendChild(text('span', pair[0])); item.appendChild(text('b', String(pair[1]))); kv.appendChild(item);
    });
    el('rejectedBox').textContent = step.rejected.length === 0 ? '本轮无拒绝记录' : '拒绝/补丁结果：' + step.rejected.join(' | ');
  }

  function render() {
    var scenario = current();
    if (scenario === undefined) return;
    if (state.step >= scenario.steps.length) state.step = scenario.steps.length - 1;
    var step = scenario.steps[state.step];
    el('trackTitle').textContent = scenario.title;
    el('stepLabel').textContent = '步骤 ' + (state.step + 1) + ' / ' + scenario.steps.length;
    el('cat').textContent = 'source: ' + scenario.sourceCategory;
    el('exec').textContent = 'execution: ' + scenario.executionCategory;
    renderScenarioList();
    if (step === undefined) return;
    renderEvent(step);
    renderState(step);
    renderPolicies(step);
    renderMaint(step);
  }

  function renderGates() {
    var kv = el('gateBox');
    clear(kv);
    data.gates.forEach(function (gate) {
      var item = text('div');
      item.appendChild(text('span', gate.id));
      item.appendChild(text('b', gate.status));
      kv.appendChild(item);
    });
    el('disclaimer').textContent = data.disclaimer;
  }

  el('prev').addEventListener('click', function () { if (state.step > 0) { state.step -= 1; render(); } });
  el('next').addEventListener('click', function () { var scenario = current(); if (scenario && state.step < scenario.steps.length - 1) { state.step += 1; render(); } });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') el('prev').click();
    if (event.key === 'ArrowRight') el('next').click();
  });

  renderMeta();
  renderScenarioList();
  render();
  renderGates();
})();
</script>
</body>
</html>
`;

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : OUT_ROOT;
  if (outDir === undefined) throw new Error('--out needs a value');

  const scenarios: DemoScenario[] = [];
  for (const trackId of SHOWCASE) {
    scenarios.push(await buildScenario(trackId));
  }
  scenarios.push(await buildProductScenario());

  const gates = [
    { id: 'G1', ...((statusOf(outDir, 'g1.json')) as Record<string, unknown>) },
    { id: 'P1', ...((statusOf(outDir, 'p1.json')) as Record<string, unknown>) },
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    scenarios,
    gates,
    disclaimer:
      '本页只渲染构建时算好的结果，不在浏览器里重算。synthetic/scripted 表示合成输入与确定性脚本抽取；product-replay 表示只读导入产品纯模块并注入 Promise，不是真实 Qwen 生成。页面不含任何模型能力分数。',
  };

  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
  const html = HTML.replace('__PAYLOAD__', serialized);
  const demoDir = join(outDir, 'demo');
  mkdirSync(demoDir, { recursive: true });
  writeFileSync(join(demoDir, 'index.html'), html, 'utf8');

  const size = Buffer.byteLength(html, 'utf8');
  const digest = canonicalJson({ scenarios: scenarios.map((item) => item.trackId), steps: scenarios.map((item) => item.steps.length) });
  process.stdout.write(`demo written: ${join(demoDir, 'index.html')} (${size} bytes) ${digest}\n`);
}

await main();
