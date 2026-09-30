import { supabase } from '../db/supabase.js';
import { confirmPaymentIntent } from './payment-engine.js';

const SUBSCRIPTION_PRICE_UGX = Number(process.env.SUBSCRIPTION_PRICE_UGX || 0);

const POSTGRES_UNIQUE_VIOLATION = '23505';

export const momoStorageAdapter = {
  async findPendingPaymentsByAmount(amountUgx) {
    if (!SUBSCRIPTION_PRICE_UGX || amountUgx !== SUBSCRIPTION_PRICE_UGX) return [];

    const { data, error } = await supabase
      .from('owners')
      .select('id, momo_registered_name')
      .not('momo_registered_name', 'is', null);

    if (error) throw new Error(`findPendingPaymentsByAmount failed: ${error.message}`);

    return (data || []).map((owner) => ({
      id: owner.id,
      amountUgx: SUBSCRIPTION_PRICE_UGX,
      referenceText: owner.momo_registered_name,
    }));
  },

  async reserveEvent(params) {
    const { data, error } = await supabase
      .from('momo_events')
      .insert({
        transaction_id: params.transactionId,
        network: params.network,
        raw_body: params.rawBody,
        parsed_amount_ugx: params.parsedAmountUgx,
        parsed_reason_name: params.parsedReasonName,
        parsed_reason_phone: params.parsedReasonPhone,
      })
      .select('id')
      .single();

    if (!error) return { reserved: true, eventId: data.id };

    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      const { data: existing, error: lookupError } = await supabase
        .from('momo_events')
        .select('id')
        .eq('transaction_id', params.transactionId)
        .single();

      if (lookupError || !existing) {
        throw new Error(
          `reserveEvent: unique violation but could not find existing row for transaction ${params.transactionId}: ${lookupError?.message}`
        );
      }
      return { reserved: false, existingEventId: existing.id };
    }

    throw new Error(`reserveEvent failed: ${error.message}`);
  },

  async updateEventStatus(eventId, update) {
    const { error } = await supabase
      .from('momo_events')
      .update({
        status: update.status,
        matched_owner_id: update.matchedPaymentId ?? null,
        note: update.note ?? null,
      })
      .eq('id', eventId);

    if (error) throw new Error(`updateEventStatus failed: ${error.message}`);
  },

  async recordParseFailure(rawBody, network) {
    const { error } = await supabase.from('momo_events').insert({
      transaction_id: null,
      network,
      raw_body: rawBody,
      status: 'parse_failed',
    });

    if (error) throw new Error(`recordParseFailure failed: ${error.message}`);
  },

  async onPaymentMatched(payment, parsed) {
    const { data: intent, error } = await supabase
      .from('payment_intents')
      .select('id,provider,amount_ugx,status,expires_at,created_at')
      .eq('owner_id', payment.id)
      .eq('provider', parsed.network)
      .eq('amount_ugx', parsed.amountUgx)
      .in('status', ['created', 'pending', 'processing'])
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`onPaymentMatched: could not load payment intent: ${error.message}`);

    if (!intent) {
      // Never activate a subscription merely because an SMS resembles
      // a customer's payment. A real payment intent is required.
      return;
    }

    await confirmPaymentIntent(intent.id, parsed.transactionId, {
      provider: parsed.network,
      providerEventId: parsed.transactionId,
      eventType: 'momo.sms.matched',
      amountUgx: parsed.amountUgx,
      payload: { network: parsed.network },
    });
  },
};
