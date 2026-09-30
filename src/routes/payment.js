import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import {
  paymentOptions,
  createPaymentIntent,
  getPaymentIntent,
  cancelPaymentIntent,
  PRICE,
  PERIOD_DAYS,
} from '../services/payment-engine.js';

const createSchema = z.object({
  provider: z.enum(['pesapal', 'mtn', 'airtel']),
  payer_phone: z.string().trim().min(7).max(32).optional().nullable(),
  idempotency_key: z.string().trim().min(8).max(128),
});

export default async function paymentRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/billing/payment-options', async (_request, reply) => reply.send({
    amount_ugx: PRICE,
    period_days: PERIOD_DAYS,
    currency: 'UGX',
    options: paymentOptions(),
    message: 'Choose secure checkout or manual Mobile Money. Payments are verified before access is activated.',
  }));

  fastify.post('/billing/payment-intents', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    try {
      const intent = await createPaymentIntent({
        ownerId: request.user.id,
        provider: parsed.data.provider,
        payerPhone: parsed.data.payer_phone,
        idempotencyKey: parsed.data.idempotency_key,
      });

      const option = paymentOptions().find((x) => x.provider === intent.provider);
      return reply.code(201).send({
        payment: intent,
        instructions: {
          merchant_number: option?.merchant_number || null,
          amount_ugx: intent.amount_ugx,
          reference: intent.merchant_reference,
          status: intent.status,
          mode: option?.mode || 'unknown',
          redirect_url: intent?.metadata?.redirect_url || null,
          message: intent.provider === 'pesapal'
            ? 'Continue to PesaPal checkout to choose your payment method.'
            : 'Send the exact amount from the Mobile Money account whose registered name you saved.',
        },
      });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  fastify.get('/billing/payment-intents/:id', async (request, reply) => {
    const intent = await getPaymentIntent(request.user.id, request.params.id);
    if (!intent) return reply.code(404).send({ error: 'Payment not found' });
    return reply.send({ payment: intent });
  });

  fastify.post('/billing/payment-intents/:id/cancel', async (request, reply) => {
    const intent = await cancelPaymentIntent(request.user.id, request.params.id);
    if (!intent) return reply.code(404).send({ error: 'Payment is no longer cancellable' });
    return reply.send({ payment: intent });
  });
}
