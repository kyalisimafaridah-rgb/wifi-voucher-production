-- Admin operations, auditability, and router-agent health metadata.
-- Apply after the existing adaptive router-agent migrations.

alter table public.router_agents
  add column if not exists agent_version text,
  add column if not exists last_ip inet,
  add column if not exists last_error text,
  add column if not exists last_error_at timestamptz;

alter table public.router_agent_commands
  add column if not exists expires_at timestamptz,
  add column if not exists claimed_at timestamptz;

create index if not exists router_agents_last_seen_idx
  on public.router_agents(status, last_seen_at desc);

create index if not exists router_agent_commands_expiry_idx
  on public.router_agent_commands(status, expires_at);

create table if not exists public.admin_audit_logs (
  id uuid primary key default uuid_generate_v4(),
  admin_id uuid references public.owners(id) on delete set null,
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_idx
  on public.admin_audit_logs(created_at desc);

create index if not exists admin_audit_logs_target_idx
  on public.admin_audit_logs(target_type, target_id, created_at desc);

alter table public.admin_audit_logs enable row level security;
revoke all on public.admin_audit_logs from anon, authenticated;

-- Only the service-role backend writes/reads the admin audit trail.
-- Do not grant this table to browser clients.
