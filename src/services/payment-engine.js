import crypto from 'crypto';
import { supabase } from '../db/supabase.js';

const PRICE = Number(process.env.SUBSCRIPTION_PRICE_UGX || 0);
const PERIOD_DAYS = Number(process.env.SUBSCRIPTION_PERIOD_DAYS || 30);

function merchantNumber(provider) {
  return provider === 'mtn'
    ? String(process.env.MOMO_MTN_MERCHANT_NUMBER || '').trim()
    : provider === 'airtel'
      ? String(process.env.MOMO_AIRTEL_MERCHANT_NUMBER || '').trim()
      : '';
}

function makeReference() { return 'WV-' + crypto.randomBytes(6).toString('hex').toUpperCase(); }

export function paymentOptions() {
  return ['mtn', 'airtel'].map((provider) => ({
    provider, configured: Boolean(merchantNumber(provider)),
    merchant_number: merchantNumber(provider), mode: 'merchant_manual',
  }));
}

export async function createPaymentIntent({ ownerId, provider, payerPhone, idempotencyKey }) {
  if (!PRICE || PRICE < 1) throw new Error('Subscription price is not configured');
  if (!['mtn', 'airtel'].includes(provider)) throw new Error('Unsupported payment provider');
  if (!merchantNumber(provider)) throw new Error(provider.toUpperCase() + ' merchant payments are not configured yet');
  if (!idempotencyKey || idempotencyKey.length > 128) throw new Error('A valid idempotency key is required');
  const { data: existing } = await supabase.from('payment_intents').select('*').eq('owner_id', ownerId).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase.from('payment_intents').insert({
    owner_id: ownerId, provider, amount_ugx: PRICE, payer_phone: payerPhone || null,
    merchant_reference: makeReference(), idempotency_key: idempotencyKey, status: 'pending',
    metadata: { collection_mode: 'merchant_manual' },
  }).select('*').single();
  if (!error) return data;
  if (error.code === '23505') {
    const { data: raced } = await supabase.from('payment_intents').select('*').eq('owner_id', ownerId).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (raced) return raced;
  }
  throw new Error('Could not create payment intent: ' + error.message);
}

export async function getPaymentIntent(ownerId, id) {
  const { data, error } = await supabase.from('payment_intents').select('*').eq('id', id).eq('owner_id', ownerId).maybeSingle();
  if (error) throw new Error('Could not load payment: ' + error.message);
  return data;
}

export async function cancelPaymentIntent(ownerId, id) {
  const { data, error } = await supabase.from('payment_intents').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id).eq('owner_id', ownerId).in('status', ['created', 'pending', 'processing']).select('*').maybeSingle();
  if (error) throw new Error('Could not cancel payment: ' + error.message);
  return data;
}

export async function confirmPaymentIntent(id, providerTransactionId, eventPayload = {}) {
  const provider = eventPayload.provider || 'manual';
  const amountUgx = Number(eventPayload.amountUgx);
  if (!Number.isInteger(amountUgx) || amountUgx < 1) {
    throw new Error('A valid payment amount is required');
  }

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