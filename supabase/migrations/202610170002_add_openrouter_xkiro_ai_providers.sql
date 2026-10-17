-- Permit additional OpenAI-compatible BYOK gateways for AI answer synthesis.
alter table public.ai_credentials
  drop constraint if exists ai_credentials_provider_check;

alter table public.ai_credentials
  add constraint ai_credentials_provider_check
  check (provider in ('openai', 'anthropic', 'groq', 'openrouter', 'xkiro'));
