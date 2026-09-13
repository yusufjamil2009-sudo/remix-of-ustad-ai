-- Weekly Rank certificate template + minimal service-role RLS policies for the
-- weekly leaderboard tables. Idempotent: safe to re-run on an already-applied
-- database.
--
--  * The weekly_rank certificate template gives rank certificates their own
--    visual theme while the engine falls back to DEFAULT_TEMPLATE if it is not
--    present (so the app works either way).
--  * ustad_rank_awards / ustad_rank_cycles are accessed exclusively through
--    server engines that run with the service role. Enabling RLS with NO
--    anon/authenticated policy already denies everyone but the service role;
--    the explicit service-role policy just matches the pattern used by the
--    other tables and keeps the security posture auditable.

insert into public.certificate_templates (code, certificate_type, title, subtitle, theme)
values (
  'ustad-cert-weekly-rank-v1', 'weekly_rank',
  'Certificate of Weekly Ranking', 'USTAD AI Weekly Leaderboard',
  '{"tier":"rank","ink":"#08291f","accent":"#0f8a5f","accentSoft":"#c9efe0","paper":"#f9fffc","border":"double","seal":"#0f8a5f","pattern":"laurel"}'::jsonb
)
on conflict (code) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ustad_rank_awards'
      and policyname = 'service role manages rank awards'
  ) then
    create policy "service role manages rank awards"
      on public.ustad_rank_awards for all to service_role
      using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ustad_rank_cycles'
      and policyname = 'service role manages rank cycles'
  ) then
    create policy "service role manages rank cycles"
      on public.ustad_rank_cycles for all to service_role
      using (true) with check (true);
  end if;
end $$;
