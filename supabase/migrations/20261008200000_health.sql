-- Kontrola działania (co godzinę): czy ogłoszenia się odświeżają, czy Otomoto nie zmieniło strony,
-- czy zadania pg_cron i wywołania funkcji kończą się sukcesem. Funkcja health wysyła mail/push
-- do administratora tylko przy nowym problemie, codziennym przypomnieniu i po naprawie.

create table public.health_state (
  id          int primary key default 1 check (id = 1),
  codes       text[] not null default '{}',   -- kody problemów z ostatniego sprawdzenia
  notified_at timestamptz                      -- kiedy ostatnio wysłano powiadomienie o problemach
);
insert into public.health_state default values;
alter table public.health_state enable row level security;
revoke all on public.health_state from anon, authenticated;

-- Lista bieżących problemów: [{ code, title, detail }]. Pusta tablica = wszystko działa.
create or replace function public.health_check()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  out jsonb := '[]'::jsonb;
  n int; m int; s text;
begin
  -- Obserwowane, aktywne ogłoszenia niesprawdzane od ponad 30 h (odświeżanie co ~20 h) → refresh nie działa.
  select count(*), string_agg(distinct coalesce(a.title, a.key), ', ')
    into n, s
    from public.ads a
   where a.status is distinct from 'REMOVED'
     and exists (select 1 from public.watches w where w.ad_key = a.key)
     and (a.last_checked is null or a.last_checked < now() - interval '30 hours');
  if n > 0 then
    out := out || jsonb_build_object('code', 'stale', 'title', format('%s ogłoszeń nie odświeżono od ponad 30 h', n), 'detail', left(s, 300));
  end if;

  -- Błędy pobierania przy ostatnim sprawdzeniu (np. Otomoto zmieniło stronę). Pojedynczy błąd to zwykle przypadek.
  select count(*), string_agg(distinct a.last_error, ' | ')
    into n, s
    from public.ads a
   where a.last_error is not null and a.status is distinct from 'REMOVED'
     and exists (select 1 from public.watches w where w.ad_key = a.key);
  select count(*) into m from public.ads a
   where a.status is distinct from 'REMOVED' and exists (select 1 from public.watches w where w.ad_key = a.key);
  if n >= 3 or (n > 0 and n * 10 >= m) then
    out := out || jsonb_build_object('code', 'errors', 'title', format('%s z %s ogłoszeń: błąd pobierania z Otomoto', n, m), 'detail', left(s, 300));
  end if;

  -- Zapisane wyszukiwania: błąd albo brak sprawdzenia od 12 h (sprawdzane co ~4 h).
  select count(*), string_agg(distinct coalesce(x.last_error, 'nie sprawdzano od ' || to_char(x.last_checked at time zone 'Europe/Warsaw', 'DD.MM HH24:MI')), ' | ')
    into n, s
    from public.searches x
   where x.last_error is not null
      or (x.created_at < now() - interval '12 hours' and (x.last_checked is null or x.last_checked < now() - interval '12 hours'));
  if n > 0 then
    out := out || jsonb_build_object('code', 'searches', 'title', format('%s wyszukiwań z problemem', n), 'detail', left(s, 300));
  end if;

  -- Próbki rynku dla obserwowanych ogłoszeń starsze niż 5 dni (odnawiane po 3 dniach) → funkcja market nie działa.
  select count(distinct a.market_url) into n
    from public.ads a
    join public.market_samples ms on ms.url = a.market_url
   where a.status is distinct from 'REMOVED'
     and exists (select 1 from public.watches w where w.ad_key = a.key)
     and ms.fetched_at < now() - interval '5 days';
  if n > 0 then
    out := out || jsonb_build_object('code', 'market', 'title', format('%s próbek rynku nieodświeżonych od 5 dni', n), 'detail', '');
  end if;

  -- Nieudane uruchomienia zadań pg_cron w ostatniej dobie.
  select count(*), string_agg(distinct j.jobname || ': ' || left(coalesce(d.return_message, d.status), 120), ' | ')
    into n, s
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
   where d.start_time > now() - interval '24 hours' and d.status not in ('succeeded', 'running', 'starting');
  if n > 0 then
    out := out || jsonb_build_object('code', 'cron', 'title', format('%s nieudanych uruchomień zadań', n), 'detail', left(s, 300));
  end if;

  -- Wywołania funkcji (pg_net, historia z ok. 6 h) z błędem HTTP lub przekroczonym czasem. Jeden błąd pomijamy.
  select count(*), string_agg(distinct coalesce(r.error_msg, r.status_code::text || ' ' || left(r.content::text, 120)), ' | ')
    into n, s
    from net._http_response r
   where r.created > now() - interval '6 hours'
     and (r.error_msg is not null or r.status_code is null or r.status_code >= 300);
  if n >= 2 then
    out := out || jsonb_build_object('code', 'http', 'title', format('%s nieudanych wywołań funkcji w ostatnich 6 h', n), 'detail', left(s, 300));
  end if;

  return out;
end;
$$;
revoke execute on function public.health_check() from public, anon, authenticated;

-- Id użytkownika po adresie e-mail (do wysłania push administratorowi).
create or replace function public.user_id_by_email(addr text)
returns uuid
language sql stable security definer set search_path = public as $$
  select id from auth.users where lower(email) = lower(addr) limit 1;
$$;
revoke execute on function public.user_id_by_email(text) from public, anon, authenticated;

select cron.schedule(
  'cenomierz-health',
  '50 * * * *',
  $$
  select net.http_post(
    url := 'https://kkduvothshtywldnuspe.supabase.co/functions/v1/health',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
