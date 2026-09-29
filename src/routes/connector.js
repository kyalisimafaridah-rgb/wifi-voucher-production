import { requireAuth, requireActiveSubscription } from '../middleware/auth.js';
import {
  authenticateConnector,
  createConnectorToken,
  hashConnectorToken,
  registerConnectorSocket,
  startConnectorHeartbeat,
} from '../services/connector.js';
import { supabase } from '../db/supabase.js';

export default async function connectorRoutes(fastify) {
  fastify.get('/connector/ws', { websocket: true }, async (socket, request) => {
    try {
      const token = request.query?.token;
      const device = await authenticateConnector(token);
      if (!device) {
        socket.close(4003, 'Invalid connector token');
        return;
      }
      await registerConnectorSocket(device, socket);
      startConnectorHeartbeat(socket);
      socket.send(JSON.stringify({
        type: 'connected',
        deviceId: device.id,
        routerId: device.router_id,
        serverTime: new Date().toISOString(),
      }));
    } catch (err) {
      request.log.error(err);
      try { socket.close(1011, 'Connector registration failed'); } catch {}
    }
  });

  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireActiveSubscription);

  fastify.post('/routers/:id/connector', async (request, reply) => {
    const { id } = request.params;
    const { data: router, error: routerError } = await request.supabase
      .from('routers')
      .select('id, label, owner_id')
      .eq('id', id)
      .eq('owner_id', request.user.id)
      .single();

    if (routerError || !router) return reply.code(404).send({ error: 'Router not found' });

    const token = createConnectorToken();
    const { data, error } = await supabase.from('connector_devices').upsert({
      owner_id: request.user.id,
      router_id: id,
      label: router.label,
      token_hash: hashConnectorToken(token),
      status: 'offline',
      last_seen_at: null,
    }, { onConflict: 'router_id' })
      .select('id, router_id, label, status, created_at')
      .single();

    if (error) return reply.code(500).send({ error: 'Failed to create connector', message: error.message });

    return {
      success: true,
      message: 'Connector created. Store this token safely — it is shown only once.',
      connector: data,
      token,
      websocket_url: process.env.APP_URL.replace(/^http/, 'ws') + '/connector/ws?token=' + encodeURIComponent(token),
      setup: {
        server_url: process.env.APP_URL,
        router_label: router.label,
        router_id: id,
      },
    };
  });

  fastify.get('/routers/:id/connector', async (request, reply) => {
    const { id } = request.params;
    const { data, error } = await request.supabase
      .from('connector_devices')
      .select('id, router_id, label, status, last_seen_at, created_at, updated_at')
      .eq('router_id', id)
      .eq('owner_id', request.user.id)
      .maybeSingle();

    if (error) return reply.code(500).send({ error: error.message });
    return { connector: data || null };
  });

  fastify.delete('/routers/:id/connector', async (request, reply) => {
    const { id } = request.params;
    const { error } = await request.supabase
      .from('connector_devices')
      .delete()
      .eq('router_id', id)
      .eq('owner_id', request.user.id);

    if (error) return reply.code(500).send({ error: error.message });
    return { success: true, message: 'Remote connector revoked.' };
  });
}
