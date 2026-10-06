-- Harmonogram: co 10 minut funkcja refresh odświeża porcję ogłoszeń sprawdzanych dawniej niż 20 h
-- (każde ogłoszenie ~raz na dobę) i raz na 30 dni pobiera oficjalne dane WLTP. Wywołanie jest idempotentne.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'cenomierz-refresh',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://kkduvothshtywldnuspe.supabase.co/functions/v1/refresh',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
