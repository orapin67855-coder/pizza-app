import { describe, expect, it } from 'vitest';
import { createAlternatingCounter } from '../src/pose/alternating-counter';

const cfg = { upA: 150, downA: 40, upB: 150, downB: 40, minRepMs: 300 };

type Sample = [a: number, b: number, t: number];
const feed = (c: ReturnType<typeof createAlternatingCounter>, samples: Sample[]) => {
  let s = c.state;
  for (const [a, b, t] of samples) s = c.update(a, b, t);
  return s;
};

describe('createAlternatingCounter: overlapping raises', () => {
  it('does not pair a raise with the opposite side when that side is still raised', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [
      [10, 10, 0],
      [10, 160, 1000], // B up
      [10, 10, 2000], // B done -> waiting for an A raise
      [160, 10, 3000], // A up
      [160, 160, 3500], // B up again while A is still up
      [10, 160, 4000], // A done while B is raised: not an alternation
      [10, 10, 5000], // B done
    ]);
    expect(s.reps).toBe(0);
  });

  it('still counts a clean alternation afterwards', () => {
    const c = createAlternatingCounter(cfg);
    const s = feed(c, [
      [10, 10, 0],
      [160, 160, 1000],
      [10, 10, 2000], // both together: ignored
      [160, 10, 3000],
      [10, 10, 4000], // A
      [10, 160, 5000],
      [10, 10, 6000], // B
    ]);
    expect(s.reps).toBe(1);
  });
});
