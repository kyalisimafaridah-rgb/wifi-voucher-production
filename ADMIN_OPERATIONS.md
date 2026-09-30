# Admin operations runbook

The admin console is the operator control center for WiFi Voucher.

## Daily workflow

1. Open **Overview** and check expired customers, unreachable routers, unresolved Mobile Money events, and failed agent commands.
2. Open **Customers** for account-level work. Search by email/name, open the customer, inspect routers/payments, and renew or expire the subscription.
3. Open **Routers** to diagnose connection mode, RouterOS version, agent heartbeat and last-seen time.
4. Open **Payments** to inspect matched, unmatched, ambiguous, duplicate and parse-failed Mobile Money events.
5. Open **Health** when a customer reports a router problem. Check agent status, last error, command failures and problem routers.
6. Use **Audit log** to verify subscription changes made by administrators.

## Subscription rules

- `trial` is shown as expired when the trial end timestamp has passed, even if the stored status has not yet been normalized.
- `active` access can be extended with a number of days. Extension continues from the existing paid-until date when that date is still in the future.
- `expired` is an explicit operator state.
- Subscription changes from the admin console are recorded in `admin_audit_logs`.

## Security

- Admin API routes require a valid Supabase access token for an owner with `role=admin`, or the server-side `X-Admin-Secret` path used for operational scripts.
- Browser clients never receive the Supabase service-role key.
- Admin audit logs are service-role-only.
- Router credentials and agent tokens are not exposed in the admin lists.
- Payment records shown in the console are operational records; raw SMS bodies remain outside the admin UI.

## Important operational limitation

The console reports RouterOS agent state from heartbeats. It does not prove that a physical router is healthy in every respect. Physical MikroTik test coverage is still required before promising universal compatibility.