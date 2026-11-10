/**
 * 离线演示的结构与内容校验。
 *
 * 说明：这里没有真实浏览器，所以断言的是「生成物本身」：
 * 内嵌数据能否解析、页面是否自包含、要求演示的三段事实是否真的出现在时间线里。
 * 交互（点击、键盘）未在浏览器实测，报告里标 not-run。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT = join(HERE, '..');
const OUT = join(EXPERIMENT, 'out');
const DEMO = join(OUT, 'demo', 'index.html');

function buildDemo(): void {
  execFileSync(process.execPath, [join(EXPERIMENT, 'run.mjs'), '--demo', `--out=${OUT}`], {
    cwd: join(EXPERIMENT, '..', '..'),
    stdio: 'pipe',
    timeout: 300_000,
  });
}

interface DemoStep {
  readonly sequence: number;
  readonly notes: readonly { readonly noteId: string; readonly status: string }[];
  readonly requests: readonly Record<string, unknown>[];
  readonly tasks: readonly Record<string, unknown>[];
  readonly contexts: readonly { readonly policyId: string; readonly text: string; readonly utf16: number }[];
}

interface DemoPayload {
  readonly scenarios: readonly { readonly trackId: string; readonly sourceCategory: string; readonly steps: readonly DemoStep[] }[];
  readonly gates: readonly { readonly id: string; readonly status: string }[];
}

describe('离线演示', () => {
  test('生成物存在且自包含', () => {
    buildDemo();
    assert.equal(existsSync(DEMO), true);
    const html = readFileSync(DEMO, 'utf8');
    assert.ok(html.length > 10_000);
    assert.equal(/https?:\/\//.test(html), false, 'demo must not reference the network');
    assert.equal(/\ssrc=/.test(html), false, 'demo must not load external resources');
    assert.equal(/innerHTML/.test(html), false, 'event text must be set via textContent');
    assert.ok(html.includes('textContent'));
    assert.ok(html.includes('type="application/json"'));
  });

  test('内嵌数据可解析，四个场景各带完整步骤与四策略上下文', () => {
    const html = readFileSync(DEMO, 'utf8');
    const match = /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match !== null, 'payload block missing');
    const payload = JSON.parse(match[1] ?? '') as DemoPayload;
    assert.equal(payload.scenarios.length, 4);
    for (const scenario of payload.scenarios) {
      assert.ok(scenario.steps.length >= 2, scenario.trackId);
      for (const step of scenario.steps) {
        assert.equal(step.contexts.length, 4, `${scenario.trackId}#${step.sequence}`);
      }
    }
  });

  test('必演事实一：取消后旧摘要被拒（A1-v1 里 n1 从 active 变 invalidated）', () => {
    const html = readFileSync(DEMO, 'utf8');
    const payload = JSON.parse(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as DemoPayload;
    const scenario = payload.scenarios.find((item) => item.trackId === 'A1-v1');
    assert.ok(scenario !== undefined);
    const statuses = scenario.steps.map((step) => step.notes.find((note) => note.noteId === 'n1')?.status ?? 'absent');
    assert.ok(statuses.includes('active'), `expected an active phase, got ${statuses.join(',')}`);
    assert.ok(statuses.includes('invalidated'), `expected invalidation, got ${statuses.join(',')}`);
    const last = scenario.steps[scenario.steps.length - 1];
    const task = last?.tasks[0];
    assert.equal(task?.['change'], 'cancelled');
  });

  test('必演事实二：生成不等于呈现（B1-v1 两步：先生成，再呈现）', () => {
    const html = readFileSync(DEMO, 'utf8');
    const payload = JSON.parse(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as DemoPayload;
    const scenario = payload.scenarios.find((item) => item.trackId === 'B1-v1');
    const first = scenario?.steps[0]?.requests[0];
    assert.equal(first?.['generated'], true);
    assert.equal(first?.['presented'], false, '生成后立即为真就不是独立事实了');
    const last = scenario?.steps[scenario.steps.length - 1]?.requests[0];
    assert.equal(last?.['presented'], true);
    assert.equal(last?.['acknowledged'], false, '呈现不得升级为已读');
  });

  test('必演事实三：任务正常继续（A6-v1 请求取消但任务仍 created）', () => {
    const html = readFileSync(DEMO, 'utf8');
    const payload = JSON.parse(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as DemoPayload;
    const scenario = payload.scenarios.find((item) => item.trackId === 'A6-v1');
    const last = scenario?.steps[scenario.steps.length - 1];
    assert.equal(last?.tasks[0]?.['change'], 'created');
    assert.equal(last?.requests[0]?.['cancelled'], true);
  });

  test('场景分类标在页面上，产品回放不与合成轨迹混称', () => {
    const html = readFileSync(DEMO, 'utf8');
    const payload = JSON.parse(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as DemoPayload;
    const categories = new Set(payload.scenarios.map((item) => item.sourceCategory));
    assert.deepEqual([...categories].sort(), ['product-replay', 'synthetic']);
    const product = payload.scenarios.find((item) => item.sourceCategory === 'product-replay');
    assert.ok(product !== undefined);
  });
});
