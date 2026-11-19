import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { A, as, asUser, B, createDb, createUser, PHYSIO } from './db';

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('delete from auth.users');
  await createUser(db, A);
  await createUser(db, B);
});

const denied = /row-level security|permission denied/i;

const grantConsent = (uid: string, purpose = 'sync_sessions') =>
  asUser(db, uid, () =>
    db.query(
      `insert into public.consents (purpose, granted, text_version) values ($1, true, 'v1')
       on conflict (user_id, purpose) do update set granted = true, text_version = 'v1'`,
      [purpose],
    ),
  );

const revokeConsent = (uid: string, purpose = 'sync_sessions') =>
  asUser(db, uid, () =>
    db.query(`update public.consents set granted = false where purpose = $1`, [purpose]),
  );

const insertSession = (uid: string, clientId = 'c-1', extra: Record<string, unknown> = {}) => {
  const v = {
    client_id: clientId,
    exercise_id: 'arm-raise',
    started_at: '2026-11-18T09:00:00Z',
    duration_s: 60,
    reps: 5,
    status: 'completed',
    ...extra,
  };
  const cols = Object.keys(v);
  return asUser(db, uid, () =>
    db.query(
      `insert into public.sessions (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(v),
    ),
  );
};

describe('hygiene', () => {
  it('has row level security enabled on every public table', async () => {
    const r = await db.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it('grants the anonymous role nothing on public tables', async () => {
    const r = await db.query(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe('profiles', () => {
  it('are created automatically as patients when an auth user appears', async () => {
    const r = await db.query<{ role: string }>(`select role from public.profiles where id = $1`, [
      A,
    ]);
    expect(r.rows).toEqual([{ role: 'patient' }]);
  });

  it('are readable only by their owner', async () => {
    const own = await asUser(db, A, () => db.query(`select id from public.profiles`));
    expect(own.rows).toEqual([{ id: A }]);
  });

  it('let the owner change the display name', async () => {
    await asUser(db, A, () =>
      db.query(`update public.profiles set display_name = 'Somchai' where id = $1`, [A]),
    );
    const r = await db.query<{ display_name: string }>(
      `select display_name from public.profiles where id = $1`,
      [A],
    );
    expect(r.rows[0]?.display_name).toBe('Somchai');
  });

  it('do not let a user promote themselves', async () => {
    await expect(
      asUser(db, A, () => db.query(`update public.profiles set role = 'admin' where id = $1`, [A])),
    ).rejects.toThrow(denied);
  });

  it('cannot be created directly by users', async () => {
    await expect(
      asUser(db, A, () => db.query(`insert into public.profiles (id) values (gen_random_uuid())`)),
    ).rejects.toThrow(denied);
  });

  it('are invisible to anonymous callers', async () => {
    await expect(
      as(db, 'anon', null, () => db.query(`select * from public.profiles`)),
    ).rejects.toThrow(denied);
  });
});

describe('consents', () => {
  it('can be recorded and read by their owner', async () => {
    await grantConsent(A);
    const r = await asUser(db, A, () => db.query(`select purpose, granted from public.consents`));
    expect(r.rows).toEqual([{ purpose: 'sync_sessions', granted: true }]);
  });

  it('stamp the server time on grant and keep it when revoked', async () => {
    await grantConsent(A);
    await revokeConsent(A);
    const r = await db.query<{
      granted_at: Date | null;
      revoked_at: Date | null;
      granted: boolean;
    }>(`select granted, granted_at, revoked_at from public.consents where user_id = $1`, [A]);
    const row = r.rows[0];
    expect(row?.granted).toBe(false);
    expect(row?.granted_at).not.toBeNull();
    expect(row?.revoked_at).not.toBeNull();
  });

  it('ignore timestamps supplied by the client (server time is authoritative)', async () => {
    await asUser(db, A, () =>
      db.query(
        `insert into public.consents (purpose, granted, text_version, granted_at)
         values ('ai_summary', true, 'v1', '1999-01-01')`,
      ),
    );
    const r = await db.query<{ year: number }>(
      `select extract(year from granted_at)::int as year from public.consents where user_id = $1`,
      [A],
    );
    expect(r.rows[0]?.year).toBeGreaterThan(2000);
  });

  it('cannot be written on behalf of another user', async () => {
    await expect(
      asUser(db, A, () =>
        db.query(
          `insert into public.consents (user_id, purpose, granted, text_version)
           values ($1, 'sync_sessions', true, 'v1')`,
          [B],
        ),
      ),
    ).rejects.toThrow(denied);
  });

  it('are not visible to other users', async () => {
    await grantConsent(A);
    const r = await asUser(db, B, () => db.query(`select * from public.consents`));
    expect(r.rows).toEqual([]);
  });

  it('support the upsert PostgREST generates for merge-duplicates', async () => {
    await grantConsent(A);
    await asUser(db, A, () =>
      db.query(
        `insert into public.consents (purpose, granted, text_version)
         values ('sync_sessions', false, 'v2')
         on conflict (user_id, purpose) do update
           set purpose = excluded.purpose, granted = excluded.granted,
               text_version = excluded.text_version`,
      ),
    );
    const r = await db.query<{ granted: boolean; text_version: string }>(
      `select granted, text_version from public.consents where user_id = $1`,
      [A],
    );
    expect(r.rows).toEqual([{ granted: false, text_version: 'v2' }]);
  });

  it('reject an unknown purpose', async () => {
    await expect(
      asUser(db, A, () =>
        db.query(
          `insert into public.consents (purpose, granted, text_version) values ('marketing', true, 'v1')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('append an immutable event for every change (proof of what was agreed)', async () => {
    await grantConsent(A);
    await revokeConsent(A);
    const r = await asUser(db, A, () =>
      db.query(`select granted, text_version from public.consent_events order by id`),
    );
    expect(r.rows).toEqual([
      { granted: true, text_version: 'v1' },
      { granted: false, text_version: 'v1' },
    ]);
  });

  it('keep their event history out of reach of the user (read-only)', async () => {
    await grantConsent(A);
    await expect(
      asUser(db, A, () => db.query(`delete from public.consent_events`)),
    ).rejects.toThrow(denied);
    await expect(
      asUser(db, A, () => db.query(`update public.consent_events set granted = false`)),
    ).rejects.toThrow(denied);
    await expect(
      asUser(db, A, () =>
        db.query(
          `insert into public.consent_events (user_id, purpose, granted, text_version)
           values ($1, 'sync_sessions', true, 'forged')`,
          [A],
        ),
      ),
    ).rejects.toThrow(denied);
  });

  it("do not expose one user's events to another", async () => {
    await grantConsent(A);
    const r = await asUser(db, B, () => db.query(`select * from public.consent_events`));
    expect(r.rows).toEqual([]);
  });
});

describe('sessions', () => {
  it('cannot be uploaded without sync consent', async () => {
    await expect(insertSession(A)).rejects.toThrow(denied);
  });

  it('can be uploaded once sync consent is granted, owned by the caller', async () => {
    await grantConsent(A);
    await insertSession(A);
    const r = await db.query<{ patient_id: string }>(`select patient_id from public.sessions`);
    expect(r.rows).toEqual([{ patient_id: A }]);
  });

  it('cannot be uploaded again after consent is revoked', async () => {
    await grantConsent(A);
    await revokeConsent(A);
    await expect(insertSession(A)).rejects.toThrow(denied);
  });

  it('cannot be uploaded for another patient', async () => {
    await grantConsent(A);
    await expect(insertSession(A, 'c-1', { patient_id: B })).rejects.toThrow(denied);
  });

  it('need the sync consent specifically, not just any consent', async () => {
    await grantConsent(A, 'ai_summary');
    await expect(insertSession(A)).rejects.toThrow(denied);
  });

  it('ignore a resend of the same clientId (idempotent upsert)', async () => {
    await grantConsent(A);
    for (let i = 0; i < 2; i++) {
      await asUser(db, A, () =>
        db.query(
          `insert into public.sessions (client_id, exercise_id, started_at, duration_s, reps, status)
           values ('same', 'arm-raise', '2026-11-18T09:00:00Z', 60, $1, 'completed')
           on conflict (patient_id, client_id) do nothing`,
          [5 + i],
        ),
      );
    }
    const r = await db.query<{ reps: number }>(`select reps from public.sessions`);
    expect(r.rows).toEqual([{ reps: 5 }]);
  });

  it('allow two different users to use the same clientId', async () => {
    await grantConsent(A);
    await grantConsent(B);
    await insertSession(A, 'shared');
    await insertSession(B, 'shared');
    const r = await db.query(`select 1 from public.sessions`);
    expect(r.rows).toHaveLength(2);
  });

  it.each([
    ['negative reps', { reps: -1 }],
    ['absurd reps', { reps: 1001 }],
    ['negative duration', { duration_s: -1 }],
    ['absurd duration', { duration_s: 86_401 }],
    ['unknown status', { status: 'weird' }],
    ['empty client id', { client_id: '' }],
    ['overlong client id', { client_id: 'x'.repeat(65) }],
    ['empty exercise id', { exercise_id: '' }],
  ])('reject %s', async (_label, extra) => {
    await grantConsent(A);
    await expect(insertSession(A, 'c-x', extra)).rejects.toThrow();
  });

  it('are readable only by their owner', async () => {
    await grantConsent(A);
    await insertSession(A);
    const mine = await asUser(db, A, () => db.query(`select client_id from public.sessions`));
    const theirs = await asUser(db, B, () => db.query(`select client_id from public.sessions`));
    expect(mine.rows).toHaveLength(1);
    expect(theirs.rows).toEqual([]);
  });

  it('cannot be edited after upload', async () => {
    await grantConsent(A);
    await insertSession(A);
    await expect(
      asUser(db, A, () => db.query(`update public.sessions set reps = 99`)),
    ).rejects.toThrow(denied);
  });

  it('can be deleted by their owner but not by someone else', async () => {
    await grantConsent(A);
    await insertSession(A);
    await asUser(db, B, () => db.query(`delete from public.sessions`));
    expect((await db.query(`select 1 from public.sessions`)).rows).toHaveLength(1);
    await asUser(db, A, () => db.query(`delete from public.sessions`));
    expect((await db.query(`select 1 from public.sessions`)).rows).toHaveLength(0);
  });

  it('are invisible and unwritable for anonymous callers', async () => {
    await expect(
      as(db, 'anon', null, () => db.query(`select * from public.sessions`)),
    ).rejects.toThrow(denied);
  });
});

describe('exercises', () => {
  const insertExercise = (uid: string, id = 'new-ex') =>
    asUser(db, uid, () =>
      db.query(
        `insert into public.exercises (id, version, name, category, needs_carer, metric)
         values ($1, 1, 'New', 'A', false, 'shoulder-angle')`,
        [id],
      ),
    );

  it('are seeded as drafts, never pre-approved', async () => {
    const r = await db.query<{ id: string; approval_status: string; needs_carer: boolean }>(
      `select id, approval_status, needs_carer from public.exercises order by id`,
    );
    expect(r.rows.map((x) => x.id)).toEqual([
      'arm-raise',
      'big-step',
      'seated-alt-arm',
      'sit-stand',
      'torso-twist',
    ]);
    expect(r.rows.every((x) => x.approval_status === 'draft')).toBe(true);
    expect(r.rows.filter((x) => x.needs_carer).map((x) => x.id)).toEqual(['big-step', 'sit-stand']);
  });

  it('are readable by signed-in users', async () => {
    const r = await asUser(db, A, () => db.query(`select id from public.exercises`));
    expect(r.rows).toHaveLength(5);
  });

  it('are not readable anonymously', async () => {
    await expect(
      as(db, 'anon', null, () => db.query(`select * from public.exercises`)),
    ).rejects.toThrow(denied);
  });

  it('cannot be changed by a patient', async () => {
    await expect(insertExercise(A)).rejects.toThrow(denied);
    // RLS hides the rows from UPDATE/DELETE, so they silently affect nothing
    const upd = await asUser(db, A, () => db.query(`update public.exercises set name = 'x'`));
    const del = await asUser(db, A, () => db.query(`delete from public.exercises`));
    expect(upd.affectedRows).toBe(0);
    expect(del.affectedRows).toBe(0);
    expect((await db.query(`select 1 from public.exercises where name = 'x'`)).rows).toEqual([]);
    expect((await db.query(`select 1 from public.exercises`)).rows).toHaveLength(5);
  });

  it('can be added by a physiotherapist', async () => {
    await createUser(db, PHYSIO);
    await db.query(`update public.profiles set role = 'physio' where id = $1`, [PHYSIO]);
    await insertExercise(PHYSIO);
    const r = await db.query(`select 1 from public.exercises where id = 'new-ex'`);
    expect(r.rows).toHaveLength(1);
  });

  it('cannot be marked approved without who approved it and when', async () => {
    await expect(
      db.query(`update public.exercises set approval_status = 'approved' where id = 'arm-raise'`),
    ).rejects.toThrow();
    await createUser(db, PHYSIO);
    await db.query(
      `update public.exercises set approval_status = 'approved', approved_by = $1, approved_at = now()
       where id = 'arm-raise'`,
      [PHYSIO],
    );
    await db.query(
      `update public.exercises set approval_status = 'draft', approved_by = null, approved_at = null where id = 'arm-raise'`,
    );
  });
});

describe('account deletion', () => {
  it('removes every trace of the user when the auth user is deleted', async () => {
    await grantConsent(A);
    await insertSession(A);
    await db.query('delete from auth.users where id = $1', [A]);
    for (const table of ['profiles', 'consents', 'consent_events', 'sessions']) {
      const col = table === 'profiles' ? 'id' : table === 'sessions' ? 'patient_id' : 'user_id';
      const r = await db.query(`select 1 from public.${table} where ${col} = $1`, [A]);
      expect(r.rows, table).toEqual([]);
    }
  });

  it('leaves other users untouched', async () => {
    await grantConsent(B);
    await insertSession(B);
    await db.query('delete from auth.users where id = $1', [A]);
    expect((await db.query(`select 1 from public.sessions`)).rows).toHaveLength(1);
  });
});
