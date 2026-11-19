-- PIZZA: access control. Supabase grants ALL on new public tables to anon/authenticated by
-- default and relies on RLS; we revoke first and grant back only what each table needs
-- (defence in depth: RLS policy AND privilege must both allow an action).

alter table public.profiles enable row level security;
alter table public.consents enable row level security;
alter table public.consent_events enable row level security;
alter table public.exercises enable row level security;
alter table public.sessions enable row level security;

revoke all on public.profiles, public.consents, public.consent_events,
  public.exercises, public.sessions from anon, authenticated;

-- ----------------------------------------------------------------- helpers
create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('physio', 'admin')
  )
$$;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- Trigger functions are not meant to be called through the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.consents_stamp() from public, anon, authenticated;
revoke execute on function public.consents_log() from public, anon, authenticated;

-- ---------------------------------------------------------------- profiles
-- Rows are created by trigger. A user may read their own and change only the display name
-- (column-level grant: nobody can promote themselves).
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------- consents
grant select, insert on public.consents to authenticated;
-- `purpose` is included because PostgREST's merge-duplicates upsert also sets the conflict key.
grant update (purpose, granted, text_version) on public.consents to authenticated;

create policy consents_select_own on public.consents
  for select to authenticated using (user_id = auth.uid());
create policy consents_insert_own on public.consents
  for insert to authenticated with check (user_id = auth.uid());
create policy consents_update_own on public.consents
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Read-only for users; only the logging trigger can append.
grant select on public.consent_events to authenticated;
create policy consent_events_select_own on public.consent_events
  for select to authenticated using (user_id = auth.uid());

-- --------------------------------------------------------------- exercises
-- Any signed-in user (including anonymous sign-ins) can read; only staff can write.
grant select, insert, update, delete on public.exercises to authenticated;

create policy exercises_select on public.exercises
  for select to authenticated using (true);
create policy exercises_insert_staff on public.exercises
  for insert to authenticated with check (public.is_staff());
create policy exercises_update_staff on public.exercises
  for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy exercises_delete_staff on public.exercises
  for delete to authenticated using (public.is_staff());

-- ---------------------------------------------------------------- sessions
-- Upload requires the sync consent to be on RIGHT NOW: revoking it blocks new uploads at the
-- database level, whatever any client or function does. No UPDATE privilege: uploads are final.
grant select, insert, delete on public.sessions to authenticated;

create policy sessions_select_own on public.sessions
  for select to authenticated using (patient_id = auth.uid());
create policy sessions_insert_own_with_consent on public.sessions
  for insert to authenticated
  with check (
    patient_id = auth.uid()
    and exists (
      select 1 from public.consents c
      where c.user_id = auth.uid() and c.purpose = 'sync_sessions' and c.granted
    )
  );
create policy sessions_delete_own on public.sessions
  for delete to authenticated using (patient_id = auth.uid());
