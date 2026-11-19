import { LANDMARK } from '../src/pose/signals';
import type { Landmark } from '../src/types/landmark';

/** 33 landmarks, all visible, at the origin unless overridden by index. */
export const makePose = (overrides: Record<number, Partial<Landmark>> = {}): Landmark[] =>
  Array.from({ length: 33 }, (_, i) => ({ x: 0, y: 0, visibility: 1, ...overrides[i] }));

/** Both sides mirrored: shoulders at y=0.3, hips at y=0.6, wrists wherever asked. */
export const armPose = (wristY: number, wristX = 0.4, vis = 1): Landmark[] =>
  makePose({
    [LANDMARK.leftHip]: { x: 0.4, y: 0.6, visibility: vis },
    [LANDMARK.leftShoulder]: { x: 0.4, y: 0.3, visibility: vis },
    [LANDMARK.leftWrist]: { x: wristX, y: wristY, visibility: vis },
    [LANDMARK.rightHip]: { x: 0.6, y: 0.6, visibility: vis },
    [LANDMARK.rightShoulder]: { x: 0.6, y: 0.3, visibility: vis },
    [LANDMARK.rightWrist]: { x: 0.6 + (wristX - 0.4), y: wristY, visibility: vis },
  });

/** Arms at `deg` degrees from hanging down (0) to straight overhead (180). */
export const armPoseAtAngle = (deg: number, vis = 1): Landmark[] => {
  const r = (deg * Math.PI) / 180;
  const len = 0.25;
  return armPose(0.3 + len * Math.cos(r), 0.4 + len * Math.sin(r), vis);
};

export const legPose = (kneeX: number, hipY: number, vis = 1): Landmark[] =>
  makePose({
    [LANDMARK.leftHip]: { x: 0.3, y: hipY, visibility: vis },
    [LANDMARK.leftKnee]: { x: kneeX, y: 0.7, visibility: vis },
    [LANDMARK.leftAnkle]: { x: kneeX, y: 0.9, visibility: vis },
    [LANDMARK.rightHip]: { x: 0.3, y: hipY, visibility: vis },
    [LANDMARK.rightKnee]: { x: kneeX, y: 0.7, visibility: vis },
    [LANDMARK.rightAnkle]: { x: kneeX, y: 0.9, visibility: vis },
  });

/** Knees at `deg` degrees: 90 = seated, 180 = standing. */
export const legPoseAtAngle = (deg: number, vis = 1): Landmark[] => {
  const r = (deg * Math.PI) / 180;
  const thigh = 0.2;
  const shin = 0.2;
  // knee fixed at (0.5, 0.7); hip up-left of it, ankle rotated by the knee angle
  const hip = { x: 0.5 - thigh, y: 0.7 };
  const ankle = { x: 0.5 + shin * Math.cos(Math.PI - r), y: 0.7 + shin * Math.sin(Math.PI - r) };
  return makePose({
    [LANDMARK.leftHip]: { ...hip, visibility: vis },
    [LANDMARK.leftKnee]: { x: 0.5, y: 0.7, visibility: vis },
    [LANDMARK.leftAnkle]: { ...ankle, visibility: vis },
    [LANDMARK.rightHip]: { ...hip, visibility: vis },
    [LANDMARK.rightKnee]: { x: 0.5, y: 0.7, visibility: vis },
    [LANDMARK.rightAnkle]: { ...ankle, visibility: vis },
  });
};
