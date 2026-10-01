import { z } from 'zod';
import { requireAuth, requireActiveSubscription } from '../middleware/auth.js';
import { supabase } from '../db/supabase.js';
import { runAdaptiveRouterOperation } from '../services/router-agent.js';
import { diagnoseRouter, explainRouterError } from '../services/connection-intelligence.js';

async function loadRouter(request, id) {
  const { data, error } = await request.supabase
    .from('routers')
    .select('id,label,host,api_port,api_tls,api_username,api_password_encrypted,connection_mode,status,last_connected_at,owner_id')
    .eq('id', id)
    .eq('owner_id', request.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export default async function connectionRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireActiveSubscription);

  fastify.get('/routers/:id/connection', async (request, reply) => {
    try {
      const router = await loadRouter(request, request.params.id);
      if (!router) return reply.code(404).send({ error: 'Router not found' });
      return { success: true, connection: await diagnoseRouter(router) };
    } catch (error) {
      request.log.error({ err: error }, 'Router connection diagnosis failed');
      return reply.code(500).send({ error: 'Could not diagnose router connection' });
    }
  });

  fastify.post('/routers/:id/repair', { config: { rateLimit: { max: 6, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const router = await loadRouter(request, request.params.id);
    if (!router) return reply.code(404).send({ error: 'Router not found' });

    const before = await diagnoseRouter(router);
    if (before.state === 'connected') {
      return { success: true, repaired: false, connection: before, message: 'Your router is already connected.' };
    }

    try {
      const result = await runAdaptiveRouterOperation(router, 'test', {}, 15000);
      await supabase.from('routers').update({
        status: 'connected',
        last_connected_at: new Date().toISOString(),
      }).eq('id', router.id).eq('owner_id', request.user.id);

      const refreshed = await loadRouter(request, router.id);
      return {
        success: true,
        repaired: true,
        result,
        connection: await diagnoseRouter(refreshed),
        message: 'Connection restored. Your router is ready.',
      };
    } catch (error) {
      await supabase.from('routers').update({ status: 'unreachable' })
        .eq('id', router.id).eq('owner_id', request.user.id);

      const refreshed = await loadRouter(request, router.id);
      return reply.code(409).send({
        success: false,
        repaired: false,
        error: 'Router connection needs attention',
        message: explainRouterError(error),
        code: error.code || 'ROUTER_CONNECTION_FAILED',
        connection: await diagnoseRouter(refreshed),
      });
    }
  });

  fastify.post('/routers/:id/readiness', { config: { rateLimit: { max: 6, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const router = await loadRouter(request, request.params.id);
    if (!router) return reply.code(404).send({ error: 'Router not found' });

    try {
      const result = await runAdaptiveRouterOperation(router, 'test', {}, 15000);
      await supabase.from('routers').update({
        status: 'connected',
        last_connected_at: new Date().toISOString(),
      }).eq('id', router.id).eq('owner_id', request.user.id);

      return {
        success: true,
        ready: true,
        message: 'Router connection is healthy and ready for WiFi Voucher operations.',
        result,
      };
    } catch (error) {
      return reply.code(409).send({
        success: false,
        ready: false,
        message: explainRouterError(error),
        code: error.code || 'ROUTER_READINESS_FAILED',
      });
    }
  });
}
