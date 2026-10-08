-- Okazje w wyszukiwaniach: cena nowego ogłoszenia względem podobnych ofert z tego samego wyszukiwania
-- (ta sama marka i model, rocznik ±1, zbliżona moc, korekta na przebieg). Liczone przy zapisie przez funkcję searches.

alter table public.search_hits
  add column deal_pct numeric,   -- % względem ceny oczekiwanej (ujemny = taniej niż rynek); null = za mało porównań
  add column deal_n   integer;   -- liczba ofert w porównaniu

drop function public.pending_search_alerts(timestamptz);
create function public.pending_search_alerts(until timestamptz)
returns table (user_id uuid, email text, search_name text, search_url text, ad_key text, title text, url text,
               image text, price numeric, currency text, params jsonb, location text, deal_pct numeric, deal_n integer)
language sql stable security definer set search_path = public as $$
  select s.user_id, u.email, s.name, s.url, h.ad_key, h.title, h.url, h.image, h.price, h.currency, h.params, h.location,
         h.deal_pct, h.deal_n
  from public.searches s
  join auth.users u on u.id = s.user_id
  left join public.alert_prefs p on p.user_id = s.user_id
  join public.search_hits h on h.search_id = s.id
  where coalesce(p.email_drops, true) and not h.baseline and u.email is not null
    and h.first_seen <= until
    and h.first_seen > greatest(coalesce(p.checked_until, until - interval '1 day'), s.created_at)
  order by s.user_id, s.name, h.first_seen desc;
$$;
revoke execute on function public.pending_search_alerts(timestamptz) from public, anon, authenticated;
