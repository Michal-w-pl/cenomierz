-- Ustawienia użytkownika zapisywane na koncie (te same na telefonie i komputerze), np. parametry kosztów jazdy.

create table public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}' check (pg_column_size(data) < 8192),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
create policy "settings: select own" on public.user_settings for select to authenticated using (user_id = auth.uid());
create policy "settings: insert own" on public.user_settings for insert to authenticated with check (user_id = auth.uid());
create policy "settings: update own" on public.user_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.user_settings to authenticated;
revoke all on public.user_settings from anon;
