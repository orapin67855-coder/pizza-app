import { baseUrl, errorResponse, guard, jsonResponse, type Env } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST (no body) -> { deleted: true }. PDPA "right to erasure".
 * The account to delete is taken from the caller's own token - never from the request - and
 * removing the auth user cascades to every table (profiles, consents, sessions, ...).
 * This is the only function that uses the service role key.
 */
export async function handleDeleteMe(
  req: Request,
  env: Env,
  fetchFn: typeof fetch,
): Promise<Response> {
  const gate = guard(req, env);
  if (!gate.ok) return gate.response;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return errorResponse(500, 'server_misconfigured');

  let who: Response;
  try {
    who = await fetchFn(`${baseUrl(env)}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${gate.token}` },
    });
  } catch {
    return errorResponse(502, 'upstream_error');
  }
  if (who.status === 401 || who.status === 403) return errorResponse(401, 'unauthorized');
  if (!who.ok) return errorResponse(502, 'upstream_error');

  const user = (await who.json().catch(() => null)) as { id?: unknown } | null;
  const id = user?.id;
  if (typeof id !== 'string' || !UUID.test(id)) return errorResponse(502, 'upstream_error');

  let del: Response;
  try {
    del = await fetchFn(`${baseUrl(env)}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
  } catch {
    return errorResponse(502, 'upstream_error');
  }
  return del.ok ? jsonResponse(200, { deleted: true }) : errorResponse(502, 'upstream_error');
}
