-- WEEKLY RANK REWARD ATOMICITY + WEEKLY CERTIFICATE DEDUPE.
--
-- 1) ustad_rank_awards gains a `status` lifecycle (pending → processing →
--    paid | failed) so a coin-credit failure is recorded as `failed` (still
--    retryable) instead of being silently treated as settled. Existing rows
--    that already carry a transaction_id were paid → `paid`; the rare rows
--    without one (a credit that failed after the award was recorded) stay
--    `pending` and are retried by the engine's reconciliation pass.
--
-- 2) ustad_certificates gains a `reference_key` column that holds the stable
--    weekly-rank reference (e.g. "2026-09-06:most_cups:1"). A partial UNIQUE
--    index on (guest_id, reference_key) makes weekly-rank certificate lookup a
--    single indexed equality — no more scanning a limited window of rows,
--    which is what let duplicates appear once a user passed the window.
--    Existing rows are back-filled non-destructively; any pre-existing
--    duplicate reference_keys are cleared (the row itself is kept) so the
--    index can be created safely.
--
-- Non-destructive, idempotent, backward compatible: no user data, certificate,
-- wallet/ledger or RLS protection is dropped.

alter table public.ustad_rank_awards
  add column if not exists status text not null default 'pending';

update public.ustad_rank_awards
   set status = 'paid'
 where status = 'pending' and transaction_id is not null;

alter table public.ustad_certificates
  add column if not exists reference_key text;

do $$
begin
  -- Back-fill reference_key from the existing metadata reference, if any.
  update public.ustad_certificates
     set reference_key = metadata ->> 'reference'
   where reference_key is null and metadata ? 'reference';

  -- De-duplicate existing rows non-destructively: keep the earliest issued
  -- certificate per (guest_id, reference_key); clear reference_key on the
  -- extras so the unique index can be created. No row is deleted.
  with ranked as (
    select id,
           row_number() over (
             partition by guest_id, reference_key
             order by issued_at asc, id asc
           ) as rn
      from public.ustad_certificates
     where reference_key is not null
  )
  update public.ustad_certificates c
     set reference_key = null
    from ranked r
   where c.id = r.id and r.rn > 1;
end $$;

create unique index if not exists ustad_certificates_reference_uidx
  on public.ustad_certificates (guest_id, reference_key)
  where reference_key is not null;
