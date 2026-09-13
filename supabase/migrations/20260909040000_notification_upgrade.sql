-- NOTIFICATION SYSTEM UPGRADE — soft-delete for independent removal.
--
-- Each notification is its own row (as before). A user may delete ONE
-- notification without touching any other: this adds a per-row `deleted_at`
-- tombstone. Reads (feed, unread count, detail, mark-read) all ignore rows
-- where `deleted_at` is set, and deletes are scoped to the owning guest.
--
-- We soft-delete instead of hard-delete so the activity/audit history stays
-- intact and the unique (guest_id, dedupe_key) guard still prevents a deleted
-- reminder from being re-announced forever.
alter table public.ustad_notifications
  add column if not exists deleted_at timestamptz;

create index if not exists ustad_notifications_deleted_idx
  on public.ustad_notifications (guest_id, deleted_at)
  where deleted_at is null;
