import {
  errorResponse,
  guard,
  jsonResponse,
  postgrest,
  readJsonBody,
  type Env,
} from '../_shared/http.ts';
import { parseSessionsBatch, ValidationError } from '../_shared/validate.ts';

/**
 * POST { sessions: [...] } -> { acceptedIds }.
 * Inserts as the signed-in user, so the database enforces ownership and the sync consent.
 * Re-sending a session is harmless (ignored by the (patient_id, client_id) key), so a client
 * can retry freely and every submitted id counts as accepted once the insert succeeds.
 */
export async function handleSessionsBatch(
  req: Request,
  env: Env,
  fetchFn: typeof fetch,
): Promise<Response> {
  const gate = guard(req, env);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;

  let rows;
  try {
    rows = parseSessionsBatch(body.value);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, 'invalid_request', e.message);
    throw e;
  }

  let res: Response;
  try {
    res = await postgrest(
      env,
      gate.token,
      'sessions?on_conflict=patient_id,client_id',
      'resolution=ignore-duplicates,return=minimal',
      rows,
      fetchFn,
    );
  } catch {
    return errorResponse(502, 'upstream_error');
  }

  if (res.ok) return jsonResponse(200, { acceptedIds: rows.map((r) => r.client_id) });
  if (res.status === 401) return errorResponse(401, 'unauthorized');
  if (res.status === 403) return errorResponse(403, 'consent_required');
  return errorResponse(502, 'upstream_error');
}
