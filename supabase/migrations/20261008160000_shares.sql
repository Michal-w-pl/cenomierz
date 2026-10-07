-- Udostępnianie porównania: link tylko do podglądu (bez logowania) z wybranymi ogłoszeniami użytkownika.
-- Podgląd czyta dane przez funkcję share (service role) — tabela nie jest dostępna dla anon.

create table public.shares (
  id         text primary key default encode(extensions.gen_random_bytes(8), 'hex'),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ad_keys    text[] not null check (cardinality(ad_keys) between 1 and 12),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);
create index shares_user_idx on public.shares(user_id);

alter table public.shares enable row level security;
create policy "shares: select own" on public.shares for select to authenticated using (user_id = auth.uid());
-- można udostępnić tylko ogłoszenia, które samemu się obserwuje
create policy "shares: insert own" on public.shares for insert to authenticated
  with check (user_id = auth.uid()
    and not exists (select 1 from unnest(ad_keys) k where not exists (
      select 1 from public.watches w where w.user_id = auth.uid() and w.ad_key = k)));
create policy "shares: delete own" on public.shares for delete to authenticated using (user_id = auth.uid());
grant select, delete on public.shares to authenticated;
grant insert (ad_keys) on public.shares to authenticated;
revoke all on public.shares from anon;
