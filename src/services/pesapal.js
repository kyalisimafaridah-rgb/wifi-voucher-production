import { supabase } from '../db/supabase.js';

const LIVE_BASE_URL = 'https://pay.pesapal.com/v3';
const SANDBOX_BASE_URL = 'https://cybqa.pesapal.com/pesapalv3';

let tokenCache = { token: null, expiresAt: 0 };
let ipnRegistrationPromise = null;

function envName() {
  return String(process.env.PESAPAL_ENV || 'live').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'live';
}

function baseUrl() {
  return envName() === 'sandbox' ? SANDBOX_BASE_URL : LIVE_BASE_URL;
}

function consumerKey() {
  return String(process.env.PESAPAL_CONSUMER_KEY || '').trim();
}

function consumerSecret() {
  return String(process.env.PESAPAL_CONSUMER_SECRET || '').trim();
}

export function isPesapalConfigured() {
  return Boolean(consumerKey() && consumerSecret() && process.env.APP_URL);
}

function publicUrl(path) {
  return new URL(path, String(process.env.APP_URL).replace(/\/$/, '') + '/').toString();
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.PESAPAL_TIMEOUT_MS || 15000));
  try {
    const response = await fetch(baseUrl() + path, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || `PesaPal request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    if (body?.error && body?.status && String(body.status) !== '200') {
      throw new Error(body.error.message || body.message || 'PesaPal rejected the request');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  if (!isPesapalConfigured()) throw new Error('PesaPal is not configured');
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 15000) return tokenCache.token;

  const body = await requestJson('/api/Auth/RequestToken', {
    method: 'POST',
    body: JSON.stringify({ consumer_key: consumerKey(), consumer_secret: consumerSecret() }),
  });

  if (!body.token) throw new Error(body.message || 'PesaPal did not return an access token');
  const expiry = body.expiryDate ? Date.parse(body.expiryDate) : Date.now() + 4 * 60 * 1000;
  tokenCache = {
    token: body.token,
    expiresAt: Number.isFinite(expiry) ? expiry : Date.now() + 4 * 60 * 1000,
  };
  return body.token;
}

async function authenticatedRequest(path, options = {}) {
  const token = await getAccessToken();
  return requestJson(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
}

function ipnUrl() {
  return publicUrl('/webhooks/pesapal');
}

function callbackUrl() {
  return String(process.env.PESAPAL_CALLBACK_URL || publicUrl('/billing/pesapal/callback'));
}

export async function getRegisteredIpns() {
  return authenticatedRequest('/api/URLSetup/GetIpnList', { method: 'GET' });
}

export async function ensurePesaPalIpn() {
  if (!isPesapalConfigured()) throw new Error('PesaPal is not configured');
  const configuredId = String(process.env.PESAPAL_IPN_ID || '').trim();
  if (configuredId) return configuredId;

  if (ipnRegistrationPromise) return ipnRegistrationPromise;
  ipnRegistrationPromise = (async () => {
    const registered = await getRegisteredIpns();
    const list = Array.isArray(registered) ? registered : (registered?.data || []);
    const existing = list.find((item) =>
      String(item?.url || '').replace(/\/$/, '') === ipnUrl().replace(/\/$/, '') &&
      String(item?.ipn_status ?? '1') !== '0'
    );
    if (existing?.ipn_id) return existing.ipn_id;

    const result = await authenticatedRequest('/api/URLSetup/RegisterIPN', {
      method: 'POST',
      body: JSON.stringify({ url: ipnUrl(), ipn_notification_type: 'POST' }),
    });
    if (!result?.ipn_id) throw new Error(result?.message || 'PesaPal did not return an IPN ID');
    return result.ipn_id;
  })().finally(() => { ipnRegistrationPromise = null; });

  return ipnRegistrationPromise;
}

export async function createPesapalOrder({ merchantReference, amountUgx, email, phone, fullName }) {
  const notificationId = await ensurePesaPalIpn();
  const names = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = names.shift() || 'WiFi';
  const lastName = names.join(' ') || 'Voucher';

  const result = await authenticatedRequest('/api/Transactions/SubmitOrderRequest', {
    method: 'POST',
    body: JSON.stringify({
      id: merchantReference,
      currency: 'UGX',
      amount: Number(amountUgx),
      description: 'WiFi Voucher subscription',
      callback_url: callbackUrl(),
      cancellation_url: callbackUrl(),
      notification_id: notificationId,
      billing_address: {
        email_address: email || undefined,
        phone_number: phone || undefined,
        country_code: 'UG',
        first_name: firstName,
        last_name: lastName,
      },
    }),
  });

  if (!result?.order_tracking_id || !result?.redirect_url) {
    throw new Error(result?.message || 'PesaPal did not return a payment checkout URL');
  }

  return {
    order_tracking_id: result.order_tracking_id,
    merchant_reference: result.merchant_reference || merchantReference,
    redirect_url: result.redirect_url,
  };
}

export async function getPesapalTransactionStatus(orderTrackingId) {
  if (!orderTrackingId) throw new Error('PesaPal order tracking ID is required');
  return authenticatedRequest(
    '/api/Transactions/GetTransactionStatus?orderTrackingId=' + encodeURIComponent(orderTrackingId),
    { method: 'GET' },
  );
}

function normalizeStatus(status) {
  const text = String(status || '').trim().toUpperCase();
  if (text === 'COMPLETED' || text === 'SUCCESS' || text === '1') return 'succeeded';
  if (text === 'FAILED' || text === 'INVALID' || text === 'REVERSED' || ['2', '3', '0'].includes(text)) return 'failed';
  return 'pending';
}

export async function processPesapalNotification({ orderTrackingId, merchantReference, eventType = 'pesapal.ipn' }) {
  if (!orderTrackingId) throw new Error('Missing PesaPal order tracking ID');

  const { data: intent, error: intentError } = await supabase
    .from('payment_intents')
    .select('id,owner_id,provider,amount_ugx,currency,status,merchant_reference,provider_transaction_id,expires_at')
    .eq('provider', 'pesapal')
    .eq('merchant_reference', merchantReference || '')
    .maybeSingle();

  if (intentError) throw new Error('Could not load PesaPal payment intent: ' + intentError.message);
  if (!intent) throw new Error('Payment intent not found');
  if (intent.provider_transaction_id && intent.provider_transaction_id !== orderTrackingId) {
    throw new Error('PesaPal tracking ID does not match the payment intent');
  }

  const status = await getPesapalTransactionStatus(orderTrackingId);
  const returnedReference = String(status?.merchant_reference || '').trim();
  const returnedCurrency = String(status?.currency || '').trim().toUpperCase();
  const returnedAmount = Number(status?.amount);

  if (returnedReference && returnedReference !== intent.merchant_reference) {
    throw new Error('PesaPal merchant reference does not match the payment intent');
  }
  if (returnedCurrency && returnedCurrency !== 'UGX') {
    throw new Error('PesaPal returned an unexpected currency');
  }
  if (!Number.isFinite(returnedAmount) || Math.round(returnedAmount) !== intent.amount_ugx) {
    throw new Error('PesaPal returned an amount that does not match the payment intent');
  }

  const normalized = normalizeStatus(status?.payment_status_description ?? status?.status_code);

  if (normalized === 'succeeded') {
    const confirmationCode = String(status?.confirmation_code || orderTrackingId);
    const { confirmPaymentIntent } = await import('./payment-engine.js');
    const confirmed = await confirmPaymentIntent(intent.id, orderTrackingId, {
      provider: 'pesapal',
      providerEventId: confirmationCode,
      eventType,
      amountUgx: intent.amount_ugx,
      payload: {
        order_tracking_id: orderTrackingId,
        merchant_reference: intent.merchant_reference,
        payment_status_description: status?.payment_status_description,
        status_code: status?.status_code,
        payment_method: status?.payment_method,
        payment_account: status?.payment_account,
        confirmation_code: status?.confirmation_code,
        created_date: status?.created_date,
      },
    });
    return { intent, status: 'succeeded', confirmed, provider: status };
  }

  if (intent.status === 'succeeded') {
    return { intent, status: normalized, provider: status };
  }

  const nextStatus = normalized === 'failed' ? 'failed' : 'processing';
  const { error: updateError } = await supabase
    .from('payment_intents')
    .update({
      status: nextStatus,
      failure_code: normalized === 'failed' ? String(status?.status_code ?? 'PESAPAL_FAILED') : null,
      failure_message: normalized === 'failed' ? String(status?.description || status?.message || 'PesaPal payment failed').slice(0, 500) : null,
      provider_transaction_id: orderTrackingId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', intent.id)
    .in('status', ['created', 'pending', 'processing']);

  if (updateError) throw new Error('Could not update PesaPal payment status: ' + updateError.message);
  return { intent, status: normalized, provider: status };
}

export function pesapalCallbackUrl() {
  return callbackUrl();
}

export function pesapalIpnUrl() {
  return ipnUrl();
}
