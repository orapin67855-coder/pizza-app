// End-to-end check of the REAL client (PizzaCore + createSupabaseTransport from ai/dist) against a
// REAL local Supabase stack (`npm run db:start`). Unlike e2e-local.mjs (raw HTTP), this drives the
// same code path the UI will use: consent -> sessions -> sync.flush() -> export -> deleteAll().
//
// Usage: (cd ../ai && npm run build) && npm run e2e:client     (from backend/)
// Node has no IndexedDB, so PizzaCore falls back to memory storage here; the IndexedDB path is
// covered separately by the browser tests in ai/.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { check, createHttp, finish, readLocalEnv } from './lib/e2e.mjs';

const distFile = join(import.meta.dirname, '..', '..', 'ai', 'dist', 'pizza-core.js');
if (!existsSync(distFile))
  throw new Error('ai/dist/pizza-core.js missing: run `npm run build` in ai/');
const { createPizzaCore, createSupabaseTransport } = await import(pathToFileURL(distFile).href);

const env = readLocalEnv();
const API = env.API_URL;
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;
const http = createHttp(ANON);

// The UI gets its token from supabase-js; here a plain anonymous sign-in gives the same JWT.
const signUp = await http(`${API}/auth/v1/signup`, { method: 'POST', body: { data: {} } });
const token = signUp.json?.access_token;
const userId = signUp.json?.user?.id;
if (!token) throw new Error('anonymous sign-in failed');

const transport = createSupabaseTransport({
  functionsUrl: `${API}/functions/v1`,
  anonKey: ANON,
  getAccessToken: async () => token,
});
const core = await createPizzaCore({ transport, consentTextVersion: 'v1' });

const serverSessions = async () =>
  (
    await http(
      `${API}/rest/v1/sessions?select=client_id,exercise_id,reps,status,duration_s&order=client_id`,
      { token },
    )
  ).json;
const serverConsent = async () =>
  (
    await http(
      `${API}/rest/v1/consents?select=purpose,granted,text_version,granted_at,revoked_at`,
      { token },
    )
  ).json;

try {
  check(
    'PizzaCore starts (memory storage in Node, as expected)',
    core.storageMode === 'memory',
    core.storageMode,
  );

  const s1 = await core.sessions.save({
    exerciseId: 'arm-raise',
    startedAt: '2026-11-19T09:00:00.000Z',
    durationS: 61.5,
    reps: 5,
    status: 'completed',
  });
  const s2 = await core.sessions.save({
    exerciseId: 'arm-raise',
    startedAt: '2026-11-19T10:00:00.000Z',
    durationS: 20,
    reps: 2,
    status: 'stopped',
  });
  check(
    'two sessions are saved locally with generated client ids',
    !!s1.clientId && !!s2.clientId && s1.clientId !== s2.clientId,
  );

  const noConsent = await core.sync.flush();
  check(
    'flush without consent uploads nothing (skipped: no-consent)',
    noConsent.status === 'skipped' && noConsent.reason === 'no-consent',
    noConsent,
  );
  check('...and the server has no sessions', (await serverSessions()).length === 0);

  await core.consent.set('sync_sessions', true);
  const first = await core.sync.flush();
  check(
    'after consent, flush uploads both sessions',
    first.status === 'ok' && first.sent === 2,
    first,
  );
  const rows = await serverSessions();
  check(
    'the server holds the same numbers the client saved',
    rows.length === 2 &&
      rows.some(
        (r) =>
          r.client_id === s1.clientId &&
          r.reps === 5 &&
          r.status === 'completed' &&
          r.duration_s === 61.5,
      ) &&
      rows.some((r) => r.client_id === s2.clientId && r.reps === 2 && r.status === 'stopped'),
    rows,
  );
  const consents = await serverConsent();
  check(
    'the consent reached the server with its text version and a server timestamp',
    consents.length === 1 &&
      consents[0].purpose === 'sync_sessions' &&
      consents[0].granted === true &&
      consents[0].text_version === 'v1' &&
      !!consents[0].granted_at,
    consents,
  );

  const again = await core.sync.flush();
  check(
    'a second flush has nothing to do',
    again.status === 'skipped' && again.reason === 'nothing-to-sync',
    again,
  );

  const dup = await core.sessions.save({
    clientId: s1.clientId,
    exerciseId: s1.exerciseId,
    startedAt: s1.startedAt,
    durationS: s1.durationS,
    reps: 99,
    status: s1.status,
  });
  const afterDup = await core.sessions.list();
  check(
    'saving the same client id again keeps the original and does not duplicate',
    dup.clientId === s1.clientId && dup.reps === 5 && afterDup.length === 2,
    [dup.reps, afterDup.length],
  );

  // revoke: server must learn about it even though nothing is uploaded
  await core.consent.set('sync_sessions', false);
  const s3 = await core.sessions.save({
    exerciseId: 'arm-raise',
    startedAt: '2026-11-19T11:00:00.000Z',
    durationS: 30,
    reps: 3,
    status: 'completed',
  });
  const revoked = await core.sync.flush();
  check(
    'after revoking, flush is skipped and the new session stays local',
    revoked.status === 'skipped' && revoked.reason === 'no-consent',
    revoked,
  );
  const consentsAfter = await serverConsent();
  check(
    'the revocation reached the server',
    consentsAfter[0]?.granted === false && !!consentsAfter[0]?.revoked_at,
    consentsAfter,
  );
  check(
    'the server still has only the two earlier sessions',
    (await serverSessions()).length === 2,
  );

  // the database itself refuses an upload without consent, whatever the client does
  const direct = await transport.sendSessions([{ ...s3 }]).then(
    () => 'accepted',
    (e) => e.message,
  );
  check(
    'forcing an upload without consent is refused by the server (consent-required)',
    direct === 'consent-required',
    direct,
  );

  await core.consent.set('sync_sessions', true);
  const resumed = await core.sync.flush();
  check(
    're-granting consent uploads the pending session',
    resumed.status === 'ok' && resumed.sent === 1,
    resumed,
  );
  check('the server now has three sessions', (await serverSessions()).length === 3);

  const exported = await core.data.exportAll();
  check(
    'exportAll returns sessions and consents',
    exported.sessions.length === 3 && exported.consents.length >= 1 && !!exported.exportedAt,
  );

  // signed-out / bad token: data must be kept, error must be a short code
  const offline = await createPizzaCore({
    transport: createSupabaseTransport({
      functionsUrl: `${API}/functions/v1`,
      anonKey: ANON,
      getAccessToken: async () => null,
    }),
  });
  await offline.consent.set('sync_sessions', true);
  await offline.sessions.save({
    exerciseId: 'arm-raise',
    startedAt: '2026-11-19T12:00:00.000Z',
    durationS: 5,
    reps: 1,
    status: 'stopped',
  });
  const signedOut = await offline.sync.flush();
  const unsynced = (await offline.sessions.list()).filter((s) => s.syncedAt === null).length;
  check(
    'signed out: flush reports not-signed-in and keeps the data',
    signedOut.status === 'error' && signedOut.error === 'not-signed-in' && unsynced === 1,
    signedOut,
  );

  const garbage = await createPizzaCore({
    transport: createSupabaseTransport({
      functionsUrl: `${API}/functions/v1`,
      anonKey: ANON,
      getAccessToken: async () => 'not.a.jwt',
    }),
  });
  await garbage.consent.set('sync_sessions', true);
  await garbage.sessions.save({
    exerciseId: 'arm-raise',
    startedAt: '2026-11-19T12:00:00.000Z',
    durationS: 5,
    reps: 1,
    status: 'stopped',
  });
  const bad = await garbage.sync.flush();
  check(
    'a garbage token is rejected as not-signed-in',
    bad.status === 'error' && bad.error === 'not-signed-in',
    bad,
  );

  // right to erasure through the client
  const del = await core.data.deleteAll();
  check(
    'deleteAll erases locally and in the cloud',
    del.local === true && del.cloud === 'deleted',
    del,
  );
  check(
    'local storage is empty afterwards',
    (await core.sessions.list()).length === 0 && (await core.consent.list()).length === 0,
  );
  const gone = await http(`${API}/rest/v1/sessions?select=client_id&patient_id=eq.${userId}`, {
    key: SERVICE,
    token: SERVICE,
  });
  const goneConsents = await http(`${API}/rest/v1/consents?select=purpose&user_id=eq.${userId}`, {
    key: SERVICE,
    token: SERVICE,
  });
  const userRow = await http(`${API}/auth/v1/admin/users/${userId}`, {
    key: SERVICE,
    token: SERVICE,
  });
  check(
    'the server has no sessions, consents or account left for that user',
    gone.json?.length === 0 &&
      goneConsents.json?.length === 0 &&
      [400, 403, 404].includes(userRow.status),
    [gone.json?.length, goneConsents.json?.length, userRow.status],
  );
} catch (e) {
  check(`no unexpected exception: ${e?.message ?? e}`, false);
} finally {
  await http(`${API}/functions/v1/delete-me`, { method: 'POST', token }).catch(() => {});
}

finish();
