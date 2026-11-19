import { cueForFrame, type CueKey } from '../coach/cues';
import {
  createSafetyGuard,
  type SafetyAction,
  type SafetyReason,
  type TrackingQuality,
} from '../coach/safety-guard';
import type { Exercise } from '../types/exercise';
import type { Landmark } from '../types/landmark';
import { createCounterEngine, type EngineFrame } from './engines';
import type { RepPhase } from './rep-counter';

export interface PoseSessionOptions {
  exercise: Exercise;
  lostPersonMs?: number;
  lowTrackingMs?: number;
}

export interface FrameInput {
  /** Landmarks of the detected person, or null when nobody was detected. */
  landmarks: readonly Landmark[] | null;
  timestampMs: number;
  /** Set false if the camera stream ended. Default true. */
  cameraActive?: boolean;
}

export interface FrameResult {
  reps: number;
  phase: RepPhase;
  /** Smoothed measurement; NaN until the first usable frame. */
  value: number;
  quality: TrackingQuality;
  action: SafetyAction;
  reason?: SafetyReason;
  cue: CueKey | null;
  /** True only on the frame where a rep was completed. */
  repCompleted: boolean;
  /** True while the person's resting posture is being learned (trunk rotation). */
  calibrating: boolean;
}

export interface PoseSession {
  processFrame(frame: FrameInput): FrameResult;
  confirmCarer(): void;
  requestStop(): void;
  reset(): void;
}

/**
 * Wires one exercise end to end: sense -> safety guard -> smoothing/counting -> cue.
 * Counting only happens while the guard says "continue"; any interruption discards the rep in
 * progress so a gap in tracking can never produce a phantom rep.
 */
export function createPoseSession(options: PoseSessionOptions): PoseSession {
  const { exercise } = options;
  const { criteria } = exercise;

  const engine = createCounterEngine(criteria);
  const guard = createSafetyGuard({
    needsCarer: exercise.needsCarer,
    minVisibility: criteria.minVisibility ?? 0.5,
    ...(options.lostPersonMs !== undefined ? { lostPersonMs: options.lostPersonMs } : {}),
    ...(options.lowTrackingMs !== undefined ? { lowTrackingMs: options.lowTrackingMs } : {}),
  });

  return {
    processFrame(frame) {
      const sensed = engine.sense(frame.landmarks);
      const decision = guard.evaluate({
        timestampMs: frame.timestampMs,
        personDetected: frame.landmarks !== null && frame.landmarks.length > 0,
        visibility: sensed.visibility,
        cameraActive: frame.cameraActive ?? true,
      });

      let state: EngineFrame;
      if (decision.action === 'continue') {
        state = engine.advance(sensed, frame.timestampMs);
      } else {
        engine.abandonRep();
        state = engine.peek();
      }

      const reason = decision.reason !== undefined ? { reason: decision.reason } : {};
      return {
        reps: state.reps,
        phase: state.phase,
        value: state.value,
        quality: decision.quality,
        action: decision.action,
        ...reason,
        cue: cueForFrame({
          phase: state.phase,
          value: state.value,
          up: criteria.up,
          down: criteria.down,
          action: decision.action,
          calibrating: state.calibrating,
          ...reason,
        }),
        repCompleted: state.repCompleted,
        calibrating: state.calibrating,
      };
    },
    confirmCarer: () => guard.confirmCarer(),
    requestStop: () => guard.requestStop(),
    reset() {
      guard.reset();
      engine.reset();
    },
  };
}
