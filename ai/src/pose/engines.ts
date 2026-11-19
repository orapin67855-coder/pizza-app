import type { ExerciseCriteria } from '../types/exercise';
import type { Landmark } from '../types/landmark';
import { createAlternatingCounter } from './alternating-counter';
import { createBaseline } from './baseline';
import { createMedianFilter, createOneEuroFilter } from './filters';
import { createRepCounter, type RepPhase } from './rep-counter';
import {
  extractPairSignals,
  extractSignal,
  isPairedMetric,
  type PairedMetric,
  type SingleMetric,
} from './signals';

/** Raw, unfiltered measurement of one frame. */
export interface Sensed {
  /** Lowest visibility among the landmarks needed (0 when nobody was detected). */
  visibility: number;
  /** One value per channel; NaN where a channel cannot be measured. */
  values: readonly number[];
}

export interface EngineFrame {
  /** Smoothed measurement for display/cues; NaN until the first usable frame. */
  value: number;
  reps: number;
  phase: RepPhase;
  /** True while the person's resting posture is still being learned. */
  calibrating: boolean;
  /** True only on the frame in which a rep was completed. */
  repCompleted: boolean;
}

/**
 * Turns landmarks into reps for one kind of exercise. `sense` is pure; `advance` updates
 * filters and counters and must only be called on frames the safety guard allows.
 */
export interface CounterEngine {
  sense(landmarks: readonly Landmark[] | null): Sensed;
  advance(sensed: Sensed, timestampMs: number): EngineFrame;
  /** Current state without consuming a frame. */
  peek(): EngineFrame;
  /** Drops the rep in progress and the smoothing history (keeps counted reps and calibration). */
  abandonRep(): void;
  reset(): void;
}

const BASELINE_SAMPLES = 20;
const makeSmoother = () => {
  const median = createMedianFilter(3);
  const euro = createOneEuroFilter({ minCutoff: 1.5, beta: 0.02 });
  return {
    apply: (v: number, t: number) => euro.filter(median.push(v), t),
    reset() {
      median.reset();
      euro.reset();
    },
  };
};

const NONE: Sensed = { visibility: 0, values: [NaN] };

function createSingleEngine(metric: SingleMetric, criteria: ExerciseCriteria): CounterEngine {
  const minVisibility = criteria.minVisibility ?? 0.5;
  const counter = createRepCounter({
    up: criteria.up,
    down: criteria.down,
    minRepMs: criteria.minRepMs,
  });
  const smoother = makeSmoother();
  let value = NaN;

  const frame = (repCompleted: boolean): EngineFrame => ({
    value,
    reps: counter.state.reps,
    phase: counter.state.phase,
    calibrating: false,
    repCompleted,
  });

  return {
    sense(landmarks) {
      if (!landmarks || landmarks.length === 0) return NONE;
      const s = extractSignal(metric, landmarks, { minVisibility });
      return { visibility: s.visibility, values: [s.value] };
    },
    advance(sensed, t) {
      const raw = sensed.values[0] as number;
      if (!Number.isFinite(raw)) return frame(false);
      const before = counter.state.reps;
      value = smoother.apply(raw, t);
      counter.update(value, t);
      return frame(counter.state.reps > before);
    },
    peek: () => frame(false),
    abandonRep() {
      counter.abandonRep();
      smoother.reset();
    },
    reset() {
      counter.reset();
      smoother.reset();
      value = NaN;
    },
  };
}

function createPairedEngine(metric: PairedMetric, criteria: ExerciseCriteria): CounterEngine {
  const minVisibility = criteria.minVisibility ?? 0.5;
  const counter = createAlternatingCounter({
    upA: criteria.up,
    downA: criteria.down,
    upB: criteria.up,
    downB: criteria.down,
    minRepMs: criteria.minRepMs,
  });
  const smoothA = makeSmoother();
  const smoothB = makeSmoother();
  const baseline = createBaseline({ samples: BASELINE_SAMPLES });
  const isTrunk = metric === 'trunk-rotation';
  let value = NaN;
  let lastA = NaN;
  let lastB = NaN;

  const frame = (repCompleted: boolean): EngineFrame => ({
    value,
    reps: counter.state.reps,
    phase: counter.state.phase,
    calibrating: isTrunk && !baseline.ready,
    repCompleted,
  });

  const advanceArms = (a: number, b: number, t: number): number => {
    const fa = Number.isFinite(a) ? smoothA.apply(a, t) : NaN;
    const fb = Number.isFinite(b) ? smoothB.apply(b, t) : NaN;
    if (Number.isFinite(fa)) lastA = fa;
    if (Number.isFinite(fb)) lastB = fb;
    counter.update(fa, fb, t);
    const finite = [lastA, lastB].filter(Number.isFinite);
    value = finite.length > 0 ? Math.max(...finite) : NaN;
    return value;
  };

  return {
    sense(landmarks) {
      if (!landmarks || landmarks.length === 0) return { visibility: 0, values: [NaN, NaN] };
      const s = extractPairSignals(metric, landmarks, { minVisibility });
      return { visibility: s.visibility, values: isTrunk ? [s.raw] : [s.a, s.b] };
    },
    advance(sensed, t) {
      const before = counter.state.reps;
      if (isTrunk) {
        const raw = sensed.values[0] as number;
        if (!Number.isFinite(raw)) return frame(false);
        const rel = baseline.update(smoothA.apply(raw, t)).value;
        if (!Number.isFinite(rel)) return frame(false); // still calibrating
        value = rel;
        counter.update(rel, -rel, t);
      } else {
        advanceArms(sensed.values[0] as number, sensed.values[1] as number, t);
      }
      return frame(counter.state.reps > before);
    },
    peek: () => frame(false),
    abandonRep() {
      counter.abandonRep();
      smoothA.reset();
      smoothB.reset();
    },
    reset() {
      counter.reset();
      smoothA.reset();
      smoothB.reset();
      baseline.reset();
      value = NaN;
      lastA = NaN;
      lastB = NaN;
    },
  };
}

export function createCounterEngine(criteria: ExerciseCriteria): CounterEngine {
  return isPairedMetric(criteria.metric)
    ? createPairedEngine(criteria.metric, criteria)
    : createSingleEngine(criteria.metric, criteria);
}
