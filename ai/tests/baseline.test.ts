import { describe, expect, it } from 'vitest';
import { createBaseline } from '../src/pose/baseline';

describe('createBaseline', () => {
  it('is not ready until it has collected the requested number of samples', () => {
    const b = createBaseline({ samples: 3 });
    expect(b.update(10).ready).toBe(false);
    expect(b.update(10).ready).toBe(false);
    expect(b.update(10).ready).toBe(true);
  });

  it('reports NaN while calibrating so nothing can be counted from it', () => {
    const b = createBaseline({ samples: 3 });
    expect(Number.isNaN(b.update(10).value)).toBe(true);
  });

  it('subtracts the median of the calibration samples afterwards', () => {
    const b = createBaseline({ samples: 3 });
    b.update(10);
    b.update(12);
    b.update(11);
    expect(b.update(30).value).toBeCloseTo(19, 9);
  });

  it('is robust to one outlier during calibration', () => {
    const b = createBaseline({ samples: 5 });
    [5, 5, 90, 5, 5].forEach((v) => b.update(v));
    expect(b.update(5).value).toBeCloseTo(0, 9);
  });

  it('ignores non-finite samples while calibrating', () => {
    const b = createBaseline({ samples: 2 });
    b.update(NaN);
    expect(b.update(4).ready).toBe(false);
    expect(b.update(6).ready).toBe(true);
  });

  it('keeps returning NaN for non-finite input once ready', () => {
    const b = createBaseline({ samples: 1 });
    b.update(7);
    expect(Number.isNaN(b.update(NaN).value)).toBe(true);
  });

  it('reset starts calibration again', () => {
    const b = createBaseline({ samples: 1 });
    b.update(7);
    b.reset();
    expect(b.update(100).ready).toBe(true);
    expect(b.update(100).value).toBeCloseTo(0, 9);
  });

  it('exposes whether it is ready', () => {
    const b = createBaseline({ samples: 1 });
    expect(b.ready).toBe(false);
    b.update(1);
    expect(b.ready).toBe(true);
  });

  it('rejects an invalid sample count', () => {
    expect(() => createBaseline({ samples: 0 })).toThrow();
  });
});
