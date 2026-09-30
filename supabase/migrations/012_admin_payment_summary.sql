-- Admin payment aggregates. Kept server-side; browser clients get no execute privilege.
create or replace function public.admin_payment_summary()
returns table (
  matched_count bigint,
  matched_amount_ugx numeric,
  matched_30d_count bigint,
  matched_30d_amount_ugx numeric,
  pending_review_count bigint
)
language sql
security definer
set search_path = public
as $$
  select
    count(*) filter (where status = 'matched')::bigint,
    coalesce(sum(parsed_amount_ugx) filter (where status = 'matched'), 0)::numeric,
    count(*) filter (where status = 'matched' and created_at >= now() - interval '30 days')::bigint,
    coalesce(sum(parsed_amount_ugx) filter (where status = 'matched' and created_at >= now() - interval '30 days'), 0)::numeric,
    count(*) filter (where status in ('ambiguous','no_match','parse_failed'))::bigint
  from public.momo_events;
$$;
revoke all on function public.admin_payment_summary() from public, anon, authenticated;
grant execute on function public.admin_payment_summary() to service_role;
