-- Optional semantic citation review is off by default for every account.
alter table public.profiles
  add column if not exists semantic_citation_check boolean not null default false;
