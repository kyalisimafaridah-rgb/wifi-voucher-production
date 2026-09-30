import crypto from 'crypto';
import { supabase } from '../db/supabase.js';
import { createPesapalOrder, isPesapalConfigured } from './pesapal.js';

const PRICE = Number(process.env.SUBSCRIPTION_PRICE_UGX || 0);
const PERIOD_DAYS = Number(process.env.SUBSCRIPTION_PERIOD_DAYS || 30);

function merchantNumber(provider) {
  return provider === 'mtn'
    ? String(process.env.MOMO_MTN_MERCHANT_NUMBER || '').trim()
    : provider === 'airtel'
      ? String(process.env.MOMO_AIRTEL_MERCHANT_NUMBER || '').trim()
      : '';
}

function makeReference() {
  return 'WV-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

export function paymentOptions() {
  return [
    { provider: 'pesapal', configured: isPesapalConfigured(), merchant_number: null, mode: 'pesapal_checkout' },
    ...['mtn', 'airtel'].map((provider) => ({
      provider,
      configured: Boolean(merchantNumber(provider)),
      merchant_number: merchantNumber(provider),
      mode: 'merchant_manual',
    })),
  ];
}

export async function createPaymentIntent({ ownerId, provider, payerPhone, idempotencyKey }) {
  if (!PRICE || PRICE < 1) throw new Error('Subscription price is not configured');
  if (!['mtn', 'airtel', 'pesapal'].includes(provider)) throw new Error('Unsupported payment provider');
  if (provider !== 'pesapal' && !merchantNumber(provider)) {
    throw new Error(provider.toUpperCase() + ' merchant payments are not configured yet');
  }
  if (provider === 'pesapal' && !isPesapalConfigured()) {
    throw new Error('PesaPal checkout is not configured yet');
  }
  if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('A valid idempotency key is required');

  const { data: existing } = await supabase
    .from('payment_intents')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing) return existing;

  const { data: owner, error: ownerError } = await supabase
    .from('owners')
    .select('id,email,full_name')
    .eq('id', ownerId)
    .maybeSingle();
  if (ownerError) throw new Error('Could not load account for payment: ' + ownerError.message);
  if (!owner?.email) throw new Error('A valid account email is required for payment');

  const { data, error } = await supabase.from('payment_intents').insert({
    owner_id: ownerId,
    provider,
    amount_ugx: PRICE,
    payer_phone: payerPhone || null,
    merchant_reference: makeReference(),
    idempotency_key: idempotencyKey,
    status: 'pending',
    metadata: { collection_mode: provider === 'pesapal' ? 'pesapal_checkout' : 'merchant_manual' },
  }).select('*').single();

  if (error) {
    if (error.code === '23505') {
      const { data: raced } = await supabase.from('payment_intents').select('*')
        .eq('owner_id', ownerId).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (raced) return raced;
    }
    throw new Error('Could not create payment intent: ' + error.message);
  }

  if (provider === 'pesapal') {
    try {
      const checkout = await createPesapalOrder({
        merchantReference: data.merchant_reference,
        amountUgx: data.amount_ugx,
        email: owner.email,
        phone: payerPhone,
        fullName: owner.full_name,
      });

      const metadata = {
        ...(data.metadata || {}),
        collection_mode: 'pesapal_checkout',
        redirect_url: checkout.redirect_url,
        order_tracking_id: checkout.order_tracking_id,
        pesapal_merchant_reference: checkout.merchant_reference,
      };

      const { data: updated, error: updateError } = await supabase.from('payment_intents')
        .update({
          provider_transaction_id: checkout.order_tracking_id,
          metadata,
          status: 'pending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', data.id).select('*').single();

      if (updateError) throw new Error('Could not save PesaPal checkout: ' + updateError.message);
      return updated;
    } catch (error) {
      await supabase.from('payment_intents').update({
        status: 'failed',
        failure_code: 'PESAPAL_ORDER_CREATE_FAILED',
        failure_message: String(error.message || 'PesaPal checkout could not be created').slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq('id', data.id);
      throw error;
    }
  }

  return data;
}

export async function getPaymentIntent(ownerId, id) {
  const { data, error } = await supabase.from('payment_intents').select('*')
    .eq('id', id).eq('owner_id', ownerId).maybeSingle();
  if (error) throw new Error('Could not load payment: ' + error.message);
  return data;
}

export async function cancelPaymentIntent(ownerId, id) {
  const { data, error } = await supabase.from('payment_intents').update({
    status: 'cancelled', updated_at: new Date().toISOString(),
  }).eq('id', id).eq('owner_id', ownerId)
    .in('status', ['created', 'pending', 'processing']).select('*').maybeSingle();
  if (error) throw new Error('Could not cancel payment: ' + error.message);
  return data;
}

export async function confirmPaymentIntent(id, providerTransactionId, eventPayload = {}) {
  const provider = eventPayload.provider || 'manual';
  const amountUgx = Number(eventPayload.amountUgx);
  if (!Number.isInteger(amountUgx) || amountUgx < 1) throw new Error('A valid payment amount is required');

  const { data, error } = await supabase.rpc('confirm_payment_intent', {
    p_intent_id: id,
    p_provider: provider,
    p_amount_ugx: amountUgx,
    p_provider_transaction_id: providerTransactionId || null,
    p_provider_event_id: eventPayload.providerEventId || null,
    p_event_type: eventPayload.eventType || 'payment.confirmed',
    p_signature_valid: eventPayload.signatureValid ?? null,
    p_payload: eventPayload.payload || {},
    p_period_days: PERIOD_DAYS,
  });
  if (error) throw new Error('Could not confirm payment: ' + error.message);
  return data?.[0] || null;
}

export { PRICE, PERIOD_DAYS, merchantNumber };
