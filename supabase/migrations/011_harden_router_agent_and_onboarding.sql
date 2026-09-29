-- Harden RouterOS cloud agent lifecycle and make onboarding resumable.
alter table public.router_agents
  add column if not exists agent_version text,
  add column if not exists last_ip text,
  add column if not exists last_error_at timestamptz,
  add column if not exists last_error text,
  add column if not exists revoked_at timestamptz,
  add column if not exists token_version integer not null default 1;

alter table public.router_agent_commands
  add column if not exists expires_at timestamptz,
  add column if not exists claimed_at timestamptz;

create index if not exists router_agents_last_seen_idx on public.router_agents(last_seen_at);
create index if not exists router_agent_commands_expiry_idx on public.router_agent_commands(status, expires_at);

alter table public.routers add column if not exists onboarding_key text;
create unique index if not exists routers_owner_onboarding_key_uidx
  on public.routers(owner_id, onboarding_key) where onboarding_key is not null;
