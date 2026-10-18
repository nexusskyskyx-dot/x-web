-- Firecrawl keys are encrypted by x-web before being stored. They are used
-- only for caller-requested deep DOM scraping and never as search/AI keys.
create table if not exists public.scraper_credentials (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  encrypted_key text not null,
  iv text not null,
  updated_at timestamptz not null default now()
);

alter table public.scraper_credentials enable row level security;
revoke all on public.scraper_credentials from anon, authenticated;
grant all on public.scraper_credentials to service_role;
