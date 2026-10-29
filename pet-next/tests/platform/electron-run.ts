/**
 * 默认缩放下跑完全部桌宠流程，模拟缩放只再核对拖动。
 * 退出码在 `stop` 之前读取，避免清理动作把残留进程杀掉后看起来像自己退出。
 * @module pet-next/tests/platform/electron-run
 */
import path from 'node:path';

import { pidIsAlive } from '../support/process-table.ts';
import { checkClamp, checkClick, checkDrag, checkTransparent, waitIdle, writeNotes } from './checks.ts';
import { flowRow, type FlowRow, type ScaleObservation } from './matrix.ts';
import { openDecoy, type Decoy } from './process-cases.ts';
import { aliveTracked, closePet, evaluate, openPet, petRoot, relativeToPet, type PetSession } from './session.ts';

export interface ElectronFlows {
  flows: FlowRow[];
  defaultScale: ScaleObservation;
  simulated: ScaleObservation[];
}

const SIMULATED = [
  { id: 'simulated-100' as const, forced: 1, label: 'platform-sim-100' },
  { id: 'simulated-125' as const, forced: 1.25, label: 'platform-sim-125' },
  { id: 'simulated-150' as const, forced: 1.5, label: 'platform-sim-150' },
];

export async function runElectronFlows(host: NodeJS.Platform, osScale: number | null): Promise<ElectronFlows> {
  const platform = host === 'win32' ? 'win32' : 'linux';
  const decoy = await openDecoy();
  let session: PetSession | undefined;
  try {
    session = await openPet({ label: 'platform-default', forced: null });
    const ready = session.ready;
    const idle = await waitIdle(session);
    const transparent = await checkTransparent(session);
    const click = await checkClick(session);
    const drag = await checkDrag(session, click.trace || idle);
    const clamp = drag.ok ? await checkClamp(session, drag.trace) : { ok: false, reason: '拖动未通过，不再夹边' };
    const quit = await quitPet(session, decoy);
    const evidencePath = await finish(session);
    session = undefined;
    if (evidencePath !== 'tests/platform/electron-run.ts') {
      await writeNotes(absFromRelative(evidencePath), { transparent, click, drag, clamp, quit, ready });
    }
    return {
      flows: [
        flowRow('click', platform, click.ok ? 'passed' : 'failed', click.reason, evidencePath),
        flowRow('drag', platform, drag.ok && clamp.ok ? 'passed' : 'failed', drag.reason ?? clamp.reason, evidencePath),
        flowRow('transparent', platform, transparent.ok ? 'passed' : 'failed', transparent.reason, evidencePath),
        flowRow('quit', platform, quit.exitCode === 0 ? 'passed' : 'failed', quit.reason, evidencePath),
        flowRow('process-cleanup', platform, quit.cleanupOk ? 'passed' : 'failed', quit.cleanupReason, evidencePath),
      ],
      defaultScale: scaleObservation('default', host, osScale, ready, drag.ok ? null : drag.reason, drag.devicePixelRatio, drag.ok, evidencePath, null),
      simulated: await runSimulated(host, osScale),
    };
  } catch (error) {
    const evidencePath = session ? await finish(session) : 'tests/platform/electron-run.ts';
    session = undefined;
    const message = error instanceof Error ? error.message : String(error);
    return failedElectron(platform, host, osScale, message, evidencePath);
  } finally {
    if (session) await closePet(session);
    await decoy.close();
  }
}

async function runSimulated(host: NodeJS.Platform, osScale: number | null): Promise<ScaleObservation[]> {
  const rows: ScaleObservation[] = [];
  for (const item of SIMULATED) {
    let session: PetSession | undefined;
    try {
      session = await openPet({ label: item.label, forced: item.forced });
      const ready = session.ready;
      const idle = await waitIdle(session);
      const drag = await checkDrag(session, idle);
      const evidencePath = await finish(session);
      session = undefined;
      if (evidencePath !== 'tests/platform/electron-run.ts') {
        await writeNotes(absFromRelative(evidencePath), { ready, drag });
      }
      rows.push(
        scaleObservation(item.id, host, osScale, ready, drag.ok ? null : drag.reason, drag.devicePixelRatio, drag.ok, evidencePath, item.forced),
      );
    } catch (error) {
      const evidencePath = session ? await finish(session) : 'tests/platform/electron-run.ts';
      rows.push(
        scaleObservation(
          item.id,
          host,
          osScale,
          null,
          error instanceof Error ? error.message : String(error),
          null,
          false,
          evidencePath,
          item.forced,
        ),
      );
    }
  }
  return rows;
}

function scaleObservation(
  id: ScaleObservation['id'],
  host: NodeJS.Platform,
  osScale: number | null,
  ready: PetSession['ready'] | null,
  error: string | null,
  devicePixelRatio: number | null,
  dragOk: boolean,
  evidencePath: string,
  forcedArg: number | null,
): ScaleObservation {
  const screenError = ready && ready.displayCount !== 1 ? `显示器数量 ${ready.displayCount}，本轮只验收单屏` : null;
  return {
    id,
    host,
    osScale,
    forcedArg,
    reportedForced: ready?.forcedDeviceScaleFactor ?? null,
    reportedSource: ready?.scaleSource ?? null,
    reportedScale: ready?.scaleFactor ?? null,
    devicePixelRatio,
    dragOk,
    evidencePath,
    error: error ?? screenError,
  };
}

async function quitPet(session: PetSession, decoy: Decoy): Promise<{
  exitCode: number | null;
  reason: string | null;
  cleanupOk: boolean;
  cleanupReason: string | null;
}> {
  try {
    await evaluate(session.cdp, 'window.pet.quit()');
  } catch {
    // 进程退出时调试连接会断开。
  }
  let exitCode: number | null;
  try {
    exitCode = await waitExit(session);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: null, reason, cleanupOk: false, cleanupReason: reason };
  }
  const alive = await aliveTracked(session.tracked);
  const decoyAlive = pidIsAlive(decoy.pid);
  const cleanupOk = exitCode === 0 && alive.length === 0 && decoyAlive;
  return {
    exitCode,
    reason: exitCode === 0 ? null : `退出码 ${exitCode}`,
    cleanupOk,
    cleanupReason: cleanupOk ? null : `exit=${exitCode} alive=${alive.join(',') || 'none'} decoyAlive=${decoyAlive}`,
  };
}

function failedElectron(
  platform: FlowRow['platform'],
  host: NodeJS.Platform,
  osScale: number | null,
  message: string,
  evidencePath: string,
): ElectronFlows {
  return {
    flows: (['click', 'drag', 'transparent', 'quit', 'process-cleanup'] as const).map((flow) =>
      flowRow(flow, platform, 'failed', message, evidencePath),
    ),
    defaultScale: scaleObservation('default', host, osScale, null, message, null, false, evidencePath, null),
    simulated: SIMULATED.map((item) =>
      scaleObservation(item.id, host, osScale, null, message, null, false, evidencePath, item.forced),
    ),
  };
}

async function finish(session: PetSession): Promise<string> {
  const recordDir = await closePet(session);
  return recordDir ? relativeToPet(recordDir) : 'tests/platform/electron-run.ts';
}

function absFromRelative(relativePath: string): string {
  return path.join(petRoot(), relativePath);
}

function waitExit(session: PetSession): Promise<number | null> {
  const child = session.tracked.child;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`exit timeout\n${session.stderr()}`)), 10000);
    if (child.exitCode !== null) {
      clearTimeout(timer);
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
