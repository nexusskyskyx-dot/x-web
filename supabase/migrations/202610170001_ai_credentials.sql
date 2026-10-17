-- Encrypted account-owned AI credentials for answer synthesis.
-- Apply after 202610160002_provider_credentials.sql.

create table if not exists public.ai_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'groq')),
  model text not null,
  encrypted_key text not null,
  iv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists ai_credentials_user_idx on public.ai_credentials (user_id);
alter table public.ai_credentials enable row level security;
revoke all on public.ai_credentials from anon, authenticated;
grant all on public.ai_credentials to service_role;
