-- PIZZA: limit guessing of care-invite codes.
--
-- A code has 64 random bits and only a confirmed, non-anonymous account may try one, so guessing
-- is already impractical; this adds a hard per-user ceiling anyway: 5 wrong codes in 15 minutes
-- locks that user out of accept_care_invite for the rest of the window.
--
-- A refused guess used to RAISE, which rolls the transaction back and would erase the record of
-- the attempt. It now RETURNS {"error": "invalid_invite"} after recording it; the edge function
-- turns that back into the same 404 as before.

create table public.care_invite_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index care_invite_attempts_user_idx on public.care_invite_attempts (user_id, at);
create index care_invite_attempts_at_idx on public.care_invite_attempts (at);

-- Internal bookkeeping: no API role may read or write it (only the function below does).
alter table public.care_invite_attempts enable row level security;
revoke all on public.care_invite_attempts from anon, authenticated;

create or replace function public.accept_care_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_norm text := regexp_replace(upper(coalesce(p_code, '')), '[^0-9A-F]', '', 'g');
  v_link public.care_links%rowtype;
  v_email text;
  v_valid boolean;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not public.is_real_account(v_uid) then
    raise exception 'account_required' using errcode = 'P0001';
  end if;

  -- One attempt at a time per user, so parallel requests cannot slip past the counter.
  perform pg_advisory_xact_lock(hashtextextended('care_accept:' || v_uid::text, 0));
  delete from public.care_invite_attempts where at < now() - interval '1 day';
  if (
    select count(*) from public.care_invite_attempts
    where user_id = v_uid and at > now() - interval '15 minutes'
  ) >= 5 then
    raise exception 'too_many_attempts' using errcode = 'P0001';
  end if;

  -- Every way a code can be wrong (unknown, used, withdrawn, expired, someone else's email, your
  -- own invitation) is one outcome, so a guesser learns nothing.
  v_valid := char_length(v_norm) = 16;
  if v_valid then
    select * into v_link from public.care_links
    where invite_hash = encode(sha256(convert_to(v_norm, 'utf8')), 'hex') and status = 'pending'
    for update;
    v_valid := found and v_link.expires_at > now() and v_link.patient_id <> v_uid;
  end if;
  if v_valid and v_link.invite_email is not null then
    select lower(u.email) into v_email from auth.users u where u.id = v_uid;
    v_valid := v_email is not distinct from v_link.invite_email;
  end if;
  if not coalesce(v_valid, false) then
    insert into public.care_invite_attempts (user_id) values (v_uid);
    return jsonb_build_object('error', 'invalid_invite');
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
  delete from public.care_invite_attempts where user_id = v_uid;

  insert into public.audit_log (patient_id, actor_id, action, link_id)
  values (v_link.patient_id, v_uid, 'care_link.accepted', v_link.id);

  return jsonb_build_object('link_id', v_link.id, 'member_role', v_link.member_role);
end
$$;
