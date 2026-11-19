import { describe, expect, it } from 'vitest';
import { createRepCounter } from '../src/pose/rep-counter';

const cfg = { up: 150, down: 40, minRepMs: 500 };

/** Feed [value, tMs] samples and return the final state. */
const feed = (counter: ReturnType<typeof createRepCounter>, samples: Array<[number, number]>) => {
  let state = counter.state;
  for (const [v, t] of samples) state = counter.update(v, t);
  return state;
};

describe('createRepCounter', () => {
  it('starts with zero reps, waiting for the rest position', () => {
    const c = createRepCounter(cfg);
    expect(c.state.reps).toBe(0);
    expect(c.state.phase).toBe('waiting');
  });

  it('counts nothing for a flat signal at rest', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [10, 1000],
      [10, 2000],
    ]);
    expect(s.reps).toBe(0);
    expect(s.phase).toBe('rest');
  });

  it('counts one rep after reaching the target and returning to rest', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [100, 800],
      [160, 1600],
      [90, 2400],
      [20, 3200],
    ]);
    expect(s.reps).toBe(1);
    expect(s.phase).toBe('rest');
  });

  it('does not count when the target is never reached', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [140, 1000],
      [20, 2000],
    ]);
    expect(s.reps).toBe(0);
  });

  it('does not count again while the value hovers between the thresholds (hysteresis)', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [155, 1000],
      [145, 1500],
      [155, 2000],
      [145, 2500],
      [100, 3000],
    ]);
    expect(s.reps).toBe(0);
    expect(s.phase).toBe('up');
  });

  it('records the peak value of each completed rep', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [160, 1000],
      [172, 1500],
      [30, 2500],
      [160, 3500],
      [165, 4000],
      [30, 5000],
    ]);
    expect(s.reps).toBe(2);
    expect(s.repPeaks).toEqual([172, 165]);
  });

  it('records how long each rep took, from reaching the target to returning to rest', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [160, 1000],
      [30, 3000],
    ]);
    expect(s.repDurationsMs).toEqual([2000]);
  });

  it('ignores a spike that rises and falls faster than minRepMs', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [170, 1000],
      [10, 1100],
    ]);
    expect(s.reps).toBe(0);
    expect(s.phase).toBe('rest');
  });

  it('does not count a rep when the session starts above the target (no rest position seen)', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [170, 0],
      [20, 1000],
    ]);
    expect(s.reps).toBe(0);
    expect(s.phase).toBe('rest');
  });

  it('ignores NaN samples and leaves the state unchanged', () => {
    const c = createRepCounter(cfg);
    feed(c, [
      [10, 0],
      [160, 1000],
    ]);
    const s = c.update(NaN, 1500);
    expect(s.phase).toBe('up');
    expect(s.reps).toBe(0);
  });

  it('reset returns to the initial state', () => {
    const c = createRepCounter(cfg);
    feed(c, [
      [10, 0],
      [160, 1000],
      [20, 2000],
    ]);
    c.reset();
    expect(c.state.reps).toBe(0);
    expect(c.state.phase).toBe('waiting');
    expect(c.state.repPeaks).toEqual([]);
  });

  it('exposes the running peak of the rep in progress', () => {
    const c = createRepCounter(cfg);
    const s = feed(c, [
      [10, 0],
      [160, 1000],
      [175, 1500],
    ]);
    expect(s.currentPeak).toBe(175);
  });

  it('rejects thresholds where up is not above down', () => {
    expect(() => createRepCounter({ up: 40, down: 40, minRepMs: 0 })).toThrow();
    expect(() => createRepCounter({ up: 30, down: 40, minRepMs: 0 })).toThrow();
  });

  it('rejects a negative minRepMs', () => {
    expect(() => createRepCounter({ up: 150, down: 40, minRepMs: -1 })).toThrow();
  });

  it('exposes its state as a snapshot, not a live reference', () => {
    const c = createRepCounter(cfg);
    const before = c.state;
    feed(c, [
      [10, 0],
      [160, 1000],
      [20, 2000],
    ]);
    expect(before.reps).toBe(0);
    expect(c.state.reps).toBe(1);
  });
});
