export interface RepCounterConfig {
  /** The measurement must reach this value for a rep to start. */
  up: number;
  /** The measurement must fall back to this value to finish the rep. Must be below `up`. */
  down: number;
  /** Reps that go up and down faster than this are treated as noise. */
  minRepMs: number;
}

/**
 * - waiting: have not yet seen the rest position (a session that starts mid-movement
 *   must not count a rep it never saw begin)
 * - rest: at/below `down`, ready for the next rep
 * - up: reached `up`, waiting to return to rest
 */
export type RepPhase = 'waiting' | 'rest' | 'up';

export interface RepCounterState {
  reps: number;
  phase: RepPhase;
  /** Highest value so far in the rep in progress, or null when not mid-rep. */
  currentPeak: number | null;
  repPeaks: number[];
  repDurationsMs: number[];
}

export interface RepCounter {
  readonly state: RepCounterState;
  update(value: number, timestampMs: number): RepCounterState;
  /**
   * Discards the rep in progress (never counted) and waits for the rest position again.
   * Completed reps are kept. Use after tracking is interrupted.
   */
  abandonRep(): void;
  reset(): void;
}

/**
 * Hysteresis state machine: a rep is one trip rest -> up -> rest.
 * Pure and deterministic; time comes from the caller.
 */
export function createRepCounter(config: RepCounterConfig): RepCounter {
  if (!(config.up > config.down)) throw new RangeError('up must be greater than down');
  if (!(config.minRepMs >= 0)) throw new RangeError('minRepMs must be >= 0');

  let phase: RepPhase = 'waiting';
  let reps = 0;
  let peak: number | null = null;
  let upSince = 0;
  let repPeaks: number[] = [];
  let repDurationsMs: number[] = [];

  const snapshot = (): RepCounterState => ({
    reps,
    phase,
    currentPeak: peak,
    repPeaks: [...repPeaks],
    repDurationsMs: [...repDurationsMs],
  });

  return {
    get state() {
      return snapshot();
    },
    update(value, timestampMs) {
      if (!Number.isFinite(value)) return snapshot();

      if (phase === 'waiting') {
        if (value <= config.down) phase = 'rest';
      } else if (phase === 'rest') {
        if (value >= config.up) {
          phase = 'up';
          upSince = timestampMs;
          peak = value;
        }
      } else {
        peak = Math.max(peak ?? value, value);
        if (value <= config.down) {
          const duration = timestampMs - upSince;
          if (duration >= config.minRepMs) {
            reps += 1;
            repPeaks.push(peak);
            repDurationsMs.push(duration);
          }
          phase = 'rest';
          peak = null;
        }
      }
      return snapshot();
    },
    abandonRep() {
      phase = 'waiting';
      peak = null;
    },
    reset() {
      phase = 'waiting';
      reps = 0;
      peak = null;
      upSince = 0;
      repPeaks = [];
      repDurationsMs = [];
    },
  };
}
