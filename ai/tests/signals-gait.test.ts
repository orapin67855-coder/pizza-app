import { describe, expect, it } from 'vitest';
import { extractPairSignals, extractSignal } from '../src/pose/signals';
import { altArmPose, stridePose, twistPose } from './helpers-gait';
import { makePose } from './helpers';

describe('extractSignal: stride-ratio', () => {
  it('is the ankle separation divided by torso length', () => {
    expect(extractSignal('stride-ratio', stridePose(0.3)).value).toBeCloseTo(1, 6);
    expect(extractSignal('stride-ratio', stridePose(0.15)).value).toBeCloseTo(0.5, 6);
  });

  it('is 0 when the feet are together', () => {
    expect(extractSignal('stride-ratio', stridePose(0)).value).toBeCloseTo(0, 9);
  });

  it('does not depend on how far the person stands from the camera', () => {
    const near = extractSignal('stride-ratio', stridePose(0.3)).value;
    // same pose scaled to half size around the same centre
    const far = stridePose(0.3).map((p) => ({
      ...p,
      x: 0.5 + (p.x - 0.5) / 2,
      y: 0.5 + (p.y - 0.5) / 2,
    }));
    expect(extractSignal('stride-ratio', far).value).toBeCloseTo(near, 6);
  });

  it('is NaN when the torso has no length (degenerate pose)', () => {
    const r = extractSignal('stride-ratio', makePose());
    expect(Number.isNaN(r.value)).toBe(true);
  });

  it('is NaN when an ankle is not visible enough', () => {
    const pose = stridePose(0.3);
    (pose[27] as { visibility: number }).visibility = 0.1;
    expect(Number.isNaN(extractSignal('stride-ratio', pose).value)).toBe(true);
  });
});

describe('extractPairSignals: alt-shoulder-angle', () => {
  it('returns each arm separately', () => {
    const r = extractPairSignals('alt-shoulder-angle', altArmPose(170, 20));
    expect(r.a).toBeCloseTo(170, 3);
    expect(r.b).toBeCloseTo(20, 3);
  });

  it('marks only the unusable side as NaN', () => {
    const pose = altArmPose(170, 20);
    (pose[16] as { visibility: number }).visibility = 0.1; // right wrist
    const r = extractPairSignals('alt-shoulder-angle', pose);
    expect(r.a).toBeCloseTo(170, 3);
    expect(Number.isNaN(r.b)).toBe(true);
    expect(r.visibility).toBeCloseTo(0.1, 9);
  });
});

describe('extractPairSignals: trunk-rotation', () => {
  it('reports shoulder yaw relative to the hips, as +rotation and -rotation', () => {
    const r = extractPairSignals('trunk-rotation', twistPose(40, 0));
    expect(r.raw).toBeCloseTo(40, 3);
    expect(r.a).toBeCloseTo(40, 3);
    expect(r.b).toBeCloseTo(-40, 3);
  });

  it('ignores the whole body turning together', () => {
    expect(extractPairSignals('trunk-rotation', twistPose(30, 30)).raw).toBeCloseTo(0, 3);
  });

  it('is negative when rotating the other way', () => {
    expect(extractPairSignals('trunk-rotation', twistPose(-35, 0)).raw).toBeCloseTo(-35, 3);
  });

  it('is NaN when depth (z) is missing', () => {
    const noZ = twistPose(40, 0).map(({ x, y, visibility }) => ({
      x,
      y,
      ...(visibility !== undefined ? { visibility } : {}),
    }));
    expect(Number.isNaN(extractPairSignals('trunk-rotation', noZ).raw)).toBe(true);
  });
});

describe('extractPairSignals: validation', () => {
  it('returns NaN and zero visibility for a too-short landmark list', () => {
    const r = extractPairSignals('alt-shoulder-angle', [{ x: 0, y: 0 }]);
    expect(Number.isNaN(r.a)).toBe(true);
    expect(r.visibility).toBe(0);
  });
});
