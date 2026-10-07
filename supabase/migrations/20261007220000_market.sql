-- Porównanie z rynkiem: dla obserwowanych ogłoszeń funkcja market pobiera próbkę podobnych ofert z Otomoto
-- (ta sama marka, model i paliwo, rocznik ±1). Próbka jest wspólna dla wszystkich ogłoszeń o tym samym adresie
-- wyszukiwania; panel sam wybiera z niej auta o zbliżonej mocy i przebiegu.

alter table public.ads add column market_url text;

create table public.market_samples (
  url        text primary key,
  fetched_at timestamptz not null default now(),
  total      integer,
  hits       jsonb not null default '[]'   -- [{k, u, t, p, c, y, m, pw}] — klucz, link, tytuł, cena, waluta, rocznik, przebieg, moc
);

alter table public.market_samples enable row level security;
-- dane publiczne z Otomoto, bez informacji o użytkownikach
create policy "market: read" on public.market_samples for select to authenticated using (true);
grant select on public.market_samples to authenticated;
revoke all on public.market_samples from anon;

-- Co godzinę (o :20) funkcja market odświeża próbki starsze niż 3 dni — porcjami, w limicie czasu.
select cron.schedule(
  'cenomierz-market',
  '20 * * * *',
  $$
  select net.http_post(
    url := 'https://kkduvothshtywldnuspe.supabase.co/functions/v1/market',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
