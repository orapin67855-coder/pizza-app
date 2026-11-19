import { describe, expect, it } from 'vitest';
import { createRepCounter } from '../src/pose/rep-counter';

const cfg = { up: 150, down: 40, minRepMs: 500 };

const feed = (counter: ReturnType<typeof createRepCounter>, samples: Array<[number, number]>) => {
  let state = counter.state;
  for (const [v, t] of samples) state = counter.update(v, t);
  return state;
};

describe('createRepCounter: abandonRep', () => {
  it('drops the rep in progress without counting it and waits for the rest position again', () => {
    const c = createRepCounter(cfg);
    feed(c, [
      [10, 0],
      [160, 1000],
    ]);
    c.abandonRep();
    expect(c.state.phase).toBe('waiting');
    expect(c.state.currentPeak).toBeNull();
    expect(c.state.reps).toBe(0);
  });

  it('keeps reps that were already completed', () => {
    const c = createRepCounter(cfg);
    feed(c, [
      [10, 0],
      [160, 1000],
      [20, 2000],
      [160, 3000],
    ]);
    c.abandonRep();
    expect(c.state.reps).toBe(1);
  });

  it('lets the next full rep count after the user is back at rest', () => {
    const c = createRepCounter(cfg);
    feed(c, [
      [10, 0],
      [160, 1000],
    ]);
    c.abandonRep();
    const s = feed(c, [
      [20, 2000],
      [160, 3000],
      [20, 4000],
    ]);
    expect(s.reps).toBe(1);
  });
});
