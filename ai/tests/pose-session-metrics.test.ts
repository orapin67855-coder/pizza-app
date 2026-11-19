import { describe, expect, it } from 'vitest';
import { createPoseSession, type FrameResult } from '../src/pose/pose-session';
import { DEFAULT_EXERCISES } from '../src/index';
import type { Exercise } from '../src/types/exercise';
import type { Landmark } from '../src/types/landmark';
import { altArmPose, stridePose, twistPose } from './helpers-gait';

const FRAME_MS = 33;
const exercise = (id: string): Exercise => {
  const e = DEFAULT_EXERCISES.find((x) => x.id === id);
  if (!e) throw new Error(`missing default exercise ${id}`);
  return e;
};

/** rest -> peak -> rest over `seconds`, sampled at ~30 fps, with a short rest at each end. */
const cycle = (rest: number, peak: number, seconds = 2): number[] => {
  const n = Math.round((seconds * 1000) / FRAME_MS);
  const out: number[] = Array<number>(6).fill(rest);
  for (let i = 0; i <= n; i++) out.push(rest + (peak - rest) * Math.sin((Math.PI * i) / n) ** 2);
  out.push(...Array<number>(15).fill(rest));
  return out;
};

type Session = ReturnType<typeof createPoseSession>;
const run = (s: Session, frames: Landmark[][], startMs = 0) => {
  let t = startMs;
  const results: FrameResult[] = [];
  for (const landmarks of frames) {
    results.push(s.processFrame({ landmarks, timestampMs: t }));
    t += FRAME_MS;
  }
  return { results, endMs: t };
};
const last = (r: FrameResult[]) => r.at(-1) as FrameResult;

describe('seated alternating arm raise', () => {
  const pose = (l: number, r: number) => altArmPose(l, r);
  const left = () => cycle(10, 165).map((a) => pose(a, 10));
  const right = () => cycle(10, 165).map((a) => pose(10, a));

  it('counts left-then-right as one rep, three times over', () => {
    const s = createPoseSession({ exercise: exercise('seated-alt-arm') });
    const frames = [1, 2, 3].flatMap(() => [...left(), ...right()]);
    const { results } = run(s, frames);
    expect(last(results).reps).toBe(3);
    expect(results.filter((r) => r.repCompleted)).toHaveLength(3);
  });

  it('does not count raising the same arm repeatedly', () => {
    const s = createPoseSession({ exercise: exercise('seated-alt-arm') });
    const { results } = run(s, [...left(), ...left(), ...left()]);
    expect(last(results).reps).toBe(0);
  });

  it('does not count both arms raised together', () => {
    const s = createPoseSession({ exercise: exercise('seated-alt-arm') });
    const both = cycle(10, 165).map((a) => pose(a, a));
    const { results } = run(s, [...both, ...both]);
    expect(last(results).reps).toBe(0);
  });

  it('keeps counting when one arm is briefly hidden, without inventing reps', () => {
    const s = createPoseSession({ exercise: exercise('seated-alt-arm') });
    const hidden = Array.from({ length: 10 }, () => altArmPose(10, 10, 0.1));
    const { results } = run(s, [...left(), ...hidden, ...right()]);
    expect(last(results).reps).toBe(1);
  });
});

describe('seated trunk rotation', () => {
  const pose = (deg: number) => twistPose(deg, 0);
  const still = (n: number) => Array.from({ length: n }, () => pose(0));

  it('calibrates first: no reps, a calibrating flag and a "calibrating" cue', () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const { results } = run(s, still(5));
    expect(last(results)).toMatchObject({ calibrating: true, cue: 'calibrating', reps: 0 });
  });

  it('finishes calibrating after the resting samples have been collected', () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const { results } = run(s, still(40));
    expect(last(results).calibrating).toBe(false);
  });

  it('counts turning to one side and then the other as one rep', () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const frames = [...still(30), ...cycle(0, 40).map(pose), ...cycle(0, -40).map(pose)];
    const { results } = run(s, frames);
    expect(last(results).reps).toBe(1);
  });

  it('works whichever side the person turns first', () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const frames = [...still(30), ...cycle(0, -40).map(pose), ...cycle(0, 40).map(pose)];
    expect(last(run(s, frames).results).reps).toBe(1);
  });

  it('does not count turning to one side only', () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const { results } = run(s, [
      ...still(30),
      ...cycle(0, 40).map(pose),
      ...cycle(0, 40).map(pose),
    ]);
    expect(last(results).reps).toBe(0);
  });

  it('does not count the whole body turning (hips follow the shoulders)', () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const together = (deg: number) => twistPose(deg, deg);
    const frames = [...still(30), ...cycle(0, 40).map(together), ...cycle(0, -40).map(together)];
    expect(last(run(s, frames).results).reps).toBe(0);
  });

  it("measures from the person's own resting posture, not from zero", () => {
    const s = createPoseSession({ exercise: exercise('torso-twist') });
    const offset = (deg: number) => twistPose(deg + 20, 0); // sits slightly turned
    const frames = [
      ...Array.from({ length: 30 }, () => offset(0)),
      ...cycle(0, 40).map(offset),
      ...cycle(0, -40).map(offset),
    ];
    expect(last(run(s, frames).results).reps).toBe(1);
  });
});

describe('big step (walking)', () => {
  const pose = (ratio: number) => stridePose(ratio * 0.3);
  const steps = (n: number) => Array.from({ length: n }, () => cycle(0.05, 0.9, 1.2)).flat();

  it('will not start without a carer', () => {
    const s = createPoseSession({ exercise: exercise('big-step') });
    const { results } = run(s, steps(2).map(pose));
    expect(results.every((r) => r.action === 'stop' && r.reason === 'carer-not-confirmed')).toBe(
      true,
    );
    expect(last(results).reps).toBe(0);
  });

  it('counts one step each time the feet spread and come back together', () => {
    const s = createPoseSession({ exercise: exercise('big-step') });
    s.confirmCarer();
    const { results } = run(s, steps(4).map(pose));
    expect(last(results).reps).toBe(4);
  });

  it('does not count short shuffles', () => {
    const s = createPoseSession({ exercise: exercise('big-step') });
    s.confirmCarer();
    const shuffles = Array.from({ length: 4 }, () => cycle(0.05, 0.4, 1)).flat();
    expect(last(run(s, shuffles.map(pose)).results).reps).toBe(0);
  });

  it('gives the same count at half the apparent size (camera further away)', () => {
    const s = createPoseSession({ exercise: exercise('big-step') });
    s.confirmCarer();
    const far = steps(3)
      .map(pose)
      .map((lm) => lm.map((p) => ({ ...p, x: 0.5 + (p.x - 0.5) / 2, y: 0.5 + (p.y - 0.5) / 2 })));
    expect(last(run(s, far).results).reps).toBe(3);
  });
});

describe('default exercises cover every counter', () => {
  it('includes the five prototype exercises, all drafts', () => {
    const ids = DEFAULT_EXERCISES.map((e) => e.id).sort();
    expect(ids).toEqual(['arm-raise', 'big-step', 'seated-alt-arm', 'sit-stand', 'torso-twist']);
    expect(DEFAULT_EXERCISES.every((e) => e.approvalStatus === 'draft')).toBe(true);
  });

  it('require a carer only for the fall-risk exercises', () => {
    const needs = DEFAULT_EXERCISES.filter((e) => e.needsCarer)
      .map((e) => e.id)
      .sort();
    expect(needs).toEqual(['big-step', 'sit-stand']);
  });
});
