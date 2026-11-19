/** Sliding-window median. Removes single-frame spikes (e.g. a bad landmark). */
export interface MedianFilter {
  push(value: number): number;
  reset(): void;
}

export function createMedianFilter(size = 3): MedianFilter {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
  let window: number[] = [];
  let last = NaN;

  return {
    push(value) {
      if (!Number.isFinite(value)) return last;
      window.push(value);
      if (window.length > size) window.shift();
      const sorted = [...window].sort((p, q) => p - q);
      const mid = sorted.length >> 1;
      last =
        sorted.length % 2 === 1
          ? (sorted[mid] as number)
          : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
      return last;
    },
    reset() {
      window = [];
      last = NaN;
    },
  };
}

export interface OneEuroOptions {
  /** Lower = smoother at rest (Hz). */
  minCutoff?: number;
  /** Higher = less lag during fast movement. */
  beta?: number;
  /** Cutoff for the derivative estimate (Hz). */
  dCutoff?: number;
}

/**
 * One Euro filter (Casiez et al., 2012): adaptive low-pass that smooths tremor
 * when the signal is slow and follows quickly when it moves fast.
 */
export interface OneEuroFilter {
  filter(value: number, timestampMs: number): number;
  reset(): void;
}

const MIN_DT_S = 1e-3;

const smoothingFactor = (cutoffHz: number, dtSeconds: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
};

export function createOneEuroFilter(options: OneEuroOptions = {}): OneEuroFilter {
  const minCutoff = options.minCutoff ?? 1.0;
  const beta = options.beta ?? 0.007;
  const dCutoff = options.dCutoff ?? 1.0;

  let initialised = false;
  let prevRaw = 0;
  let prevOut = NaN;
  let prevDeriv = 0;
  let prevT = 0;

  return {
    filter(value, timestampMs) {
      if (!Number.isFinite(value)) return prevOut;
      if (!initialised) {
        initialised = true;
        prevRaw = value;
        prevOut = value;
        prevDeriv = 0;
        prevT = timestampMs;
        return value;
      }
      const dt = Math.max((timestampMs - prevT) / 1000, MIN_DT_S);
      prevT = Math.max(prevT, timestampMs);

      const rawDeriv = (value - prevRaw) / dt;
      const aD = smoothingFactor(dCutoff, dt);
      prevDeriv = aD * rawDeriv + (1 - aD) * prevDeriv;

      const cutoff = minCutoff + beta * Math.abs(prevDeriv);
      const a = smoothingFactor(cutoff, dt);
      prevOut = a * value + (1 - a) * prevOut;
      prevRaw = value;
      return prevOut;
    },
    reset() {
      initialised = false;
      prevOut = NaN;
      prevDeriv = 0;
    },
  };
}
