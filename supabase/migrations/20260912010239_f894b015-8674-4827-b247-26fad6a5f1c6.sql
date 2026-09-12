alter table public.crorepati_events alter column open_hour set default 6, alter column window_minutes set default 960;
update public.crorepati_events set open_hour = 6, window_minutes = 960 where open_hour = 18 and window_minutes = 240;
delete from public.crorepati_event_occurrences o
 where o.status = 'scheduled'
   and o.opened_at > now()
   and exists (select 1 from public.crorepati_events e where e.id = o.event_id);