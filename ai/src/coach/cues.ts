import type { RepPhase } from '../pose/rep-counter';
import type { SafetyAction, SafetyReason } from './safety-guard';

/** Language-independent cue identifiers; text lives in coach/messages/*. */
export type CueKey =
  | 'get_into_start_position'
  | 'calibrating'
  | 'reach_higher'
  | 'hold_then_lower'
  | 'person_lost'
  | 'low_tracking'
  | 'carer_required'
  | 'camera_stopped'
  | 'stopped';

export interface CueInput {
  phase: RepPhase;
  /** Current filtered measurement in degrees (NaN if unknown). */
  value: number;
  up: number;
  down: number;
  action: SafetyAction;
  reason?: SafetyReason;
  /** True while the person's resting posture is still being learned. */
  calibrating?: boolean;
}

const SAFETY_CUES: Record<SafetyReason, CueKey> = {
  'person-lost': 'person_lost',
  'low-tracking': 'low_tracking',
  'carer-not-confirmed': 'carer_required',
  'camera-stopped': 'camera_stopped',
  'user-stop': 'stopped',
};

/** Picks at most one cue for the frame. Safety cues always win over coaching cues. */
export function cueForFrame(input: CueInput): CueKey | null {
  if (input.action !== 'continue' && input.reason) return SAFETY_CUES[input.reason];
  if (input.calibrating === true) return 'calibrating';
  if (!Number.isFinite(input.value)) return null;

  if (input.phase === 'waiting') return 'get_into_start_position';
  if (input.phase === 'up') return 'hold_then_lower';

  const halfway = input.down + (input.up - input.down) / 2;
  return input.value >= halfway ? 'reach_higher' : null;
}
