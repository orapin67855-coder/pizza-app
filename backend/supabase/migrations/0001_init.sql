-- PIZZA: core schema (profiles, consents, exercises, sessions).
-- Privacy by design: only summary numbers are stored - never video, frames or landmarks.
-- Access control lives in 0002_rls.sql; every table here has RLS enabled there.

create type public.user_role as enum ('patient', 'carer', 'physio', 'admin');
create type public.consent_purpose as enum (
  'sync_sessions', 'share_with_physio', 'community_clip', 'ai_summary'
);
create type public.approval_status as enum ('draft', 'under_review', 'approved');

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'patient',
  display_name text check (char_length(display_name) <= 60),
  created_at timestamptz not null default now()
);

-- Every new auth user (including anonymous sign-ins) gets a patient profile.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- consents
-- One current row per (user, purpose). Timestamps are set by the server, never by the client.
create table public.consents (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  purpose public.consent_purpose not null,
  granted boolean not null,
  text_version text not null check (char_length(text_version) between 1 and 32),
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, purpose)
);

create function public.consents_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.granted_at := case when new.granted then now() end;
    new.revoked_at := case when new.granted then null else now() end;
  elsif new.granted and not old.granted then
    new.granted_at := now();
    new.revoked_at := null;
  elsif not new.granted and old.granted then
    new.granted_at := old.granted_at;
    new.revoked_at := now();
  else
    new.granted_at := old.granted_at;
    new.revoked_at := old.revoked_at;
  end if;
  return new;
end
$$;

create trigger consents_stamp
  before insert or update on public.consents
  for each row execute function public.consents_stamp();

-- Append-only history: proof of exactly what each user agreed to, and when.
create table public.consent_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose public.consent_purpose not null,
  granted boolean not null,
  text_version text not null,
  at timestamptz not null default now()
);
create index consent_events_user_idx on public.consent_events (user_id, id);

create function public.consents_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.consent_events (user_id, purpose, granted, text_version)
  values (new.user_id, new.purpose, new.granted, new.text_version);
  return new;
end
$$;

create trigger consents_log_insert
  after insert on public.consents
  for each row execute function public.consents_log();

create trigger consents_log_update
  after update on public.consents
  for each row
  when (old.granted is distinct from new.granted or old.text_version is distinct from new.text_version)
  execute function public.consents_log();

-- --------------------------------------------------------------- exercises
-- Definitions are data, versioned, and drafts until a physiotherapist approves them.
create table public.exercises (
  id text not null check (char_length(id) between 1 and 64),
  version integer not null default 1 check (version >= 1),
  name text not null,
  category text not null,
  needs_carer boolean not null default false,
  metric text not null,
  criteria jsonb not null default '{}'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  approval_status public.approval_status not null default 'draft',
  -- nulled if the approving account is deleted; approved_at is the durable record
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id, version),
  constraint approved_has_timestamp
    check (approval_status <> 'approved' or approved_at is not null)
);

-- ---------------------------------------------------------------- sessions
-- Idempotent on (patient_id, client_id): retries and resends never create duplicates.
create table public.sessions (
  patient_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 64),
  exercise_id text not null check (char_length(exercise_id) between 1 and 64),
  started_at timestamptz not null,
  duration_s double precision not null check (duration_s between 0 and 86400),
  reps integer not null check (reps between 0 and 1000),
  status text not null check (status in ('completed', 'stopped')),
  created_at timestamptz not null default now(),
  primary key (patient_id, client_id)
);
create index sessions_patient_started_idx on public.sessions (patient_id, started_at);
