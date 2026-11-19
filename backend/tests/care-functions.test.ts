import { describe, expect, it } from 'vitest';
import { handleCareLinks } from '../supabase/functions/care-links/handler.ts';
import { handlePatientSummary } from '../supabase/functions/patient-summary/handler.ts';
import { empty, ENV, fakeFetch, json, req } from './fake-fetch.ts';

const LINK_ID = '11111111-2222-4333-8444-555555555555';
const PATIENT_ID = '99999999-2222-4333-8444-555555555555';

const rpcError = (status: number, code: string, message: string) => json(status, { code, message });

describe('care-links', () => {
  const call = (body: unknown, fetchFn = fakeFetch(() => json(200, {}))) =>
    handleCareLinks(req('care-links', { body }), ENV, fetchFn.fetch);

  describe('invite', () => {
    const upstream = {
      id: LINK_ID,
      code: 'ABCD-1234-ABCD-1234',
      expires_at: '2026-11-25T00:00:00Z',
    };

    it("creates an invitation through the database function with the caller's own token", async () => {
      const f = fakeFetch(() => json(200, upstream));
      const res = await call({ action: 'invite', role: 'physio', email: 'dr@example.test' }, f);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: LINK_ID,
        code: 'ABCD-1234-ABCD-1234',
        expiresAt: '2026-11-25T00:00:00Z',
      });
      expect(f.calls).toHaveLength(1);
      const c = f.calls[0]!;
      expect(c.url).toBe('https://proj.supabase.test/rest/v1/rpc/create_care_invite');
      expect(c.method).toBe('POST');
      expect(c.headers['authorization']).toBe('Bearer user-jwt');
      expect(c.headers['apikey']).toBe('anon-key');
      expect(JSON.parse(c.body ?? '{}')).toEqual({ p_role: 'physio', p_email: 'dr@example.test' });
    });

    it('sends no email restriction when none is given', async () => {
      const f = fakeFetch(() => json(200, upstream));
      await call({ action: 'invite', role: 'carer' }, f);
      expect(JSON.parse(f.calls[0]!.body ?? '{}')).toEqual({ p_role: 'carer', p_email: null });
    });

    it.each([
      ['an unknown role', { action: 'invite', role: 'admin' }],
      ['the patient role', { action: 'invite', role: 'patient' }],
      ['a missing role', { action: 'invite' }],
      ['a non-string email', { action: 'invite', role: 'carer', email: 5 }],
      ['an overlong email', { action: 'invite', role: 'carer', email: 'x'.repeat(300) }],
      ['an extra field', { action: 'invite', role: 'carer', patientId: PATIENT_ID }],
    ])('rejects %s without touching the database', async (_label, body) => {
      const f = fakeFetch(() => json(200, upstream));
      const res = await call(body, f);
      expect(res.status).toBe(400);
      expect(f.calls).toHaveLength(0);
    });

    it.each([
      ['invalid_email', 400, 'invalid_email'],
      ['too_many_invites', 429, 'too_many_invites'],
    ])('maps the database refusal %s to %i', async (message, status, error) => {
      const f = fakeFetch(() => rpcError(400, 'P0001', message));
      const res = await call({ action: 'invite', role: 'carer' }, f);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    });
  });

  describe('accept', () => {
    it('redeems a code and reports the link', async () => {
      const f = fakeFetch(() => json(200, { link_id: LINK_ID, member_role: 'physio' }));
      const res = await call({ action: 'accept', code: 'abcd-1234-abcd-1234' }, f);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ linkId: LINK_ID, memberRole: 'physio' });
      expect(f.calls[0]!.url).toBe('https://proj.supabase.test/rest/v1/rpc/accept_care_invite');
      expect(JSON.parse(f.calls[0]!.body ?? '{}')).toEqual({ p_code: 'abcd-1234-abcd-1234' });
    });

    it.each([
      ['no code', { action: 'accept' }],
      ['an empty code', { action: 'accept', code: '' }],
      ['an overlong code', { action: 'accept', code: 'x'.repeat(65) }],
      ['a non-string code', { action: 'accept', code: 123 }],
      ['an extra field', { action: 'accept', code: 'ABCD', memberId: 'x' }],
    ])('rejects %s', async (_label, body) => {
      const f = fakeFetch(() => json(200, {}));
      const res = await call(body, f);
      expect(res.status).toBe(400);
      expect(f.calls).toHaveLength(0);
    });

    it('turns a refused guess (answered as a value so it can be counted) into 404', async () => {
      const f = fakeFetch(() => json(200, { error: 'invalid_invite' }));
      const res = await call({ action: 'accept', code: 'ABCD-ABCD-ABCD-ABCD' }, f);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'invalid_invite' });
    });

    it('does not pass on an unknown error value from the database', async () => {
      const f = fakeFetch(() => json(200, { error: 'some_internal_rule' }));
      const res = await call({ action: 'accept', code: 'ABCD-ABCD-ABCD-ABCD' }, f);
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain('some_internal_rule');
    });

    it('tells a locked-out user to wait (429)', async () => {
      const f = fakeFetch(() => rpcError(400, 'P0001', 'too_many_attempts'));
      const res = await call({ action: 'accept', code: 'ABCD-ABCD-ABCD-ABCD' }, f);
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: string }).error).toBe('too_many_attempts');
    });

    it.each([
      ['invalid_invite', 404, 'invalid_invite'],
      ['account_required', 403, 'account_required'],
      ['already_linked', 409, 'already_linked'],
    ])('maps the database refusal %s to %i', async (message, status, error) => {
      const f = fakeFetch(() => rpcError(400, 'P0001', message));
      const res = await call({ action: 'accept', code: 'ABCD-ABCD-ABCD-ABCD' }, f);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    });
  });

  describe('revoke', () => {
    it('ends the link', async () => {
      const f = fakeFetch(() => empty(204));
      const res = await call({ action: 'revoke', linkId: LINK_ID }, f);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });
      expect(f.calls[0]!.url).toBe('https://proj.supabase.test/rest/v1/rpc/revoke_care_link');
      expect(JSON.parse(f.calls[0]!.body ?? '{}')).toEqual({ p_link_id: LINK_ID });
    });

    it.each([
      ['a non-uuid id', { action: 'revoke', linkId: '../../x' }],
      ['no id', { action: 'revoke' }],
      ['an extra field', { action: 'revoke', linkId: LINK_ID, status: 'active' }],
    ])('rejects %s', async (_label, body) => {
      const f = fakeFetch(() => empty(204));
      const res = await call(body, f);
      expect(res.status).toBe(400);
      expect(f.calls).toHaveLength(0);
    });

    it('maps not_found to 404', async () => {
      const f = fakeFetch(() => rpcError(400, 'P0001', 'not_found'));
      const res = await call({ action: 'revoke', linkId: LINK_ID }, f);
      expect(res.status).toBe(404);
    });
  });

  describe('every action', () => {
    it('rejects an unknown or missing action', async () => {
      const f = fakeFetch(() => json(200, {}));
      expect((await call({ action: 'promote' }, f)).status).toBe(400);
      expect((await call({}, f)).status).toBe(400);
      expect((await call([], f)).status).toBe(400);
      expect(f.calls).toHaveLength(0);
    });

    it('never uses the service role key', async () => {
      const f = fakeFetch(() => json(200, { id: LINK_ID, code: 'C', expires_at: 'x' }));
      await call({ action: 'invite', role: 'carer' }, f);
      await call({ action: 'accept', code: 'ABCD' }, f);
      await call({ action: 'revoke', linkId: LINK_ID }, f);
      expect(JSON.stringify(f.calls)).not.toContain('service-key');
    });

    it('requires POST, a token, valid JSON and a configured server', async () => {
      const f = fakeFetch(() => json(200, {}));
      const body = { action: 'revoke', linkId: LINK_ID };
      expect((await handleCareLinks(req('c', { method: 'GET' }), ENV, f.fetch)).status).toBe(405);
      expect((await handleCareLinks(req('c', { token: null, body }), ENV, f.fetch)).status).toBe(
        401,
      );
      expect((await handleCareLinks(req('c', { raw: '{nope' }), ENV, f.fetch)).status).toBe(400);
      expect(
        (await handleCareLinks(req('c', { body }), { ...ENV, SUPABASE_URL: '' }, f.fetch)).status,
      ).toBe(500);
      expect(f.calls).toHaveLength(0);
    });

    it('answers CORS preflight and adds CORS headers', async () => {
      const f = fakeFetch(() => json(200, { id: LINK_ID, code: 'C', expires_at: 'x' }));
      const pre = await handleCareLinks(req('c', { method: 'OPTIONS' }), ENV, f.fetch);
      expect(pre.status).toBe(204);
      const res = await call({ action: 'invite', role: 'carer' }, f);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('passes an expired token through as 401', async () => {
      const f = fakeFetch(() => json(401, { message: 'JWT expired' }));
      expect((await call({ action: 'revoke', linkId: LINK_ID }, f)).status).toBe(401);
    });

    it('hides unexpected database errors', async () => {
      const f = fakeFetch(() => json(500, { code: 'XX000', message: 'relation "secret" is gone' }));
      const res = await call({ action: 'revoke', linkId: LINK_ID }, f);
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain('secret');
    });

    it('hides database refusals it does not know about', async () => {
      const f = fakeFetch(() => rpcError(400, 'P0001', 'some_internal_rule'));
      const res = await call({ action: 'revoke', linkId: LINK_ID }, f);
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).not.toContain('some_internal_rule');
    });

    it('reports a network failure as 502', async () => {
      const f = fakeFetch(() => {
        throw new Error('down');
      });
      expect((await call({ action: 'revoke', linkId: LINK_ID }, f)).status).toBe(502);
    });
  });
});

describe('patient-summary', () => {
  const upstream = {
    patient: { id: PATIENT_ID, display_name: 'Somchai' },
    range: { from: '2026-11-01T00:00:00+00:00', to: '2026-11-30T00:00:00+00:00' },
    truncated: false,
    totals: { sessions: 2, completed: 1, stopped: 1, reps: 8, duration_s: 120 },
    by_exercise: [{ exercise_id: 'arm-raise', sessions: 2, reps: 8, duration_s: 120 }],
    sessions: [
      {
        exercise_id: 'arm-raise',
        started_at: '2026-11-12T09:00:00+00:00',
        duration_s: 60,
        reps: 3,
        status: 'stopped',
      },
      {
        exercise_id: 'arm-raise',
        started_at: '2026-11-10T09:00:00+00:00',
        duration_s: 60,
        reps: 5,
        status: 'completed',
      },
    ],
  };

  const call = (body: unknown, fetchFn = fakeFetch(() => json(200, upstream))) =>
    handlePatientSummary(req('patient-summary', { body }), ENV, fetchFn.fetch);

  it("asks the database function as the caller and returns the numbers in the API's casing", async () => {
    const f = fakeFetch(() => json(200, upstream));
    const res = await call(
      { patientId: PATIENT_ID, from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' },
      f,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      patient: { id: PATIENT_ID, displayName: 'Somchai' },
      range: upstream.range,
      truncated: false,
      totals: { sessions: 2, completed: 1, stopped: 1, reps: 8, durationS: 120 },
      byExercise: [{ exerciseId: 'arm-raise', sessions: 2, reps: 8, durationS: 120 }],
      sessions: [
        {
          exerciseId: 'arm-raise',
          startedAt: '2026-11-12T09:00:00+00:00',
          durationS: 60,
          reps: 3,
          status: 'stopped',
        },
        {
          exerciseId: 'arm-raise',
          startedAt: '2026-11-10T09:00:00+00:00',
          durationS: 60,
          reps: 5,
          status: 'completed',
        },
      ],
    });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://proj.supabase.test/rest/v1/rpc/patient_summary');
    expect(c.headers['authorization']).toBe('Bearer user-jwt');
    expect(JSON.parse(c.body ?? '{}')).toEqual({
      p_patient_id: PATIENT_ID,
      p_from: '2026-11-01T00:00:00.000Z',
      p_to: '2026-11-30T00:00:00.000Z',
    });
  });

  it('lets the database default the range when none is given', async () => {
    const f = fakeFetch(() => json(200, upstream));
    await call({ patientId: PATIENT_ID }, f);
    expect(JSON.parse(f.calls[0]!.body ?? '{}')).toEqual({ p_patient_id: PATIENT_ID });
  });

  it('passes on only the fields it knows, never extra data the database might add', async () => {
    const leaky = {
      ...upstream,
      sessions: [{ ...upstream.sessions[0]!, client_id: 'internal', landmarks: [1, 2, 3] }],
      patient: { ...upstream.patient, email: 'x@example.test' },
      secret: 'nope',
    };
    const res = await call(
      { patientId: PATIENT_ID },
      fakeFetch(() => json(200, leaky)),
    );
    const text = JSON.stringify(await res.json());
    for (const needle of ['internal', 'landmarks', 'x@example.test', 'nope']) {
      expect(text).not.toContain(needle);
    }
  });

  it('never uses the service role key', async () => {
    const f = fakeFetch(() => json(200, upstream));
    await call({ patientId: PATIENT_ID }, f);
    expect(JSON.stringify(f.calls)).not.toContain('service-key');
  });

  it.each([
    ['no patient id', {}],
    ['a non-uuid patient id', { patientId: 'me' }],
    ['a path-like patient id', { patientId: '../sessions' }],
    ['a malformed from', { patientId: PATIENT_ID, from: 'yesterday' }],
    ['a non-string to', { patientId: PATIENT_ID, to: 5 }],
    ['an extra field', { patientId: PATIENT_ID, limit: 5 }],
  ])('rejects %s without touching the database', async (_label, body) => {
    const f = fakeFetch(() => json(200, upstream));
    const res = await call(body, f);
    expect(res.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it('answers 403 forbidden for every refusal, with no hint why', async () => {
    const f = fakeFetch(() => rpcError(403, '42501', 'forbidden'));
    const res = await call({ patientId: PATIENT_ID }, f);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('maps an invalid range to 400', async () => {
    const f = fakeFetch(() => rpcError(400, 'P0001', 'invalid_range'));
    const res = await call({ patientId: PATIENT_ID }, f);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_range');
  });

  it('passes an expired token through as 401 and hides other upstream errors', async () => {
    expect(
      (
        await call(
          { patientId: PATIENT_ID },
          fakeFetch(() => json(401, { message: 'JWT expired' })),
        )
      ).status,
    ).toBe(401);
    const res = await call(
      { patientId: PATIENT_ID },
      fakeFetch(() => json(500, { message: 'relation "secret" is gone' })),
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it.each([
    ['an unrelated object', { oops: true }],
    ['a missing truncated flag', { ...upstream, truncated: undefined }],
    ['a non-numeric total', { ...upstream, totals: { ...upstream.totals, reps: '8' } }],
    [
      'an unknown session status',
      { ...upstream, sessions: [{ ...upstream.sessions[0]!, status: 'x' }] },
    ],
    ['a missing display name field', { ...upstream, patient: { id: PATIENT_ID } }],
  ])('does not hand out data when the upstream answer has %s', async (_label, bad) => {
    const res = await call(
      { patientId: PATIENT_ID },
      fakeFetch(() => json(200, bad)),
    );
    expect(res.status).toBe(502);
  });

  it('requires POST, a token and answers preflight', async () => {
    const f = fakeFetch(() => json(200, upstream));
    expect((await handlePatientSummary(req('p', { method: 'GET' }), ENV, f.fetch)).status).toBe(
      405,
    );
    expect(
      (
        await handlePatientSummary(
          req('p', { token: null, body: { patientId: PATIENT_ID } }),
          ENV,
          f.fetch,
        )
      ).status,
    ).toBe(401);
    expect((await handlePatientSummary(req('p', { method: 'OPTIONS' }), ENV, f.fetch)).status).toBe(
      204,
    );
    expect(f.calls).toHaveLength(0);
  });
});
