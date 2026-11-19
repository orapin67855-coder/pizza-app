import { describe, expect, it } from 'vitest';
import { createMedianFilter, createOneEuroFilter } from '../src/pose/filters';

describe('createMedianFilter', () => {
  it('returns the first value unchanged', () => {
    const f = createMedianFilter(3);
    expect(f.push(42)).toBe(42);
  });

  it('averages the two middle values while the window holds an even count', () => {
    const f = createMedianFilter(3);
    f.push(10);
    expect(f.push(20)).toBe(15);
  });

  it('removes a single-sample spike', () => {
    const f = createMedianFilter(3);
    const out = [10, 10, 90, 10, 10].map((v) => f.push(v));
    expect(out.slice(2)).toEqual([10, 10, 10]);
  });

  it('forgets values older than the window size', () => {
    const f = createMedianFilter(3);
    [1, 1, 1].forEach((v) => f.push(v));
    f.push(100);
    f.push(100);
    expect(f.push(100)).toBe(100);
  });

  it('ignores non-finite input and returns the last output', () => {
    const f = createMedianFilter(3);
    f.push(10);
    f.push(20);
    expect(f.push(NaN)).toBe(15);
  });

  it('returns NaN when it has never seen a finite value', () => {
    const f = createMedianFilter(3);
    expect(Number.isNaN(f.push(NaN))).toBe(true);
  });

  it('rejects an invalid window size', () => {
    expect(() => createMedianFilter(0)).toThrow();
  });

  it('reset clears history', () => {
    const f = createMedianFilter(3);
    f.push(100);
    f.push(100);
    f.reset();
    expect(f.push(5)).toBe(5);
  });
});

describe('createOneEuroFilter', () => {
  const variance = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  };
  // deterministic pseudo-noise, no Math.random so the test is repeatable
  const noise = (i: number) => Math.sin(i * 12.9898) * 3;

  it('returns the first sample unchanged', () => {
    const f = createOneEuroFilter();
    expect(f.filter(37, 0)).toBe(37);
  });

  it('keeps a constant signal constant', () => {
    const f = createOneEuroFilter();
    let last = 0;
    for (let i = 0; i < 50; i++) last = f.filter(80, i * 33);
    expect(last).toBeCloseTo(80, 9);
  });

  it('reduces jitter around a steady value', () => {
    const f = createOneEuroFilter({ minCutoff: 1, beta: 0.0 });
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const v = 100 + noise(i);
      raw.push(v);
      out.push(f.filter(v, i * 33));
    }
    expect(variance(out.slice(20))).toBeLessThan(variance(raw.slice(20)) * 0.5);
  });

  it('follows a fast step quickly when beta is high', () => {
    const f = createOneEuroFilter({ minCutoff: 1, beta: 0.05 });
    for (let i = 0; i < 30; i++) f.filter(0, i * 33);
    let out = 0;
    for (let i = 30; i < 45; i++) out = f.filter(150, i * 33);
    expect(out).toBeGreaterThan(140);
  });

  it('does not produce NaN or Infinity when timestamps repeat or go backwards', () => {
    const f = createOneEuroFilter();
    f.filter(10, 100);
    expect(Number.isFinite(f.filter(20, 100))).toBe(true);
    expect(Number.isFinite(f.filter(30, 50))).toBe(true);
  });

  it('ignores non-finite input and returns the last output', () => {
    const f = createOneEuroFilter();
    const a = f.filter(60, 0);
    expect(f.filter(NaN, 33)).toBe(a);
  });

  it('reset starts over from the next sample', () => {
    const f = createOneEuroFilter();
    f.filter(0, 0);
    f.filter(0, 33);
    f.reset();
    expect(f.filter(99, 66)).toBe(99);
  });
});
