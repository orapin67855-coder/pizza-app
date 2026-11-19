import {
  errorResponse,
  guard,
  jsonResponse,
  knownRefusal,
  readJsonBody,
  rpc,
  rpcFailure,
  type Env,
} from '../_shared/http.ts';
import { parseCareLinksBody, ValidationError } from '../_shared/validate.ts';

/** The database's own refusal codes (see 0003_care_links.sql) and the status each maps to. */
const KNOWN_REFUSALS = {
  invalid_email: 400,
  too_many_invites: 429,
  invalid_invite: 404,
  account_required: 403,
  already_linked: 409,
  not_found: 404,
  too_many_attempts: 429,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * POST { action: 'invite', role, email? } -> { id, code, expiresAt }   (patient)
 * POST { action: 'accept', code }          -> { linkId, memberRole }    (carer / physio)
 * POST { action: 'revoke', linkId }        -> { revoked: true }         (either side)
 * Every rule lives in the database functions; this layer validates and translates. The caller
 * is identified only by their token, so no id in the body can act on someone else's behalf.
 */
export async function handleCareLinks(
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
    request = parseCareLinksBody(body.value);
  } catch (e) {
    if (e instanceof ValidationError) return errorResponse(400, 'invalid_request', e.message);
    throw e;
  }

  let res: Response;
  try {
    switch (request.action) {
      case 'invite':
        res = await rpc(
          env,
          gate.token,
          'create_care_invite',
          { p_role: request.role, p_email: request.email },
          fetchFn,
        );
        break;
      case 'accept':
        res = await rpc(env, gate.token, 'accept_care_invite', { p_code: request.code }, fetchFn);
        break;
      case 'revoke':
        res = await rpc(
          env,
          gate.token,
          'revoke_care_link',
          { p_link_id: request.linkId },
          fetchFn,
        );
        break;
    }
  } catch {
    return errorResponse(502, 'upstream_error');
  }

  if (!res.ok) return rpcFailure(res, KNOWN_REFUSALS);
  if (request.action === 'revoke') return jsonResponse(200, { revoked: true });

  const data: unknown = await res.json().catch(() => null);
  if (!isObject(data)) return errorResponse(502, 'upstream_error');
  // A refused guess is answered as a value (so the attempt is committed and counted).
  if (typeof data['error'] === 'string') return knownRefusal(data['error'], KNOWN_REFUSALS);
  if (request.action === 'invite') {
    const { id, code, expires_at: expiresAt } = data;
    if (typeof id !== 'string' || typeof code !== 'string' || typeof expiresAt !== 'string') {
      return errorResponse(502, 'upstream_error');
    }
    return jsonResponse(200, { id, code, expiresAt });
  }
  const { link_id: linkId, member_role: memberRole } = data;
  if (typeof linkId !== 'string' || typeof memberRole !== 'string') {
    return errorResponse(502, 'upstream_error');
  }
  return jsonResponse(200, { linkId, memberRole });
}
