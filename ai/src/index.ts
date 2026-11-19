export { jointAngle } from './pose/angles';
export type { AngleOptions } from './pose/angles';
export { createMedianFilter, createOneEuroFilter } from './pose/filters';
export type { MedianFilter, OneEuroFilter, OneEuroOptions } from './pose/filters';
export { LANDMARK, extractPairSignals, extractSignal, isPairedMetric } from './pose/signals';
export type {
  Metric,
  PairSignals,
  PairedMetric,
  SingleMetric,
  Signal,
  SignalOptions,
} from './pose/signals';
export { createBaseline } from './pose/baseline';
export type { Baseline, BaselineOptions, BaselineResult } from './pose/baseline';
export { createAlternatingCounter } from './pose/alternating-counter';
export type {
  AlternatingCounter,
  AlternatingCounterConfig,
  AlternatingCounterState,
} from './pose/alternating-counter';
export { createCounterEngine } from './pose/engines';
export type { CounterEngine, EngineFrame, Sensed } from './pose/engines';
export { createRepCounter } from './pose/rep-counter';
export type { RepCounter, RepCounterConfig, RepCounterState, RepPhase } from './pose/rep-counter';
export { createPoseSession } from './pose/pose-session';
export type { FrameInput, FrameResult, PoseSession, PoseSessionOptions } from './pose/pose-session';

export { createSafetyGuard } from './coach/safety-guard';
export type {
  SafetyAction,
  SafetyDecision,
  SafetyFrame,
  SafetyGuard,
  SafetyGuardOptions,
  SafetyReason,
  TrackingQuality,
} from './coach/safety-guard';
export { cueForFrame } from './coach/cues';
export type { CueInput, CueKey } from './coach/cues';
export { EN_MESSAGES } from './coach/messages/en';

export { DEFAULT_EXERCISES } from './exercises/defaults';
export type { ApprovalStatus, Exercise, ExerciseCriteria } from './types/exercise';
export type { Landmark } from './types/landmark';

export { createPizzaCore } from './core/pizza-core';
export type { DeleteResult, PizzaCore, PizzaCoreOptions, SyncResult } from './core/pizza-core';
export { openStorage } from './core/open-storage';
export type { OpenStorageOptions, StorageMode } from './core/open-storage';
export { openIdbStorage } from './core/idb-storage';
export { createMemoryStorage } from './core/storage';
export { createMediaPipeBackend } from './core/pose-backend';
export type {
  LandmarkerLike,
  MediaDevicesLike,
  MediaPipeBackendOptions,
  PoseBackend,
  VisionModule,
} from './core/pose-backend';
export { defaultScheduler } from './core/pose-controller';
export type {
  PoseController,
  PoseHandlers,
  PoseStartOptions,
  PoseSummary,
  Scheduler,
} from './core/pose-controller';
export { CONSENT_PURPOSES } from './core/types';
export type {
  ConsentPurpose,
  ConsentRecord,
  DateRange,
  ExportedData,
  SessionInput,
  SessionStatus,
  Storage,
  StoredSession,
  SyncTransport,
} from './core/types';
export { createSupabaseTransport } from './core/supabase-transport';
export type { SupabaseTransportOptions } from './core/supabase-transport';
