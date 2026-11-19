export interface BaselineOptions {
  /** How many usable samples to collect before the baseline is fixed. */
  samples: number;
}

export interface BaselineResult {
  ready: boolean;
  /** Input minus the baseline; NaN while calibrating or for non-finite input. */
  value: number;
}

/**
 * Learns a person's resting value from the first N usable samples (median, so one bad
 * frame cannot skew it) and reports later values relative to it.
 */
export interface Baseline {
  update(value: number): BaselineResult;
  readonly ready: boolean;
  reset(): void;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export function createBaseline(options: BaselineOptions): Baseline {
  if (!Number.isInteger(options.samples) || options.samples < 1) {
    throw new RangeError('samples must be a positive integer');
  }
  let collected: number[] = [];
  let base: number | null = null;

  return {
    get ready() {
      return base !== null;
    },
    update(value) {
      if (base === null) {
        if (Number.isFinite(value)) collected.push(value);
        if (collected.length >= options.samples) base = median(collected);
        return { ready: base !== null, value: NaN };
      }
      return { ready: true, value: Number.isFinite(value) ? value - base : NaN };
    },
    reset() {
      collected = [];
      base = null;
    },
  };
}
