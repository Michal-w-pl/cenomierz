-- Śledzenie wyszukiwań: użytkownik zapisuje link do wyników wyszukiwania Otomoto (z dowolnymi filtrami),
-- funkcja searches co kilka godzin sprawdza najnowsze wyniki i zapisuje ogłoszenia, których wcześniej nie było.

create table public.searches (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  url          text not null check (url ~ '^https://www\.otomoto\.pl/' and url !~ '/oferta/' and char_length(url) <= 2000),
  created_at   timestamptz not null default now(),
  seen_until   timestamptz not null default now(),  -- do kiedy użytkownik obejrzał nowe ogłoszenia (znacznik „nowe”)
  last_checked timestamptz,
  last_error   text,
  total_count  integer
);
create index searches_user_idx on public.searches(user_id);

create table public.search_hits (
  search_id     uuid not null references public.searches(id) on delete cascade,
  ad_key        text not null,                       -- jak ads.key (…-ID6I0pDV.html → 6I0pDV)
  url           text not null,
  title         text,
  subtitle      text,
  image         text,
  price         numeric,
  currency      text,
  location      text,
  params        jsonb not null default '{}',        -- rocznik, przebieg, moc, paliwo
  ad_created_at timestamptz,
  first_seen    timestamptz not null default now(),
  baseline      boolean not null default false,     -- było w wynikach przy pierwszym sprawdzeniu (nie jest „nowe”)
  primary key (search_id, ad_key)
);
create index search_hits_new_idx on public.search_hits(search_id, first_seen desc) where not baseline;

alter table public.searches    enable row level security;
alter table public.search_hits enable row level security;

create policy "searches: select own" on public.searches for select to authenticated using (user_id = auth.uid());
-- najwyżej 10 wyszukiwań na użytkownika
create policy "searches: insert own" on public.searches for insert to authenticated
  with check (user_id = auth.uid() and (select count(*) from public.searches s where s.user_id = auth.uid()) < 10);
create policy "searches: update own" on public.searches for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "searches: delete own" on public.searches for delete to authenticated using (user_id = auth.uid());
create policy "search_hits: own" on public.search_hits for select to authenticated
  using (exists (select 1 from public.searches s where s.id = search_hits.search_id and s.user_id = auth.uid()));

grant select, delete on public.searches to authenticated;
grant insert (user_id, name, url), update (name, url, seen_until) on public.searches to authenticated;
grant select on public.search_hits to authenticated;
revoke all on public.searches, public.search_hits from anon;

-- Powiadomienia: nowe ogłoszenia z wyszukiwań od ostatniego maila (to samo okno co obniżki cen).
create or replace function public.pending_search_alerts(until timestamptz)
returns table (user_id uuid, email text, search_name text, search_url text, ad_key text, title text, url text,
               image text, price numeric, currency text, params jsonb, location text)
language sql stable security definer set search_path = public as $$
  select s.user_id, u.email, s.name, s.url, h.ad_key, h.title, h.url, h.image, h.price, h.currency, h.params, h.location
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

-- alerts_mark: oznacza też użytkowników, którzy mają tylko wyszukiwania (bez obserwowanych ogłoszeń).
create or replace function public.alerts_mark(until timestamptz, skip uuid[] default '{}')
returns void
language sql security definer set search_path = public as $$
  insert into public.alert_prefs (user_id, checked_until)
  select distinct user_id, until from (
    select user_id from public.watches union select user_id from public.searches
  ) x where not (user_id = any(skip))
  on conflict (user_id) do update set checked_until = excluded.checked_until;
$$;
revoke execute on function public.alerts_mark(timestamptz, uuid[]) from public, anon, authenticated;

-- Harmonogram: co 10 minut (przesunięte o 5 min względem refresh) — funkcja sama wybiera wyszukiwania
-- sprawdzane dawniej niż 4 h, więc nowe ogłoszenia są wykrywane kilka razy dziennie.
select cron.schedule(
  'cenomierz-searches',
  '5-59/10 * * * *',
  $$
  select net.http_post(
    url := 'https://kkduvothshtywldnuspe.supabase.co/functions/v1/searches',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
