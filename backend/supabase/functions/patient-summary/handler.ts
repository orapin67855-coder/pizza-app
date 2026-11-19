import {
  errorResponse,
  guard,
  jsonResponse,
  readJsonBody,
  rpc,
  rpcFailure,
  type Env,
} from '../_shared/http.ts';
import { parsePatientSummaryBody, ValidationError } from '../_shared/validate.ts';

/** Every refusal to read (no link, no consent, revoked, ...) is the same 403 on purpose. */
const KNOWN_REFUSALS = { forbidden: 403, invalid_range: 400 } as const;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Copies the database answer field by field into the API shape. Whatever the database might add
 * later is dropped, and an unexpected shape yields null (we send nothing rather than guess).
 */
function toApiSummary(raw: unknown): Obj | null {
  if (!isObject(raw)) return null;
  const { patient, range, truncated, totals, by_exercise: byExercise, sessions } = raw;
  if (!isObject(patient) || typeof patient['id'] !== 'string') return null;
  const displayName = patient['display_name'];
  if (displayName !== null && typeof displayName !== 'string') return null;
  if (!isObject(range) || typeof range['from'] !== 'string' || typeof range['to'] !== 'string') {
    return null;
  }
  if (typeof truncated !== 'boolean' || !isObject(totals)) return null;
  const t = ['sessions', 'completed', 'stopped', 'reps', 'duration_s'].map((k) => totals[k]);
  if (!t.every(isNumber)) return null;
  if (!Array.isArray(byExercise) || !Array.isArray(sessions)) return null;

  const exercises = [];
  for (const e of byExercise) {
    if (!isObject(e) || typeof e['exercise_id'] !== 'string') return null;
    const nums = [e['sessions'], e['reps'], e['duration_s']];
    if (!nums.every(isNumber)) return null;
    exercises.push({
      exerciseId: e['exercise_id'],
      sessions: e['sessions'],
      reps: e['reps'],
      durationS: e['duration_s'],
    });
  }
  const list = [];
  for (const s of sessions) {
    if (!isObject(s) || typeof s['exercise_id'] !== 'string') return null;
    if (typeof s['started_at'] !== 'string') return null;
    if (!isNumber(s['duration_s']) || !isNumber(s['reps'])) return null;
    if (s['status'] !== 'completed' && s['status'] !== 'stopped') return null;
    list.push({
      exerciseId: s['exercise_id'],
      startedAt: s['started_at'],
      durationS: s['duration_s'],
      reps: s['reps'],
      status: s['status'],
    });
  }
  return {
    patient: { id: patient['id'], displayName },
    range: { from: range['from'], to: range['to'] },
    truncated,
    totals: {
      sessions: totals['sessions'],
      completed: totals['completed'],
      stopped: totals['stopped'],
      reps: totals['reps'],
      durationS: totals['duration_s'],
    },
    byExercise: exercises,
    sessions: list,
  };
}

/**
 * POST { patientId, from?, to? } -> activity numbers for a patient who shares with the caller.
 * Access control and the audit row are written by the database function in one transaction,
 * so a read cannot happen without being recorded. The service role key is never used.
 */
export async function handlePatientSummary(
  req: Request,
  env: Env,
  fetchFn: typeof fetch,
): Promise<Response> {
  const gate = guard(req, env);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;

  let request;
  try {
    request = parsePatientSummaryBody(body.value);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, 'invalid_request', e.message);
    throw e;
  }

  let res: Response;
  try {
    res = await rpc(
      env,
      gate.token,
      'patient_summary',
      {
        p_patient_id: request.patientId,
        ...(request.from !== undefined ? { p_from: request.from } : {}),
        ...(request.to !== undefined ? { p_to: request.to } : {}),
      },
      fetchFn,
    );
  } catch {
    return errorResponse(502, 'upstream_error');
  }

  if (!res.ok) return rpcFailure(res, KNOWN_REFUSALS);
  const summary = toApiSummary(await res.json().catch(() => null));
  return summary === null ? errorResponse(502, 'upstream_error') : jsonResponse(200, summary);
}
