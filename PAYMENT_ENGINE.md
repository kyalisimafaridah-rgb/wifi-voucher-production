# WiFi Voucher Payment Engine

## What is implemented
- Payment intents with idempotency keys and explicit states.
- Immutable provider-event records.
- Atomic payment confirmation that activates the owner's subscription in the same database transaction.
- Customer checkout UI for MTN/Airtel merchant payments.
- Existing Mobile Money SMS matching now confirms a matching payment intent when one exists.
- Admin Payments view includes payment intents as well as legacy SMS events.

## Current collection mode
The checkout is currently merchant-manual: the customer chooses MTN or Airtel, the system creates a payment intent and shows the configured merchant number, amount and reference. A legitimate merchant confirmation is still required before access is activated.

## Required production configuration
Set these Render environment variables after obtaining legitimate merchant accounts:

- MOMO_MTN_MERCHANT_NUMBER
- MOMO_AIRTEL_MERCHANT_NUMBER
- SUBSCRIPTION_PRICE_UGX
- SUBSCRIPTION_PERIOD_DAYS (default 30)

Do not put personal collection numbers in the app as a workaround. Use a merchant/business account that the provider permits for receiving business payments.

## Next provider integration phase
1. MTN RequestToPay adapter using official integration credentials.
2. Airtel collection adapter using official developer credentials.
3. Provider webhook/signature verification.
4. Provider transaction-status reconciliation before activation.
5. Idempotent retry handling and automatic expiry.
6. Refund/dispute workflows and customer receipts.

## Regulatory boundary
WiFi Voucher is a software layer for collecting payment for its own subscription. It must not be turned into a payment processor, wallet, or money-transfer service for other businesses without the required regulatory authorization or a licensed partner.