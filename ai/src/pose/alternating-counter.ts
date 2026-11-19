import { createRepCounter, type RepPhase } from './rep-counter';

export interface AlternatingCounterConfig {
  upA: number;
  downA: number;
  upB: number;
  downB: number;
  /** Raises faster than this (ms) are treated as noise. */
  minRepMs: number;
}

export interface AlternatingCounterState {
  /** Completed pairs: one raise on one side followed by one on the other. */
  reps: number;
  phase: RepPhase;
  /** Highest value so far among the sides currently mid-raise, or null. */
  currentPeak: number | null;
  /** For each rep, the weaker of its two peaks. */
  repPeaks: number[];
  /** For each rep, from the start of the first raise to the end of the second. */
  repDurationsMs: number[];
  /** Times the same side was raised twice in a row (not alternating). */
  sameSideRepeats: number;
}

export interface AlternatingCounter {
  readonly state: AlternatingCounterState;
  update(a: number, b: number, timestampMs: number): AlternatingCounterState;
  /** Drops any half-finished pair and waits for both sides to be at rest again. */
  abandonRep(): void;
  reset(): void;
}

type Side = 'a' | 'b';

/**
 * Counts "left then right" (or right then left) as one rep. Each side runs its own hysteresis
 * counter; a raise only counts toward a pair if the other side was not raised at the same time.
 * Used for alternating arm raises and for turning the trunk to each side.
 */
export function createAlternatingCounter(config: AlternatingCounterConfig): AlternatingCounter {
  const sideA = createRepCounter({ up: config.upA, down: config.downA, minRepMs: config.minRepMs });
  const sideB = createRepCounter({ up: config.upB, down: config.downB, minRepMs: config.minRepMs });

  let reps = 0;
  let repPeaks: number[] = [];
  let repDurationsMs: number[] = [];
  let sameSideRepeats = 0;
  let firstSide: Side | null = null;
  let pairStartMs = 0;
  let pairPeak = 0;

  const snapshot = (): AlternatingCounterState => {
    const a = sideA.state;
    const b = sideB.state;
    const peaks = [a.currentPeak, b.currentPeak].filter((p): p is number => p !== null);
    let phase: RepPhase = 'waiting';
    if (a.phase === 'up' || b.phase === 'up') phase = 'up';
    else if (a.phase === 'rest' && b.phase === 'rest') phase = 'rest';
    return {
      reps,
      phase,
      currentPeak: peaks.length > 0 ? Math.max(...peaks) : null,
      repPeaks: [...repPeaks],
      repDurationsMs: [...repDurationsMs],
      sameSideRepeats,
    };
  };

  const recordRaise = (side: Side, peak: number, durationMs: number, endMs: number) => {
    const startMs = endMs - durationMs;
    if (firstSide === null) {
      firstSide = side;
    } else if (firstSide === side) {
      sameSideRepeats += 1;
    } else {
      reps += 1;
      repPeaks.push(Math.min(pairPeak, peak));
      repDurationsMs.push(endMs - pairStartMs);
      firstSide = null;
      return;
    }
    pairStartMs = startMs;
    pairPeak = peak;
  };

  return {
    get state() {
      return snapshot();
    },
    update(a, b, timestampMs) {
      const repsBeforeA = sideA.state.reps;
      const repsBeforeB = sideB.state.reps;
      const sa = sideA.update(a, timestampMs);
      const sb = sideB.update(b, timestampMs);
      const doneA = sa.reps > repsBeforeA;
      const doneB = sb.reps > repsBeforeB;

      // A raise made while the other side was also raised is not an alternation: ignore it.
      if (doneA && !doneB && sb.phase !== 'up') {
        recordRaise(
          'a',
          sa.repPeaks.at(-1) as number,
          sa.repDurationsMs.at(-1) as number,
          timestampMs,
        );
      }
      if (doneB && !doneA && sa.phase !== 'up') {
        recordRaise(
          'b',
          sb.repPeaks.at(-1) as number,
          sb.repDurationsMs.at(-1) as number,
          timestampMs,
        );
      }
      if ((doneA && doneB) || (doneA && sb.phase === 'up') || (doneB && sa.phase === 'up')) {
        firstSide = null;
      }
      return snapshot();
    },
    abandonRep() {
      sideA.abandonRep();
      sideB.abandonRep();
      firstSide = null;
    },
    reset() {
      sideA.reset();
      sideB.reset();
      reps = 0;
      repPeaks = [];
      repDurationsMs = [];
      sameSideRepeats = 0;
      firstSide = null;
      pairStartMs = 0;
      pairPeak = 0;
    },
  };
}
