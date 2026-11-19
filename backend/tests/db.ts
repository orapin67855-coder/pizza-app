import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'supabase');

/**
 * Minimal imitation of what Supabase provides before our migrations run: the three API roles,
 * `auth.users`, `auth.uid()`, and - importantly - Supabase's default grants on `public` tables,
 * so tests expose any table our migrations forget to lock down.
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    email_confirmed_at timestamptz,
    is_anonymous boolean not null default false,
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const sqlFiles = (dir: string): string[] =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

/** Boots a fresh in-memory Postgres with the Supabase stub, all migrations and the seed. */
export async function createDb(options: { seed?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of sqlFiles('migrations')) {
    await db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  if (options.seed !== false) {
    await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  }
  return db;
}

export type ApiRole = 'anon' | 'authenticated' | 'service_role';

/**
 * Runs `fn` the way PostgREST would: switch to an API role and set the JWT subject, so RLS and
 * `auth.uid()` behave as they do in production. Always restores the superuser afterwards.
 */
export async function as<T>(
  db: PGlite,
  role: ApiRole,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export const asUser = <T>(db: PGlite, userId: string, fn: () => Promise<T>) =>
  as(db, 'authenticated', userId, fn);

export async function createUser(db: PGlite, id: string, email = `${id}@example.test`) {
  await db.query('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())', [
    id,
    email,
  ]);
}

/** Mirrors the account states Supabase Auth can produce: anonymous, or an unconfirmed email. */
export async function createUserWith(
  db: PGlite,
  id: string,
  options: { email?: string | null; anonymous?: boolean; confirmed?: boolean } = {},
) {
  const { email = null, anonymous = false, confirmed = true } = options;
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, is_anonymous)
     values ($1, $2, case when $3::boolean then now() end, $4)`,
    [id, email, confirmed, anonymous],
  );
}

export const A = '00000000-0000-4000-8000-00000000000a';
export const B = '00000000-0000-4000-8000-00000000000b';
export const PHYSIO = '00000000-0000-4000-8000-0000000000f1';
