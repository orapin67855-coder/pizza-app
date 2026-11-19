export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** Only the delete-me function may use this. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export const MAX_BODY_BYTES = 64 * 1024;

const CORS_HEADERS: Record<string, string> = {
  // Requests carry a bearer token and no cookies, so a wildcard origin does not widen access.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });

export const errorResponse = (status: number, error: string, message?: string): Response =>
  jsonResponse(status, message === undefined ? { error } : { error, message });

export const preflightResponse = (): Response =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const bearerToken = (req: Request): string | null => {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
};

export const baseUrl = (env: Env): string => env.SUPABASE_URL.replace(/\/+$/, '');

export type Guard = { ok: true; token: string } | { ok: false; response: Response };

/** Shared front door: CORS preflight, POST only, configured, and a bearer token present. */
export function guard(req: Request, env: Env): Guard {
  if (req.method === 'OPTIONS') return { ok: false, response: preflightResponse() };
  if (req.method !== 'POST')
    return { ok: false, response: errorResponse(405, 'method_not_allowed') };
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return { ok: false, response: errorResponse(500, 'server_misconfigured') };
  }
  const token = bearerToken(req);
  if (!token) return { ok: false, response: errorResponse(401, 'unauthorized') };
  return { ok: true, token };
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

export async function readJsonBody(req: Request): Promise<BodyResult> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES)
    return { ok: false, response: errorResponse(413, 'payload_too_large') };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, 'payload_too_large') };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_json') };
  }
}

/**
 * Calls a database function through PostgREST as the signed-in user. The function itself decides
 * who may do what; this layer only validates input and translates answers.
 */
export function rpc(
  env: Env,
  token: string,
  fn: string,
  args: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<Response> {
  return postgrest(env, token, `rpc/${fn}`, 'return=representation', args, fetchFn);
}

/**
 * Turns a failed rpc into our response. Only refusals listed in `known` (the database's own
 * short codes) are passed on; anything else becomes a generic 502 so internals never leak.
 */
export async function rpcFailure(
  res: Response,
  known: Readonly<Record<string, number>>,
): Promise<Response> {
  if (res.status === 401) return errorResponse(401, 'unauthorized');
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return knownRefusal(typeof body?.message === 'string' ? body.message : '', known);
}

/** A refusal the database reported by its short code: listed ones keep their code, others become 502. */
export function knownRefusal(code: string, known: Readonly<Record<string, number>>): Response {
  const status = Object.hasOwn(known, code) ? known[code] : undefined;
  return status === undefined ? errorResponse(502, 'upstream_error') : errorResponse(status, code);
}

/** Calls PostgREST as the signed-in user, so row level security stays in force. */
export function postgrest(
  env: Env,
  token: string,
  path: string,
  prefer: string,
  rows: unknown,
  fetchFn: typeof fetch,
): Promise<Response> {
  return fetchFn(`${baseUrl(env)}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(rows),
  });
}
