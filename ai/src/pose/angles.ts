import type { Landmark } from '../types/landmark';

export interface AngleOptions {
  /** Include the z axis. Off by default: MediaPipe's normalized z is noisy. */
  use3d?: boolean;
}

/**
 * Angle in degrees (0..180) at point `b` between the rays b->a and b->c.
 * Returns NaN when the angle is undefined (non-finite input or a zero-length ray)
 * so callers can treat the frame as "no measurement" instead of guessing.
 */
export function jointAngle(
  a: Landmark,
  b: Landmark,
  c: Landmark,
  options: AngleOptions = {},
): number {
  const use3d = options.use3d === true;
  const ux = a.x - b.x;
  const uy = a.y - b.y;
  const uz = use3d ? (a.z ?? 0) - (b.z ?? 0) : 0;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const vz = use3d ? (c.z ?? 0) - (b.z ?? 0) : 0;

  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (!Number.isFinite(lu) || !Number.isFinite(lv) || lu === 0 || lv === 0) return NaN;

  const cos = (ux * vx + uy * vy + uz * vz) / (lu * lv);
  const clamped = Math.min(1, Math.max(-1, cos));
  return (Math.acos(clamped) * 180) / Math.PI;
}
