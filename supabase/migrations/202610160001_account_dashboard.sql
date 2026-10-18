-- x-web account foundation: profiles, hashed API keys, and API usage history.
-- Apply this migration to the Supabase project before enabling account APIs.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 48),
  prefix text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_user_active_idx on public.api_keys (user_id, created_at desc) where revoked_at is null;
create index if not exists api_keys_prefix_active_idx on public.api_keys (prefix) where revoked_at is null;

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  api_key_id uuid references public.api_keys(id) on delete set null,
  endpoint text not null,
  provider text not null,
  result_count integer not null default 0 check (result_count >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  created_at timestamptz not null default now()
);
create index if not exists usage_events_user_created_idx on public.usage_events (user_id, created_at desc);

create or replace function public.handle_new_xweb_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles as p (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', '')
    )
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(p.full_name, excluded.full_name),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_xweb on auth.users;
create trigger on_auth_user_created_xweb
after insert on auth.users
for each row execute procedure public.handle_new_xweb_user();

alter table public.profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.usage_events enable row level security;

drop policy if exists "Users can read their own x-web profile" on public.profiles;
create policy "Users can read their own x-web profile"
  on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Users can update their own x-web display name" on public.profiles;
create policy "Users can update their own x-web display name"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- The browser must never be able to read key hashes or write/revoke keys directly.
revoke all on public.api_keys from anon, authenticated;
-- The account server uses the service role to manage keys and write usage records.
revoke insert, update, delete on public.usage_events from anon, authenticated;
grant select on public.usage_events to authenticated;
drop policy if exists "Users can read their own x-web usage" on public.usage_events;
create policy "Users can read their own x-web usage"
  on public.usage_events for select to authenticated using ((select auth.uid()) = user_id);

-- Users may read their profile and edit only their display name.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant all on public.profiles, public.api_keys, public.usage_events to service_role;
