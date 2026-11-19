// End-to-end check against a REAL local Supabase stack (`supabase start`).
// Usage: node scripts/e2e-local.mjs   (reads URL/keys from `supabase status -o env`)
//
// Exercises, over real HTTP: anonymous sign-in, consent enforcement by the database,
// idempotent session upload, revocation, cross-user isolation and account deletion.

import { check, createHttp, finish, readLocalEnv } from './lib/e2e.mjs';

const env = readLocalEnv();
const API = env.API_URL;
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;
const http = createHttp(ANON);
const FN = `${API}/functions/v1`;

async function signInAnonymously() {
  const r = await http(`${API}/auth/v1/signup`, { method: 'POST', body: { data: {} } });
  if (r.status !== 200 || !r.json?.access_token)
    throw new Error(`anonymous sign-in failed: ${r.status} ${r.text}`);
  return { token: r.json.access_token, id: r.json.user.id };
}

const session = (id, over = {}) => ({
  clientId: id,
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00Z',
  durationS: 61.5,
  reps: 5,
  status: 'completed',
  ...over,
});

try {
  // ---- auth + profile trigger
  const A = await signInAnonymously();
  const B = await signInAnonymously();
  check('anonymous sign-in works for two users', A.id && B.id && A.id !== B.id);

  const profile = await http(`${API}/rest/v1/profiles?select=id,role`, { token: A.token });
  check(
    'profile row was auto-created as a patient',
    profile.json?.length === 1 && profile.json[0].role === 'patient',
    profile.json,
  );

  // ---- exercises readable when signed in, not anonymously (apikey only)
  const ex = await http(`${API}/rest/v1/exercises?select=id,approval_status&order=id`, {
    token: A.token,
  });
  check(
    'exercises are readable by a signed-in user (5 drafts)',
    ex.json?.length === 5 && ex.json.every((e) => e.approval_status === 'draft'),
    ex.json?.length,
  );
  const exAnon = await http(`${API}/rest/v1/exercises?select=id`);
  check(
    'exercises are NOT readable with only the anon key',
    exAnon.status === 401 || exAnon.status === 403 || exAnon.json?.length === 0,
    exAnon.status,
  );

  // ---- self-promotion blocked
  const promote = await http(`${API}/rest/v1/profiles?id=eq.${A.id}`, {
    method: 'PATCH',
    token: A.token,
    body: { role: 'admin' },
    headers: { Prefer: 'return=representation' },
  });
  const after = await http(`${API}/rest/v1/profiles?select=role`, { token: A.token });
  check(
    'a user cannot promote themselves',
    promote.status >= 400 && after.json?.[0]?.role === 'patient',
    promote.status,
  );

  // ---- no consent -> upload refused by the database, surfaced as consent_required
  const noConsent = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: A.token,
    body: { sessions: [session('s-1')] },
  });
  check(
    'upload without consent is refused (403 consent_required)',
    noConsent.status === 403 && noConsent.json?.error === 'consent_required',
    noConsent,
  );

  // ---- grant consent through the function; server stamps the time
  const grant = await http(`${FN}/consents`, {
    method: 'POST',
    token: A.token,
    body: { consents: [{ purpose: 'sync_sessions', granted: true, textVersion: 'v1' }] },
  });
  check('consent can be granted through the function', grant.status === 200, grant);
  const consentRow = await http(
    `${API}/rest/v1/consents?select=purpose,granted,granted_at,revoked_at`,
    { token: A.token },
  );
  check(
    'server stamped granted_at',
    consentRow.json?.[0]?.granted === true && !!consentRow.json?.[0]?.granted_at,
    consentRow.json,
  );

  // ---- upload + idempotent resend
  const up = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: A.token,
    body: { sessions: [session('s-1'), session('s-2', { status: 'stopped', reps: 2 })] },
  });
  check(
    'upload with consent succeeds',
    up.status === 200 && up.json?.acceptedIds?.length === 2,
    up,
  );
  const resend = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: A.token,
    body: { sessions: [session('s-1', { reps: 99 })] },
  });
  const rows = await http(`${API}/rest/v1/sessions?select=client_id,reps&order=client_id`, {
    token: A.token,
  });
  check(
    'resending the same clientId is idempotent (no duplicate, original kept)',
    resend.status === 200 && rows.json?.length === 2 && rows.json[0].reps === 5,
    rows.json,
  );

  // ---- invalid payloads rejected by the function
  const bad = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: A.token,
    body: { sessions: [{ ...session('s-9'), landmarks: [[{ x: 0, y: 0 }]] }] },
  });
  check('raw landmark field is rejected (400)', bad.status === 400, bad.json);

  // ---- isolation
  const bView = await http(`${API}/rest/v1/sessions?select=client_id`, { token: B.token });
  check(
    "another user cannot see A's sessions",
    Array.isArray(bView.json) && bView.json.length === 0,
    bView.json,
  );
  const bUpload = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: B.token,
    body: { sessions: [session('b-1')] },
  });
  check('user B (no consent) cannot upload', bUpload.status === 403, bUpload.status);
  const forge = await http(`${API}/rest/v1/sessions`, {
    method: 'POST',
    token: A.token,
    body: {
      patient_id: B.id,
      client_id: 'forged',
      exercise_id: 'x',
      started_at: '2026-11-18T09:00:00Z',
      duration_s: 1,
      reps: 1,
      status: 'completed',
    },
  });
  check('cannot insert a session for another patient directly', forge.status >= 400, forge.status);
  const edit = await http(`${API}/rest/v1/sessions?client_id=eq.s-1`, {
    method: 'PATCH',
    token: A.token,
    body: { reps: 1 },
  });
  const still = await http(`${API}/rest/v1/sessions?select=reps&client_id=eq.s-1`, {
    token: A.token,
  });
  check(
    'uploaded sessions cannot be edited',
    edit.status >= 400 && still.json?.[0]?.reps === 5,
    edit.status,
  );

  // ---- consent history is append-only
  const events = await http(`${API}/rest/v1/consent_events?select=granted,text_version`, {
    token: A.token,
  });
  check(
    'consent history recorded the grant',
    events.json?.length === 1 && events.json[0].granted === true,
    events.json,
  );
  const forgeEvent = await http(`${API}/rest/v1/consent_events`, {
    method: 'POST',
    token: A.token,
    body: { user_id: A.id, purpose: 'sync_sessions', granted: true, text_version: 'forged' },
  });
  // a filter is required: PostgREST refuses an unfiltered DELETE with 400 for its own reasons
  const delEvent = await http(`${API}/rest/v1/consent_events?user_id=eq.${A.id}`, {
    method: 'DELETE',
    token: A.token,
  });
  const updEvent = await http(`${API}/rest/v1/consent_events?user_id=eq.${A.id}`, {
    method: 'PATCH',
    token: A.token,
    body: { granted: false },
  });
  const eventsAfter = await http(`${API}/rest/v1/consent_events?select=granted,text_version`, {
    token: A.token,
  });
  check(
    'consent history cannot be forged, edited or deleted (database refuses)',
    forgeEvent.status === 403 &&
      delEvent.status === 403 &&
      updEvent.status === 403 &&
      eventsAfter.json?.length === 1 &&
      eventsAfter.json[0].granted === true,
    [forgeEvent.status, delEvent.status, updEvent.status],
  );

  const exWrite = await http(`${API}/rest/v1/exercises`, {
    method: 'POST',
    token: A.token,
    body: { id: 'evil', name: 'x', category: 'A', metric: 'm' },
  });
  const exEdit = await http(`${API}/rest/v1/exercises?id=eq.arm-raise`, {
    method: 'PATCH',
    token: A.token,
    body: { approval_status: 'approved', approved_at: '2026-01-01T00:00:00Z' },
    headers: { Prefer: 'return=representation' },
  });
  const exAfter = await http(`${API}/rest/v1/exercises?select=approval_status&id=eq.arm-raise`, {
    token: A.token,
  });
  check(
    'a patient cannot create or approve exercises',
    exWrite.status >= 400 &&
      exAfter.json?.[0]?.approval_status === 'draft' &&
      (exEdit.json?.length ?? 0) === 0,
    [exWrite.status, exEdit.status],
  );

  const otherProfile = await http(`${API}/rest/v1/profiles?select=id&id=eq.${B.id}`, {
    token: A.token,
  });
  check(
    "a user cannot read another user's profile",
    Array.isArray(otherProfile.json) && otherProfile.json.length === 0,
    otherProfile.json,
  );

  // ---- revocation blocks new uploads at the database
  const revoke = await http(`${FN}/consents`, {
    method: 'POST',
    token: A.token,
    body: { consents: [{ purpose: 'sync_sessions', granted: false, textVersion: 'v1' }] },
  });
  check('consent can be revoked', revoke.status === 200, revoke);
  const afterRevoke = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: A.token,
    body: { sessions: [session('s-3')] },
  });
  check('upload after revocation is refused', afterRevoke.status === 403, afterRevoke.status);
  const events2 = await http(`${API}/rest/v1/consent_events?select=granted&order=id`, {
    token: A.token,
  });
  check(
    'consent history now shows grant then revoke',
    events2.json?.map((e) => e.granted).join() === 'true,false',
    events2.json,
  );

  // ---- auth edge cases
  const noToken = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    body: { sessions: [session('x')] },
  });
  check('function without a token is rejected', noToken.status === 401, noToken.status);
  const garbage = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: 'not.a.jwt',
    body: { sessions: [session('x')] },
  });
  check('function with a garbage token is rejected', garbage.status === 401, garbage.status);

  // ---- account deletion (right to erasure)
  const del = await http(`${FN}/delete-me`, { method: 'POST', token: A.token });
  check('delete-me succeeds', del.status === 200 && del.json?.deleted === true, del);
  const leftovers = await Promise.all(
    [
      'profiles?select=id',
      'consents?select=user_id',
      'consent_events?select=id',
      'sessions?select=client_id',
    ].map((t) =>
      http(`${API}/rest/v1/${t}`, { key: SERVICE, token: SERVICE }).then(
        (r) => (r.json ?? []).length,
      ),
    ),
  );
  const userRow = await http(`${API}/auth/v1/admin/users/${A.id}`, {
    key: SERVICE,
    token: SERVICE,
  });
  check(
    'the auth user is gone',
    userRow.status === 404 || userRow.status === 400 || userRow.status === 403,
    userRow.status,
  );
  const bProfile = await http(`${API}/rest/v1/profiles?select=id&id=eq.${B.id}`, {
    key: SERVICE,
    token: SERVICE,
  });
  check("user B's data is untouched", bProfile.json?.length === 1, bProfile.json);
  const aProfile = await http(`${API}/rest/v1/profiles?select=id&id=eq.${A.id}`, {
    key: SERVICE,
    token: SERVICE,
  });
  const aSessions = await http(`${API}/rest/v1/sessions?select=client_id&patient_id=eq.${A.id}`, {
    key: SERVICE,
    token: SERVICE,
  });
  const aConsents = await http(`${API}/rest/v1/consents?select=purpose&user_id=eq.${A.id}`, {
    key: SERVICE,
    token: SERVICE,
  });
  const aEvents = await http(`${API}/rest/v1/consent_events?select=id&user_id=eq.${A.id}`, {
    key: SERVICE,
    token: SERVICE,
  });
  check(
    'every trace of A was removed (profile, sessions, consents, history)',
    [aProfile, aSessions, aConsents, aEvents].every(
      (r) => Array.isArray(r.json) && r.json.length === 0,
    ),
    leftovers,
  );

  // cleanup B
  await http(`${FN}/delete-me`, { method: 'POST', token: B.token });
} catch (e) {
  check(`no unexpected exception: ${e?.message ?? e}`, false);
}

finish();
