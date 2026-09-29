-- Adaptive RouterOS cloud agent
create table if not exists public.router_agents (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  router_id uuid not null unique references public.routers(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'offline' check (status in ('online','offline')),
  routeros_version text,
  architecture text,
  board_name text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists router_agents_owner_idx on public.router_agents(owner_id);
create index if not exists router_agents_status_idx on public.router_agents(status);

create table if not exists public.router_agent_commands (
  id uuid primary key default uuid_generate_v4(),
  agent_id uuid not null references public.router_agents(id) on delete cascade,
  operation text not null check (operation in ('test','create_users','delete_users','usage')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','expired')),
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index if not exists router_agent_commands_poll_idx on public.router_agent_commands(agent_id,status,created_at);

alter table public.router_agents enable row level security;
alter table public.router_agent_commands enable row level security;

drop policy if exists "Owners can view own router agents" on public.router_agents;
create policy "Owners can view own router agents" on public.router_agents for select using (auth.uid() = owner_id);

drop policy if exists "Owners can manage own router agents" on public.router_agents;
create policy "Owners can manage own router agents" on public.router_agents for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "Owners can view own router agent commands" on public.router_agent_commands;
create policy "Owners can view own router agent commands" on public.router_agent_commands for select
using (exists (select 1 from public.router_agents a where a.id = router_agent_commands.agent_id and a.owner_id = auth.uid()));

revoke all on public.router_agents from anon, authenticated;
revoke all on public.router_agent_commands from anon, authenticated;
grant select on public.router_agents to authenticated;
grant select on public.router_agent_commands to authenticated;

create or replace function public.set_router_agent_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql security definer set search_path = public;
revoke execute on function public.set_router_agent_updated_at() from public, anon, authenticated;
drop trigger if exists router_agents_updated_at on public.router_agents;
create trigger router_agents_updated_at before update on public.router_agents
for each row execute procedure public.set_router_agent_updated_at();

alter table public.routers add column if not exists connection_mode text not null default 'direct';
