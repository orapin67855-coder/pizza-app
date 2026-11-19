import type { Metric } from '../pose/signals';

/** Thresholds a physiotherapist can edit without touching code. */
export interface ExerciseCriteria {
  metric: Metric;
  /** Measurement that must be reached for a rep to start (degrees, or a ratio for stride-ratio). */
  up: number;
  /** Measurement the user must return to for the rep to finish (same unit as `up`). */
  down: number;
  /** Reps faster than this (ms) are treated as noise. */
  minRepMs: number;
  /** Landmarks below this visibility make a frame unusable. Default 0.5. */
  minVisibility?: number;
}

export type ApprovalStatus = 'draft' | 'under_review' | 'approved';

export interface Exercise {
  id: string;
  name: string;
  /** Fall-risk exercises must have a carer confirmed before they can start. */
  needsCarer: boolean;
  targetReps: number;
  /** Everything is a prototype until a physiotherapist approves it. */
  approvalStatus: ApprovalStatus;
  criteria: ExerciseCriteria;
}
