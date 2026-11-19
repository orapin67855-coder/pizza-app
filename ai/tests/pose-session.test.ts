import { describe, expect, it } from 'vitest';
import { createPoseSession } from '../src/pose/pose-session';
import type { Exercise } from '../src/types/exercise';
import type { Landmark } from '../src/types/landmark';
import { armPoseAtAngle, legPoseAtAngle } from './helpers';

const FRAME_MS = 33;

const armExercise: Exercise = {
  id: 'arm-raise',
  name: 'High arm raise',
  needsCarer: false,
  targetReps: 5,
  approvalStatus: 'draft',
  criteria: { metric: 'shoulder-angle', up: 150, down: 40, minRepMs: 300 },
};

const stsExercise: Exercise = {
  id: 'sit-stand',
  name: 'Sit-to-stand from a chair',
  needsCarer: true,
  targetReps: 5,
  approvalStatus: 'draft',
  criteria: { metric: 'knee-angle', up: 160, down: 110, minRepMs: 300 },
};

/** Smooth rest -> peak -> rest cycle sampled at ~30 fps, plus a short rest at each end. */
function cycleAngles(rest: number, peak: number, seconds = 2): number[] {
  const n = Math.round((seconds * 1000) / FRAME_MS);
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push(rest);
  for (let i = 0; i <= n; i++) out.push(rest + (peak - rest) * Math.sin((Math.PI * i) / n) ** 2);
  for (let i = 0; i < 20; i++) out.push(rest);
  return out;
}

type Pose = (deg: number) => Landmark[];
type Session = ReturnType<typeof createPoseSession>;

function run(session: Session, angles: number[], pose: Pose, startMs = 0) {
  let t = startMs;
  const results = [];
  for (const a of angles) {
    results.push(session.processFrame({ landmarks: pose(a), timestampMs: t }));
    t += FRAME_MS;
  }
  return { results, endMs: t };
}

describe('createPoseSession: arm raise', () => {
  it('counts each full raise-and-lower exactly once', () => {
    const s = createPoseSession({ exercise: armExercise });
    const angles = [...cycleAngles(10, 170), ...cycleAngles(10, 170)];
    const { results } = run(s, angles, armPoseAtAngle);
    expect(results.at(-1)?.reps).toBe(2);
    expect(results.filter((r) => r.repCompleted)).toHaveLength(2);
  });

  it('does not count a raise that stops short of the target', () => {
    const s = createPoseSession({ exercise: armExercise });
    const { results } = run(s, cycleAngles(10, 110), armPoseAtAngle);
    expect(results.at(-1)?.reps).toBe(0);
  });

  it('is not fooled by a single-frame glitch in the middle of rest', () => {
    const s = createPoseSession({ exercise: armExercise });
    const angles = [...Array<number>(10).fill(10), 175, ...Array<number>(10).fill(10)];
    const { results } = run(s, angles, armPoseAtAngle);
    expect(results.at(-1)?.reps).toBe(0);
  });

  it('reports the filtered measurement and a quality rating', () => {
    const s = createPoseSession({ exercise: armExercise });
    const { results } = run(s, [10, 10, 10], armPoseAtAngle);
    const last = results.at(-1);
    expect(last?.value).toBeCloseTo(10, 0);
    expect(last?.quality).toBe('good');
    expect(last?.action).toBe('continue');
  });

  it('asks the user to reach the start position first', () => {
    const s = createPoseSession({ exercise: armExercise });
    const r = s.processFrame({ landmarks: armPoseAtAngle(120), timestampMs: 0 });
    expect(r.cue).toBe('get_into_start_position');
  });
});

describe('createPoseSession: safety', () => {
  it('refuses to run a carer-required exercise until a carer is confirmed', () => {
    const s = createPoseSession({ exercise: stsExercise });
    const { results } = run(s, cycleAngles(90, 175), legPoseAtAngle);
    expect(results.every((r) => r.action === 'stop')).toBe(true);
    expect(results.at(-1)?.reps).toBe(0);
    expect(results.at(-1)?.reason).toBe('carer-not-confirmed');
  });

  it('counts sit-to-stand reps once the carer is confirmed', () => {
    const s = createPoseSession({ exercise: stsExercise });
    s.confirmCarer();
    const angles = [...cycleAngles(90, 175, 3), ...cycleAngles(90, 175, 3)];
    const { results } = run(s, angles, legPoseAtAngle);
    expect(results.at(-1)?.reps).toBe(2);
  });

  it('stops at once on user request and ignores later movement', () => {
    const s = createPoseSession({ exercise: armExercise });
    s.requestStop();
    const { results } = run(s, cycleAngles(10, 170), armPoseAtAngle);
    expect(results.every((r) => r.action === 'stop' && r.reason === 'user-stop')).toBe(true);
    expect(results.at(-1)?.reps).toBe(0);
  });

  it('pauses when the person leaves the frame and discards the rep in progress', () => {
    const s = createPoseSession({ exercise: armExercise });
    // up to the top of a raise...
    const up = cycleAngles(10, 170).slice(0, 6 + 32);
    const first = run(s, up, armPoseAtAngle);
    // ...person disappears for ~3 s...
    let t = first.endMs;
    let last;
    for (let i = 0; i < 100; i++) {
      last = s.processFrame({ landmarks: null, timestampMs: t });
      t += FRAME_MS;
    }
    expect(last).toMatchObject({ action: 'pause', reason: 'person-lost', cue: 'person_lost' });
    // ...and returns already at rest: the interrupted rep must not be counted
    const back = run(s, Array<number>(30).fill(10), armPoseAtAngle, t);
    expect(back.results.at(-1)?.reps).toBe(0);
    expect(back.results.at(-1)?.action).toBe('continue');
    // a fresh full rep afterwards counts normally
    const again = run(s, cycleAngles(10, 170), armPoseAtAngle, back.endMs);
    expect(again.results.at(-1)?.reps).toBe(1);
  });

  it('pauses when tracking stays poor and does not count during the pause', () => {
    const s = createPoseSession({ exercise: armExercise, lowTrackingMs: 1000 });
    let t = 0;
    let last;
    for (let i = 0; i < 60; i++) {
      last = s.processFrame({ landmarks: armPoseAtAngle(170, 0.1), timestampMs: t });
      t += FRAME_MS;
    }
    expect(last).toMatchObject({ action: 'pause', reason: 'low-tracking' });
    expect(last?.reps).toBe(0);
  });

  it('stops when the camera is reported inactive', () => {
    const s = createPoseSession({ exercise: armExercise });
    const r = s.processFrame({
      landmarks: armPoseAtAngle(10),
      timestampMs: 0,
      cameraActive: false,
    });
    expect(r).toMatchObject({ action: 'stop', reason: 'camera-stopped', cue: 'camera_stopped' });
  });
});

describe('createPoseSession: reset', () => {
  it('clears reps and re-arms a user stop', () => {
    const s = createPoseSession({ exercise: armExercise });
    run(s, cycleAngles(10, 170), armPoseAtAngle);
    s.requestStop();
    s.reset();
    const { results } = run(s, cycleAngles(10, 170), armPoseAtAngle);
    expect(results.at(-1)?.reps).toBe(1);
    expect(results.at(-1)?.action).toBe('continue');
  });
});
