create table if not exists public.ustad_accounts (
  guest_id text primary key references public.guests (id) on delete cascade,
  user_id uuid not null default gen_random_uuid(),
  username text not null,
  username_normalized text not null,
  password_hash text not null,
  password_algo text not null default 'scrypt',
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ustad_accounts_username_norm_uidx
  on public.ustad_accounts (username_normalized);
create unique index if not exists ustad_accounts_user_id_uidx
  on public.ustad_accounts (user_id);

create table if not exists public.ustad_sessions (
  jti uuid primary key,
  guest_id text not null references public.guests (id) on delete cascade,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text not null default ''
);

create index if not exists ustad_sessions_guest_idx
  on public.ustad_sessions (guest_id, issued_at desc);

create table if not exists public.ustad_login_attempts (
  id uuid primary key default gen_random_uuid(),
  username_normalized text not null default '',
  outcome text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists ustad_login_attempts_username_idx
  on public.ustad_login_attempts (username_normalized, created_at desc);

grant all on public.ustad_accounts to service_role;
grant all on public.ustad_sessions to service_role;
grant all on public.ustad_login_attempts to service_role;

alter table public.ustad_accounts enable row level security;
alter table public.ustad_sessions enable row level security;
alter table public.ustad_login_attempts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ustad_accounts'
      and policyname = 'service role manages accounts'
  ) then
    create policy "service role manages accounts"
      on public.ustad_accounts for all to service_role using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ustad_sessions'
      and policyname = 'service role manages sessions'
  ) then
    create policy "service role manages sessions"
      on public.ustad_sessions for all to service_role using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ustad_login_attempts'
      and policyname = 'service role manages login attempts'
  ) then
    create policy "service role manages login attempts"
      on public.ustad_login_attempts for all to service_role using (true) with check (true);
  end if;
end $$;

create or replace function public.ustad_issue_fresh_session(p_guest_id text)
returns table (jti uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jti uuid := gen_random_uuid();
begin
  update public.ustad_sessions
     set revoked_at = now(), revoked_reason = 'rotated'
   where guest_id = p_guest_id
     and revoked_at is null;

  insert into public.ustad_sessions (jti, guest_id, expires_at)
  values (v_jti, p_guest_id, now() + interval '365 days');

  return query select v_jti;
end;
$$;

create or replace function public.ustad_refresh_session(p_guest_id text, p_jti uuid)
returns table (jti uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update public.ustad_sessions
       set expires_at = now() + interval '365 days'
     where jti = p_jti
       and guest_id = p_guest_id
       and revoked_at is null
     returning public.ustad_sessions.jti;
end;
$$;

create or replace function public.ustad_revoke_session(p_jti uuid, p_reason text)
returns table (jti uuid, revoked_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update public.ustad_sessions
       set revoked_at = coalesce(revoked_at, now()),
           revoked_reason = case when revoked_reason = '' then p_reason else revoked_reason end
     where jti = p_jti
     returning public.ustad_sessions.jti, public.ustad_sessions.revoked_at;
end;
$$;

create or replace function public.ustad_create_guest_account(
  p_guest_id text,
  p_username text,
  p_username_normalized text,
  p_password_hash text
) returns table (guest_id text, username text, jti uuid, user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jti uuid := gen_random_uuid();
begin
  insert into public.guests (id)
  values (p_guest_id)
  on conflict (id) do nothing;

  insert into public.profiles (guest_id)
  values (p_guest_id)
  on conflict (guest_id) do nothing;

  insert into public.settings (guest_id)
  values (p_guest_id)
  on conflict (guest_id) do nothing;

  insert into public.ustad_accounts
    (guest_id, username, username_normalized, password_hash, password_algo)
  values
    (p_guest_id, p_username, p_username_normalized, p_password_hash, 'scrypt')
  on conflict (guest_id) do nothing;

  if not exists (
    select 1 from public.ustad_accounts
     where guest_id = p_guest_id
       and username_normalized = p_username_normalized
  ) then
    raise exception using
      errcode = 'U0001',
      message = 'guest_already_claimed';
  end if;

  insert into public.ustad_sessions (jti, guest_id, expires_at)
  values (v_jti, p_guest_id, now() + interval '365 days');

  return query
    select p_guest_id,
           (select u.username from public.ustad_accounts u where u.guest_id = p_guest_id),
           v_jti,
           (select u.user_id from public.ustad_accounts u where u.guest_id = p_guest_id);
end;
$$;

revoke all on function public.ustad_issue_fresh_session(text) from public;
revoke all on function public.ustad_refresh_session(text, uuid) from public;
revoke all on function public.ustad_revoke_session(uuid, text) from public;
revoke all on function public.ustad_create_guest_account(text, text, text, text) from public;
grant execute on function public.ustad_issue_fresh_session(text) to service_role;
grant execute on function public.ustad_refresh_session(text, uuid) to service_role;
grant execute on function public.ustad_revoke_session(uuid, text) to service_role;
grant execute on function public.ustad_create_guest_account(text, text, text, text) to service_role;