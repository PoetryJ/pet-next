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
export { BENCH_MODES, BENCH_ROUND_COUNT, BENCH_SAMPLE_COUNT } from './bench.ts';
export type { BenchMode, BenchPlay, BenchRecommendation, BenchSample, BenchSummary } from './bench.ts';
export { BEHAVIOR_LIMITS, PRODUCT_BEHAVIOR_RULES } from './behavior.ts';
export type {
  BehaviorClip,
  BehaviorDeps,
  BehaviorEffect,
  BehaviorFactory,
  BehaviorInput,
  BehaviorScheduler,
  BehaviorStep,
  ProductBehaviorRule,
} from './behavior.ts';
export type { AssetCandidateKind, AssetCandidateManifest, AssetCandidatePlate } from './asset-candidate.ts';
export { REQUIRED_CONTRACT_CASES, REQUIRED_PLATFORM_FLOWS } from './coverage.ts';
export type { RequiredContractCase, RequiredPlatformFlow } from './coverage.ts';
export { MEDIA_SLOT_COUNT } from './media-slot.ts';
export type {
  MediaSlotIndex,
  PreheatNotice,
  SlotClip,
  SlotFailureReason,
  SlotPlayRequest,
  SlotToken,
  TwoSlotAdapter,
  TwoSlotFactory,
  TwoSlotNotice,
  TwoSlotOptions,
} from './media-slot.ts';
export { PLAYBACK_MODES, PREVIEW_ENV, PREVIEW_QUERY, formatPreview, parsePreview, previewUsesAcceptedPath } from './preview.ts';
export type { PlaybackMode, PreviewSelection } from './preview.ts';
