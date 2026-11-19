import { describe, expect, it } from 'vitest';
import { extractSignal, LANDMARK } from '../src/pose/signals';
import type { Landmark } from '../src/types/landmark';
import { armPose, legPose } from './helpers';

describe('extractSignal: shoulder-angle', () => {
  it('is ~0 degrees with the arms hanging down', () => {
    expect(extractSignal('shoulder-angle', armPose(0.5)).value).toBeCloseTo(0, 3);
  });

  it('is ~90 degrees with the arms horizontal', () => {
    expect(extractSignal('shoulder-angle', armPose(0.3, 0.7)).value).toBeCloseTo(90, 3);
  });

  it('is ~180 degrees with the arms straight overhead', () => {
    expect(extractSignal('shoulder-angle', armPose(0.0)).value).toBeCloseTo(180, 3);
  });

  it('reports the lowest visibility of the landmarks it used', () => {
    const pose = armPose(0.0);
    (pose[LANDMARK.rightWrist] as Landmark).visibility = 0.7;
    expect(extractSignal('shoulder-angle', pose).visibility).toBeCloseTo(0.7, 9);
  });

  it('returns NaN when a needed landmark is below the visibility threshold', () => {
    const r = extractSignal('shoulder-angle', armPose(0.0, 0.4, 0.2), { minVisibility: 0.5 });
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.visibility).toBeCloseTo(0.2, 9);
  });

  it('treats a missing visibility field as fully visible', () => {
    const pose = armPose(0.0).map(({ x, y }) => ({ x, y }));
    expect(extractSignal('shoulder-angle', pose).value).toBeCloseTo(180, 3);
  });
});

describe('extractSignal: knee-angle', () => {
  it('is ~180 degrees with straight legs (standing)', () => {
    expect(extractSignal('knee-angle', legPose(0.3, 0.5)).value).toBeCloseTo(180, 3);
  });

  it('is ~90 degrees with the thigh horizontal and the shin vertical (seated)', () => {
    expect(extractSignal('knee-angle', legPose(0.5, 0.7)).value).toBeCloseTo(90, 3);
  });
});

describe('extractSignal: input validation', () => {
  it('returns NaN with zero visibility when the landmark list is too short', () => {
    const r = extractSignal('shoulder-angle', [{ x: 0, y: 0 }]);
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.visibility).toBe(0);
  });
});
