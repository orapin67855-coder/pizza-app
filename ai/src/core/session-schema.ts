import type { SessionInput } from './types';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface ValidSessionInput {
  exerciseId: string;
  /** Canonical ISO string (UTC, milliseconds). */
  startedAt: string;
  durationS: number;
  reps: number;
  status: SessionInput['status'];
  clientId: string | undefined;
}

const ALLOWED_KEYS = new Set([
  'exerciseId',
  'startedAt',
  'durationS',
  'reps',
  'status',
  'clientId',
]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const MAX_DURATION_S = 86_400;
const MAX_REPS = 1_000;

const isShortString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

/**
 * Validates a session summary. Strict on purpose: unknown keys are rejected so a caller can
 * never slip landmarks, frames or other raw data into storage or sync by accident.
 * (Hand-written to keep the browser bundle small; Edge Functions can use a schema library.)
 */
export function parseSessionInput(input: unknown): ValidSessionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Session input must be an object');
  }
  const obj = input as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) throw new ValidationError(`Unexpected field: ${key}`);
  }
  if (!isShortString(obj['exerciseId'], 64)) throw new ValidationError('Invalid exerciseId');

  const startedAt = obj['startedAt'];
  if (
    typeof startedAt !== 'string' ||
    !ISO_UTC.test(startedAt) ||
    Number.isNaN(Date.parse(startedAt))
  ) {
    throw new ValidationError('startedAt must be an ISO-8601 UTC timestamp');
  }

  const durationS = obj['durationS'];
  if (
    typeof durationS !== 'number' ||
    !Number.isFinite(durationS) ||
    durationS < 0 ||
    durationS > MAX_DURATION_S
  ) {
    throw new ValidationError('Invalid durationS');
  }

  const reps = obj['reps'];
  if (typeof reps !== 'number' || !Number.isInteger(reps) || reps < 0 || reps > MAX_REPS) {
    throw new ValidationError('Invalid reps');
  }

  const status = obj['status'];
  if (status !== 'completed' && status !== 'stopped') throw new ValidationError('Invalid status');

  const clientId = obj['clientId'];
  if (clientId !== undefined && !isShortString(clientId, 64)) {
    throw new ValidationError('Invalid clientId');
  }

  return {
    exerciseId: obj['exerciseId'] as string,
    startedAt: new Date(startedAt).toISOString(),
    durationS,
    reps,
    status,
    clientId: clientId as string | undefined,
  };
}
