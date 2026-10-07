-- Historia próbek rynku: kopia każdej pobranej próbki (co ~3 dni na adres), żeby pokazać trend cen modelu.
-- Trzymamy tylko pola potrzebne do mediany podobnych ofert (cena, waluta, moc, przebieg).

create table public.market_history (
  url   text not null,
  t     timestamptz not null default now(),
  total integer,
  hits  jsonb not null default '[]',   -- [{p, c, pw, m}]
  primary key (url, t)
);

alter table public.market_history enable row level security;
create policy "market history: read" on public.market_history for select to authenticated using (true);
grant select on public.market_history to authenticated;
revoke all on public.market_history from anon;

-- pierwszy pomiar: obecne próbki
insert into public.market_history (url, t, total, hits)
select url, fetched_at, total,
       coalesce((select jsonb_agg(jsonb_build_object('p', h->'p', 'c', h->'c', 'pw', h->'pw', 'm', h->'m')) from jsonb_array_elements(hits) h), '[]')
from public.market_samples;
