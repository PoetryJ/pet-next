/**
 * 数据集装载与整批执行。run.mjs 与测试共用，避免两套口径。
 *
 * @module pet-next/experiments/memory-consistency/eval/dataset
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../contracts.ts';
import { describeObservation, loadTrack, runTrack, type Mutation, type TrackFile, type TrackObservation } from './harness.ts';
import { MUTATIONS } from './mutations.ts';
import { scoreDataset, type DatasetScore, type ExpectationFile } from './scorer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 开发集轨迹目录。 */
export const DEV_TRACKS_DIR = join(HERE, '..', 'cases', 'dev');
/** 开发集独立期望。 */
export const DEV_EXPECTATIONS_PATH = join(HERE, 'expected', 'dev.json');
/** 新模板集轨迹目录与独立期望。 */
export const NEW_TRACKS_DIR = join(HERE, '..', 'cases', 'new');
export const NEW_EXPECTATIONS_PATH = join(HERE, 'expected', 'new.json');
/** 派生笔记用例目录：只服务泄漏审计与依赖图回归，不并入开发集基线。 */
export const DERIVED_TRACKS_DIR = join(HERE, '..', 'cases', 'derived');

/** 读取开发集全部轨迹（按文件名排序，保证可复现）。 */
export function loadDevTracks(dir = DEV_TRACKS_DIR): TrackFile[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
  return files.map((name) => loadTrack(join(dir, name)));
}

/** 通用装载：任意轨迹目录。 */
export function loadTracks(dir: string): TrackFile[] {
  return loadDevTracks(dir);
}

/** 读取期望文件。 */
export function loadExpectations(path = DEV_EXPECTATIONS_PATH): ExpectationFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectationFile;
}

/** 整批执行。 */
export function runDataset(
  tracks: readonly TrackFile[],
  options: { readonly mutation?: Mutation } = {},
): readonly TrackObservation[] {
  return tracks.map((track) => runTrack(track, options));
}

/** 一次完整评分：执行 + 求值。 */
export function evaluateDataset(
  tracks: readonly TrackFile[],
  expectations: ExpectationFile,
  options: { readonly mutation?: Mutation } = {},
): { observations: readonly TrackObservation[]; score: DatasetScore } {
  const observations = runDataset(tracks, options);
  return { observations, score: scoreDataset(observations, expectations) };
}

/** 观测摘要，用于确定性比对。 */
export function observationDigest(observations: readonly TrackObservation[]): string {
  return canonicalJson(observations.map((item) => describeObservation(item)));
}

/** 单个负控的结果。 */
export interface MutationReport {
  readonly id: string;
  readonly title: string;
  readonly expectedCaughtBy: readonly string[];
  readonly detected: boolean;
  readonly caughtByExpected: readonly string[];
  readonly failedTracks: readonly string[];
  readonly collateral: readonly string[];
}

/** 跑全部负控：每个都要求被指定反例检出。 */
export function runMutationSuite(
  tracks: readonly TrackFile[],
  expectations: ExpectationFile,
): readonly MutationReport[] {
  return MUTATIONS.map((mutation) => {
    const { score } = evaluateDataset(tracks, expectations, { mutation });
    const failedTracks = score.trackFailures.map((item) => item.trackId);
    const caughtByExpected = mutation.expectedCaughtBy.filter((trackId) => failedTracks.includes(trackId));
    return {
      id: mutation.id,
      title: mutation.title,
      expectedCaughtBy: mutation.expectedCaughtBy,
      detected: caughtByExpected.length > 0,
      caughtByExpected,
      failedTracks,
      collateral: failedTracks.filter((trackId) => !mutation.expectedCaughtBy.includes(trackId)),
    };
  });
}
