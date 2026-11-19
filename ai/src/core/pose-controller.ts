import type { CueKey } from '../coach/cues';
import type { SafetyReason, TrackingQuality } from '../coach/safety-guard';
import { createPoseSession, type FrameResult } from '../pose/pose-session';
import type { Exercise } from '../types/exercise';
import type { PoseBackend } from './pose-backend';
import type { SessionInput, SessionStatus, StoredSession } from './types';

export interface Scheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

/** requestAnimationFrame when available, otherwise a ~60 fps timer. */
export const defaultScheduler: Scheduler = {
  request: (cb) =>
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(() => cb())
      : (setTimeout(cb, 16) as unknown as number),
  cancel: (id) =>
    typeof globalThis.cancelAnimationFrame === 'function'
      ? globalThis.cancelAnimationFrame(id)
      : clearTimeout(id),
};

export interface PoseHandlers {
  onStatus?(status: 'loading' | 'running' | 'stopped'): void;
  /** Every analysed frame, e.g. to draw the measured angle. */
  onFrame?(result: FrameResult): void;
  onRep?(reps: number, target: number): void;
  /** Fires only when the cue changes, so it is safe to speak or display directly. */
  onCue?(cue: { key: CueKey; text: string }): void;
  onQuality?(quality: TrackingQuality): void;
  /** Tracking was lost; counting is paused until it recovers. */
  onPause?(reason: SafetyReason): void;
  onResume?(): void;
  /** Counting is blocked (e.g. a carer has not been confirmed) or the exercise was stopped. */
  onSafetyStop?(reason: SafetyReason): void;
  onDone?(summary: PoseSummary): void;
  onError?(error: Error): void;
}

export interface PoseSummary {
  exerciseId: string;
  reps: number;
  durationS: number;
  startedAt: string;
  status: SessionStatus;
  /** clientId of the saved session, or null if it was not saved. */
  clientId: string | null;
  saved: boolean;
}

export interface PoseController {
  /** Call when a carer is nearby; required before carer-only exercises count. */
  confirmCarer(): void;
  /** Ends the exercise now. Safe to call more than once. */
  requestStop(): void;
  /** Resolves once, when the exercise has ended (completed or stopped). */
  readonly finished: Promise<PoseSummary>;
}

export interface PoseStartOptions {
  /** Save the session when it ends. Default true. */
  autoSave?: boolean;
}

export interface ControllerDeps {
  backend: PoseBackend;
  exercise: Exercise;
  video: HTMLVideoElement;
  handlers: PoseHandlers;
  messages: Record<CueKey, string>;
  scheduler: Scheduler;
  /** Monotonic milliseconds (performance.now). */
  clock: () => number;
  now: () => Date;
  save: (input: SessionInput) => Promise<StoredSession>;
  autoSave: boolean;
}

/**
 * Runs one exercise: camera frames -> PoseSession -> events for the UI. Saves the session
 * exactly once when it ends. Stopped sessions with no reps are not saved (nothing was done).
 */
export async function startPoseController(deps: ControllerDeps): Promise<PoseController> {
  const { backend, exercise, handlers, scheduler, clock } = deps;
  const session = createPoseSession({ exercise });
  const target = exercise.targetReps;

  handlers.onStatus?.('loading');
  try {
    await backend.start(deps.video);
  } catch (error) {
    handlers.onStatus?.('stopped');
    handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  handlers.onStatus?.('running');

  const startMs = clock();
  const startedAt = deps.now().toISOString();
  let frameId = 0;
  let isFinished = false;
  let reps = 0;
  let lastCue: CueKey | null = null;
  let lastQuality: TrackingQuality | null = null;
  let lastAction: FrameResult['action'] = 'continue';
  let lastReason: SafetyReason | undefined;
  let resolveFinished: (s: PoseSummary) => void = () => {};
  const finished = new Promise<PoseSummary>((resolve) => (resolveFinished = resolve));

  const finish = async (status: SessionStatus): Promise<void> => {
    if (isFinished) return;
    isFinished = true;
    scheduler.cancel(frameId);
    backend.stop();

    const durationS = Math.max(0, Math.round((clock() - startMs) / 1000));
    let clientId: string | null = null;
    let saved = false;
    if (deps.autoSave && (status === 'completed' || reps > 0)) {
      try {
        const stored = await deps.save({
          exerciseId: exercise.id,
          startedAt,
          durationS,
          reps,
          status,
        });
        clientId = stored.clientId;
        saved = true;
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const summary: PoseSummary = {
      exerciseId: exercise.id,
      reps,
      durationS,
      startedAt,
      status,
      clientId,
      saved,
    };
    handlers.onStatus?.('stopped');
    handlers.onDone?.(summary);
    resolveFinished(summary);
  };

  const dispatch = (r: FrameResult) => {
    reps = r.reps;
    handlers.onFrame?.(r);
    if (r.quality !== lastQuality) {
      lastQuality = r.quality;
      handlers.onQuality?.(r.quality);
    }
    if (r.repCompleted) handlers.onRep?.(r.reps, target);
    if (r.cue !== lastCue) {
      lastCue = r.cue;
      if (r.cue) handlers.onCue?.({ key: r.cue, text: deps.messages[r.cue] });
    }

    if (r.action === 'pause' && lastAction !== 'pause' && r.reason) handlers.onPause?.(r.reason);
    if (lastAction === 'pause' && r.action === 'continue') handlers.onResume?.();
    if (r.action === 'stop' && r.reason && (lastAction !== 'stop' || r.reason !== lastReason)) {
      handlers.onSafetyStop?.(r.reason);
    }
    lastAction = r.action;
    lastReason = r.reason;

    if (r.reps >= target) void finish('completed');
    else if (r.action === 'stop' && (r.reason === 'camera-stopped' || r.reason === 'user-stop')) {
      void finish('stopped');
    }
  };

  const tick = () => {
    if (isFinished) return;
    const timestampMs = clock();
    const landmarks = backend.detect(timestampMs);
    const cameraActive = backend.cameraActive;
    // No new frame yet: wait, unless the camera itself has gone away.
    if (landmarks !== undefined || !cameraActive) {
      dispatch(session.processFrame({ landmarks: landmarks ?? null, timestampMs, cameraActive }));
    }
    if (!isFinished) frameId = scheduler.request(tick);
  };
  frameId = scheduler.request(tick);

  return {
    confirmCarer: () => session.confirmCarer(),
    requestStop() {
      session.requestStop();
      void finish('stopped');
    },
    finished,
  };
}
