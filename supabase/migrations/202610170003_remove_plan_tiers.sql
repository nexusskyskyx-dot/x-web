-- x-web has no account tiers or billing. Drop the unused plan column from
-- databases where the original account migration has already been applied.
alter table public.profiles
  drop constraint if exists profiles_plan_check;

alter table public.profiles
  drop column if exists plan;
