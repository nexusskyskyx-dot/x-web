-- Per-user search provider credentials, encrypted by x-web before they reach the database.
-- Run after 202610160001_account_dashboard.sql.

create table if not exists public.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('tavily', 'brave', 'serper', 'exa')),
  encrypted_key text not null,
  iv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists provider_credentials_user_idx
  on public.provider_credentials (user_id);

alter table public.provider_credentials enable row level security;
revoke all on public.provider_credentials from anon, authenticated;
grant all on public.provider_credentials to service_role;
