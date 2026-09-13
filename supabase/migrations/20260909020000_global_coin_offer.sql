-- mega_passes gains base_cost (uncharged) so the ledger records the real
-- (possibly discounted) `cost` while the original server price stays available.
alter table public.mega_passes add column if not exists base_cost bigint not null default 0;

-- GLOBAL COIN OFFER — one persisted schedule per Sunday→Sunday cycle.
--
--   ustad_coin_offers           one row per cycle (unique cycle_start => exactly
--                               one offer per week; duplicate-proof).
--   ustad_coin_offer_purchases  audit log of every discounted purchase.
--
-- The active window and discount are computed server-side (deterministic per
-- week) and persisted here so the engine can audit and notify. Only the
-- discounted amount is ever charged. All tables are service-role only (RLS with
-- no anon/authenticated policies), matching the existing economy tables.

create table if not exists public.ustad_coin_offers (
  id uuid primary key default gen_random_uuid(),
  cycle_start date not null,
  cycle_end date not null,
  weekly_offer_id text not null,
  offer_day_offset integer not null default 0,
  start_iso timestamptz not null,
  end_iso timestamptz not null,
  discount_pct integer not null check (discount_pct between 10 and 70),
  duration_minutes integer not null check (duration_minutes between 10 and 180),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'live', 'ended')),
  purchases_count integer not null default 0,
  coins_deducted bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ustad_coin_offers_unique_cycle unique (cycle_start)
);

create index if not exists ustad_coin_offers_cycle_idx
  on public.ustad_coin_offers (cycle_start);

create table if not exists public.ustad_coin_offer_purchases (
  id uuid primary key default gen_random_uuid(),
  weekly_offer_id text not null,
  guest_id text not null references public.guests (id) on delete cascade,
  item_kind text not null default '',
  item_id text not null default '',
  base_price bigint not null default 0,
  discount_pct integer not null default 0,
  discount_amount bigint not null default 0,
  final_price bigint not null default 0,
  source text not null default '',
  ref_id text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists ustad_coin_offer_purchases_offer_idx
  on public.ustad_coin_offer_purchases (weekly_offer_id, created_at desc);
create index if not exists ustad_coin_offer_purchases_guest_idx
  on public.ustad_coin_offer_purchases (guest_id);

-- Auto bump purchases_count / coins_deducted on the owning offer row.
create or replace function public.ustad_coin_offer_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ustad_coin_offers
     set purchases_count = purchases_count + 1,
         coins_deducted = coins_deducted + new.final_price,
         updated_at = now()
   where weekly_offer_id = new.weekly_offer_id;
  return new;
end;
$$;

drop trigger if exists ustad_coin_offer_purchases_bump on public.ustad_coin_offer_purchases;
create trigger ustad_coin_offer_purchases_bump
after insert on public.ustad_coin_offer_purchases
for each row execute function public.ustad_coin_offer_touch();

grant all on public.ustad_coin_offers to service_role;
grant all on public.ustad_coin_offer_purchases to service_role;
grant all on function public.ustad_coin_offer_touch() to service_role;

alter table public.ustad_coin_offers enable row level security;
alter table public.ustad_coin_offer_purchases enable row level security;
