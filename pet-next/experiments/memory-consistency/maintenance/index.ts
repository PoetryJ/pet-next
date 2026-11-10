/**
 * 维护层门面。
 *
 * @module pet-next/experiments/memory-consistency/maintenance
 */
export {
  fullRebuild,
  incrementalRebuild,
  changeSetOf,
  noteView,
  activeFactSet,
  deps,
  type BuildOutput,
  type BuildStats,
  type ChangeSet,
  type DesiredNote,
} from './rebuild.ts';
