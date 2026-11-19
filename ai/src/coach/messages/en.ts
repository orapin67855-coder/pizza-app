import type { CueKey } from '../cues';

/**
 * User-facing cue text. Keep neutral: no clinical claims, no detection/diagnosis wording
 * (enforced by tests). Add other languages as sibling files (e.g. th.ts) with the same keys.
 */
export const EN_MESSAGES: Record<CueKey, string> = {
  get_into_start_position: 'Get into the starting position',
  calibrating: 'Sit still and face the camera for a moment',
  reach_higher: 'A little higher',
  hold_then_lower: 'Hold for a moment, then lower slowly',
  person_lost: "We can't see you. Please step back into the camera view",
  low_tracking: "We can't see you clearly. Check the lighting and your position",
  carer_required: 'A carer needs to be nearby before this exercise can start',
  camera_stopped: 'The camera stopped. Please check it and try again',
  stopped: 'Exercise stopped',
};
