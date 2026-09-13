create or replace function public.ustad_issue_fresh_session(p_guest_id text)
returns table (jti uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_jti uuid := gen_random_uuid();
begin
  update public.ustad_sessions s
     set revoked_at = now(), revoked_reason = 'rotated'
   where s.guest_id = p_guest_id
     and s.revoked_at is null;

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
#variable_conflict use_column
begin
  return query
    update public.ustad_sessions s
       set expires_at = now() + interval '365 days'
     where s.jti = p_jti
       and s.guest_id = p_guest_id
       and s.revoked_at is null
     returning s.jti;
end;
$$;

create or replace function public.ustad_revoke_session(p_jti uuid, p_reason text)
returns table (jti uuid, revoked_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    update public.ustad_sessions s
       set revoked_at = coalesce(s.revoked_at, now()),
           revoked_reason = case when s.revoked_reason = '' then p_reason else s.revoked_reason end
     where s.jti = p_jti
     returning s.jti, s.revoked_at;
end;
$$;

revoke execute on function public.ustad_issue_fresh_session(text) from anon, authenticated, public;
revoke execute on function public.ustad_refresh_session(text, uuid) from anon, authenticated, public;
revoke execute on function public.ustad_revoke_session(uuid, text) from anon, authenticated, public;
grant execute on function public.ustad_issue_fresh_session(text) to service_role;
grant execute on function public.ustad_refresh_session(text, uuid) to service_role;
grant execute on function public.ustad_revoke_session(uuid, text) to service_role;