import { describe, expect, it } from 'vitest';
import { createSupabaseTransport } from '../../ai/src/core/supabase-transport';
import type { StoredSession } from '../../ai/src/core/types';
import { handleConsents } from '../supabase/functions/consents/handler.ts';
import { handleDeleteMe } from '../supabase/functions/delete-me/handler.ts';
import { handleSessionsBatch } from '../supabase/functions/sessions-batch/handler.ts';
import { ENV } from './fake-fetch.ts';

const FUNCTIONS = 'https://proj.supabase.test/functions/v1';
const USER_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Routes the real client transport into the real function handlers, with a fake Supabase
 * (PostgREST + GoTrue) behind them. This proves the two packages agree on the wire format.
 */
function wire(supabase: (url: string, init: RequestInit) => Response) {
  const upstream: Array<{ url: string; body: unknown }> = [];
  const supabaseFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    upstream.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    return supabase(url, init);
  }) as typeof fetch;

  const clientFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(input), init);
    const name = new URL(req.url).pathname.split('/').pop();
    if (name === 'sessions-batch') return handleSessionsBatch(req, ENV, supabaseFetch);
    if (name === 'consents') return handleConsents(req, ENV, supabaseFetch);
    if (name === 'delete-me') return handleDeleteMe(req, ENV, supabaseFetch);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const transport = createSupabaseTransport({
    functionsUrl: FUNCTIONS,
    anonKey: ENV.SUPABASE_ANON_KEY,
    getAccessToken: async () => 'user-jwt',
    fetch: clientFetch,
  });
  return { transport, upstream };
}

const stored = (id: string, over: Partial<StoredSession> = {}): StoredSession => ({
  clientId: id,
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00.000Z',
  durationS: 62.5,
  reps: 5,
  status: 'completed',
  syncedAt: null,
  ...over,
});

describe('client transport <-> edge functions', () => {
  it('uploads sessions end to end and reports every id accepted', async () => {
    const { transport, upstream } = wire(() => new Response(null, { status: 201 }));
    const r = await transport.sendSessions([
      stored('a'),
      stored('b', { status: 'stopped', reps: 2 }),
    ]);
    expect(r.acceptedIds).toEqual(['a', 'b']);
    expect(upstream[0]?.url).toContain('/rest/v1/sessions?on_conflict=patient_id,client_id');
    expect(upstream[0]?.body).toEqual([
      {
        client_id: 'a',
        exercise_id: 'arm-raise',
        started_at: '2026-11-18T09:00:00.000Z',
        duration_s: 62.5,
        reps: 5,
        status: 'completed',
      },
      {
        client_id: 'b',
        exercise_id: 'arm-raise',
        started_at: '2026-11-18T09:00:00.000Z',
        duration_s: 62.5,
        reps: 2,
        status: 'stopped',
      },
    ]);
  });

  it('surfaces the database refusing an upload as consent-required', async () => {
    const { transport } = wire(
      () => new Response(JSON.stringify({ code: '42501' }), { status: 403 }),
    );
    await expect(transport.sendSessions([stored('a')])).rejects.toThrow('consent-required');
  });

  it('sends consent changes that the server accepts', async () => {
    const { transport, upstream } = wire(() => new Response(null, { status: 201 }));
    await transport.sendConsents([
      {
        purpose: 'sync_sessions',
        granted: false,
        textVersion: 'v2',
        grantedAt: '2026-11-18T10:00:00.000Z',
        revokedAt: '2026-11-18T11:00:00.000Z',
      },
    ]);
    // timestamps stay on the client; the server row has none, the database stamps them
    expect(upstream[0]?.body).toEqual([
      { purpose: 'sync_sessions', granted: false, text_version: 'v2' },
    ]);
  });

  it('erases the account end to end', async () => {
    const { transport, upstream } = wire((url) =>
      url.endsWith('/auth/v1/user')
        ? new Response(JSON.stringify({ id: USER_ID }), { status: 200 })
        : new Response(null, { status: 200 }),
    );
    await transport.deleteMyData();
    expect(upstream.at(-1)?.url).toBe(`${ENV.SUPABASE_URL}/auth/v1/admin/users/${USER_ID}`);
  });

  it('turns an expired token into not-signed-in', async () => {
    const { transport } = wire(() => new Response('{}', { status: 401 }));
    await expect(transport.sendSessions([stored('a')])).rejects.toThrow('not-signed-in');
  });
});
