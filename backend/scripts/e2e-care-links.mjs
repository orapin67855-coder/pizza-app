// End-to-end check of care links, patient-summary and the audit log against a REAL local
// Supabase stack (`npm run db:start`). Usage: node scripts/e2e-care-links.mjs
//
// The carer/physio side needs a real (confirmed, non-anonymous) account. Locally we create
// those through the admin API with the local service key; that key is used only for this test
// setup and cleanup, never by the functions under test.

import { check, createHttp, finish, readLocalEnv } from './lib/e2e.mjs';
import { randomUUID } from 'node:crypto';

const env = readLocalEnv();
const API = env.API_URL;
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;
const http = createHttp(ANON);
const FN = `${API}/functions/v1`;

async function anonymousUser() {
  const r = await http(`${API}/auth/v1/signup`, { method: 'POST', body: { data: {} } });
  if (r.status !== 200 || !r.json?.access_token) throw new Error(`anonymous sign-in failed`);
  return { token: r.json.access_token, id: r.json.user.id };
}

/** A confirmed email account, created with the local admin API and signed in with a password. */
async function realUser(label) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const created = await http(`${API}/auth/v1/admin/users`, {
    method: 'POST',
    key: SERVICE,
    token: SERVICE,
    body: { email, password, email_confirm: true },
  });
  if (created.status >= 300) throw new Error(`admin create user failed: ${created.status}`);
  const login = await http(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    body: { email, password },
  });
  if (!login.json?.access_token) throw new Error(`password sign-in failed: ${login.status}`);
  return { token: login.json.access_token, id: created.json.id, email };
}

const careLinks = (user, body) =>
  http(`${FN}/care-links`, { method: 'POST', token: user.token, body });
const summary = (user, body) =>
  http(`${FN}/patient-summary`, { method: 'POST', token: user.token, body });
const setConsent = (user, purpose, granted) =>
  http(`${FN}/consents`, {
    method: 'POST',
    token: user.token,
    body: { consents: [{ purpose, granted, textVersion: 'v1' }] },
  });
const session = (id, over = {}) => ({
  clientId: id,
  exerciseId: 'arm-raise',
  startedAt: '2026-11-18T09:00:00Z',
  durationS: 60,
  reps: 5,
  status: 'completed',
  ...over,
});
const audit = (user) =>
  http(`${API}/rest/v1/audit_log?select=action,actor_id,patient_id,detail&order=id`, {
    token: user.token,
  });

const users = [];
try {
  const patient = await anonymousUser(); // a local-first patient: anonymous is fine
  const other = await anonymousUser();
  const physio = await realUser('physio');
  const carer = await realUser('carer');
  const anonMember = await anonymousUser();
  const guesser = await realUser('guesser');
  users.push(patient, other, physio, carer, anonMember, guesser);

  await setConsent(patient, 'sync_sessions', true);
  const upload = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token: patient.token,
    body: { sessions: [session('s-1'), session('s-2', { status: 'stopped', reps: 2 })] },
  });
  check('patient uploaded two sessions', upload.status === 200, upload.json);

  // ---- third parties have no direct door to the data
  const direct = await http(`${API}/rest/v1/sessions?select=client_id`, { token: physio.token });
  check('a physio cannot read sessions directly', direct.json?.length === 0, direct.json);

  // ---- invite / accept
  const inv = await careLinks(patient, { action: 'invite', role: 'physio' });
  check(
    'patient can create an invitation code',
    inv.status === 200 && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(inv.json?.code ?? ''),
    inv.status,
  );

  const noLink = await summary(physio, { patientId: patient.id });
  check('no access before the invitation is accepted', noLink.status === 403, noLink.json);

  const anonAccept = await careLinks(anonMember, { action: 'accept', code: inv.json.code });
  check(
    'an anonymous account cannot accept (403 account_required)',
    anonAccept.status === 403 && anonAccept.json?.error === 'account_required',
    anonAccept.json,
  );
  // a real account (so the account check passes) redeeming its own invitation
  const ownInvite = await careLinks(carer, { action: 'invite', role: 'carer' });
  const selfAccept = await careLinks(carer, { action: 'accept', code: ownInvite.json.code });
  check('nobody can accept their own invitation (404)', selfAccept.status === 404, selfAccept.json);
  const wrong = await careLinks(physio, { action: 'accept', code: '0000-0000-0000-0000' });
  check('a wrong code is refused (404)', wrong.status === 404, wrong.json);

  const ok = await careLinks(physio, { action: 'accept', code: inv.json.code.toLowerCase() });
  check(
    'the physio accepts the code',
    ok.status === 200 && ok.json?.memberRole === 'physio',
    ok.json,
  );
  const reuse = await careLinks(carer, { action: 'accept', code: inv.json.code });
  check('the code works only once', reuse.status === 404, reuse.json);

  // ---- consent gate
  const noConsent = await summary(physio, { patientId: patient.id });
  check(
    'linked but without share_with_physio consent: refused',
    noConsent.status === 403,
    noConsent.json,
  );
  await setConsent(patient, 'share_with_physio', true);
  const read = await summary(physio, {
    patientId: patient.id,
    from: '2026-11-01T00:00:00Z',
    to: '2026-11-30T00:00:00Z',
  });
  check(
    'with link + consent the physio gets the numbers',
    read.status === 200 &&
      read.json?.totals?.sessions === 2 &&
      read.json?.totals?.reps === 7 &&
      read.json?.sessions?.length === 2 &&
      read.json?.byExercise?.[0]?.exerciseId === 'arm-raise',
    read.json?.totals,
  );
  check(
    'the summary carries no client ids or other raw fields',
    !/clientId|client_id|landmark/i.test(JSON.stringify(read.json)),
  );

  const otherRead = await summary(physio, { patientId: other.id });
  check(
    "the physio cannot read another patient's numbers",
    otherRead.status === 403,
    otherRead.status,
  );
  const carerRead = await summary(carer, { patientId: patient.id });
  check('an unlinked carer cannot read', carerRead.status === 403, carerRead.status);
  const badRange = await summary(physio, {
    patientId: patient.id,
    from: '2026-11-30T00:00:00Z',
    to: '2026-11-01T00:00:00Z',
  });
  check('an inverted range is rejected (400)', badRange.status === 400, badRange.json);

  // ---- audit trail
  const trail = await audit(patient);
  const reads = (trail.json ?? []).filter((r) => r.action === 'patient_summary.read');
  check(
    'every successful read was audited (and only successful ones)',
    reads.length === 1 && reads[0].actor_id === physio.id,
    trail.json?.map((r) => r.action),
  );
  check(
    'the audit rows hold only the date range, no health data',
    Object.keys(reads[0]?.detail ?? {})
      .sort()
      .join() === 'from,to',
    reads[0]?.detail,
  );
  const physioTrail = await audit(physio);
  check('the physio cannot read the audit log', physioTrail.json?.length === 0, physioTrail.json);
  const forged = await http(`${API}/rest/v1/audit_log`, {
    method: 'POST',
    token: patient.token,
    body: { patient_id: patient.id, action: 'care_link.created' },
  });
  const wiped = await http(`${API}/rest/v1/audit_log?patient_id=eq.${patient.id}`, {
    method: 'DELETE',
    token: patient.token,
  });
  const after = await audit(patient);
  check(
    'the audit log cannot be forged or wiped by the patient (403)',
    forged.status === 403 && wiped.status === 403 && after.json?.length === trail.json?.length,
    [forged.status, wiped.status],
  );

  // ---- links are visible only to the people in them; hash never exposed
  const ownLinks = await http(
    `${API}/rest/v1/care_links?select=id,status,member_role,member_id,patient_id`,
    { token: patient.token },
  );
  const strangerLinks = await http(`${API}/rest/v1/care_links?select=id`, { token: other.token });
  check(
    'only participants can see a link',
    ownLinks.json?.length === 1 && strangerLinks.json?.length === 0,
    [ownLinks.json?.length, strangerLinks.json?.length],
  );
  const hash = await http(`${API}/rest/v1/care_links?select=invite_hash`, { token: patient.token });
  check('the invitation hash is not readable', hash.status >= 400, hash.status);
  const forgedLink = await http(`${API}/rest/v1/care_links`, {
    method: 'POST',
    token: other.token,
    body: {
      patient_id: patient.id,
      member_id: other.id,
      member_role: 'physio',
      status: 'active',
      expires_at: '2099-01-01T00:00:00Z',
    },
  });
  check(
    'a link cannot be forged through the table API',
    forgedLink.status >= 400,
    forgedLink.status,
  );

  // ---- email-restricted invitation
  const restricted = await careLinks(patient, {
    action: 'invite',
    role: 'carer',
    email: carer.email.toUpperCase(),
  });
  const wrongEmail = await careLinks(physio, { action: 'accept', code: restricted.json.code });
  check(
    'an email-restricted code refuses other accounts',
    wrongEmail.status === 404,
    wrongEmail.json,
  );
  const rightEmail = await careLinks(carer, { action: 'accept', code: restricted.json.code });
  check('...and works for the matching account', rightEmail.status === 200, rightEmail.json);

  // ---- revocation cuts access at once
  await setConsent(patient, 'share_with_physio', false);
  const afterConsent = await summary(physio, { patientId: patient.id });
  check(
    'withdrawing consent cuts access immediately',
    afterConsent.status === 403,
    afterConsent.json,
  );
  await setConsent(patient, 'share_with_physio', true);
  const back = await summary(physio, { patientId: patient.id });
  check('re-granting consent restores access while the link is active', back.status === 200);

  const revoke = await careLinks(patient, { action: 'revoke', linkId: ok.json.linkId });
  check('the patient revokes the physio link', revoke.status === 200, revoke.json);
  const afterRevoke = await summary(physio, { patientId: patient.id });
  check('revoking the link cuts access immediately', afterRevoke.status === 403, afterRevoke.json);
  const strangerRevoke = await careLinks(other, {
    action: 'revoke',
    linkId: rightEmail.json.linkId,
  });
  check('a stranger cannot revoke someone else’s link (404)', strangerRevoke.status === 404);
  const leave = await careLinks(carer, { action: 'revoke', linkId: rightEmail.json.linkId });
  check('a member can leave a link themselves', leave.status === 200, leave.json);

  // ---- guessing invitation codes is rate limited (5 wrong codes -> locked out)
  const guesses = [];
  for (let i = 0; i < 5; i++) {
    guesses.push(
      (await careLinks(guesser, { action: 'accept', code: '0000-0000-0000-0000' })).status,
    );
  }
  const realInvite = await careLinks(patient, { action: 'invite', role: 'carer' });
  const locked = await careLinks(guesser, { action: 'accept', code: realInvite.json.code });
  check(
    'five wrong codes are refused (404), then the user is locked out even with a valid code (429)',
    guesses.every((s) => s === 404) &&
      locked.status === 429 &&
      locked.json?.error === 'too_many_attempts',
    [guesses.join(), locked.status],
  );
  const otherUserOk = await careLinks(carer, { action: 'accept', code: realInvite.json.code });
  check(
    'the lockout is per user: another account can still use the code',
    otherUserOk.status === 200,
    otherUserOk.status,
  );

  // ---- auth edge cases
  const noToken = await http(`${FN}/patient-summary`, {
    method: 'POST',
    body: { patientId: patient.id },
  });
  const garbage = await summary({ token: 'not.a.jwt' }, { patientId: patient.id });
  check(
    'no token / garbage token are rejected (401)',
    noToken.status === 401 && garbage.status === 401,
    [noToken.status, garbage.status],
  );

  // ---- deleting the physio keeps the patient's history; deleting the patient erases it all
  const delPhysio = await http(`${FN}/delete-me`, { method: 'POST', token: physio.token });
  const trailAfter = await audit(patient);
  check(
    'deleting the physio account keeps the patient’s audit history (actor becomes null)',
    delPhysio.status === 200 &&
      trailAfter.json?.some((r) => r.action === 'patient_summary.read' && r.actor_id === null),
    delPhysio.status,
  );
  const delPatient = await http(`${FN}/delete-me`, { method: 'POST', token: patient.token });
  const leftovers = await Promise.all(
    ['care_links?select=id', 'audit_log?select=id'].map((t) =>
      http(`${API}/rest/v1/${t}&patient_id=eq.${patient.id}`, {
        key: SERVICE,
        token: SERVICE,
      }).then((r) => (Array.isArray(r.json) ? r.json.length : -1)),
    ),
  );
  check(
    'deleting the patient removes their links and audit trail',
    delPatient.status === 200 && leftovers.every((n) => n === 0),
    leftovers,
  );
} catch (e) {
  check(`no unexpected exception: ${e?.message ?? e}`, false);
} finally {
  for (const u of users) {
    await http(`${FN}/delete-me`, { method: 'POST', token: u.token }).catch(() => {});
  }
}

finish();
