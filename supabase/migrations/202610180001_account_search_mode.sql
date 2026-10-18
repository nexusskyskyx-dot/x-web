-- Persist each account's preferred search mode so connected API/MCP agents can
-- honor the Dashboard selection. Automatic uses x-web's lightweight query
-- intent heuristic to avoid Deep Research on routine lookups.
alter table public.profiles
  add column if not exists default_search_mode text not null default 'automatic'
  check (default_search_mode in ('automatic', 'standard', 'deep'));
