import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '../src/core/storage';
import { createPizzaCore, type PizzaCore } from '../src/core/pizza-core';
import type { PoseBackend } from '../src/core/pose-backend';
import type { PoseHandlers, PoseSummary } from '../src/core/pose-controller';
import type { Exercise } from '../src/types/exercise';
import type { Landmark } from '../src/types/landmark';
import { DEFAULT_EXERCISES } from '../src/exercises/defaults';
import { armPoseAtAngle } from './helpers';

const FRAME_MS = 33;

/** Rest -> peak -> rest cycle as a list of arm angles (30 fps). */
const cycle = (peak = 170, seconds = 2): number[] => {
  const n = Math.round((seconds * 1000) / FRAME_MS);
  const out: number[] = Array<number>(6).fill(10);
  for (let i = 0; i <= n; i++) out.push(10 + (peak - 10) * Math.sin((Math.PI * i) / n) ** 2);
  out.push(...Array<number>(15).fill(10));
  return out;
};

type Frame = Landmark[] | null | undefined;

function harness(
  opts: { targetReps?: number; exercise?: Exercise; autoSave?: boolean; startFails?: boolean } = {},
) {
  const clock = { t: 1000 };
  const queue: Frame[] = [];
  let cameraActive = true;
  const backend: PoseBackend & { startCalls: number; stopCalls: number } = {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      this.startCalls++;
      if (opts.startFails) throw new Error('NotAllowedError');
    },
    detect() {
      return queue.length > 0 ? queue.shift() : undefined;
    },
    get cameraActive() {
      return cameraActive;
    },
    stop() {
      this.stopCalls++;
    },
  };

  let pending: (() => void) | null = null;
  const scheduler = {
    request(cb: () => void) {
      pending = cb;
      return 1;
    },
    cancel() {
      pending = null;
    },
  };
  /** Advance the clock and run one animation frame. */
  const step = () => {
    clock.t += FRAME_MS;
    const cb = pending;
    pending = null;
    cb?.();
  };

  const exercise: Exercise = opts.exercise ?? {
    ...(DEFAULT_EXERCISES.find((e) => e.id === 'arm-raise') as Exercise),
    targetReps: opts.targetReps ?? 2,
  };

  const events: string[] = [];
  const handlers: Required<PoseHandlers> = {
    onStatus: vi.fn((s: string) => events.push(`status:${s}`)),
    onFrame: vi.fn(),
    onRep: vi.fn((n: number) => events.push(`rep:${n}`)),
    onCue: vi.fn((c: { key: string }) => events.push(`cue:${c.key}`)),
    onQuality: vi.fn(),
    onPause: vi.fn((r: string) => events.push(`pause:${r}`)),
    onResume: vi.fn(() => events.push('resume')),
    onSafetyStop: vi.fn((r: string) => events.push(`safety:${r}`)),
    onDone: vi.fn((s: PoseSummary) => events.push(`done:${s.status}`)),
    onError: vi.fn(),
  };

  const make = async (): Promise<PizzaCore> =>
    createPizzaCore({
      storage: createMemoryStorage(),
      exercises: [exercise],
      uuid: () => 'session-1',
      now: () => new Date('2026-11-18T09:00:00.000Z'),
      createPoseBackend: () => backend,
      scheduler,
      clock: () => clock.t,
    });

  const feed = (angles: number[]) => angles.forEach((a) => queue.push(armPoseAtAngle(a)));
  const run = (frames: number) => {
    for (let i = 0; i < frames; i++) step();
  };

  return {
    make,
    backend,
    handlers,
    events,
    exercise,
    feed,
    queue,
    run,
    step,
    clock,
    setCamera: (v: boolean) => (cameraActive = v),
    start: async (core: PizzaCore, h: PoseHandlers = handlers) =>
      core.pose.start({} as HTMLVideoElement, exercise.id, h, { autoSave: opts.autoSave ?? true }),
  };
}

describe('pose.start: lifecycle', () => {
  it('opens the backend and reports loading then running', async () => {
    const h = harness();
    const core = await h.make();
    await h.start(core);
    expect(h.backend.startCalls).toBe(1);
    expect(h.events.slice(0, 2)).toEqual(['status:loading', 'status:running']);
  });

  it('rejects and reports the error if the camera or model cannot start', async () => {
    const h = harness({ startFails: true });
    const core = await h.make();
    await expect(h.start(core)).rejects.toThrow('NotAllowedError');
    expect(h.handlers.onError).toHaveBeenCalledOnce();
    expect(h.events).not.toContain('status:running');
  });

  it('rejects an unknown exercise without touching the camera', async () => {
    const h = harness();
    const core = await h.make();
    await expect(
      core.pose.start({} as HTMLVideoElement, 'does-not-exist', h.handlers),
    ).rejects.toThrow(/exercise/i);
    expect(h.backend.startCalls).toBe(0);
  });

  it('refuses to start when no pose backend is configured', async () => {
    const core = await createPizzaCore({ storage: createMemoryStorage() });
    await expect(core.pose.start({} as HTMLVideoElement, 'arm-raise')).rejects.toThrow(/backend/i);
  });
});

describe('pose.start: counting and finishing', () => {
  it('reports each rep and finishes as completed at the target, saving once', async () => {
    const h = harness({ targetReps: 2 });
    const core = await h.make();
    const ctl = await h.start(core);
    h.feed([...cycle(), ...cycle(), ...cycle()]);
    h.run(400);

    expect(h.events.filter((e) => e.startsWith('rep:'))).toEqual(['rep:1', 'rep:2']);
    const summary = await ctl.finished;
    expect(summary).toMatchObject({
      exerciseId: 'arm-raise',
      reps: 2,
      status: 'completed',
      clientId: 'session-1',
      saved: true,
    });
    expect(h.backend.stopCalls).toBe(1);
    expect(h.handlers.onDone).toHaveBeenCalledOnce();
    expect(await core.sessions.list()).toHaveLength(1);
  });

  it('stops looping after it finishes', async () => {
    const h = harness({ targetReps: 1 });
    const core = await h.make();
    await h.start(core);
    h.feed([...cycle(), ...cycle()]);
    h.run(300);
    const calls = (h.handlers.onFrame as ReturnType<typeof vi.fn>).mock.calls.length;
    h.run(50);
    expect((h.handlers.onFrame as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('computes the duration from the clock', async () => {
    const h = harness({ targetReps: 1 });
    const core = await h.make();
    const ctl = await h.start(core);
    h.feed(cycle());
    h.run(200);
    const s = await ctl.finished;
    expect(s.durationS).toBeGreaterThan(0);
    expect(s.startedAt).toBe('2026-11-18T09:00:00.000Z');
  });

  it('does not save when autoSave is off', async () => {
    const h = harness({ targetReps: 1, autoSave: false });
    const core = await h.make();
    const ctl = await h.start(core);
    h.feed(cycle());
    h.run(200);
    expect(await ctl.finished).toMatchObject({ saved: false, clientId: null });
    expect(await core.sessions.list()).toEqual([]);
  });

  it('still reports done, saved:false, if saving fails', async () => {
    const h = harness({ targetReps: 1 });
    const core = await h.make();
    vi.spyOn(core.sessions, 'save').mockRejectedValueOnce(new Error('disk full'));
    const ctl = await h.start(core);
    h.feed(cycle());
    h.run(200);
    expect(await ctl.finished).toMatchObject({ saved: false });
    expect(h.handlers.onError).toHaveBeenCalled();
  });
});

describe('pose.start: cues and frames', () => {
  it('reports a cue only when it changes', async () => {
    const h = harness();
    const core = await h.make();
    await h.start(core);
    for (let i = 0; i < 10; i++) h.queue.push(armPoseAtAngle(120)); // not at the start position
    h.run(10);
    expect(h.events.filter((e) => e === 'cue:get_into_start_position')).toHaveLength(1);
  });

  it('includes the cue text from the message table', async () => {
    const h = harness();
    const core = await h.make();
    await h.start(core);
    h.queue.push(armPoseAtAngle(120));
    h.run(1);
    expect(h.handlers.onCue).toHaveBeenCalledWith({
      key: 'get_into_start_position',
      text: 'Get into the starting position',
    });
  });

  it('skips frames the camera has not produced yet', async () => {
    const h = harness();
    const core = await h.make();
    await h.start(core);
    h.queue.push(undefined, undefined);
    h.run(2);
    expect(h.handlers.onFrame).not.toHaveBeenCalled();
  });
});

describe('pose.start: safety', () => {
  const sitStand = (): Exercise => DEFAULT_EXERCISES.find((e) => e.id === 'sit-stand') as Exercise;

  it('holds a carer-required exercise until a carer is confirmed', async () => {
    const h = harness({ exercise: { ...sitStand(), targetReps: 1 } });
    const core = await h.make();
    const ctl = await h.start(core);
    for (let i = 0; i < 5; i++) h.queue.push(armPoseAtAngle(10));
    h.run(5);
    expect(h.events.filter((e) => e === 'safety:carer-not-confirmed')).toHaveLength(1);
    expect(h.backend.stopCalls).toBe(0);

    ctl.confirmCarer();
    h.queue.push(armPoseAtAngle(10));
    h.run(1);
    expect(h.events).not.toContain('done:completed');
    expect((h.handlers.onFrame as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].action).toBe(
      'continue',
    );
  });

  it('finishes as stopped immediately when the user asks, saving only if something was done', async () => {
    const h = harness({ targetReps: 5 });
    const core = await h.make();
    const ctl = await h.start(core);
    ctl.requestStop();
    const s = await ctl.finished;
    expect(s).toMatchObject({ status: 'stopped', reps: 0, saved: false });
    expect(h.backend.stopCalls).toBe(1);
    expect(await core.sessions.list()).toEqual([]);
  });

  it('saves a stopped session that already has reps', async () => {
    const h = harness({ targetReps: 5 });
    const core = await h.make();
    const ctl = await h.start(core);
    h.feed(cycle());
    h.run(150);
    ctl.requestStop();
    expect(await ctl.finished).toMatchObject({ status: 'stopped', reps: 1, saved: true });
    expect((await core.sessions.list())[0]?.status).toBe('stopped');
  });

  it('ignores repeated stop requests (no double save, one onDone)', async () => {
    const h = harness({ targetReps: 5 });
    const core = await h.make();
    const ctl = await h.start(core);
    h.feed(cycle());
    h.run(150);
    ctl.requestStop();
    ctl.requestStop();
    await ctl.finished;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let any duplicate finish() settle
    expect(h.handlers.onDone).toHaveBeenCalledOnce();
    expect(h.backend.stopCalls).toBe(1);
    expect(await core.sessions.list()).toHaveLength(1);
  });

  it('pauses when the person leaves the view, and resumes when they return', async () => {
    const h = harness({ targetReps: 5 });
    const core = await h.make();
    await h.start(core);
    h.feed(Array<number>(5).fill(10));
    for (let i = 0; i < 100; i++) h.queue.push(null); // ~3.3 s with nobody in view
    h.queue.push(armPoseAtAngle(10));
    h.run(106);
    expect(h.events).toContain('pause:person-lost');
    expect(h.events).toContain('resume');
    expect(h.events.indexOf('pause:person-lost')).toBeLessThan(h.events.indexOf('resume'));
  });

  it('finishes as stopped if the camera stream ends', async () => {
    const h = harness({ targetReps: 5 });
    const core = await h.make();
    const ctl = await h.start(core);
    h.feed(cycle());
    h.run(120);
    h.setCamera(false);
    h.run(2);
    expect(h.events).toContain('safety:camera-stopped');
    expect(await ctl.finished).toMatchObject({ status: 'stopped' });
    expect(h.backend.stopCalls).toBe(1);
  });
});
