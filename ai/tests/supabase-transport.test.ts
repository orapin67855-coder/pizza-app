import { describe, expect, it } from 'vitest';
import { createSupabaseTransport } from '../src/core/supabase-transport';
import type { ConsentRecord, StoredSession } from '../src/core/types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const fail = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const stored = (id: string): StoredSession => ({
  clientId: id,
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00.000Z',
  durationS: 60,
  reps: 5,
  status: 'completed',
  syncedAt: null,
});

const consent: ConsentRecord = {
  purpose: 'sync_sessions',
  granted: true,
  textVersion: 'v1',
  grantedAt: '2026-11-18T10:00:00.000Z',
  revokedAt: null,
};

const make = (f: ReturnType<typeof fakeFetch>, token: string | null = 'jwt-1') =>
  createSupabaseTransport({
    functionsUrl: 'https://proj.supabase.co/functions/v1/',
    anonKey: 'anon-key',
    getAccessToken: async () => token,
    fetch: f.fetch,
  });

describe('createSupabaseTransport: sendSessions', () => {
  it('posts the sessions to the edge function with the user token and the anon key', async () => {
    const f = fakeFetch(() => ok({ acceptedIds: ['a', 'b'] }));
    const r = await make(f).sendSessions([stored('a'), stored('b')]);
    expect(r).toEqual({ acceptedIds: ['a', 'b'] });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.url).toBe('https://proj.supabase.co/functions/v1/sessions-batch');
    expect(c.method).toBe('POST');
    expect(c.headers['authorization']).toBe('Bearer jwt-1');
    expect(c.headers['apikey']).toBe('anon-key');
    expect(c.headers['content-type']).toBe('application/json');
  });

  it('sends only the summary fields (no local bookkeeping such as syncedAt)', async () => {
    const f = fakeFetch(() => ok({ acceptedIds: ['a'] }));
    await make(f).sendSessions([stored('a')]);
    expect(f.calls[0]?.body).toEqual({
      sessions: [
        {
          clientId: 'a',
          exerciseId: 'arm-raise',
          startedAt: '2026-11-18T09:00:00.000Z',
          durationS: 60,
          reps: 5,
          status: 'completed',
        },
      ],
    });
  });

  it('fails clearly, without any request, when the user is not signed in', async () => {
    const f = fakeFetch(() => ok({ acceptedIds: [] }));
    await expect(make(f, null).sendSessions([stored('a')])).rejects.toThrow('not-signed-in');
    expect(f.calls).toHaveLength(0);
  });

  it('maps 401 to not-signed-in', async () => {
    const f = fakeFetch(() => fail(401, { error: 'unauthorized' }));
    await expect(make(f).sendSessions([stored('a')])).rejects.toThrow('not-signed-in');
  });

  it('maps the consent_required refusal to consent-required', async () => {
    const f = fakeFetch(() => fail(403, { error: 'consent_required' }));
    await expect(make(f).sendSessions([stored('a')])).rejects.toThrow('consent-required');
  });

  it('reports other failures with the status code only', async () => {
    const f = fakeFetch(() => fail(502, { error: 'upstream_error' }));
    await expect(make(f).sendSessions([stored('a')])).rejects.toThrow('sync-failed-502');
  });

  it('rejects a malformed success response instead of trusting it', async () => {
    const f = fakeFetch(() => ok({ acceptedIds: 'nope' }));
    await expect(make(f).sendSessions([stored('a')])).rejects.toThrow('bad-response');
    const g = fakeFetch(() => ok({ acceptedIds: [1, 2] }));
    await expect(make(g).sendSessions([stored('a')])).rejects.toThrow('bad-response');
  });

  it('lets network errors propagate so the caller keeps the sessions for retry', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(make(f).sendSessions([stored('a')])).rejects.toThrow('Failed to fetch');
  });
});

describe('createSupabaseTransport: sendConsents', () => {
  it('posts purpose, granted and text version only (server stamps the time)', async () => {
    const f = fakeFetch(() => ok({ updated: 1 }));
    await make(f).sendConsents!([consent]);
    expect(f.calls[0]?.url).toBe('https://proj.supabase.co/functions/v1/consents');
    expect(f.calls[0]?.body).toEqual({
      consents: [{ purpose: 'sync_sessions', granted: true, textVersion: 'v1' }],
    });
  });

  it('does nothing when there is nothing to send', async () => {
    const f = fakeFetch(() => ok({}));
    await make(f).sendConsents!([]);
    expect(f.calls).toHaveLength(0);
  });

  it('fails when the user is not signed in or the server refuses', async () => {
    await expect(
      make(
        fakeFetch(() => ok({})),
        null,
      ).sendConsents!([consent]),
    ).rejects.toThrow('not-signed-in');
    await expect(make(fakeFetch(() => fail(500))).sendConsents!([consent])).rejects.toThrow(
      'sync-failed-500',
    );
  });
});

describe('createSupabaseTransport: deleteMyData', () => {
  it('asks the delete-me function to erase the account', async () => {
    const f = fakeFetch(() => ok({ deleted: true }));
    await make(f).deleteMyData!();
    expect(f.calls[0]?.url).toBe('https://proj.supabase.co/functions/v1/delete-me');
    expect(f.calls[0]?.method).toBe('POST');
    expect(f.calls[0]?.headers['authorization']).toBe('Bearer jwt-1');
  });

  it('fails if the account could not be deleted, or the user is not signed in', async () => {
    await expect(make(fakeFetch(() => fail(502))).deleteMyData!()).rejects.toThrow(
      'sync-failed-502',
    );
    await expect(
      make(
        fakeFetch(() => ok({})),
        null,
      ).deleteMyData!(),
    ).rejects.toThrow('not-signed-in');
  });
});
