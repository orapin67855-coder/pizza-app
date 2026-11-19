import { LANDMARK } from '../src/pose/signals';
import type { Landmark } from '../src/types/landmark';
import { makePose } from './helpers';

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Side-view walking pose: torso 0.3 tall, ankles `separation` apart horizontally. */
export const stridePose = (separation: number, vis = 1): Landmark[] =>
  makePose({
    [LANDMARK.leftShoulder]: { x: 0.5, y: 0.3, visibility: vis },
    [LANDMARK.rightShoulder]: { x: 0.5, y: 0.3, visibility: vis },
    [LANDMARK.leftHip]: { x: 0.5, y: 0.6, visibility: vis },
    [LANDMARK.rightHip]: { x: 0.5, y: 0.6, visibility: vis },
    [LANDMARK.leftAnkle]: { x: 0.5 - separation / 2, y: 0.9, visibility: vis },
    [LANDMARK.rightAnkle]: { x: 0.5 + separation / 2, y: 0.9, visibility: vis },
  });

/** Facing the camera, shoulder line yawed by `shoulderDeg` and hip line by `hipDeg`. */
export const twistPose = (shoulderDeg: number, hipDeg: number, vis = 1): Landmark[] => {
  const w = 0.1;
  const line = (y: number, deg: number, left: number, right: number) => ({
    [left]: { x: 0.5 - w * Math.cos(rad(deg)), y, z: -w * Math.sin(rad(deg)), visibility: vis },
    [right]: { x: 0.5 + w * Math.cos(rad(deg)), y, z: w * Math.sin(rad(deg)), visibility: vis },
  });
  return makePose({
    ...line(0.3, shoulderDeg, LANDMARK.leftShoulder, LANDMARK.rightShoulder),
    ...line(0.6, hipDeg, LANDMARK.leftHip, LANDMARK.rightHip),
  });
};

/** Each arm at its own angle from hanging down (0) to overhead (180). */
export const altArmPose = (leftDeg: number, rightDeg: number, vis = 1): Landmark[] => {
  const len = 0.25;
  return makePose({
    [LANDMARK.leftHip]: { x: 0.4, y: 0.6, visibility: vis },
    [LANDMARK.leftShoulder]: { x: 0.4, y: 0.3, visibility: vis },
    [LANDMARK.leftWrist]: {
      x: 0.4 + len * Math.sin(rad(leftDeg)),
      y: 0.3 + len * Math.cos(rad(leftDeg)),
      visibility: vis,
    },
    [LANDMARK.rightHip]: { x: 0.6, y: 0.6, visibility: vis },
    [LANDMARK.rightShoulder]: { x: 0.6, y: 0.3, visibility: vis },
    [LANDMARK.rightWrist]: {
      x: 0.6 + len * Math.sin(rad(rightDeg)),
      y: 0.3 + len * Math.cos(rad(rightDeg)),
      visibility: vis,
    },
  });
};
