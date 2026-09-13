-- Equipped profile cosmetics — real, persistent, single-active-per-category.
--
-- avatar_frames already persists via profiles.equipped_frame (Part 8). This
-- adds the two sibling single-active cosmetic slots for the OTHER shop
-- categories that decorate the user's displayed name/identity:
--   * badges       -> equipped_badge     (a small emblem next to the name)
--   * name_styles  -> equipped_name_style (a typographic treatment of the name)
--
-- Following the exact Part 8 pattern: a single column per cosmetic category on
-- the existing profiles row, FK-guarded to ustad_shop_items, so only one item
-- per category can ever be equipped and the state survives refresh / re-login.

alter table public.profiles
  add column if not exists equipped_badge text,
  add column if not exists equipped_name_style text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_equipped_badge_fk'
  ) then
    alter table public.profiles
      add constraint profiles_equipped_badge_fk
      foreign key (equipped_badge) references public.ustad_shop_items (item_id)
      on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_equipped_name_style_fk'
  ) then
    alter table public.profiles
      add constraint profiles_equipped_name_style_fk
      foreign key (equipped_name_style) references public.ustad_shop_items (item_id)
      on delete set null;
  end if;
end $$;
