import {
  errorResponse,
  guard,
  jsonResponse,
  postgrest,
  readJsonBody,
  type Env,
} from '../_shared/http.ts';
import { parseConsentsBody, ValidationError } from '../_shared/validate.ts';

/**
 * POST { consents: [{ purpose, granted, textVersion }] } -> { updated }.
 * The database stamps server time and takes the owner from the caller's JWT; the history is
 * appended to consent_events by a trigger, so this function cannot forge or hide changes.
 */
export async function handleConsents(
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
    rows = parseConsentsBody(body.value);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, 'invalid_request', e.message);
    throw e;
  }

  let res: Response;
  try {
    res = await postgrest(
      env,
      gate.token,
      'consents?on_conflict=user_id,purpose',
      'resolution=merge-duplicates,return=minimal',
      rows,
      fetchFn,
    );
  } catch {
    return errorResponse(502, 'upstream_error');
  }

  if (res.ok) return jsonResponse(200, { updated: rows.length });
  if (res.status === 401) return errorResponse(401, 'unauthorized');
  return errorResponse(502, 'upstream_error');
}
