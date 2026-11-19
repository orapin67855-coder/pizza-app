// Logic behind `npm run admin:set-role`, kept free of I/O so it can be unit-tested.

const ROLES = ['patient', 'carer', 'physio', 'admin'];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

export function parseArgs(argv) {
  const usage = 'usage: npm run admin:set-role -- <email> <patient|carer|physio|admin>';
  if (argv.length !== 2) throw new Error(usage);
  const [rawEmail, role] = argv;
  const email = String(rawEmail).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`invalid email. ${usage}`);
  if (!ROLES.includes(role)) throw new Error(`invalid role. ${usage}`);
  return { email, role };
}

/**
 * The service role key bypasses every policy. This script exists for the local demo stack only,
 * so it refuses anything that is not a loopback address (real projects need a deliberate change).
 */
export function assertLocalApi(apiUrl) {
  let host;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    throw new Error('Refusing to run: the API URL is not a valid local address.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error(`Refusing to run: ${host} is not a local address (local stack only).`);
  }
}

async function findUserId({ api, serviceKey, fetchFn }, email) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchFn(`${api}/auth/v1/admin/users?page=${page}&per_page=${PAGE_SIZE}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) throw new Error(`Could not list accounts (HTTP ${res.status}).`);
    const users = (await res.json())?.users ?? [];
    const hit = users.find((u) => String(u.email ?? '').toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < PAGE_SIZE) break;
  }
  throw new Error(`No account with email ${email}. Sign up with that email first.`);
}

export async function setRole(deps, email, role) {
  assertLocalApi(deps.api);
  const id = await findUserId(deps, email);
  const res = await deps.fetchFn(`${deps.api}/rest/v1/profiles?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: deps.serviceKey,
      Authorization: `Bearer ${deps.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ role }),
  });
  const rows = res.ok ? await res.json() : [];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('Profile was not updated.');
  }
  return { id, role };
}
