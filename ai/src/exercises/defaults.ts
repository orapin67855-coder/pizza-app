import type { Exercise } from '../types/exercise';

/**
 * Offline fallback copies of the exercise definitions. The source of truth will be the
 * `exercises` table (versioned, physiotherapist-approved). Every value here is a PLACEHOLDER
 * prototype setting, not a clinical prescription.
 */
export const DEFAULT_EXERCISES: readonly Exercise[] = [
  {
    id: 'arm-raise',
    name: 'High arm raise',
    needsCarer: false,
    targetReps: 5,
    approvalStatus: 'draft',
    criteria: { metric: 'shoulder-angle', up: 150, down: 40, minRepMs: 600 },
  },
  {
    id: 'sit-stand',
    name: 'Sit-to-stand from a chair',
    needsCarer: true,
    targetReps: 5,
    approvalStatus: 'draft',
    criteria: { metric: 'knee-angle', up: 160, down: 110, minRepMs: 800 },
  },
  {
    id: 'seated-alt-arm',
    name: 'Seated alternating arm raise',
    needsCarer: false,
    targetReps: 5,
    approvalStatus: 'draft',
    // one rep = one raise on each side; thresholds apply per arm
    criteria: { metric: 'alt-shoulder-angle', up: 140, down: 40, minRepMs: 400 },
  },
  {
    id: 'torso-twist',
    name: 'Seated trunk rotation',
    needsCarer: false,
    targetReps: 5,
    approvalStatus: 'draft',
    // degrees of shoulder-vs-hip rotation from the person's own resting posture, each way
    criteria: { metric: 'trunk-rotation', up: 25, down: 10, minRepMs: 500 },
  },
  {
    id: 'big-step',
    name: 'Long steps, rhythmic walking',
    needsCarer: true,
    targetReps: 10,
    approvalStatus: 'draft',
    // unitless: ankle gap / torso length, measured from a side-on camera; one rep = one step
    criteria: { metric: 'stride-ratio', up: 0.6, down: 0.2, minRepMs: 250 },
  },
];
