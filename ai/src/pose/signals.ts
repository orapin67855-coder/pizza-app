import type { Landmark } from '../types/landmark';
import { jointAngle } from './angles';

/** MediaPipe Pose Landmarker indices (33-point model). */
export const LANDMARK = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

/** One number per frame. `stride-ratio` is unitless (ankle gap / torso length); others are degrees. */
export type SingleMetric = 'shoulder-angle' | 'knee-angle' | 'stride-ratio';
/** Two alternating channels (e.g. left arm / right arm, or turn left / turn right). */
export type PairedMetric = 'alt-shoulder-angle' | 'trunk-rotation';
export type Metric = SingleMetric | PairedMetric;

export const isPairedMetric = (metric: Metric): metric is PairedMetric =>
  metric === 'alt-shoulder-angle' || metric === 'trunk-rotation';

export interface SignalOptions {
  /** A needed landmark below this visibility makes the sample unusable. Default 0.5. */
  minVisibility?: number;
  use3d?: boolean;
}

export interface Signal {
  /** Measurement, or NaN when the frame cannot be measured reliably. */
  value: number;
  /** Lowest visibility among the landmarks this metric needs (0 if they are missing). */
  visibility: number;
}

export interface PairSignals {
  /** First channel (left arm / turn-one-way), NaN when unusable. */
  a: number;
  /** Second channel (right arm / turn-the-other-way), NaN when unusable. */
  b: number;
  /** Single number for display and cues (max arm angle, or signed trunk rotation). */
  raw: number;
  visibility: number;
}

type Triple = readonly [number, number, number];

/** Each triple is (outer point, vertex, outer point); the angle is measured at the vertex. */
const ANGLE_TRIPLES = {
  'shoulder-angle': [
    [LANDMARK.leftHip, LANDMARK.leftShoulder, LANDMARK.leftWrist],
    [LANDMARK.rightHip, LANDMARK.rightShoulder, LANDMARK.rightWrist],
  ],
  'knee-angle': [
    [LANDMARK.leftHip, LANDMARK.leftKnee, LANDMARK.leftAnkle],
    [LANDMARK.rightHip, LANDMARK.rightKnee, LANDMARK.rightAnkle],
  ],
} as const satisfies Record<string, readonly Triple[]>;

const MIN_LANDMARKS = 29;
const UNUSABLE_SIGNAL: Signal = { value: NaN, visibility: 0 };
const UNUSABLE_PAIR: PairSignals = { a: NaN, b: NaN, raw: NaN, visibility: 0 };

const vis = (p: Landmark): number => p.visibility ?? 1;
const at = (landmarks: readonly Landmark[], index: number): Landmark =>
  landmarks[index] as Landmark;
const minVisibilityOf = (points: readonly Landmark[]): number =>
  points.reduce((m, p) => Math.min(m, vis(p)), 1);

/** Averages the left and right side angles. Both sides must be usable. */
function averagedAngle(
  triples: readonly Triple[],
  landmarks: readonly Landmark[],
  options: SignalOptions,
): Signal {
  const minVisibility = options.minVisibility ?? 0.5;
  let visibility = 1;
  let sum = 0;
  let usable = true;
  for (const [i, j, k] of triples) {
    const a = at(landmarks, i);
    const b = at(landmarks, j);
    const c = at(landmarks, k);
    visibility = Math.min(visibility, minVisibilityOf([a, b, c]));
    const angle = jointAngle(a, b, c, { use3d: options.use3d === true });
    if (Number.isNaN(angle)) usable = false;
    sum += angle;
  }
  if (!usable || visibility < minVisibility) return { value: NaN, visibility };
  return { value: sum / triples.length, visibility };
}

/**
 * Ankle gap divided by torso length (mid-shoulder to mid-hip). Dividing by the person's own
 * torso makes it independent of camera distance, so no manual calibration is needed.
 * Meant for a side-on camera: only the horizontal gap is used.
 */
function strideRatio(landmarks: readonly Landmark[], options: SignalOptions): Signal {
  const minVisibility = options.minVisibility ?? 0.5;
  const ls = at(landmarks, LANDMARK.leftShoulder);
  const rs = at(landmarks, LANDMARK.rightShoulder);
  const lh = at(landmarks, LANDMARK.leftHip);
  const rh = at(landmarks, LANDMARK.rightHip);
  const la = at(landmarks, LANDMARK.leftAnkle);
  const ra = at(landmarks, LANDMARK.rightAnkle);
  const visibility = minVisibilityOf([ls, rs, lh, rh, la, ra]);

  const torso = Math.hypot(
    (ls.x + rs.x) / 2 - (lh.x + rh.x) / 2,
    (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2,
  );
  const gap = Math.abs(la.x - ra.x);
  if (!(torso > 0) || !Number.isFinite(gap) || visibility < minVisibility) {
    return { value: NaN, visibility };
  }
  return { value: gap / torso, visibility };
}

/** Measurement for single-channel metrics. */
export function extractSignal(
  metric: SingleMetric,
  landmarks: readonly Landmark[],
  options: SignalOptions = {},
): Signal {
  if (landmarks.length < MIN_LANDMARKS) return UNUSABLE_SIGNAL;
  if (metric === 'stride-ratio') return strideRatio(landmarks, options);
  return averagedAngle(ANGLE_TRIPLES[metric], landmarks, options);
}

const toDegrees = (rad: number) => (rad * 180) / Math.PI;
const wrap180 = (deg: number) => {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
};

/** Yaw (degrees) of the line from `left` to `right` around the vertical axis; NaN without depth. */
function lineYaw(left: Landmark, right: Landmark): number {
  if (left.z === undefined || right.z === undefined) return NaN;
  return toDegrees(Math.atan2(right.z - left.z, right.x - left.x));
}

function altShoulder(landmarks: readonly Landmark[], options: SignalOptions): PairSignals {
  const minVisibility = options.minVisibility ?? 0.5;
  const use3d = options.use3d === true;
  const sides = [
    [LANDMARK.leftHip, LANDMARK.leftShoulder, LANDMARK.leftWrist],
    [LANDMARK.rightHip, LANDMARK.rightShoulder, LANDMARK.rightWrist],
  ] as const;
  const out = sides.map(([i, j, k]) => {
    const a = at(landmarks, i);
    const b = at(landmarks, j);
    const c = at(landmarks, k);
    const v = minVisibilityOf([a, b, c]);
    return { v, angle: v < minVisibility ? NaN : jointAngle(a, b, c, { use3d }) };
  });
  const [left, right] = out as [(typeof out)[number], (typeof out)[number]];
  const finite = [left.angle, right.angle].filter(Number.isFinite);
  return {
    a: left.angle,
    b: right.angle,
    raw: finite.length > 0 ? Math.max(...finite) : NaN,
    visibility: Math.min(left.v, right.v),
  };
}

/**
 * Shoulder-line yaw relative to the hip-line yaw, so the whole body turning is ignored.
 * Needs depth (z). Sign depends on camera mirroring; the engine subtracts a resting baseline
 * and counts both directions, so the sign convention does not matter.
 */
function trunkRotation(landmarks: readonly Landmark[], options: SignalOptions): PairSignals {
  const minVisibility = options.minVisibility ?? 0.5;
  const ls = at(landmarks, LANDMARK.leftShoulder);
  const rs = at(landmarks, LANDMARK.rightShoulder);
  const lh = at(landmarks, LANDMARK.leftHip);
  const rh = at(landmarks, LANDMARK.rightHip);
  const visibility = minVisibilityOf([ls, rs, lh, rh]);
  const rotation = wrap180(lineYaw(ls, rs) - lineYaw(lh, rh));
  const raw = visibility < minVisibility || !Number.isFinite(rotation) ? NaN : rotation;
  return { a: raw, b: -raw, raw, visibility };
}

/** Measurement for two-channel (alternating) metrics. */
export function extractPairSignals(
  metric: PairedMetric,
  landmarks: readonly Landmark[],
  options: SignalOptions = {},
): PairSignals {
  if (landmarks.length < MIN_LANDMARKS) return UNUSABLE_PAIR;
  return metric === 'alt-shoulder-angle'
    ? altShoulder(landmarks, options)
    : trunkRotation(landmarks, options);
}
