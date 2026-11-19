// Helpers shared by the local-stack scripts (e2e-*.mjs, set-role.mjs).

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The Supabase CLI is a dev dependency (a Node script). It is run through this Node binary by
// absolute path, so no executable is looked up through the PATH variable.
const SUPABASE_CLI = join(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  'supabase',
  'dist',
  'supabase.js',
);

/** Connection details of the running local stack (`npm run db:start`), from `supabase status`. */
export function readLocalEnv() {
  const output = execFileSync(process.execPath, [SUPABASE_CLI, 'status', '-o', 'env'], {
    encoding: 'utf8',
  });
  const env = Object.fromEntries(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  if (!env.API_URL || !env.ANON_KEY || !env.SERVICE_ROLE_KEY) {
    throw new Error(
      'Could not read API_URL/ANON_KEY/SERVICE_ROLE_KEY: is the local stack running?',
    );
  }
  return env;
}

const results = [];

/** Records and prints one check. */
export function check(name, ok, extra) {
  results.push(!!ok);
  const detail = extra !== undefined ? `  ${JSON.stringify(extra)}` : '';
  // Values can come from server responses: keep every result on one line.
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail}`.replace(/[\r\n]+/g, ' '));
}

/** Prints the tally and exits non-zero if any check failed. */
export function finish() {
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

/** A tiny fetch wrapper; `anonKey` is the default `apikey` header. */
export function createHttp(anonKey) {
  return async function http(
    url,
    { method = 'GET', token, key = anonKey, body, headers = {} } = {},
  ) {
    const res = await fetch(url, {
      method,
      headers: {
        apikey: key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  };
}
