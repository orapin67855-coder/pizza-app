// Gives an existing LOCAL account a role (e.g. physio) for demos and testing.
// Usage (from backend/): npm run admin:set-role -- doctor@example.test physio
//
// Roles are never self-service: users cannot promote themselves, and a care link's declared
// role grants nothing special. Only profiles.role = 'physio' | 'admin' may edit/approve exercises,
// so setting it is an admin act. Needs `npm run db:start` (reads keys from `supabase status`).

import { readLocalEnv } from './lib/e2e.mjs';
import { assertLocalApi, parseArgs, setRole } from './set-role-core.mjs';

try {
  const { email, role } = parseArgs(process.argv.slice(2));
  const env = readLocalEnv();
  assertLocalApi(env.API_URL);
  const done = await setRole(
    { api: env.API_URL, serviceKey: env.SERVICE_ROLE_KEY, fetchFn: fetch },
    email,
    role,
  );
  console.log(`${email} (${done.id}) is now: ${done.role}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
