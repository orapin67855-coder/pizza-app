export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch double that records every request and answers through `responder`. */
export function fakeFetch(responder: Responder) {
  const calls: RecordedCall[] = [];
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    const call: RecordedCall = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(call);
    return responder(call);
  };
  return { fetch: fn as typeof fetch, calls };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const empty = (status: number) => new Response(null, { status });

export const ENV = {
  SUPABASE_URL: 'https://proj.supabase.test',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

export const req = (
  path: string,
  init: { method?: string; token?: string | null; body?: unknown; raw?: string } = {},
) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token !== null) headers['Authorization'] = `Bearer ${init.token ?? 'user-jwt'}`;
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`https://fn.test/${path}`, {
    method: init.method ?? 'POST',
    headers,
    ...(body !== undefined ? { body } : {}),
  });
};
