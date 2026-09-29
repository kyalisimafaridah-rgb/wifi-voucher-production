-- Remote MikroTik connector support
create table if not exists public.connector_devices (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  router_id uuid not null unique references public.routers(id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  status text not null default 'offline' check (status in ('online','offline')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists connector_devices_owner_idx on public.connector_devices(owner_id);
create index if not exists connector_devices_status_idx on public.connector_devices(status);

alter table public.routers
  add column if not exists connection_mode text not null default 'direct'
    check (connection_mode in ('direct','connector'));

alter table public.connector_devices enable row level security;

drop policy if exists "Owners can view own connector devices" on public.connector_devices;
create policy "Owners can view own connector devices"
  on public.connector_devices for select
  using (auth.uid() = owner_id);

drop policy if exists "Owners can manage own connector devices" on public.connector_devices;
create policy "Owners can manage own connector devices"
  on public.connector_devices for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create or replace function public.set_connector_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists connector_devices_updated_at on public.connector_devices;
create trigger connector_devices_updated_at
before update on public.connector_devices
for each row execute procedure public.set_connector_updated_at();

revoke all on public.connector_devices from anon, authenticated;
grant select on public.connector_devices to authenticated;
