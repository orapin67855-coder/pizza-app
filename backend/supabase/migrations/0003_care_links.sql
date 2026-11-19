-- PIZZA: care links (patient <-> carer/physio), audit log, and the only door through which a
-- third party can read a patient's numbers.
--
-- Design notes
--  * The patient is always the one who invites. A link only exists with the patient's say-so.
--  * Third parties get NO row-level access to `sessions`. Postgres cannot audit a plain SELECT,
--    so reads go through patient_summary(), which checks the link and the consent and writes the
--    audit row in the same transaction: a read that is not logged cannot happen.
--  * Consent and link status are checked on every call, so revoking either cuts access at once.
--  * All writes to care_links / audit_log happen in the SECURITY DEFINER functions below;
--    API roles have no INSERT/UPDATE/DELETE privilege on either table.

create type public.care_member_role as enum ('carer', 'physio');
create type public.care_link_status as enum ('pending', 'active', 'revoked');

-- ------------------------------------------------------------------ care_links
-- A row starts as a pending invitation (member_id null, code hash set) and becomes an active
-- link when someone with a real account redeems the code. Revoked rows are kept as history.
create table public.care_links (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references auth.users (id) on delete cascade,
  member_id uuid references auth.users (id) on delete cascade,
  member_role public.care_member_role not null,
  status public.care_link_status not null default 'pending',
  -- sha256 of the normalised invitation code; cleared once the invitation is used or withdrawn
  invite_hash text unique,
  invite_email text check (char_length(invite_email) <= 254),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint care_links_not_self check (member_id is null or member_id <> patient_id),
  constraint care_links_member_matches_status check (
    (status = 'pending' and member_id is null)
    or (status = 'active' and member_id is not null)
    or status = 'revoked'
  ),
  constraint care_links_hash_only_while_pending check (status = 'pending' or invite_hash is null)
);
create unique index care_links_one_active_per_pair
  on public.care_links (patient_id, member_id) where status = 'active';
create index care_links_member_idx on public.care_links (member_id) where member_id is not null;
create index care_links_patient_idx on public.care_links (patient_id, status);

-- ------------------------------------------------------------------- audit_log
-- Append-only record of who touched a patient's sharing. Deleting the patient deletes their
-- trail; deleting the actor keeps the patient's history (actor becomes null).
create table public.audit_log (
  id bigint generated always as identity primary key,
  patient_id uuid not null references auth.users (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (
    action in (
      'care_link.created',
      'care_link.accepted',
      'care_link.revoked',
      'patient_summary.read'
    )
  ),
  link_id uuid,
  -- never holds health data: only what was asked for (e.g. the date range)
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index audit_log_patient_idx on public.audit_log (patient_id, id);

-- ------------------------------------------------------------------------ RLS
alter table public.care_links enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.care_links, public.audit_log from anon, authenticated;

-- Read-only, own rows only. invite_hash is deliberately not granted.
grant select (
  id, patient_id, member_id, member_role, status, invite_email,
  expires_at, created_at, accepted_at, revoked_at
) on public.care_links to authenticated;
create policy care_links_select_participant on public.care_links
  for select to authenticated using (patient_id = auth.uid() or member_id = auth.uid());

grant select on public.audit_log to authenticated;
create policy audit_log_select_patient on public.audit_log
  for select to authenticated using (patient_id = auth.uid());

-- -------------------------------------------------------------------- helpers
-- A "real" account can be told apart from an anonymous sign-in or an unconfirmed email.
-- Taking part in a care link as the carer/physio requires one: an anonymous identity is not a
-- person we can hold accountable, and it disappears with the browser session.
create function public.is_real_account(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_uid and not u.is_anonymous and u.email_confirmed_at is not null
  )
$$;
revoke execute on function public.is_real_account(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ create_care_invite
-- Returns the code ONCE; only its hash is stored. 16 hex chars = 64 random bits.
create function public.create_care_invite(
  p_role public.care_member_role,
  p_email text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text := nullif(lower(btrim(p_email)), '');
  v_raw text;
  v_id uuid;
  v_expires timestamptz := now() + interval '7 days';
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_email is not null
     and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('care_invite:' || v_uid::text, 0));
  if (
    select count(*) from public.care_links
    where patient_id = v_uid and status = 'pending' and expires_at > now()
  ) >= 10 then
    raise exception 'too_many_invites' using errcode = 'P0001';
  end if;

  v_raw := upper(
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)
  );
  insert into public.care_links (patient_id, member_role, invite_hash, invite_email, expires_at)
  values (
    v_uid, p_role, encode(sha256(convert_to(v_raw, 'utf8')), 'hex'), v_email, v_expires
  )
  returning id into v_id;

  insert into public.audit_log (patient_id, actor_id, action, link_id)
  values (v_uid, v_uid, 'care_link.created', v_id);

  return jsonb_build_object(
    'id', v_id,
    'code', substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-'
            || substr(v_raw, 9, 4) || '-' || substr(v_raw, 13, 4),
    'expires_at', v_expires
  );
end
$$;

-- ----------------------------------------------------------- accept_care_invite
-- Every way a code can be wrong (unknown, used, withdrawn, expired, someone else's email, your
-- own invitation) gives the same answer, so a guesser learns nothing.
create function public.accept_care_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_norm text := regexp_replace(upper(coalesce(p_code, '')), '[^0-9A-F]', '', 'g');
  v_link public.care_links%rowtype;
  v_email text;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not public.is_real_account(v_uid) then
    raise exception 'account_required' using errcode = 'P0001';
  end if;
  if char_length(v_norm) <> 16 then
    raise exception 'invalid_invite' using errcode = 'P0001';
  end if;

  select * into v_link from public.care_links
  where invite_hash = encode(sha256(convert_to(v_norm, 'utf8')), 'hex') and status = 'pending'
  for update;
  if not found or v_link.expires_at <= now() or v_link.patient_id = v_uid then
    raise exception 'invalid_invite' using errcode = 'P0001';
  end if;
  if v_link.invite_email is not null then
    select lower(u.email) into v_email from auth.users u where u.id = v_uid;
    if v_email is distinct from v_link.invite_email then
      raise exception 'invalid_invite' using errcode = 'P0001';
    end if;
  end if;
  if exists (
    select 1 from public.care_links
    where patient_id = v_link.patient_id and member_id = v_uid and status = 'active'
  ) then
    raise exception 'already_linked' using errcode = 'P0001';
  end if;

  update public.care_links
  set member_id = v_uid, status = 'active', accepted_at = now(), invite_hash = null
  where id = v_link.id;

  insert into public.audit_log (patient_id, actor_id, action, link_id)
  values (v_link.patient_id, v_uid, 'care_link.accepted', v_link.id);

  return jsonb_build_object('link_id', v_link.id, 'member_role', v_link.member_role);
end
$$;

-- ------------------------------------------------------------- revoke_care_link
-- The patient can end any of their links or withdraw an invitation; a member can leave their
-- own link. Anyone else gets the same "not found" as for a link that does not exist.
create function public.revoke_care_link(p_link_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_link public.care_links%rowtype;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select * into v_link from public.care_links
  where id = p_link_id and (patient_id = v_uid or member_id = v_uid)
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_link.status = 'revoked' then
    return;
  end if;

  update public.care_links
  set status = 'revoked', revoked_at = now(), invite_hash = null
  where id = v_link.id;

  insert into public.audit_log (patient_id, actor_id, action, link_id)
  values (v_link.patient_id, v_uid, 'care_link.revoked', v_link.id);
end
$$;

-- -------------------------------------------------------------- patient_summary
-- Plain activity numbers for a patient who shares them with the caller. Nothing here is a
-- clinical score: counts, durations and dates, exactly what the patient's own app records.
create function public.patient_summary(
  p_patient_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_to timestamptz := coalesce(p_to, now());
  v_from timestamptz := coalesce(p_from, coalesce(p_to, now()) - interval '30 days');
  v_link_id uuid;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Authorisation first and identical for every kind of refusal (no link, pending, revoked,
  -- no consent, anonymous caller, unknown patient): the caller learns nothing about the patient.
  select l.id into v_link_id
  from public.care_links l
  where l.patient_id = p_patient_id
    and l.member_id = v_uid
    and l.status = 'active'
    and public.is_real_account(v_uid)
    and exists (
      select 1 from public.consents c
      where c.user_id = p_patient_id and c.purpose = 'share_with_physio' and c.granted
    )
  limit 1;
  if v_link_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_from > v_to or v_to - v_from > interval '366 days' then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;

  with s as (
    select exercise_id, started_at, duration_s, reps, status
    from public.sessions
    where patient_id = p_patient_id and started_at between v_from and v_to
  )
  select jsonb_build_object(
    'patient', (
      select jsonb_build_object('id', p.id, 'display_name', p.display_name)
      from public.profiles p where p.id = p_patient_id
    ),
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'truncated', (select count(*) from s) > 500,
    'totals', (
      select jsonb_build_object(
        'sessions', count(*),
        'completed', count(*) filter (where status = 'completed'),
        'stopped', count(*) filter (where status = 'stopped'),
        'reps', coalesce(sum(reps), 0),
        'duration_s', coalesce(sum(duration_s), 0)
      ) from s
    ),
    'by_exercise', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'exercise_id', g.exercise_id, 'sessions', g.n, 'reps', g.r, 'duration_s', g.d
        ) order by g.exercise_id
      )
      from (
        select exercise_id, count(*) as n, sum(reps) as r, sum(duration_s) as d
        from s group by exercise_id
      ) g
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.started_at desc)
      from (
        select exercise_id, started_at, duration_s, reps, status
        from s order by started_at desc limit 500
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  insert into public.audit_log (patient_id, actor_id, action, link_id, detail)
  values (
    p_patient_id, v_uid, 'patient_summary.read', v_link_id,
    jsonb_build_object('from', v_from, 'to', v_to)
  );

  return v_result;
end
$$;

revoke execute on function public.create_care_invite(public.care_member_role, text)
  from public, anon;
revoke execute on function public.accept_care_invite(text) from public, anon;
revoke execute on function public.revoke_care_link(uuid) from public, anon;
revoke execute on function public.patient_summary(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.create_care_invite(public.care_member_role, text)
  to authenticated;
grant execute on function public.accept_care_invite(text) to authenticated;
grant execute on function public.revoke_care_link(uuid) to authenticated;
grant execute on function public.patient_summary(uuid, timestamptz, timestamptz) to authenticated;
