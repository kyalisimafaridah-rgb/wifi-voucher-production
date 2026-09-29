-- Allow Cloud Agent-managed routers to be created before the product knows
-- the router's address or API credentials. The agent identifies the router
-- and reports RouterOS/hardware/network reachability after bootstrap.
alter table public.routers alter column host drop not null;
alter table public.routers alter column api_username drop not null;
alter table public.routers alter column api_password_encrypted drop not null;
