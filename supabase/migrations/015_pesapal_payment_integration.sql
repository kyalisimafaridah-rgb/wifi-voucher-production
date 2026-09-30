-- PesaPal API 3.0 payment integration.
-- Extends the existing hardened payment confirmation path.

alter table public.payment_intents
  drop constraint if exists payment_intents_provider_check;
alter table public.payment_intents
  add constraint payment_intents_provider_check
  check (provider in ('mtn','airtel','manual','pesapal'));

alter table public.payment_events
  drop constraint if exists payment_events_provider_check;
alter table public.payment_events
  add constraint payment_events_provider_check
  check (provider in ('mtn','airtel','manual','pesapal'));

create or replace function public.confirm_payment_intent(
  p_intent_id uuid,
  p_provider text,
  p_amount_ugx integer,
  p_provider_transaction_id text,
  p_provider_event_id text default null,
  p_event_type text default 'payment.confirmed',
  p_signature_valid boolean default null,
  p_payload jsonb default '{}'::jsonb,
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

  if p_provider not in ('mtn','airtel','manual','pesapal') then
    raise exception 'Invalid payment provider';
  end if;

  if p_amount_ugx is null or p_amount_ugx < 1 then
    raise exception 'Invalid payment amount';
  end if;

  if p_provider_transaction_id is null or length(trim(p_provider_transaction_id)) < 3 then
    raise exception 'Provider transaction ID is required';
  end if;

  select * into v_intent
  from payment_intents
  where id = p_intent_id
  for update;

  if not found then
    raise exception 'Payment intent not found';
  end if;

  if v_intent.provider <> p_provider or v_intent.amount_ugx <> p_amount_ugx then
    raise exception 'Payment confirmation does not match the original intent';
  end if;

  if v_intent.status = 'succeeded' then
    if v_intent.provider_transaction_id is not null
       and v_intent.provider_transaction_id <> p_provider_transaction_id then
      raise exception 'Payment confirmation transaction does not match the recorded transaction';
    end if;

    select o.subscription_paid_until into v_paid_until
    from owners o where o.id = v_intent.owner_id;

    return query select true, v_intent.owner_id, v_paid_until, v_intent.status;
    return;
  end if;

  if v_intent.status in ('cancelled','refunded','disputed','failed','expired') then
    raise exception 'Payment intent cannot be confirmed from status %', v_intent.status;
  end if;

  if v_intent.expires_at <= now() then
    update payment_intents set status='expired', updated_at=now() where id=p_intent_id;
    raise exception 'Payment intent has expired';
  end if;

  select * into v_owner from owners where id = v_intent.owner_id for update;
  if not found then raise exception 'Owner not found'; end if;

  v_base := greatest(coalesce(v_owner.subscription_paid_until, now()), now());
  v_paid_until := v_base + make_interval(days => p_period_days);

  update owners
    set subscription_status='active',
        subscription_paid_until=v_paid_until,
        trial_ends_at=null,
        updated_at=now()
    where id=v_intent.owner_id;

  update payment_intents
    set status='succeeded',
        provider_transaction_id=p_provider_transaction_id,
        confirmed_at=now(),
        updated_at=now()
    where id=p_intent_id;

  begin
    insert into payment_events (
      payment_intent_id, provider, provider_event_id, event_type, status,
      amount_ugx, currency, provider_transaction_id, signature_valid, payload
    ) values (
      p_intent_id, p_provider, p_provider_event_id, p_event_type, 'succeeded',
      p_amount_ugx, 'UGX', p_provider_transaction_id, p_signature_valid,
      coalesce(p_payload, '{}'::jsonb)
    );
  exception when unique_violation then
    if p_provider_event_id is not null and exists (
      select 1 from payment_events
      where provider=p_provider and provider_event_id=p_provider_event_id
        and payment_intent_id=p_intent_id
    ) then
      null;
    else
      raise;
    end if;
  end;

  return query select true, v_intent.owner_id, v_paid_until, 'succeeded'::text;
end;
$$;

revoke all on function public.confirm_payment_intent(uuid,text,integer,text,text,text,boolean,jsonb,integer)
  from public, anon, authenticated;
grant execute on function public.confirm_payment_intent(uuid,text,integer,text,text,text,boolean,jsonb,integer)
  to service_role;
