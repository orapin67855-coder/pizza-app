// Real-stack check: an anonymous user attaches an email (OTP via the local Mailpit inbox) and
// must KEEP the same user id, so their consent and uploaded sessions stay theirs.
// Usage: node scripts/e2e-upgrade-account.mjs   (needs `supabase start` with Mailpit running)

import { check, createHttp, finish, readLocalEnv } from './lib/e2e.mjs';

const env = readLocalEnv();
const API = env.API_URL;
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;
const http = createHttp(ANON);
const MAIL = env.MAILPIT_URL;
const FN = `${API}/functions/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `upgrade-${Date.now()}@example.test`;

try {
  const anon = await http(`${API}/auth/v1/signup`, { method: 'POST', body: { data: {} } });
  const { access_token: token } = anon.json;
  const id = anon.json.user.id;
  check('starts as an anonymous user', anon.json.user.is_anonymous === true);

  await http(`${FN}/consents`, {
    method: 'POST',
    token,
    body: { consents: [{ purpose: 'sync_sessions', granted: true, textVersion: 'v1' }] },
  });
  const up = await http(`${FN}/sessions-batch`, {
    method: 'POST',
    token,
    body: {
      sessions: [
        {
          clientId: 'keep-me',
          exerciseId: 'arm-raise',
          startedAt: '2026-11-18T09:00:00Z',
          durationS: 30,
          reps: 5,
          status: 'completed',
        },
      ],
    },
  });
  check('uploaded a session while anonymous', up.status === 200, up.status);

  // attach an email -> Supabase mails a confirmation code
  const change = await http(`${API}/auth/v1/user`, { method: 'PUT', token, body: { email } });
  check('email attach request accepted', change.status === 200, change.status);

  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    await sleep(500);
    const list = await http(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, {
      key: '',
    });
    const msg = list.json?.messages?.[0];
    if (msg) {
      const full = await http(`${MAIL}/api/v1/message/${msg.ID}`, { key: '' });
      const m =
        (full.json?.Text ?? '').match(/\b(\d{6})\b/) ??
        (full.json?.HTML ?? '').match(/\b(\d{6})\b/);
      code = m?.[1] ?? null;
    }
  }
  check('a six-digit code arrived in the inbox', !!code, code ? 'received' : 'missing');

  if (code) {
    const verify = await http(`${API}/auth/v1/verify`, {
      method: 'POST',
      body: { type: 'email_change', email, token: code },
    });
    check('code verified', verify.status === 200 && !!verify.json?.access_token, verify.status);
    const newToken = verify.json?.access_token;
    const user = await http(`${API}/auth/v1/user`, { token: newToken });
    check('SAME user id after attaching the email', user.json?.id === id, {
      before: id,
      after: user.json?.id,
    });
    check(
      'no longer anonymous and email is set',
      user.json?.is_anonymous === false && user.json?.email === email,
      { anon: user.json?.is_anonymous },
    );

    const sessions = await http(`${API}/rest/v1/sessions?select=client_id`, { token: newToken });
    check(
      'previously uploaded session is still there',
      sessions.json?.length === 1 && sessions.json[0].client_id === 'keep-me',
      sessions.json,
    );
    const consent = await http(`${API}/rest/v1/consents?select=granted`, { token: newToken });
    check('consent survived the upgrade', consent.json?.[0]?.granted === true, consent.json);

    const del = await http(`${FN}/delete-me`, { method: 'POST', token: newToken });
    check('delete-me works for the upgraded account', del.status === 200, del.status);
  }
  await http(`${API}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    token: SERVICE,
    key: SERVICE,
  });
} catch (e) {
  check(`no unexpected exception: ${e?.message ?? e}`, false);
}
finish();
