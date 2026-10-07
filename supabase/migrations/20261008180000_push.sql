-- Powiadomienia push (Web Push): subskrypcje urządzeń. Zapis i odczyt tylko przez funkcję push (service role).

create table public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used  timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
-- brak polityk → dostęp tylko z funkcji serwerowych
revoke all on public.push_subscriptions from anon, authenticated;
