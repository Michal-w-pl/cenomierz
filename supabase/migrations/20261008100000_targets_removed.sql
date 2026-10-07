-- Próg cenowy dla obserwowanego ogłoszenia (mail o obniżce tylko, gdy cena spadnie do progu)
-- i powiadomienie o zniknięciu ogłoszenia z Otomoto.

alter table public.watches add column target_price numeric check (target_price > 0);

-- Zmienia się zestaw kolumn wyniku, więc funkcję trzeba utworzyć od nowa.
drop function public.pending_drop_alerts(timestamptz);
create function public.pending_drop_alerts(until timestamptz)
returns table (user_id uuid, email text, ad_key text, title text, url text, image text, currency text,
               old_price numeric, new_price numeric, changed_at timestamptz, target_price numeric)
language sql stable security definer set search_path = public as $$
  with w as (
    select w.user_id, w.ad_key, w.target_price,
           greatest(coalesce(p.checked_until, until - interval '1 day'), w.added_at) as since
    from public.watches w
    left join public.alert_prefs p on p.user_id = w.user_id
    where coalesce(p.email_drops, true)
  )
  select w.user_id, u.email, a.key, a.title, a.url, a.image, a.currency, b.price, n.price, n.t, w.target_price
  from w
  join auth.users u on u.id = w.user_id
  join public.ads a on a.key = w.ad_key
  cross join lateral (select price from public.price_points where ad_key = w.ad_key and t <= w.since order by t desc limit 1) b
  cross join lateral (select price, t from public.price_points where ad_key = w.ad_key and t <= until order by t desc limit 1) n
  where n.t > w.since and n.price < b.price
    and (w.target_price is null or n.price <= w.target_price)   -- z progiem: tylko gdy cena spadła do progu
    and a.status is distinct from 'REMOVED'
    and u.email is not null
  order by w.user_id, (n.price - b.price) / b.price;
$$;
revoke execute on function public.pending_drop_alerts(timestamptz) from public, anon, authenticated;

-- Obserwowane ogłoszenia, które zniknęły z Otomoto od ostatniego powiadomienia.
create or replace function public.pending_removed_alerts(until timestamptz)
returns table (user_id uuid, email text, ad_key text, title text, url text, image text, currency text,
               last_price numeric, removed_at timestamptz, added_at timestamptz)
language sql stable security definer set search_path = public as $$
  select w.user_id, u.email, a.key, a.title, a.url, a.image, a.currency,
         (select price from public.price_points where ad_key = a.key order by t desc limit 1), a.removed_at, w.added_at
  from public.watches w
  join auth.users u on u.id = w.user_id
  join public.ads a on a.key = w.ad_key
  left join public.alert_prefs p on p.user_id = w.user_id
  where coalesce(p.email_drops, true) and u.email is not null
    and a.status = 'REMOVED' and a.removed_at <= until
    and a.removed_at > greatest(coalesce(p.checked_until, until - interval '1 day'), w.added_at)
  order by w.user_id, a.removed_at desc;
$$;
revoke execute on function public.pending_removed_alerts(timestamptz) from public, anon, authenticated;
