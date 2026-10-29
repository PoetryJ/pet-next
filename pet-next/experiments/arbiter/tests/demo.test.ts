/**
 * 演示页同时带上两种回放，并标出执行、等待和丢弃。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { buildDemo, renderServedPage, type DemoModel } from '../demo/build-demo.ts';

describe('buildDemo', () => {
  test('写出可切换的页面，素材指向现有 webm 和占位图', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'arbiter-demo-'));
    const built = await buildDemo({ outDir });
    assert.equal(built.code, 0);
    assert.ok(built.model);
    const html = await readFile(built.htmlPath, 'utf8');
    assert.equal(html.includes('idle.webm'), true);
    assert.equal(html.includes('reaction.webm'), true);
    assert.equal(html.includes('placeholder.png'), true);
    assert.equal(html.includes('baseline'), true);
    assert.equal(html.includes('state-machine'), true);
    assert.equal(html.includes('执行'), true);
    assert.equal(html.includes('等待'), true);
    assert.equal(html.includes('丢弃'), true);
    assert.equal(html.includes('../../../../assets/'), true);
    for (const frames of [built.model.baseline, built.model.stateMachine]) {
      assert.equal(frames.some((frame) => frame.decisions.some((decision) => decision.outcome === 'execute')), true);
      assert.equal(frames.some((frame) => frame.decisions.some((decision) => decision.outcome === 'wait')), true);
      assert.equal(frames.some((frame) => frame.decisions.some((decision) => decision.outcome === 'discard')), true);
      assert.equal(frames.some((frame) => frame.decisions.some((decision) => decision.reason === 'drag-blocks-auto')), true);
      assert.equal(frames.some((frame) => frame.decisions.some((decision) => decision.reason === 'queued-lower-rank')), true);
    }
    const served = renderServedPage(built.model);
    assert.equal(served.includes('/assets/idle.webm'), true);
    const trace = JSON.parse(await readFile(path.join(outDir, 'trace.json'), 'utf8')) as DemoModel;
    assert.equal(trace.baseline.length, trace.stateMachine.length);
  });
});
