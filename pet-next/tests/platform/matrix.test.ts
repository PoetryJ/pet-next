/**
 * 矩阵记账：通过必须有证据，not-run 不是通过，系统缩放和模拟缩放分开。
 */
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUIRED_SCALE_CASES } from '../../contracts/index.ts';
import {
  auditReport,
  scaleRowFromObservation,
  verdictOf,
  type PlatformReport,
  type ScaleObservation,
} from './matrix.ts';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('失败优先于未跑，未跑不是通过', () => {
  assert.equal(verdictOf(['passed', 'passed']), 'passed');
  assert.equal(verdictOf(['passed', 'not-run']), 'incomplete');
  assert.equal(verdictOf(['not-run', 'failed']), 'failed');
});

test('Linux 上 scaleFactor 为 1 也不能写成 system-100', () => {
  const row = scaleRowFromObservation(observed('system-100', { host: 'linux', reportedScale: 1, reportedSource: 'os' }));
  assert.equal(row.status, 'not-run');
  assert.equal(row.observedScaleFactor, null);
  assert.equal(row.evidencePath, null);
  assert.match(row.reason ?? '', /不能填到系统缩放行/);
});

test('模拟缩放的证据不能记成系统缩放', () => {
  const row = scaleRowFromObservation(
    observed('system-125', {
      host: 'win32',
      osScale: 1.25,
      forcedArg: 1.25,
      reportedForced: 1.25,
      reportedSource: 'simulated-chromium-flag',
      reportedScale: 1.25,
      dragOk: true,
      evidencePath: 'logs/simulated.json',
    }),
  );
  assert.equal(row.status, 'failed');
  assert.match(row.reason ?? '', /强制缩放/);
});

test('系统 DPI 不符的行保持 not-run，匹配的行才看 Electron', () => {
  const skipped = scaleRowFromObservation(
    observed('system-150', { host: 'win32', osScale: 1.25, reportedScale: 1.25, reportedSource: 'os', dragOk: true }),
  );
  assert.equal(skipped.status, 'not-run');
  assert.equal(skipped.observedScaleFactor, null);
  const passed = scaleRowFromObservation(
    observed('system-125', {
      host: 'win32',
      osScale: 1.25,
      reportedScale: 1.25,
      reportedSource: 'os',
      dragOk: true,
      evidencePath: 'logs/system-125.json',
    }),
  );
  assert.equal(passed.status, 'passed');
  assert.equal(passed.origin, 'system');
  assert.equal(passed.scaleSource, 'os');
  assert.equal(passed.forcedDeviceScaleFactor, null);
});

test('default 记录实测值，不要求等于 1', () => {
  const row = scaleRowFromObservation(
    observed('default', { reportedScale: 1.25, reportedSource: 'os', dragOk: true, evidencePath: 'logs/default.json' }),
  );
  assert.equal(row.status, 'passed');
  assert.equal(row.observedScaleFactor, 1.25);
  assert.equal(row.origin, 'default');
});

test('模拟行必须对上强制值和拖动', () => {
  const passed = scaleRowFromObservation(
    observed('simulated-150', {
      forcedArg: 1.5,
      reportedForced: 1.5,
      reportedSource: 'simulated-chromium-flag',
      reportedScale: 1.5,
      dragOk: true,
      evidencePath: 'logs/simulated-150.json',
    }),
  );
  assert.equal(passed.status, 'passed');
  const missed = scaleRowFromObservation(
    observed('simulated-150', {
      forcedArg: 1.5,
      reportedForced: 1.5,
      reportedSource: 'simulated-chromium-flag',
      reportedScale: 1.5,
      dragOk: false,
      evidencePath: 'logs/simulated-150.json',
    }),
  );
  assert.equal(missed.status, 'failed');
});

test('已提交的矩阵没有把未跑写成通过', async () => {
  const body = JSON.parse(await readFile(new URL('./evidence/matrix.json', import.meta.url), 'utf8')) as PlatformReport;
  assert.deepEqual(auditReport(body), []);
  assert.equal(body.verdict, 'incomplete');
  assert.equal(body.host, 'linux');
  assert.equal(body.osScale, null);
  for (const row of body.processes) {
    if (row.platform === 'win32') assert.equal(row.status, 'not-run');
  }
  for (const row of body.flows) {
    if (row.platform === 'win32') assert.equal(row.status, 'not-run');
  }
  for (const row of body.scales) {
    if (row.origin === 'system') {
      assert.equal(row.status, 'not-run');
      assert.equal(row.observedScaleFactor, null);
    }
    if (row.origin === 'simulated' && row.status === 'passed') assert.equal(row.scaleSource, 'simulated-chromium-flag');
    if (row.status === 'passed' && row.evidencePath) await access(path.join(petRoot, row.evidencePath));
  }
  for (const row of body.flows) {
    if (row.status === 'passed' && row.evidencePath) await access(path.join(petRoot, row.evidencePath));
  }
  for (const row of body.processes) {
    if (row.status === 'passed') await access(path.join(petRoot, row.evidencePath));
  }
  assert.equal(body.scales.length, REQUIRED_SCALE_CASES.length);
});

function observed(id: ScaleObservation['id'], patch: Partial<ScaleObservation>): ScaleObservation {
  return {
    id,
    host: 'linux',
    osScale: null,
    forcedArg: null,
    reportedForced: null,
    reportedSource: null,
    reportedScale: null,
    devicePixelRatio: null,
    dragOk: null,
    evidencePath: null,
    error: null,
    ...patch,
  };
}
