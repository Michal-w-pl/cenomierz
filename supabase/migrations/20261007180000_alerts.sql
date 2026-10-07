-- Powiadomienia e-mail o obniżkach cen: ustawienia per użytkownik + codzienny harmonogram.

create table public.alert_prefs (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  email_drops   boolean not null default true,  -- brak wiersza = powiadomienia włączone
  checked_until timestamptz                      -- do kiedy obniżki zostały już zgłoszone (ustawia funkcja alerts)
);

alter table public.alert_prefs enable row level security;
create policy "alert_prefs: select own" on public.alert_prefs for select to authenticated using (user_id = auth.uid());
create policy "alert_prefs: insert own" on public.alert_prefs for insert to authenticated with check (user_id = auth.uid());
create policy "alert_prefs: update own" on public.alert_prefs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.alert_prefs to authenticated;
grant insert (user_id, email_drops), update (email_drops) on public.alert_prefs to authenticated;
revoke all on public.alert_prefs from anon;

-- Obserwowane ogłoszenia, które od ostatniego powiadomienia potaniały (cena teraz < cena wtedy).
-- Okno: od checked_until (pierwszy raz: ostatnia doba), nie wcześniej niż dodanie do obserwowanych.
create or replace function public.pending_drop_alerts(until timestamptz)
returns table (user_id uuid, email text, ad_key text, title text, url text, image text, currency text,
               old_price numeric, new_price numeric, changed_at timestamptz)
language sql stable security definer set search_path = public as $$
  with w as (
    select w.user_id, w.ad_key,
           greatest(coalesce(p.checked_until, until - interval '1 day'), w.added_at) as since
    from public.watches w
    left join public.alert_prefs p on p.user_id = w.user_id
    where coalesce(p.email_drops, true)
  )
  select w.user_id, u.email, a.key, a.title, a.url, a.image, a.currency, b.price, n.price, n.t
  from w
  join auth.users u on u.id = w.user_id
  join public.ads a on a.key = w.ad_key
  cross join lateral (select price from public.price_points where ad_key = w.ad_key and t <= w.since order by t desc limit 1) b
  cross join lateral (select price, t from public.price_points where ad_key = w.ad_key and t <= until order by t desc limit 1) n
  where n.t > w.since and n.price < b.price
    and a.status is distinct from 'REMOVED'
    and u.email is not null
  order by w.user_id, (n.price - b.price) / b.price;
$$;

-- Zapamiętuje, że obniżki do `until` zostały obsłużone (pomija użytkowników, do których wysyłka się nie udała).
create or replace function public.alerts_mark(until timestamptz, skip uuid[] default '{}')
returns void
language sql security definer set search_path = public as $$
  insert into public.alert_prefs (user_id, checked_until)
  select distinct user_id, until from public.watches where not (user_id = any(skip))
  on conflict (user_id) do update set checked_until = excluded.checked_until;
$$;

revoke execute on function public.pending_drop_alerts(timestamptz) from public, anon, authenticated;
revoke execute on function public.alerts_mark(timestamptz, uuid[]) from public, anon, authenticated;

-- Codziennie o 6:00 UTC (8:00 latem / 7:00 zimą w Polsce) — po nocnym odświeżeniu cen.
select cron.schedule(
  'cenomierz-alerts',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://kkduvothshtywldnuspe.supabase.co/functions/v1/alerts',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
