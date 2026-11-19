import { describe, expect, it } from 'vitest';
import { handleConsents } from '../supabase/functions/consents/handler.ts';
import { handleDeleteMe } from '../supabase/functions/delete-me/handler.ts';
import { handleSessionsBatch } from '../supabase/functions/sessions-batch/handler.ts';
import { empty, ENV, fakeFetch, json, req } from './fake-fetch.ts';

const sessionBody = (n = 2) => ({
  sessions: Array.from({ length: n }, (_, i) => ({
    clientId: `c-${i}`,
    exerciseId: 'arm-raise',
    startedAt: '2026-11-18T09:00:00Z',
    durationS: 60,
    reps: 5,
    status: 'completed',
  })),
});

describe('sessions-batch', () => {
  it("forwards valid sessions to PostgREST with the caller's own token and reports them accepted", async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(
      req('sessions-batch', { body: sessionBody() }),
      ENV,
      f.fetch,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acceptedIds: ['c-0', 'c-1'] });

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(
      'https://proj.supabase.test/rest/v1/sessions?on_conflict=patient_id,client_id',
    );
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer user-jwt');
    expect(call.headers['apikey']).toBe('anon-key');
    expect(call.headers['prefer']).toContain('resolution=ignore-duplicates');
    expect(JSON.parse(call.body ?? '[]')).toHaveLength(2);
  });

  it('never uses the service role key (database policies must stay in force)', async () => {
    const f = fakeFetch(() => empty(201));
    await handleSessionsBatch(req('sessions-batch', { body: sessionBody() }), ENV, f.fetch);
    expect(JSON.stringify(f.calls)).not.toContain('service-key');
  });

  it('never sends patient_id: ownership comes from the token, not the body', async () => {
    const f = fakeFetch(() => empty(201));
    const body = sessionBody(1);
    (body.sessions[0] as Record<string, unknown>)['patientId'] = 'someone-else';
    const res = await handleSessionsBatch(req('sessions-batch', { body }), ENV, f.fetch);
    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('answers CORS preflight without touching the database', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(
      req('sessions-batch', { method: 'OPTIONS' }),
      ENV,
      f.fetch,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(f.calls).toHaveLength(0);
  });

  it('adds CORS headers to normal responses', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(
      req('sessions-batch', { body: sessionBody() }),
      ENV,
      f.fetch,
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects other HTTP methods', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(req('sessions-batch', { method: 'GET' }), ENV, f.fetch);
    expect(res.status).toBe(405);
  });

  it('requires a bearer token', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(
      req('sessions-batch', { token: null, body: sessionBody() }),
      ENV,
      f.fetch,
    );
    expect(res.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects malformed JSON', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(req('sessions-batch', { raw: '{nope' }), ENV, f.fetch);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('rejects invalid sessions with a helpful message and does not call the database', async () => {
    const f = fakeFetch(() => empty(201));
    const body = sessionBody(1);
    (body.sessions[0] as Record<string, unknown>)['reps'] = -3;
    const res = await handleSessionsBatch(req('sessions-batch', { body }), ENV, f.fetch);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    expect(f.calls).toHaveLength(0);
  });

  it('rejects oversized bodies', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(
      req('sessions-batch', { raw: JSON.stringify({ pad: 'x'.repeat(70_000) }) }),
      ENV,
      f.fetch,
    );
    expect(res.status).toBe(413);
    expect(f.calls).toHaveLength(0);
  });

  it('reports consent_required (403) when the database refuses the insert', async () => {
    const f = fakeFetch(() =>
      json(403, { code: '42501', message: 'new row violates row-level security policy' }),
    );
    const res = await handleSessionsBatch(
      req('sessions-batch', { body: sessionBody() }),
      ENV,
      f.fetch,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('consent_required');
  });

  it('passes an expired or invalid token through as 401', async () => {
    const f = fakeFetch(() => json(401, { message: 'JWT expired' }));
    const res = await handleSessionsBatch(
      req('sessions-batch', { body: sessionBody() }),
      ENV,
      f.fetch,
    );
    expect(res.status).toBe(401);
  });

  it('hides upstream error details from the client', async () => {
    const f = fakeFetch(() => json(500, { message: 'relation "secret_table" does not exist' }));
    const res = await handleSessionsBatch(
      req('sessions-batch', { body: sessionBody() }),
      ENV,
      f.fetch,
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('secret_table');
  });

  it('reports a misconfigured deployment instead of crashing', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleSessionsBatch(
      req('sessions-batch', { body: sessionBody() }),
      { ...ENV, SUPABASE_URL: '' },
      f.fetch,
    );
    expect(res.status).toBe(500);
  });
});

describe('consents', () => {
  const body = {
    consents: [
      { purpose: 'sync_sessions', granted: true, textVersion: 'v1' },
      { purpose: 'ai_summary', granted: false, textVersion: 'v1' },
    ],
  };

  it("upserts the caller's consents with their own token", async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleConsents(req('consents', { body }), ENV, f.fetch);
    expect(res.status).toBe(200);
    const call = f.calls[0]!;
    expect(call.url).toBe(
      'https://proj.supabase.test/rest/v1/consents?on_conflict=user_id,purpose',
    );
    expect(call.headers['authorization']).toBe('Bearer user-jwt');
    expect(call.headers['prefer']).toContain('resolution=merge-duplicates');
    expect(JSON.parse(call.body ?? '[]')).toEqual([
      { purpose: 'sync_sessions', granted: true, text_version: 'v1' },
      { purpose: 'ai_summary', granted: false, text_version: 'v1' },
    ]);
  });

  it('never forwards a user id or timestamps from the client', async () => {
    const f = fakeFetch(() => empty(201));
    const bad = {
      consents: [{ purpose: 'sync_sessions', granted: true, textVersion: 'v1', userId: 'x' }],
    };
    const res = await handleConsents(req('consents', { body: bad }), ENV, f.fetch);
    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('requires a token and a valid body', async () => {
    const f = fakeFetch(() => empty(201));
    expect(
      (await handleConsents(req('consents', { token: null, body }), ENV, f.fetch)).status,
    ).toBe(401);
    expect(
      (await handleConsents(req('consents', { body: { consents: [] } }), ENV, f.fetch)).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('answers CORS preflight', async () => {
    const f = fakeFetch(() => empty(201));
    const res = await handleConsents(req('consents', { method: 'OPTIONS' }), ENV, f.fetch);
    expect(res.status).toBe(204);
  });

  it('maps database failures to a generic 502', async () => {
    const f = fakeFetch(() => json(500, { message: 'internal detail' }));
    const res = await handleConsents(req('consents', { body }), ENV, f.fetch);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('internal detail');
  });
});

describe('delete-me', () => {
  const USER_ID = '11111111-2222-4333-8444-555555555555';
  const responder = (call: { url: string; method: string }) =>
    call.url.endsWith('/auth/v1/user') ? json(200, { id: USER_ID }) : empty(200);

  it('identifies the caller from their token, then deletes exactly that account', async () => {
    const f = fakeFetch(responder);
    const res = await handleDeleteMe(req('delete-me'), ENV, f.fetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const [who, del] = f.calls;
    expect(who?.url).toBe('https://proj.supabase.test/auth/v1/user');
    expect(who?.headers['authorization']).toBe('Bearer user-jwt');
    expect(del?.method).toBe('DELETE');
    expect(del?.url).toBe(`https://proj.supabase.test/auth/v1/admin/users/${USER_ID}`);
    expect(del?.headers['authorization']).toBe('Bearer service-key');
  });

  it('ignores any user id the client tries to supply', async () => {
    const f = fakeFetch(responder);
    await handleDeleteMe(req('delete-me', { body: { userId: 'someone-else' } }), ENV, f.fetch);
    expect(f.calls.map((c) => c.url).join()).not.toContain('someone-else');
  });

  it('does not delete anything when the token is not valid', async () => {
    const f = fakeFetch(() => json(401, { message: 'invalid JWT' }));
    const res = await handleDeleteMe(req('delete-me'), ENV, f.fetch);
    expect(res.status).toBe(401);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe('GET');
  });

  it('requires a bearer token', async () => {
    const f = fakeFetch(responder);
    const res = await handleDeleteMe(req('delete-me', { token: null }), ENV, f.fetch);
    expect(res.status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses to run without the service role key configured', async () => {
    const f = fakeFetch(responder);
    const res = await handleDeleteMe(
      req('delete-me'),
      { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' },
      f.fetch,
    );
    expect(res.status).toBe(500);
    expect(f.calls).toHaveLength(0);
  });

  it('reports failure when the account could not be deleted', async () => {
    const f = fakeFetch((call) =>
      call.url.endsWith('/auth/v1/user') ? json(200, { id: USER_ID }) : json(500, { msg: 'boom' }),
    );
    const res = await handleDeleteMe(req('delete-me'), ENV, f.fetch);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });

  it('refuses an identity that is not a UUID instead of building a URL from it', async () => {
    const f = fakeFetch((call) =>
      call.url.endsWith('/auth/v1/user') ? json(200, { id: '../../x' }) : empty(200),
    );
    const res = await handleDeleteMe(req('delete-me'), ENV, f.fetch);
    expect(res.status).toBe(502);
    expect(f.calls).toHaveLength(1);
  });

  it('only accepts POST', async () => {
    const f = fakeFetch(responder);
    expect((await handleDeleteMe(req('delete-me', { method: 'GET' }), ENV, f.fetch)).status).toBe(
      405,
    );
  });
});
