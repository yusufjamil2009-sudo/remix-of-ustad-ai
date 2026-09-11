-- PERMANENT GUEST IDENTITY + CREDENTIALS + REVOCABLE SESSIONS.
--
-- Extends the EXISTING identity model. Nothing existing is modified or dropped:
--   • `guests` stays the permanent account row (id = permanent Guest ID).
--   • `ustad_accounts` adds the login layer on top of a guest: a unique
--     username + a securely hashed password. A guest without an account keeps
--     working exactly as before — it stays on its EXISTING Guest ID and keeps
--     going straight Home; it is merely OFFERED (never forced) a username +
--     password through a dismissible "Secure this device" notice, and it may
--     also claim credentials from the Welcome screen if it chooses to.
--   • `ustad_sessions` makes sessions revocable, so LOG OUT can genuinely
--     invalidate a token server-side (a frontend flag is never enough).
--
-- Guarantees enforced AT THE DATABASE LEVEL (not only in the UI):
--   • username_normalized is UNIQUE  → two concurrent "New Guest ID" requests
--     with the same username can never both succeed (race-safe).
--   • guest_id is the primary key of the account → one account per guest, so a
--     restore can never create a second identity for the same account.
--
-- Non-destructive and idempotent: safe to re-run, no user data removed.

create table if not exists public.ustad_accounts (
  -- The permanent public Guest ID. One account per guest, forever.
  guest_id text primary key references public.guests (id) on delete cascade,
  -- Canonical authentication identity (UUID). qr/stable internal reference.
  user_id uuid not null default gen_random_uuid(),
  -- The username exactly as the user typed it (display).
  username text not null,
  -- Case-folded + trimmed username. ALL uniqueness/lookup uses this column.
  username_normalized text not null,
  -- Never plaintext: "scrypt$N$r$p$salt$hash" (see src/lib/account.server.ts).
  password_hash text not null,
  password_algo text not null default 'scrypt',
  -- Login abuse protection (server-side; legitimate users are never locked
  -- out persistently — the lock is short and self-healing).
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The single most important invariant: one username, one account.
create unique index if not exists ustad_accounts_username_norm_uidx
  on public.ustad_accounts (username_normalized);
create unique index if not exists ustad_accounts_user_id_uidx
  on public.ustad_accounts (user_id);

-- Revocable sessions. A token carries its session id (jti); LOG OUT revokes it
-- here so the token stops working everywhere, immediately.
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

-- Login-attempt audit for abuse protection (no secrets are ever recorded).
create table if not exists public.ustad_login_attempts (
  id uuid primary key default gen_random_uuid(),
  username_normalized text not null default '',
  outcome text not null default '',          -- success | failed | locked
  created_at timestamptz not null default now()
);
create index if not exists ustad_login_attempts_username_idx
  on public.ustad_login_attempts (username_normalized, created_at desc);

-- Same security posture as every other USTAD table: RLS on, service role only.
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

-- Migration safety (§54-§56): EXISTING guests keep their Guest ID, their
-- profile, coins, purchases, tournaments, certificates, notifications and
-- settings untouched. They simply have no username yet, so their next open
-- offers "NEW GUEST ID / BACKUP ID", and claiming binds credentials to the
-- SAME guest row (never a new identity, never a data reset).
comment on table public.ustad_accounts is
  'Login layer over the existing permanent Guest ID. username_normalized is '
  'unique at the database level; passwords are scrypt-hashed, never plaintext.';
comment on table public.ustad_sessions is
  'Revocable sessions (jti). LOG OUT revokes the row so the token is dead '
  'server-side; the permanent guest row and all data are untouched.';

-- ---------------------------------------------------------------------------
-- ATOMIC IDENTITY OPERATIONS (idempotent, re-runnable — create or replace).
--
-- The identity lifecycle needs multi-statement operations to behave as ONE
-- logical step (spec §4, §5, §9, §22). PostgREST's table API cannot do
-- transactions, so these functions run the whole step in a single transaction
-- and are executable ONLY by service_role (the server layer), following the
-- exact same pattern as the existing ustad_coin_apply / ustad_shop_buy RPCs.
--
--   ustad_issue_fresh_session   revoke all live sessions + create one new one
--   ustad_refresh_session       extend ONE live session (same jti), verified
--   ustad_revoke_session        revoke ONE session (LOG OUT)
--   ustad_create_guest_account  guest + profile + settings + account + session
--                               as one atomic creation (no partial state)
--
-- Error contract for callers:
--   • 23505 (unique_violation) on username  → USERNAME_TAKEN (and only that)
--   • 'U0001' raised explicitly             → guest already claimed by another
--   • any other SQL error                   → DATABASE_ERROR
--   • fetch/transport failure               → NETWORK_ERROR
-- A failed RPC rolls back EVERYTHING, so a half-created identity cannot exist.
-- ---------------------------------------------------------------------------

-- §4 — rotate sessions atomically: old sessions are revoked IN THE SAME
-- TRANSACTION as the new session insert, so the state "old live + new live"
-- can never be observed, and a failed insert leaves the old session untouched.
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

-- §5 — refresh ONLY a session that exists, belongs to THIS guest, and is live.
-- Returns zero rows when the session is missing, revoked, or another guest's —
-- the caller must treat zero rows as invalid_session and never mint a token.
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

-- §6 / §15 — revoke ONE session (LOG OUT). Returns the row when it existed
-- (live or already revoked — both mean the token is dead), zero rows when the
-- session never existed (nothing left to revoke: idempotent success).
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

-- §9 — NEW GUEST ID / CLAIM as ONE atomic creation:
--   guest (+ profile + settings bootstrap, reusing the existing ensureGuestRow
--   row shape) + credentials + initial revocable session. Every statement
--   commits together or not at all, so a partial identity can never exist and
--   a duplicate-username race is decided here, in the database.
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

  -- Only a REAL username collision maps to 23505 (unique_violation). If the
  -- guest already holds a DIFFERENT account, the claim must fail loudly with
  -- its own code instead of silently taking over someone's username.
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
