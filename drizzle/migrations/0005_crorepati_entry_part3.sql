alter table public.crorepati_events
  add column if not exists free_entries_grant integer not null default 3,
  add column if not exists max_free_entries integer not null default 3,
  add column if not exists missed_threshold integer not null default 10,
  add column if not exists schedule_weekdays jsonb not null default '[0,2,5]'::jsonb,
  add column if not exists open_hour integer not null default 6,
  add column if not exists open_minute integer not null default 0,
  add column if not exists window_minutes integer not null default 960,
  add column if not exists entry_timezone text not null default 'Asia/Kolkata',
  add column if not exists paid_entry_coin_cost bigint not null default 100000,
  add column if not exists paid_entry_enabled boolean not null default true;

create table if not exists public.crorepati_event_occurrences (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.crorepati_events (id) on delete cascade,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  unique (event_id, opened_at)
);
create index if not exists crorepati_occurrences_window_idx
  on public.crorepati_event_occurrences (event_id, opened_at desc);

create table if not exists public.crorepati_participation (
  occurrence_id uuid not null references public.crorepati_event_occurrences (id) on delete cascade,
  guest_id text not null references public.guests (id) on delete cascade,
  event_id uuid not null references public.crorepati_events (id) on delete cascade,
  eligible boolean not null default true,
  played boolean not null default false,
  attempt_id uuid references public.crorepati_attempts (id) on delete set null,
  counted boolean not null default false,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (occurrence_id, guest_id)
);
create index if not exists crorepati_participation_guest_idx
  on public.crorepati_participation (guest_id, closed_at desc);

create table if not exists public.crorepati_entry_state (
  guest_id text primary key references public.guests (id) on delete cascade,
  event_id uuid not null references public.crorepati_events (id) on delete cascade,
  free_entries integer not null default 3 check (free_entries >= 0),
  free_entries_used integer not null default 0,
  paid_entries_used integer not null default 0,
  missed_streak integer not null default 0 check (missed_streak >= 0),
  recovery_count integer not null default 0,
  last_played_at timestamptz,
  last_recovered_at timestamptz,
  zero_notified boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.crorepati_entries (
  id uuid primary key default gen_random_uuid(),
  guest_id text not null references public.guests (id) on delete cascade,
  event_id uuid not null references public.crorepati_events (id) on delete cascade,
  occurrence_id uuid references public.crorepati_event_occurrences (id) on delete set null,
  attempt_id uuid unique references public.crorepati_attempts (id) on delete set null,
  entry_type text not null,
  free_entry_used boolean not null default false,
  paid_entry boolean not null default false,
  price bigint not null default 0,
  currency text not null default 'USTAD_COIN',
  status text not null default 'granted',
  ledger_ref text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique (guest_id, idempotency_key)
);
create index if not exists crorepati_entries_guest_idx
  on public.crorepati_entries (guest_id, created_at desc);
create unique index if not exists crorepati_entries_one_open
  on public.crorepati_entries (guest_id)
  where status = 'granted';

alter table public.crorepati_attempts
  add column if not exists entry_id uuid references public.crorepati_entries (id) on delete set null;

insert into public.crorepati_event_occurrences (event_id, opened_at, closed_at, status)
select e.id, date_trunc('hour', now()), date_trunc('hour', now()) + interval '4 hours', 'open'
from public.crorepati_events e
where e.code = 'kbc-default'
on conflict (event_id, opened_at) do nothing;

grant all on public.crorepati_event_occurrences to service_role;
grant all on public.crorepati_participation to service_role;
grant all on public.crorepati_entry_state to service_role;
grant all on public.crorepati_entries to service_role;

alter table public.crorepati_event_occurrences enable row level security;
alter table public.crorepati_participation enable row level security;
alter table public.crorepati_entry_state enable row level security;
alter table public.crorepati_entries enable row level security;
