/**
 * 产品与仲裁实验的契约出口。
 * @module pet-next/contracts
 */
export { isDirectRun } from './direct-run.ts';
export { mulberry32 } from './mulberry32.ts';
export { REQUIRED_PLATFORMS, REQUIRED_PROCESS_CASES } from './process-tracker.ts';
export type {
  PlatformMatrixEntry,
  PlatformStatus,
  ProcessRunLog,
  ProcessTracker,
  TrackedCommand,
  TrackedProcess,
} from './process-tracker.ts';
export { REQUIRED_SCALE_CASES } from './coordinates.ts';
export type {
  DipBounds,
  DipPoint,
  PointerAdapter,
  PointerObservation,
  ScaleCaseSpec,
  ScaleMatrixEntry,
  ScaleOrigin,
  ScreenCssPoint,
  ViewportCssPoint,
} from './coordinates.ts';
export { REQUIRED_BACKGROUNDS } from './assets.ts';
export type {
  AssessQuality,
  AssetProcessReport,
  QualityBackground,
  QualityEvidence,
  QualityFrame,
  QualityVerdict,
  SourceMediaProbe,
} from './assets.ts';
export { ARBITER_RANK, REQUIRED_FIXTURE_NAMES, SUSTAINED_LOAD } from './arbiter.ts';
export type {
  Arbiter,
  ArbiterCheckReport,
  ArbiterComparison,
  ArbiterDecision,
  ArbiterEvent,
  ArbiterExample,
  ArbiterFactory,
  ArbiterImplementation,
  ArbiterInput,
  ArbiterOutcome,
  ArbiterReason,
  ArbiterRunLog,
  ArbiterSource,
  ArbiterStep,
  ArbiterStepExpectation,
  ArbiterStepRecord,
} from './arbiter.ts';
export { NORMATIVE_EXAMPLES } from './arbiter-examples.ts';
