import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { A, as, asUser, B, createDb, createUser, createUserWith, PHYSIO } from './db';

const CARER = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';

let db: PGlite;

beforeAll(async () => {
  db = await createDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec('delete from auth.users');
  await createUser(db, A, 'a@example.test');
  await createUser(db, B, 'b@example.test');
  await createUser(db, PHYSIO, 'physio@example.test');
  await createUser(db, CARER, 'carer@example.test');
  await createUser(db, OTHER, 'other@example.test');
});

const denied = /row-level security|permission denied/i;

interface Invite {
  id: string;
  code: string;
  expires_at: string;
}
interface Summary {
  patient: { id: string; display_name: string | null };
  range: { from: string; to: string };
  truncated: boolean;
  totals: {
    sessions: number;
    completed: number;
    stopped: number;
    reps: number;
    duration_s: number;
  };
  by_exercise: { exercise_id: string; sessions: number; reps: number; duration_s: number }[];
  sessions: Record<string, unknown>[];
}

/** Calls a public SQL function the way PostgREST /rpc would: as the signed-in user. */
async function rpc<T = unknown>(uid: string, fn: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await asUser(db, uid, () =>
    db.query<{ r: T }>(`select public.${fn}(${placeholders}) as r`, args),
  );
  return r.rows[0]!.r;
}

const invite = (uid: string, role = 'physio', email: string | null = null) =>
  rpc<Invite>(uid, 'create_care_invite', [role, email]);
/**
 * A refused guess comes back as `{ error }` (not an exception) so that the failed attempt is
 * committed and can be counted; this helper turns it back into a throw for readability.
 */
async function accept(
  uid: string,
  code: string,
): Promise<{ link_id: string; member_role: string }> {
  const res = await rpc<{ link_id?: string; member_role?: string; error?: string }>(
    uid,
    'accept_care_invite',
    [code],
  );
  if (res.error !== undefined) throw new Error(res.error);
  return res as { link_id: string; member_role: string };
}
const revoke = (uid: string, linkId: string) => rpc(uid, 'revoke_care_link', [linkId]);
const summary = (
  uid: string,
  patient: string,
  from: string | null = null,
  to: string | null = null,
) => rpc<Summary>(uid, 'patient_summary', [patient, from, to]);

const consent = (uid: string, purpose: string, granted = true) =>
  asUser(db, uid, () =>
    db.query(
      `insert into public.consents (purpose, granted, text_version) values ($1, $2, 'v1')
       on conflict (user_id, purpose) do update set granted = excluded.granted`,
      [purpose, granted],
    ),
  );

/** Seeds an uploaded session directly (the sessions-upload path has its own tests). */
const seedSession = (
  patient: string,
  clientId: string,
  startedAt: string,
  reps = 5,
  exercise = 'arm-raise',
  status = 'completed',
) =>
  db.query(
    `insert into public.sessions (patient_id, client_id, exercise_id, started_at, duration_s, reps, status)
     values ($1, $2, $3, $4, 60, $5, $6)`,
    [patient, clientId, exercise, startedAt, reps, status],
  );

/** A fully set-up, active link: patient `patient` shares with `member`. */
async function linkUp(patient = A, member = PHYSIO, role = 'physio'): Promise<string> {
  const inv = await invite(patient, role);
  const { link_id } = await accept(member, inv.code);
  return link_id;
}

const auditRows = async () =>
  (
    await db.query<{ action: string; actor_id: string | null; patient_id: string }>(
      `select action, actor_id, patient_id from public.audit_log order by id`,
    )
  ).rows;

describe('hygiene', () => {
  it('locks down every new table (RLS on, nothing for anon)', async () => {
    const noRls = await db.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(noRls.rows).toEqual([]);
    const anon = await db.query(
      `select table_name from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'`,
    );
    expect(anon.rows).toEqual([]);
  });

  it.each([
    ['create_care_invite', "'physio'::public.care_member_role, null::text"],
    ['accept_care_invite', "'ABCD'"],
    ['revoke_care_link', 'gen_random_uuid()'],
    ['patient_summary', 'gen_random_uuid(), null::timestamptz, null::timestamptz'],
  ])('does not let anonymous callers run %s', async (fn, args) => {
    await expect(
      as(db, 'anon', null, () => db.query(`select public.${fn}(${args})`)),
    ).rejects.toThrow(denied);
  });

  it('keeps the account-kind helper internal (users could probe other ids with it)', async () => {
    await expect(
      asUser(db, A, () => db.query(`select public.is_real_account($1)`, [PHYSIO])),
    ).rejects.toThrow(denied);
  });
});

describe('create_care_invite', () => {
  it('returns a one-time code and stores only its hash', async () => {
    const inv = await invite(A, 'carer');
    expect(inv.code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

    const row = (
      await db.query<{
        invite_hash: string;
        status: string;
        member_id: string | null;
        member_role: string;
        patient_id: string;
        days: number;
      }>(
        `select invite_hash, status, member_id, member_role, patient_id,
                round(extract(epoch from (expires_at - now())) / 86400)::int as days
         from public.care_links where id = $1`,
        [inv.id],
      )
    ).rows[0]!;
    const expectedHash = (
      await db.query<{ h: string }>(`select encode(sha256(convert_to($1, 'utf8')), 'hex') as h`, [
        inv.code.replaceAll('-', ''),
      ])
    ).rows[0]!.h;
    expect(row.invite_hash).toBe(expectedHash);
    expect(row).toMatchObject({
      status: 'pending',
      member_id: null,
      member_role: 'carer',
      patient_id: A,
      days: 7,
    });
  });

  it('generates a different code every time', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) codes.add((await invite(A)).code);
    expect(codes.size).toBe(5);
  });

  it('works for a patient with an anonymous (local-first) account', async () => {
    const ANON = '00000000-0000-4000-8000-0000000000a1';
    await createUserWith(db, ANON, { anonymous: true, email: null, confirmed: false });
    expect((await invite(ANON)).id).toBeTruthy();
  });

  it('only allows the member roles carer and physio', async () => {
    await expect(invite(A, 'admin')).rejects.toThrow();
    await expect(invite(A, 'patient')).rejects.toThrow();
  });

  it('normalises and validates the optional email restriction', async () => {
    const inv = await invite(A, 'physio', '  Dr.Physio@Example.TEST ');
    const r = await db.query<{ invite_email: string }>(
      `select invite_email from public.care_links where id = $1`,
      [inv.id],
    );
    expect(r.rows[0]?.invite_email).toBe('dr.physio@example.test');
    await expect(invite(A, 'physio', 'not-an-email')).rejects.toThrow(/invalid_email/);
    await expect(invite(A, 'physio', `${'x'.repeat(250)}@e.co`)).rejects.toThrow(/invalid_email/);
  });

  it('caps the number of open invitations per patient', async () => {
    for (let i = 0; i < 10; i++) await invite(A);
    await expect(invite(A)).rejects.toThrow(/too_many_invites/);
    // another patient is unaffected
    expect((await invite(B)).id).toBeTruthy();
  });

  it('does not count expired invitations against the cap', async () => {
    for (let i = 0; i < 10; i++) await invite(A);
    await expect(invite(A)).rejects.toThrow(/too_many_invites/);
    await db.query(`update public.care_links set expires_at = now() - interval '1 minute'`);
    expect((await invite(A)).id).toBeTruthy();
  });

  it('does not count withdrawn invitations against the cap', async () => {
    const first = await invite(A);
    for (let i = 0; i < 9; i++) await invite(A);
    await expect(invite(A)).rejects.toThrow(/too_many_invites/);
    await revoke(A, first.id);
    expect((await invite(A)).id).toBeTruthy();
  });

  it('records who created the invitation in the audit log', async () => {
    await invite(A, 'carer');
    expect(await auditRows()).toEqual([
      { action: 'care_link.created', actor_id: A, patient_id: A },
    ]);
  });
});

describe('accept_care_invite', () => {
  it('activates the link for the member and consumes the code', async () => {
    const inv = await invite(A, 'physio');
    const res = await accept(PHYSIO, inv.code);
    expect(res.member_role).toBe('physio');

    const row = (
      await db.query<{
        status: string;
        member_id: string;
        invite_hash: string | null;
        accepted_at: Date | null;
      }>(
        `select status, member_id, invite_hash, accepted_at from public.care_links where id = $1`,
        [res.link_id],
      )
    ).rows[0]!;
    expect(row.status).toBe('active');
    expect(row.member_id).toBe(PHYSIO);
    expect(row.invite_hash).toBeNull();
    expect(row.accepted_at).not.toBeNull();
  });

  it('works only once: a used code is dead', async () => {
    const inv = await invite(A);
    await accept(PHYSIO, inv.code);
    await expect(accept(CARER, inv.code)).rejects.toThrow(/invalid_invite/);
  });

  it('accepts the code however the user types it (case, dashes, spaces)', async () => {
    const inv = await invite(A);
    const typed = ` ${inv.code.toLowerCase().replaceAll('-', ' ')} `;
    expect((await accept(PHYSIO, typed)).link_id).toBe(inv.id);
  });

  it('refuses an unknown code and changes nothing', async () => {
    await invite(A);
    await expect(accept(PHYSIO, '0000-0000-0000-0000')).rejects.toThrow(/invalid_invite/);
    const r = await db.query(`select 1 from public.care_links where status <> 'pending'`);
    expect(r.rows).toEqual([]);
  });

  it('refuses an expired code', async () => {
    const inv = await invite(A);
    await db.query(`update public.care_links set expires_at = now() - interval '1 second'`);
    await expect(accept(PHYSIO, inv.code)).rejects.toThrow(/invalid_invite/);
  });

  it('refuses a code the patient has withdrawn', async () => {
    const inv = await invite(A);
    await revoke(A, inv.id);
    await expect(accept(PHYSIO, inv.code)).rejects.toThrow(/invalid_invite/);
  });

  it('does not let patients accept their own invitation', async () => {
    const inv = await invite(A);
    await expect(accept(A, inv.code)).rejects.toThrow(/invalid_invite/);
  });

  it('requires a real account: anonymous and unconfirmed accounts are refused, code survives', async () => {
    const ANON = '00000000-0000-4000-8000-0000000000a2';
    const UNCONFIRMED = '00000000-0000-4000-8000-0000000000a3';
    await createUserWith(db, ANON, { anonymous: true, email: null, confirmed: false });
    await createUserWith(db, UNCONFIRMED, { email: 'u@example.test', confirmed: false });
    const inv = await invite(A);
    await expect(accept(ANON, inv.code)).rejects.toThrow(/account_required/);
    await expect(accept(UNCONFIRMED, inv.code)).rejects.toThrow(/account_required/);
    expect((await accept(PHYSIO, inv.code)).link_id).toBe(inv.id);
  });

  it('honours an email restriction (case-insensitive) and refuses everyone else', async () => {
    const inv = await invite(A, 'physio', 'PHYSIO@example.test');
    await expect(accept(CARER, inv.code)).rejects.toThrow(/invalid_invite/);
    expect((await accept(PHYSIO, inv.code)).link_id).toBe(inv.id);
  });

  it('does not let a different member re-use a restricted code after a wrong try', async () => {
    const inv = await invite(A, 'physio', 'physio@example.test');
    await expect(accept(CARER, inv.code)).rejects.toThrow(/invalid_invite/);
    const r = await db.query<{ status: string }>(`select status from public.care_links`);
    expect(r.rows).toEqual([{ status: 'pending' }]);
  });

  it('refuses a second active link between the same two people', async () => {
    await linkUp(A, PHYSIO, 'physio');
    const second = await invite(A, 'carer');
    await expect(accept(PHYSIO, second.code)).rejects.toThrow(/already_linked/);
  });

  it('allows linking again after the previous link was revoked', async () => {
    const link = await linkUp(A, PHYSIO);
    await revoke(A, link);
    const again = await invite(A, 'physio');
    expect((await accept(PHYSIO, again.code)).link_id).toBe(again.id);
  });

  it('records who accepted in the audit log', async () => {
    await linkUp(A, PHYSIO);
    expect((await auditRows()).map((r) => [r.action, r.actor_id])).toEqual([
      ['care_link.created', A],
      ['care_link.accepted', PHYSIO],
    ]);
  });
});

describe('accept_care_invite guess limit', () => {
  const WRONG = '0000-0000-0000-0000';
  const attempts = async (uid: string) =>
    Number(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from public.care_invite_attempts where user_id = $1`,
          [uid],
        )
      ).rows[0]!.n,
    );
  const guessWrong = async (uid: string, times = 1) => {
    for (let i = 0; i < times; i++) {
      await expect(accept(uid, WRONG)).rejects.toThrow(/invalid_invite/);
    }
  };

  it('locks a user out after 5 wrong codes, even when the next code is right', async () => {
    const inv = await invite(A);
    await guessWrong(PHYSIO, 5);
    await expect(accept(PHYSIO, inv.code)).rejects.toThrow(/too_many_attempts/);
    // the right code was not consumed by the refused attempt
    const r = await db.query<{ status: string }>(`select status from public.care_links`);
    expect(r.rows).toEqual([{ status: 'pending' }]);
  });

  it('records a wrong guess even though the caller is told no', async () => {
    await guessWrong(PHYSIO, 1);
    expect(await attempts(PHYSIO)).toBe(1);
  });

  it('allows 4 wrong codes and still accepts the right one', async () => {
    const inv = await invite(A);
    await guessWrong(PHYSIO, 4);
    expect((await accept(PHYSIO, inv.code)).link_id).toBe(inv.id);
  });

  it('lets the user try again once the window has passed', async () => {
    const inv = await invite(A);
    await guessWrong(PHYSIO, 5);
    await db.query(`update public.care_invite_attempts set at = now() - interval '16 minutes'`);
    expect((await accept(PHYSIO, inv.code)).link_id).toBe(inv.id);
  });

  it('is per user: one locked-out user does not block another', async () => {
    const inv = await invite(A);
    await guessWrong(PHYSIO, 5);
    expect((await accept(CARER, inv.code)).link_id).toBe(inv.id);
  });

  it('counts every kind of bad code', async () => {
    const expired = await invite(A);
    await db.query(
      `update public.care_links set expires_at = now() - interval '1 minute' where id = $1`,
      [expired.id],
    );
    const withdrawn = await invite(A);
    await revoke(A, withdrawn.id);
    const forSomeoneElse = await invite(A, 'physio', 'other@example.test');
    await guessWrong(PHYSIO, 1); // unknown code
    for (const inv of [expired, withdrawn, forSomeoneElse]) {
      await expect(accept(PHYSIO, inv.code)).rejects.toThrow(/invalid_invite/);
    }
    expect(await attempts(PHYSIO)).toBe(4);
    const own = await invite(B);
    await expect(accept(B, own.code)).rejects.toThrow(/invalid_invite/); // your own invitation
    expect(await attempts(B)).toBe(1);
  });

  it('does not count refusals that are not guesses', async () => {
    const ANON = '00000000-0000-4000-8000-0000000000a5';
    await createUserWith(db, ANON, { anonymous: true, email: null, confirmed: false });
    await expect(accept(ANON, WRONG)).rejects.toThrow(/account_required/);
    expect(await attempts(ANON)).toBe(0);

    await linkUp(A, PHYSIO);
    const second = await invite(A, 'carer');
    await expect(accept(PHYSIO, second.code)).rejects.toThrow(/already_linked/);
    expect(await attempts(PHYSIO)).toBe(0);
  });

  it('starts counting from zero again after a successful accept', async () => {
    const inv = await invite(A);
    await guessWrong(PHYSIO, 4);
    await accept(PHYSIO, inv.code);
    expect(await attempts(PHYSIO)).toBe(0);
  });

  it('still counts attempts made 10 minutes ago (the clean-up never shortens the lockout)', async () => {
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into public.care_invite_attempts (user_id, at) values ($1, now() - interval '10 minutes')`,
        [PHYSIO],
      );
    }
    await expect(accept(PHYSIO, WRONG)).rejects.toThrow(/too_many_attempts/);
  });

  it('forgets attempts older than a day', async () => {
    await db.query(
      `insert into public.care_invite_attempts (user_id, at) values ($1, now() - interval '2 days')`,
      [CARER],
    );
    await guessWrong(PHYSIO, 1);
    expect(await attempts(CARER)).toBe(0);
  });

  it('keeps the attempts table out of reach of users', async () => {
    await guessWrong(PHYSIO, 1);
    await expect(
      asUser(db, PHYSIO, () => db.query(`select * from public.care_invite_attempts`)),
    ).rejects.toThrow(denied);
    await expect(
      asUser(db, PHYSIO, () => db.query(`delete from public.care_invite_attempts`)),
    ).rejects.toThrow(denied);
    await expect(
      asUser(db, PHYSIO, () =>
        db.query(`insert into public.care_invite_attempts (user_id) values ($1)`, [PHYSIO]),
      ),
    ).rejects.toThrow(denied);
    expect(await attempts(PHYSIO)).toBe(1);
  });
});

describe('revoke_care_link', () => {
  it('lets the patient end an active link', async () => {
    const link = await linkUp();
    await revoke(A, link);
    const r = await db.query<{ status: string; revoked_at: Date | null }>(
      `select status, revoked_at from public.care_links where id = $1`,
      [link],
    );
    expect(r.rows[0]?.status).toBe('revoked');
    expect(r.rows[0]?.revoked_at).not.toBeNull();
  });

  it('lets the member leave a link on their own', async () => {
    const link = await linkUp();
    await revoke(PHYSIO, link);
    const r = await db.query<{ status: string }>(`select status from public.care_links`);
    expect(r.rows).toEqual([{ status: 'revoked' }]);
  });

  it('lets the patient withdraw a pending invitation', async () => {
    const inv = await invite(A);
    await revoke(A, inv.id);
    const r = await db.query<{ status: string; invite_hash: string | null }>(
      `select status, invite_hash from public.care_links`,
    );
    expect(r.rows).toEqual([{ status: 'revoked', invite_hash: null }]);
  });

  it('refuses everyone who is not part of the link, without revealing it exists', async () => {
    const link = await linkUp();
    await expect(revoke(B, link)).rejects.toThrow(/not_found/);
    await expect(revoke(A, '00000000-0000-4000-8000-ffffffffffff')).rejects.toThrow(/not_found/);
    const r = await db.query<{ status: string }>(`select status from public.care_links`);
    expect(r.rows).toEqual([{ status: 'active' }]);
  });

  it('is idempotent', async () => {
    const link = await linkUp();
    await revoke(A, link);
    await revoke(A, link);
    await revoke(PHYSIO, link);
    expect(
      (await db.query(`select 1 from public.care_links where status = 'revoked'`)).rows,
    ).toHaveLength(1);
  });

  it('writes the audit trail once per actual revocation', async () => {
    const link = await linkUp();
    await revoke(PHYSIO, link);
    await revoke(PHYSIO, link);
    const actions = (await auditRows()).filter((r) => r.action === 'care_link.revoked');
    expect(actions).toEqual([{ action: 'care_link.revoked', actor_id: PHYSIO, patient_id: A }]);
  });
});

describe('care_links table access', () => {
  it('cannot be forged by users (no direct insert, update or delete)', async () => {
    const link = await linkUp();
    await expect(
      asUser(db, B, () =>
        db.query(
          `insert into public.care_links (patient_id, member_id, member_role, status, expires_at)
           values ($1, $2, 'physio', 'active', now() + interval '1 day')`,
          [A, B],
        ),
      ),
    ).rejects.toThrow(denied);
    await expect(
      asUser(db, A, () =>
        db.query(`update public.care_links set status = 'active' where id = $1`, [link]),
      ),
    ).rejects.toThrow(denied);
    await expect(asUser(db, A, () => db.query(`delete from public.care_links`))).rejects.toThrow(
      denied,
    );
  });

  it('shows each person only the links they are part of', async () => {
    await linkUp(A, PHYSIO);
    const ids = async (uid: string) =>
      (
        await asUser(db, uid, () =>
          db.query<{ patient_id: string; member_id: string | null }>(
            `select patient_id, member_id from public.care_links`,
          ),
        )
      ).rows;
    expect(await ids(A)).toHaveLength(1);
    expect(await ids(PHYSIO)).toHaveLength(1);
    expect(await ids(B)).toEqual([]);
    expect(await ids(OTHER)).toEqual([]);
  });

  it('never exposes the invitation hash to API roles', async () => {
    await invite(A);
    await expect(
      asUser(db, A, () => db.query(`select invite_hash from public.care_links`)),
    ).rejects.toThrow(denied);
    await expect(asUser(db, A, () => db.query(`select * from public.care_links`))).rejects.toThrow(
      denied,
    );
    const ok = await asUser(db, A, () => db.query(`select id, status from public.care_links`));
    expect(ok.rows).toHaveLength(1);
  });

  it('refuses a link between a person and themselves, and a second live link per pair', async () => {
    await expect(
      db.query(
        `insert into public.care_links (patient_id, member_id, member_role, status, expires_at)
         values ($1, $1, 'carer', 'active', now() + interval '1 day')`,
        [A],
      ),
    ).rejects.toThrow();
    await linkUp(A, PHYSIO);
    await expect(
      db.query(
        `insert into public.care_links (patient_id, member_id, member_role, status, expires_at)
         values ($1, $2, 'carer', 'active', now() + interval '1 day')`,
        [A, PHYSIO],
      ),
    ).rejects.toThrow();
  });
});

describe('patient_summary', () => {
  beforeEach(async () => {
    await seedSession(A, 'a1', '2026-11-10T09:00:00Z', 5, 'arm-raise');
    await seedSession(A, 'a2', '2026-11-12T09:00:00Z', 8, 'arm-raise');
    await seedSession(A, 'a3', '2026-11-14T09:00:00Z', 3, 'sit-stand', 'stopped');
    await seedSession(B, 'b1', '2026-11-11T09:00:00Z', 99, 'arm-raise');
  });

  const RANGE: [string, string] = ['2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'];

  async function share(patient = A, member = PHYSIO) {
    await linkUp(patient, member);
    await consent(patient, 'share_with_physio');
  }

  it('returns the numbers for an active link with consent', async () => {
    await share();
    const s = await summary(PHYSIO, A, ...RANGE);
    expect(s.patient.id).toBe(A);
    expect(s.truncated).toBe(false);
    expect(s.totals).toEqual({ sessions: 3, completed: 2, stopped: 1, reps: 16, duration_s: 180 });
    expect(s.by_exercise).toEqual([
      { exercise_id: 'arm-raise', sessions: 2, reps: 13, duration_s: 120 },
      { exercise_id: 'sit-stand', sessions: 1, reps: 3, duration_s: 60 },
    ]);
    expect(s.sessions.map((x) => x['reps'])).toEqual([3, 8, 5]); // newest first
  });

  it('exposes nothing beyond plain activity numbers (no ids from the client, no scores)', async () => {
    await share();
    const s = await summary(PHYSIO, A, ...RANGE);
    expect(Object.keys(s).sort()).toEqual(
      ['by_exercise', 'patient', 'range', 'sessions', 'totals', 'truncated'].sort(),
    );
    expect(Object.keys(s.sessions[0]!).sort()).toEqual(
      ['duration_s', 'exercise_id', 'reps', 'started_at', 'status'].sort(),
    );
  });

  it('only ever includes the linked patient’s sessions', async () => {
    await share(A, PHYSIO);
    await linkUp(B, CARER, 'carer');
    await consent(B, 'share_with_physio');
    const s = await summary(PHYSIO, A, ...RANGE);
    expect(s.totals.reps).toBe(16);
    await expect(summary(PHYSIO, B, ...RANGE)).rejects.toThrow(/forbidden/);
    await expect(summary(CARER, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('covers carers as well as physios', async () => {
    await linkUp(A, CARER, 'carer');
    await consent(A, 'share_with_physio');
    expect((await summary(CARER, A, ...RANGE)).totals.sessions).toBe(3);
  });

  it('is refused without a link', async () => {
    await consent(A, 'share_with_physio');
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('needs the consent of THAT patient, not of anybody', async () => {
    await linkUp(A, PHYSIO);
    await consent(B, 'share_with_physio'); // someone else consenting must not open A's data
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('is refused while the invitation is still pending', async () => {
    await invite(A);
    await consent(A, 'share_with_physio');
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('is refused without the share_with_physio consent', async () => {
    await linkUp();
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
    await consent(A, 'sync_sessions');
    await consent(A, 'ai_summary');
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('stops working the moment the patient withdraws consent', async () => {
    await share();
    expect((await summary(PHYSIO, A, ...RANGE)).totals.sessions).toBe(3);
    await consent(A, 'share_with_physio', false);
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('stops working the moment the link is revoked, and returns if consent is re-granted only with a new link', async () => {
    await share();
    const link = (await db.query<{ id: string }>(`select id from public.care_links`)).rows[0]!.id;
    await revoke(A, link);
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
    await consent(A, 'share_with_physio', false);
    await consent(A, 'share_with_physio', true);
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('refuses a member whose account is anonymous or unconfirmed even if a link exists', async () => {
    const ANON = '00000000-0000-4000-8000-0000000000a4';
    await createUserWith(db, ANON, { anonymous: true, email: null, confirmed: false });
    await db.query(
      `insert into public.care_links (patient_id, member_id, member_role, status, expires_at)
       values ($1, $2, 'physio', 'active', now() + interval '1 day')`,
      [A, ANON],
    );
    await consent(A, 'share_with_physio');
    await expect(summary(ANON, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('is not a back door for patients (they read their own sessions directly)', async () => {
    await share();
    await expect(summary(A, A, ...RANGE)).rejects.toThrow(/forbidden/);
  });

  it('answers a denial the same way whether the patient exists or not', async () => {
    await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
    await expect(summary(PHYSIO, '00000000-0000-4000-8000-eeeeeeeeeeee', ...RANGE)).rejects.toThrow(
      /forbidden/,
    );
  });

  it('filters by date range and defaults to the last 30 days', async () => {
    await share();
    const narrow = await summary(PHYSIO, A, '2026-11-11T00:00:00Z', '2026-11-13T00:00:00Z');
    expect(narrow.totals.sessions).toBe(1);
    const def = await summary(PHYSIO, A);
    const span = Date.parse(def.range.to) - Date.parse(def.range.from);
    expect(Math.round(span / 86_400_000)).toBe(30);
  });

  it('rejects an inverted or oversized range', async () => {
    await share();
    await expect(summary(PHYSIO, A, RANGE[1], RANGE[0])).rejects.toThrow(/invalid_range/);
    await expect(
      summary(PHYSIO, A, '2020-01-01T00:00:00Z', '2026-11-30T00:00:00Z'),
    ).rejects.toThrow(/invalid_range/);
  });

  it('caps the session list but still totals everything', async () => {
    await share();
    await db.query(
      `insert into public.sessions (patient_id, client_id, exercise_id, started_at, duration_s, reps, status)
       select $1, 'bulk-' || g, 'arm-raise', '2026-11-20T09:00:00Z', 1, 1, 'completed'
       from generate_series(1, 600) g`,
      [A],
    );
    const s = await summary(PHYSIO, A, ...RANGE);
    expect(s.sessions).toHaveLength(500);
    expect(s.truncated).toBe(true);
    expect(s.totals.sessions).toBe(603);
  });

  describe('audit trail', () => {
    it('records every successful read by the third party', async () => {
      await share();
      await summary(PHYSIO, A, ...RANGE);
      await summary(PHYSIO, A, ...RANGE);
      const reads = (await auditRows()).filter((r) => r.action === 'patient_summary.read');
      expect(reads).toEqual([
        { action: 'patient_summary.read', actor_id: PHYSIO, patient_id: A },
        { action: 'patient_summary.read', actor_id: PHYSIO, patient_id: A },
      ]);
    });

    it('stores the range that was read but never the data itself', async () => {
      await share();
      await summary(PHYSIO, A, ...RANGE);
      const r = await db.query<{ detail: Record<string, unknown>; link_id: string | null }>(
        `select detail, link_id from public.audit_log where action = 'patient_summary.read'`,
      );
      expect(Object.keys(r.rows[0]!.detail).sort()).toEqual(['from', 'to']);
      expect(r.rows[0]!.link_id).not.toBeNull();
    });

    it('records nothing for a refused read', async () => {
      await expect(summary(PHYSIO, A, ...RANGE)).rejects.toThrow(/forbidden/);
      expect((await auditRows()).filter((r) => r.action === 'patient_summary.read')).toEqual([]);
    });

    it('can be read by the patient, and only by the patient', async () => {
      await share();
      await summary(PHYSIO, A, ...RANGE);
      const select = (uid: string) =>
        asUser(db, uid, () => db.query<{ action: string }>(`select action from public.audit_log`));
      expect((await select(A)).rows.map((r) => r.action)).toContain('patient_summary.read');
      expect((await select(PHYSIO)).rows).toEqual([]);
      expect((await select(B)).rows).toEqual([]);
    });

    it('cannot be forged, edited or erased through the API', async () => {
      await share();
      await summary(PHYSIO, A, ...RANGE);
      for (const uid of [A, PHYSIO]) {
        await expect(
          asUser(db, uid, () =>
            db.query(
              `insert into public.audit_log (actor_id, patient_id, action) values ($1, $1, 'x')`,
              [uid],
            ),
          ),
        ).rejects.toThrow(denied);
        await expect(
          asUser(db, uid, () => db.query(`update public.audit_log set action = 'gone'`)),
        ).rejects.toThrow(denied);
        await expect(
          asUser(db, uid, () => db.query(`delete from public.audit_log`)),
        ).rejects.toThrow(denied);
      }
    });

    it('rejects action names outside the known set', async () => {
      await expect(
        db.query(`insert into public.audit_log (patient_id, action) values ($1, 'made.up')`, [A]),
      ).rejects.toThrow();
    });
  });
});

describe('account deletion', () => {
  it('removes a patient’s links and audit trail together with the account', async () => {
    await linkUp(A, PHYSIO);
    await consent(A, 'share_with_physio');
    await summary(PHYSIO, A);
    await db.query('delete from auth.users where id = $1', [A]);
    expect((await db.query(`select 1 from public.care_links`)).rows).toEqual([]);
    expect((await db.query(`select 1 from public.audit_log`)).rows).toEqual([]);
  });

  it('ends a member’s links when their account is deleted but keeps the patient’s history', async () => {
    await linkUp(A, PHYSIO);
    await consent(A, 'share_with_physio');
    await summary(PHYSIO, A);
    await db.query('delete from auth.users where id = $1', [PHYSIO]);
    expect((await db.query(`select 1 from public.care_links`)).rows).toEqual([]);
    const reads = (await auditRows()).filter((r) => r.action === 'patient_summary.read');
    expect(reads).toEqual([{ action: 'patient_summary.read', actor_id: null, patient_id: A }]);
  });
});
