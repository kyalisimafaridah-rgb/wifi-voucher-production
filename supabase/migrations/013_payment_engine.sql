-- Payment engine foundation: idempotent payment intents + immutable provider events.
create table if not exists public.payment_intents (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  provider text not null check (provider in ('mtn','airtel','manual')),
  amount_ugx integer not null check (amount_ugx > 0),
  currency text not null default 'UGX' check (currency = 'UGX'),
  payer_phone text,
  merchant_reference text not null unique,
  idempotency_key text not null,
  status text not null default 'created'
    check (status in ('created','pending','processing','succeeded','failed','expired','refunded','disputed','cancelled')),
  provider_transaction_id text,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create unique index if not exists payment_intents_owner_idempotency_idx
  on public.payment_intents(owner_id, idempotency_key);
create unique index if not exists payment_intents_provider_tx_idx
  on public.payment_intents(provider, provider_transaction_id)
  where provider_transaction_id is not null;
create index if not exists payment_intents_owner_created_idx
  on public.payment_intents(owner_id, created_at desc);
create index if not exists payment_intents_status_expires_idx
  on public.payment_intents(status, expires_at);

create table if not exists public.payment_events (
  id uuid primary key default uuid_generate_v4(),
  payment_intent_id uuid references public.payment_intents(id) on delete set null,
  provider text not null check (provider in ('mtn','airtel','manual')),
  provider_event_id text,
  event_type text not null,
  status text,
  amount_ugx integer,
  currency text,
  provider_transaction_id text,
  signature_valid boolean,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists payment_events_provider_event_idx
  on public.payment_events(provider, provider_event_id)
  where provider_event_id is not null;
create index if not exists payment_events_intent_idx
  on public.payment_events(payment_intent_id, created_at desc);

alter table public.payment_intents enable row level security;
alter table public.payment_events enable row level security;
revoke all on public.payment_intents from anon, authenticated;
revoke all on public.payment_events from anon, authenticated;

-- Atomic success path: mark one intent paid and extend the owner's subscription
-- in the same database transaction. Only service_role may execute it.
create or replace function public.confirm_payment_intent(
  p_intent_id uuid,
  p_provider_transaction_id text,
  p_period_days integer default 30
)
returns table (
  confirmed boolean,
  owner_id uuid,
  paid_until timestamptz,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intent payment_intents%rowtype;
  v_owner owners%rowtype;
  v_base timestamptz;
  v_paid_until timestamptz;
begin
  if p_period_days < 1 or p_period_days > 3650 then
    raise exception 'Invalid subscription period';
  end if;

  select * into v_intent
  from payment_intents
  where id = p_intent_id
  for update;

  if not found then
    raise exception 'Payment intent not found';
  end if;

  if v_intent.status = 'succeeded' then
    select o.subscription_paid_until into v_paid_until
    from owners o where o.id = v_intent.owner_id;
    return query select true, v_intent.owner_id, v_paid_until, v_intent.status;
    return;
  end if;

  if v_intent.status in ('cancelled','refunded','disputed') then
    raise exception 'Payment intent cannot be confirmed from status %', v_intent.status;
  end if;

  select * into v_owner from owners where id = v_intent.owner_id for update;
  if not found then
    raise exception 'Owner not found';
  end if;

  v_base := greatest(coalesce(v_owner.subscription_paid_until, now()), now());
  v_paid_until := v_base + make_interval(days => p_period_days);

  update owners
  set subscription_status = 'active',
      subscription_paid_until = v_paid_until,
      trial_ends_at = null,
      updated_at = now()
  where id = v_intent.owner_id;

  update payment_intents
  set status = 'succeeded',
      provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
      confirmed_at = now(),
      updated_at = now()
  where id = p_intent_id;

  return query select true, v_intent.owner_id, v_paid_until, 'succeeded'::text;
end;
$$;

revoke all on function public.confirm_payment_intent(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.confirm_payment_intent(uuid,text,integer) to service_role;
