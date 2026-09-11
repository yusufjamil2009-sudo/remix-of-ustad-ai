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
#variable_conflict use_column
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
    select 1 from public.ustad_accounts u
     where u.guest_id = p_guest_id
       and u.username_normalized = p_username_normalized
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

revoke execute on function public.ustad_create_guest_account(text, text, text, text) from anon, authenticated, public;
grant execute on function public.ustad_create_guest_account(text, text, text, text) to service_role;