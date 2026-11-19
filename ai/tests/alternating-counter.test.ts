import { describe, expect, it } from 'vitest';
import { createAlternatingCounter } from '../src/pose/alternating-counter';

const cfg = { upA: 150, downA: 40, upB: 150, downB: 40, minRepMs: 300 };

type Sample = [a: number, b: number, t: number];
const feed = (c: ReturnType<typeof createAlternatingCounter>, samples: Sample[]) => {
  let s = c.state;
  for (const [a, b, t] of samples) s = c.update(a, b, t);
  return s;
};

/** One side raises 10 -> 160 -> 10 over 2 s while the other stays at rest. */
const raiseA = (t0: number): Sample[] => [
  [160, 10, t0 + 1000],
  [10, 10, t0 + 2000],
];
const raiseB = (t0: number): Sample[] => [
  [10, 160, t0 + 1000],
  [10, 10, t0 + 2000],
];
const rest: Sample = [10, 10, 0];

describe('createAlternatingCounter', () => {
  it('starts at zero, waiting for both sides to be at rest', () => {
    const c = createAlternatingCounter(cfg);
    expect(c.state.reps).toBe(0);
    expect(c.state.phase).toBe('waiting');
  });

  it('counts one rep for side A followed by side B', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, ...raiseA(0), ...raiseB(2000)]);
    expect(s.reps).toBe(1);
  });

  it('counts one rep for side B followed by side A', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, ...raiseB(0), ...raiseA(2000)]);
    expect(s.reps).toBe(1);
  });

  it('does not count a single side on its own', () => {
    const c = createAlternatingCounter(cfg);
    expect(feed(c, [rest, ...raiseA(0)]).reps).toBe(0);
  });

  it('does not count the same side twice, and reports the repeat', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, ...raiseA(0), ...raiseA(2000)]);
    expect(s.reps).toBe(0);
    expect(s.sameSideRepeats).toBe(1);
  });

  it('pairs the latest same-side raise with the next opposite raise', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, ...raiseA(0), ...raiseA(2000), ...raiseB(4000)]);
    expect(s.reps).toBe(1);
  });

  it('does not count both arms raised at the same time', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, [160, 160, 1000], [10, 10, 2000], [160, 160, 3000], [10, 10, 4000]]);
    expect(s.reps).toBe(0);
  });

  it('counts several alternations', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [
      rest,
      ...raiseA(0),
      ...raiseB(2000),
      ...raiseA(4000),
      ...raiseB(6000),
      ...raiseA(8000),
      ...raiseB(10000),
    ]);
    expect(s.reps).toBe(3);
  });

  it('records the weaker peak of the two sides for each rep', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, [172, 10, 1000], [10, 10, 2000], [10, 158, 3000], [10, 10, 4000]]);
    expect(s.repPeaks).toEqual([158]);
  });

  it('records how long the pair took, from the start of the first raise to the end of the second', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [
      rest,
      [160, 10, 1000], // A up at t=1000
      [10, 10, 2000], // A done
      [10, 160, 3000], // B up
      [10, 10, 4000], // B done at 4000
    ]);
    expect(s.repDurationsMs).toEqual([3000]);
  });

  it('stays waiting until both sides have been seen at rest', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [[160, 10, 0]]);
    expect(s.phase).toBe('waiting');
    expect(feed(c, [[10, 10, 1000]]).phase).toBe('rest');
  });

  it('reports "up" while either side is raised', () => {
    const c = createAlternatingCounter(cfg);
    expect(feed(c, [rest, [160, 10, 1000]]).phase).toBe('up');
  });

  it('abandonRep discards a half-finished pair', () => {
    const c = createAlternatingCounter(cfg);
    feed(c, [rest, ...raiseA(0)]);
    c.abandonRep();
    const s = feed(c, [rest, ...raiseB(5000)]);
    expect(s.reps).toBe(0);
  });

  it('abandonRep keeps reps that were already counted', () => {
    const c = createAlternatingCounter(cfg);
    feed(c, [rest, ...raiseA(0), ...raiseB(2000)]);
    c.abandonRep();
    expect(c.state.reps).toBe(1);
  });

  it('ignores a NaN channel without disturbing the other', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [rest, [160, NaN, 1000], [10, NaN, 2000], [NaN, 160, 3000], [NaN, 10, 4000]]);
    expect(s.reps).toBe(1);
  });

  it('reset returns to the initial state', () => {
    const c = createAlternatingCounter(cfg);
    feed(c, [rest, ...raiseA(0), ...raiseB(2000)]);
    c.reset();
    expect(c.state.reps).toBe(0);
    expect(c.state.phase).toBe('waiting');
    expect(c.state.repPeaks).toEqual([]);
    expect(c.state.sameSideRepeats).toBe(0);
  });

  it('rejects invalid thresholds', () => {
    expect(() => createAlternatingCounter({ ...cfg, upA: 10 })).toThrow();
    expect(() => createAlternatingCounter({ ...cfg, downB: 200 })).toThrow();
  });
});
