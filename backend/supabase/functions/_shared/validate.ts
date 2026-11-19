export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface SessionRow {
  client_id: string;
  exercise_id: string;
  started_at: string;
  duration_s: number;
  reps: number;
  status: 'completed' | 'stopped';
}

export interface ConsentRow {
  purpose: ConsentPurpose;
  granted: boolean;
  text_version: string;
}

export const CONSENT_PURPOSES = [
  'sync_sessions',
  'share_with_physio',
  'community_clip',
  'ai_summary',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const MAX_BATCH = 50;
const MAX_DURATION_S = 86_400;
const MAX_REPS = 1_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const shortString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

/** Rejects any key outside `allowed`: nothing unexpected (raw data, owner ids) gets through. */
function onlyKeys(obj: Obj, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ValidationError(`Unexpected field in ${what}: ${key}`);
  }
}

function parseSession(raw: unknown, index: number): SessionRow {
  if (!isObject(raw)) throw new ValidationError(`sessions[${index}] must be an object`);
  onlyKeys(raw, ['clientId', 'exerciseId', 'startedAt', 'durationS', 'reps', 'status'], 'session');

  const { clientId, exerciseId, startedAt, durationS, reps, status } = raw;
  if (!shortString(clientId, 64)) throw new ValidationError(`sessions[${index}].clientId invalid`);
  if (!shortString(exerciseId, 64)) {
    throw new ValidationError(`sessions[${index}].exerciseId invalid`);
  }
  if (
    typeof startedAt !== 'string' ||
    !ISO_UTC.test(startedAt) ||
    Number.isNaN(Date.parse(startedAt))
  ) {
    throw new ValidationError(`sessions[${index}].startedAt must be an ISO-8601 UTC timestamp`);
  }
  if (
    typeof durationS !== 'number' ||
    !Number.isFinite(durationS) ||
    durationS < 0 ||
    durationS > MAX_DURATION_S
  ) {
    throw new ValidationError(`sessions[${index}].durationS invalid`);
  }
  if (typeof reps !== 'number' || !Number.isInteger(reps) || reps < 0 || reps > MAX_REPS) {
    throw new ValidationError(`sessions[${index}].reps invalid`);
  }
  if (status !== 'completed' && status !== 'stopped') {
    throw new ValidationError(`sessions[${index}].status invalid`);
  }
  return {
    client_id: clientId,
    exercise_id: exerciseId,
    started_at: new Date(startedAt).toISOString(),
    duration_s: durationS,
    reps,
    status,
  };
}

/** Validates an upload batch. Duplicate clientIds inside one batch keep only the first. */
export function parseSessionsBatch(body: unknown): SessionRow[] {
  if (!isObject(body)) throw new ValidationError('Body must be an object');
  onlyKeys(body, ['sessions'], 'body');
  const sessions = body['sessions'];
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new ValidationError('sessions must be a non-empty array');
  }
  if (sessions.length > MAX_BATCH) {
    throw new ValidationError(`At most ${MAX_BATCH} sessions per request`);
  }
  const seen = new Set<string>();
  const rows: SessionRow[] = [];
  sessions.forEach((raw, i) => {
    const row = parseSession(raw, i);
    if (seen.has(row.client_id)) return;
    seen.add(row.client_id);
    rows.push(row);
  });
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export type CareLinksRequest =
  | { action: 'invite'; role: 'carer' | 'physio'; email: string | null }
  | { action: 'accept'; code: string }
  | { action: 'revoke'; linkId: string };

/** Validates a care-links request. The caller is always taken from the token, never the body. */
export function parseCareLinksBody(body: unknown): CareLinksRequest {
  if (!isObject(body)) throw new ValidationError('Body must be an object');
  switch (body['action']) {
    case 'invite': {
      onlyKeys(body, ['action', 'role', 'email'], 'invite');
      const { role, email } = body;
      if (role !== 'carer' && role !== 'physio') throw new ValidationError('role invalid');
      if (email !== undefined && email !== null && !shortString(email, 254)) {
        throw new ValidationError('email invalid');
      }
      return { action: 'invite', role, email: typeof email === 'string' ? email : null };
    }
    case 'accept': {
      onlyKeys(body, ['action', 'code'], 'accept');
      if (!shortString(body['code'], 64)) throw new ValidationError('code invalid');
      return { action: 'accept', code: body['code'] };
    }
    case 'revoke': {
      onlyKeys(body, ['action', 'linkId'], 'revoke');
      if (!isUuid(body['linkId'])) throw new ValidationError('linkId invalid');
      return { action: 'revoke', linkId: body['linkId'] };
    }
    default:
      throw new ValidationError('action must be invite, accept or revoke');
  }
}

export interface PatientSummaryRequest {
  patientId: string;
  from?: string;
  to?: string;
}

const optionalInstant = (v: unknown, name: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ValidationError(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return new Date(v).toISOString();
};

/** Validates a patient-summary request. The range limits are enforced by the database. */
export function parsePatientSummaryBody(body: unknown): PatientSummaryRequest {
  if (!isObject(body)) throw new ValidationError('Body must be an object');
  onlyKeys(body, ['patientId', 'from', 'to'], 'body');
  if (!isUuid(body['patientId'])) throw new ValidationError('patientId invalid');
  const from = optionalInstant(body['from'], 'from');
  const to = optionalInstant(body['to'], 'to');
  return {
    patientId: body['patientId'],
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/**
 * Validates a consent update. Timestamps and the owner are deliberately not accepted:
 * the database stamps server time and takes the owner from the caller's JWT.
 */
export function parseConsentsBody(body: unknown): ConsentRow[] {
  if (!isObject(body)) throw new ValidationError('Body must be an object');
  onlyKeys(body, ['consents'], 'body');
  const consents = body['consents'];
  if (!Array.isArray(consents) || consents.length === 0) {
    throw new ValidationError('consents must be a non-empty array');
  }
  if (consents.length > CONSENT_PURPOSES.length) {
    throw new ValidationError('Too many consent records');
  }
  const seen = new Set<string>();
  return consents.map((raw, i) => {
    if (!isObject(raw)) throw new ValidationError(`consents[${i}] must be an object`);
    onlyKeys(raw, ['purpose', 'granted', 'textVersion'], 'consent');
    const { purpose, granted, textVersion } = raw;
    if (!CONSENT_PURPOSES.includes(purpose as ConsentPurpose)) {
      throw new ValidationError(`consents[${i}].purpose invalid`);
    }
    if (typeof granted !== 'boolean') throw new ValidationError(`consents[${i}].granted invalid`);
    if (!shortString(textVersion, 32)) {
      throw new ValidationError(`consents[${i}].textVersion invalid`);
    }
    if (seen.has(purpose as string)) {
      throw new ValidationError(`Duplicate consent purpose: ${purpose as string}`);
    }
    seen.add(purpose as string);
    return { purpose: purpose as ConsentPurpose, granted, text_version: textVersion };
  });
}
