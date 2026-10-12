-- Usunięte ogłoszenia mogą wrócić (sprzedawca je ponownie aktywuje). Dotąd po 7 dniach od zniknięcia
-- przestawaliśmy je sprawdzać na zawsze; teraz sprawdzamy je dalej, tylko rzadziej — raz w tygodniu.
create or replace function public.ads_due(max_rows int default 25, min_age interval default interval '20 hours')
returns setof public.ads
language sql stable security definer set search_path = public as $$
  select a.* from public.ads a
  where exists (select 1 from public.watches w where w.ad_key = a.key)
    and (a.last_checked is null or a.last_checked < now() - min_age)
    and not (a.status = 'REMOVED' and a.removed_at < now() - interval '7 days'
             and a.last_checked > now() - interval '7 days')
  order by a.last_checked nulls first
  limit max_rows;
$$;
revoke execute on function public.ads_due(int, interval) from public, anon, authenticated;
