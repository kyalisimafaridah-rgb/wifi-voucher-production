import { processPesapalNotification } from '../services/pesapal.js';

function readNotification(request) {
  const source = request.method === 'GET' ? request.query || {} : request.body || {};
  return {
    orderTrackingId: source.OrderTrackingId || source.orderTrackingId || source.pesapal_transaction_tracking_id,
    merchantReference: source.OrderMerchantReference || source.orderMerchantReference || source.pesapal_merchant_reference,
    notificationType: source.OrderNotificationType || source.orderNotificationType || source.pesapal_notification_type || 'IPNCHANGE',
  };
}

export default async function pesapalWebhookRoutes(fastify) {
  const handle = async (request, reply) => {
    try {
      const notification = readNotification(request);
      if (!notification.orderTrackingId || !notification.merchantReference) {
        return reply.code(400).send({ error: 'PesaPal notification is missing transaction identifiers' });
      }

      const result = await processPesapalNotification({
        orderTrackingId: String(notification.orderTrackingId),
        merchantReference: String(notification.merchantReference),
        eventType: notification.notificationType === 'CALLBACKURL' ? 'pesapal.callback' : 'pesapal.ipn',
      });

      return reply.code(200).send({
        orderNotificationType: notification.notificationType,
        orderTrackingId: notification.orderTrackingId,
        orderMerchantReference: notification.merchantReference,
        status: 200,
        payment_status: result.status,
      });
    } catch (error) {
      request.log.error(error, 'PesaPal notification processing failed');
      return reply.code(500).send({ error: 'Payment notification could not be verified yet' });
    }
  };

  fastify.post('/webhooks/pesapal', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, handle);
  fastify.get('/webhooks/pesapal', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, handle);

  fastify.get('/billing/pesapal/callback', async (request, reply) => {
    const notification = readNotification(request);
    if (!notification.orderTrackingId || !notification.merchantReference) {
      return reply.code(400).type('text/html').send('<h2>Payment response was incomplete.</h2><p>You can return to WiFi Voucher and check your payment.</p>');
    }

    try {
      const result = await processPesapalNotification({
        orderTrackingId: String(notification.orderTrackingId),
        merchantReference: String(notification.merchantReference),
        eventType: 'pesapal.callback',
      });

      const appUrl = String(process.env.APP_URL || '/').replace(/\/$/, '');
      const url = new URL(appUrl + '/', appUrl + '/');
      url.searchParams.set('payment', result.intent.id);
      url.searchParams.set('payment_status', result.status);
      return reply.redirect(url.toString());
    } catch (error) {
      request.log.error(error, 'PesaPal callback verification failed');
      const appUrl = String(process.env.APP_URL || '/').replace(/\/$/, '');
      const url = new URL(appUrl + '/', appUrl + '/');
      url.searchParams.set('payment', 'unknown');
      url.searchParams.set('payment_status', 'verification_error');
      return reply.redirect(url.toString());
    }
  });
}
