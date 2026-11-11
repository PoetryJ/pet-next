/**
 * R3 入口：跑 8 个固定故事 × 2 臂，写出原始请求、逐条断言与离线演示。
 *
 * 用法：
 *   node --experimental-strip-types product-shadow/shadow.ts --out=<新目录>
 *
 * 每次都必须给新目录：已有 summary.json 时拒绝启动，避免覆盖成功/失败产物。
 *
 * @module pet-next/experiments/memory-consistency/product-shadow/shadow
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupRun, runStory, productSourceHashes } from './runner.ts';
import { finalRequest, scoreStory, summarize, visibleText } from './score.ts';
import type { ArmId, AssertionResult, StoryFile, StoryRun } from './contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 读取生成好的故事与期望。 */
export function loadStories(): { stories: readonly StoryFile[]; expectedSha256: string } {
  const storiesText = readFileSync(join(HERE, 'cases', 'stories.json'), 'utf8');
  const payload = JSON.parse(storiesText) as { stories: StoryFile[] };
  const manifest = JSON.parse(readFileSync(join(HERE, 'expected', 'manifest.json'), 'utf8')) as {
    storiesSha256: string;
    expectedSha256: string;
  };
  const sha = createHash('sha256').update(storiesText).digest('hex');
  if (sha !== manifest.storiesSha256) throw new Error('stories.json 与冻结 hash 不一致');
  return { stories: payload.stories, expectedSha256: manifest.expectedSha256 };
}

/** 只保留证据所需字段，避免把 store 目录等临时信息写进交付。 */
function slimRun(run: StoryRun): Record<string, unknown> {
  return {
    storyId: run.storyId,
    armId: run.armId,
    runId: run.runId,
    turns: run.turns,
    requests: run.requests.map((request) => ({
      turnIndex: request.turnIndex,
      url: request.url,
      bodySha256: request.bodySha256,
      utf16: request.utf16,
      utf8: request.utf8,
      messages: request.messages,
      stubCalls: request.stubCalls,
      realNetworkCalls: request.realNetworkCalls,
    })),
    selection: run.selection,
    fingerprints: run.fingerprints,
    budgetFailures: run.budgetFailures,
    trims: run.trims,
    stubCalls: run.stubCalls,
    realNetworkCalls: run.realNetworkCalls,
    sourceHashes: run.sourceHashes,
  };
}

function renderDemo(data: {
  stories: { storyId: string; title: string; arms: Record<ArmId, { text: string; utf16: number; utf8: number }> }[];
  assertions: AssertionResult[];
  summary: Record<string, unknown>;
}): string {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>R3 会话记忆对照</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbfd;--muted:#6b7280;--line:#d5d7de;--ok:#0f7b3f;--bad:#b3261e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8ea;--bg:#131316;--muted:#9aa0aa;--line:#33363d;--card:#1b1c20;--ok:#5fd39a;--bad:#f2776b}}
body{margin:0;font:14px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{padding:14px 18px;border-bottom:1px solid var(--line)}
h1{font-size:15px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px}
.layout{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 70px)}
nav{border-right:1px solid var(--line);padding:10px}nav button{display:block;width:100%;text-align:left;margin-bottom:6px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);cursor:pointer;font-size:12px}
nav button.active{outline:2px solid var(--ok)}
main{padding:14px 18px;overflow:auto}section{border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px;background:var(--card)}
h2{font-size:12px;color:var(--muted);margin:0 0 8px}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace;margin:0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.badge{font-size:11px;padding:1px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--bad);border-color:var(--bad)}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid var(--line)}
</style></head><body>
<header><h1>R3 会话记忆对照（离线 + stub）</h1>
<div class="sub" id="meta"></div></header>
<div class="layout"><nav id="list"></nav><main>
<section><h2>H 臂实际请求（无记忆）</h2><div id="hStats" class="sub" style="margin-bottom:6px"></div><pre id="hText"></pre></section>
<section><h2>M 臂实际请求（含记忆块）</h2><div id="mStats" class="sub" style="margin-bottom:6px"></div><pre id="mText"></pre></section>
<section><h2>断言</h2><div id="asserts"></div></section>
<section><h2>边界</h2><pre id="boundary"></pre></section>
</main></div>
<script type="application/json" id="payload">${payload}</script>
<script>
(function(){
  var data=JSON.parse(document.getElementById('payload').textContent);
  var state={index:0};var el=function(id){return document.getElementById(id)};
  function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
  function text(tag,value,cls){var n=document.createElement(tag);if(value!==undefined&&value!==null)n.textContent=String(value);if(cls)n.className=cls;return n}
  el('meta').textContent='stub 回答固定为「离线占位回复」；scripted 事件与补丁；真实网络调用 0。';
  function render(){
    var story=data.stories[state.index];
    var list=el('list');clear(list);
    data.stories.forEach(function(item,index){
      var b=text('button',item.storyId+' · '+item.title);
      if(index===state.index)b.className='active';
      b.addEventListener('click',function(){state.index=index;render()});
      list.appendChild(b);
    });
    el('hStats').textContent='utf16='+story.arms.H.utf16+'  utf8='+story.arms.H.utf8;
    el('mStats').textContent='utf16='+story.arms.M.utf16+'  utf8='+story.arms.M.utf8;
    el('hText').textContent=story.arms.H.text;
    el('mText').textContent=story.arms.M.text;
    var box=el('asserts');clear(box);
    var table=text('table');var head=text('tr');
    ['arm','断言','结果','实际'].forEach(function(k){head.appendChild(text('th',k))});
    table.appendChild(head);
    data.assertions.filter(function(a){return a.storyId===story.storyId}).forEach(function(a){
      var tr=text('tr');tr.appendChild(text('td',a.armId));
      tr.appendChild(text('td',a.id));
      var ok=text('td',a.ok?'pass':'fail');ok.className=a.ok?'badge ok':'badge bad';tr.appendChild(ok);
      tr.appendChild(text('td',JSON.stringify(a.actual)));
      table.appendChild(tr);
    });
    box.appendChild(table);
    el('boundary').textContent=JSON.stringify(data.summary,null,1);
  }
  render();
})();
</script></body></html>`;
}

async function main(): Promise<number> {
  const outArg = process.argv.find((item) => item.startsWith('--out='));
  const outDir = outArg === undefined ? '' : outArg.slice('--out='.length);
  if (outDir === '') {
    process.stderr.write('usage: --out=<new directory>\n');
    return 2;
  }
  if (existsSync(join(outDir, 'summary.json'))) {
    process.stderr.write(`refusing to overwrite existing run: ${outDir}\n`);
    return 3;
  }
  mkdirSync(join(outDir, 'requests'), { recursive: true });
  mkdirSync(join(outDir, 'demo'), { recursive: true });

  const { stories, expectedSha256 } = loadStories();
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
  const runs: StoryRun[] = [];
  const assertions: AssertionResult[] = [];

  for (const story of stories) {
    const storyRuns: StoryRun[] = [];
    for (const arm of ['H', 'M'] as ArmId[]) {
      const run = await runStory(story, arm, runId);
      runs.push(run);
      storyRuns.push(run);
      writeFileSync(join(outDir, `story-${story.storyId}-${arm}.json`), `${JSON.stringify(slimRun(run), null, 2)}\n`, 'utf8');
      for (const request of run.requests) {
        writeFileSync(
          join(outDir, 'requests', `${story.storyId}-${arm}-turn${request.turnIndex + 1}.json`),
          `${request.bodyText}\n`,
          'utf8',
        );
      }
      cleanupRun(run);
    }
    assertions.push(...scoreStory(story.storyId, story.expect, storyRuns));
  }

  const summary = summarize(runs, assertions);
  const result = {
    schemaVersion: 'shadow-run/v1',
    runId,
    generatedAt: new Date().toISOString(),
    expectedSha256,
    productSourceHashes: productSourceHashes(),
    stories: stories.map((story) => story.storyId),
    arms: ['H', 'M'],
    summary,
    boundary: {
      realModelPost: 0,
      stubReplies: '离线占位回复',
      events: 'scripted',
      networkSentinel: 'globalThis.fetch 被替换为抛错哨兵，调用数计入 realNetworkCalls',
      budget: { utf16: 4000, utf8: 12000 },
      note: 'stub 回答不构成模型能力；本结果只证明接线、证据选择与预算。',
    },
    assertions,
  };
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const demoStories = stories.map((story) => {
    const h = runs.find((run) => run.storyId === story.storyId && run.armId === 'H');
    const m = runs.find((run) => run.storyId === story.storyId && run.armId === 'M');
    const hReq = h === undefined ? undefined : finalRequest(h);
    const mReq = m === undefined ? undefined : finalRequest(m);
    return {
      storyId: story.storyId,
      title: story.title,
      arms: {
        H: { text: h === undefined ? '' : visibleText(h), utf16: hReq?.utf16 ?? 0, utf8: hReq?.utf8 ?? 0 },
        M: { text: m === undefined ? '' : visibleText(m), utf16: mReq?.utf16 ?? 0, utf8: mReq?.utf8 ?? 0 },
      },
    };
  });
  writeFileSync(
    join(outDir, 'demo', 'index.html'),
    renderDemo({ stories: demoStories, assertions, summary: summary as unknown as Record<string, unknown> }),
    'utf8',
  );

  const failed = assertions.filter((item) => !item.ok);
  process.stdout.write(
    `${failed.length === 0 ? 'PASS' : 'FAIL'} shadow stories=${summary.stories} runs=${summary.runs} assertions=${summary.assertions} failed=${failed.length} stub=${summary.stubCalls} network=${summary.realNetworkCalls}\n`,
  );
  for (const item of failed.slice(0, 8)) {
    process.stdout.write(`  ${item.storyId}/${item.armId} ${item.id}: ${JSON.stringify(item.actual)}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
