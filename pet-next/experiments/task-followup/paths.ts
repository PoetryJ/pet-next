/**
 * 实验内固定路径。所有模块只从这里取根目录，避免各写一份相对路径。
 *
 * @module pet-next/experiments/task-followup/paths
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPERIMENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
export const DEFAULT_WORKSPACE = join(EXPERIMENT_ROOT, 'out', 'workspace')
export const FIXTURES_DIR = join(EXPERIMENT_ROOT, 'fixtures', 'trajectories')
export const GOLD_DIR = join(EXPERIMENT_ROOT, 'gold')
export const EVAL_OUT = join(EXPERIMENT_ROOT, 'out', 'eval')
