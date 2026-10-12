-- Powiadomienia push z ciszy nocnej (22–7). Zamiast przepadać, czekają tu na pierwsze odświeżanie po 7:00,
-- które wysyła je jednym zbiorczym powiadomieniem. Dostęp tylko z funkcji serwerowych.

create table public.push_queue (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  payload    jsonb not null,                -- { title, body, url?, tag? }
  created_at timestamptz not null default now()
);
create index push_queue_user_idx on public.push_queue(user_id, id);

alter table public.push_queue enable row level security;
-- brak polityk → dostęp tylko z funkcji serwerowych
revoke all on public.push_queue from anon, authenticated;
