import { describe, expect, it } from 'vitest';
import { jointAngle } from '../src/pose/angles';

describe('jointAngle', () => {
  it('returns 90 for a right angle at the middle point', () => {
    expect(jointAngle({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(90, 6);
  });

  it('returns 180 for three collinear points with the vertex in between', () => {
    expect(jointAngle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(180, 6);
  });

  it('returns 0 when both arms point the same way', () => {
    expect(jointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(0, 6);
  });

  it('is symmetric in its outer points', () => {
    const a = { x: 0.3, y: 0.9 };
    const b = { x: 0.1, y: 0.2 };
    const c = { x: 0.8, y: 0.4 };
    expect(jointAngle(a, b, c)).toBeCloseTo(jointAngle(c, b, a), 9);
  });

  it('is always within [0, 180] even when the raw atan2 difference wraps', () => {
    const v = jointAngle({ x: -1, y: -0.1 }, { x: 0, y: 0 }, { x: -1, y: 0.1 });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(180);
    expect(v).toBeCloseTo(11.421, 2);
  });

  it('returns NaN when a point coincides with the vertex (undefined angle)', () => {
    expect(Number.isNaN(jointAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }))).toBe(true);
  });

  it('returns NaN when any coordinate is not finite', () => {
    expect(Number.isNaN(jointAngle({ x: NaN, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }))).toBe(true);
  });

  it('ignores z by default (2D)', () => {
    const v = jointAngle({ x: 1, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(v).toBeCloseTo(90, 6);
  });

  it('uses z when use3d is true', () => {
    const v = jointAngle(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { use3d: true },
    );
    expect(v).toBeCloseTo(90, 6);
  });

  it('treats a missing z as 0 in 3D mode', () => {
    const v = jointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { use3d: true });
    expect(v).toBeCloseTo(90, 6);
  });
});
