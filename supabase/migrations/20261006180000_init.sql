-- Cenomierz: ogłoszenia (wspólne), historia cen (wspólna), obserwacje (per użytkownik).
-- Zapis do ads / price_points / vca_rows / app_meta tylko przez funkcje serwerowe (service role).

create table public.ads (
  key          text primary key,                 -- identyfikator ogłoszenia z adresu (…-ID6IgTqr.html → 6IgTqr)
  url          text not null,
  title        text,
  image        text,
  features     jsonb not null default '[]',
  location     text,
  currency     text not null default 'PLN',
  specs        jsonb,
  official     jsonb,                            -- dopasowane oficjalne WLTP (VCA)
  status       text,
  removed_at   timestamptz,
  last_checked timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);

create table public.price_points (
  ad_key text not null references public.ads(key) on delete cascade,
  t      timestamptz not null default now(),
  price  numeric not null,
  primary key (ad_key, t)
);

create table public.watches (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ad_key      text not null references public.ads(key) on delete cascade,
  added_at    timestamptz not null default now(),
  wltp_manual integer check (wltp_manual between 30 and 1500),
  primary key (user_id, ad_key)
);
create index watches_ad_key_idx on public.watches(ad_key);

create table public.vca_rows (
  id    serial primary key,
  mfr   text not null,
  model text not null,
  descr text not null,
  ps    numeric,
  range numeric not null,
  city  numeric,
  whkm  numeric
);

create table public.app_meta (
  key   text primary key,
  value jsonb not null
);

alter table public.ads          enable row level security;
alter table public.price_points enable row level security;
alter table public.watches      enable row level security;
alter table public.vca_rows     enable row level security;
alter table public.app_meta     enable row level security;

-- Użytkownik widzi tylko ogłoszenia, które sam obserwuje (nie widać, co obserwują inni).
create policy "ads: own watched" on public.ads for select to authenticated
  using (exists (select 1 from public.watches w where w.ad_key = ads.key and w.user_id = auth.uid()));

create policy "prices: own watched" on public.price_points for select to authenticated
  using (exists (select 1 from public.watches w where w.ad_key = price_points.ad_key and w.user_id = auth.uid()));

-- Obserwacje: pełna kontrola tylko nad własnymi. Dodanie wymaga, by ogłoszenie już istniało
-- (tworzy je funkcja add-listings), co pozwala też przywrócić usunięte („Cofnij”).
create policy "watches: select own" on public.watches for select to authenticated using (user_id = auth.uid());
create policy "watches: insert own" on public.watches for insert to authenticated with check (user_id = auth.uid());
create policy "watches: update own" on public.watches for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "watches: delete own" on public.watches for delete to authenticated using (user_id = auth.uid());

create policy "meta: read" on public.app_meta for select to authenticated using (true);
-- vca_rows: brak polityk → tylko funkcje serwerowe

grant select on public.ads, public.price_points, public.app_meta to authenticated;
grant select, insert, update, delete on public.watches to authenticated;
revoke all on public.ads, public.price_points, public.watches, public.vca_rows, public.app_meta from anon;

-- Ogłoszenia do odświeżenia: obserwowane, sprawdzane dawniej niż 20 h, pomijając dawno usunięte.
create or replace function public.ads_due(max_rows int default 25, min_age interval default interval '20 hours')
returns setof public.ads
language sql stable security definer set search_path = public as $$
  select a.* from public.ads a
  where exists (select 1 from public.watches w where w.ad_key = a.key)
    and (a.last_checked is null or a.last_checked < now() - min_age)
    and not (a.status = 'REMOVED' and a.removed_at < now() - interval '7 days')
  order by a.last_checked nulls first
  limit max_rows;
$$;
revoke execute on function public.ads_due(int, interval) from public, anon, authenticated;
