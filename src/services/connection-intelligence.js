import { supabase } from '../db/supabase.js';
import { decrypt } from '../utils/encryption.js';
import { executeConnectorOperation } from './mikrotik.js';

const FRESH_MS = 90_000;

function fresh(lastSeenAt) {
  return Boolean(lastSeenAt) && (Date.now() - new Date(lastSeenAt).getTime() < FRESH_MS);
}

export function explainRouterError(error) {
  const code = error?.code || '';
  const message = String(error?.message || '').toLowerCase();

  if (code === 'AGENT_TIMEOUT' || code === 'CONNECTOR_TIMEOUT') {
    return 'The secure connection to your router stopped responding. We are ready to try another connection path.';
  }
  if (code === 'AGENT_COMMAND_FAILED' || code === 'CONNECTOR_COMMAND_FAILED') {
    return 'The secure connection reached your router, but the router rejected the requested action.';
  }
  if (code === 'AGENT_OFFLINE') {
    return 'Your router’s secure connection is offline. Keep the router connected to the Internet and try again.';
  }
  if (code === 'CONNECTOR_OFFLINE') {
    return 'The computer that connects your router to WiFi Voucher is offline.';
  }
  if (code === 'CONNECTOR_NOT_CONFIGURED') {
    return 'A local connection helper has not been set up for this router.';
  }
  if (code === 'MIKROTIK_CONNECTION_FAILED') {
    if (message.includes('login') || message.includes('password')) return 'We reached the router, but the router login details were not accepted.';
    if (message.includes('timeout')) return 'The router did not respond in time. We will try another available connection path.';
    if (message.includes('refused')) return 'The router refused the connection. We will try another available connection path.';
    return 'We could not reach the router using this connection path.';
  }
  if (code === 'UNSUPPORTED_ROUTER_OPERATION') return 'This router connection does not support that action yet.';
  return error?.message || 'We could not complete the router action.';
}

export async function getConnectionSnapshot(router) {
  const [agentQ, connectorQ] = await Promise.all([
    supabase.from('router_agents')
      .select('id,status,last_seen_at,routeros_version,architecture,board_name,agent_version,last_error,last_error_at')
      .eq('router_id', router.id).maybeSingle(),
    supabase.from('connector_devices')
      .select('id,status,last_seen_at,label')
      .eq('router_id', router.id).maybeSingle(),
  ]);

  const agent = agentQ.data || null;
  const connector = connectorQ.data || null;
  const agentOnline = agent?.status === 'online' && fresh(agent.last_seen_at);
  const connectorOnline = connector?.status === 'online' && fresh(connector.last_seen_at);
  const directConfigured = Boolean(router.host && router.api_username && router.api_password_encrypted);

  let state = 'needs_setup';
  let message = 'Connect your router once and WiFi Voucher will choose the safest available connection.';
  if (agentOnline || connectorOnline) {
    state = 'connected';
    message = 'Your router is connected through a secure remote path.';
  } else if (directConfigured && router.status === 'connected') {
    state = 'connected';
    message = 'Your router is connected directly.';
  } else if (agent || connector || directConfigured) {
    state = 'attention';
    message = 'Your router connection needs attention. We can test the available paths automatically.';
  }

  return {
    state,
    message,
    preferred: router.connection_mode || 'agent',
    paths: {
      cloud: { available: Boolean(agent), online: agentOnline, last_seen_at: agent?.last_seen_at || null },
      local: { available: Boolean(connector), online: connectorOnline, last_seen_at: connector?.last_seen_at || null },
      direct: { available: directConfigured, online: router.status === 'connected', last_seen_at: router.last_connected_at || null },
    },
    selected_path: agentOnline ? 'cloud' : connectorOnline ? 'local' : directConfigured && router.status === 'connected' ? 'direct' : null,
    router: {
      status: router.status || 'unknown',
      last_connected_at: router.last_connected_at || null,
    },
  };
}

export async function diagnoseRouter(router) {
  const snapshot = await getConnectionSnapshot(router);
  const checks = [
    {
      id: 'cloud',
      label: 'Secure cloud connection',
      state: snapshot.paths.cloud.online ? 'pass' : snapshot.paths.cloud.available ? 'waiting' : 'not_configured',
      detail: snapshot.paths.cloud.online
        ? 'Your router is checking in securely.'
        : snapshot.paths.cloud.available
          ? 'The cloud connection is configured but is not checking in right now.'
          : 'Not configured.',
    },
    {
      id: 'local',
      label: 'Local connection helper',
      state: snapshot.paths.local.online ? 'pass' : snapshot.paths.local.available ? 'waiting' : 'not_configured',
      detail: snapshot.paths.local.online
        ? 'A device on the router network is online.'
        : snapshot.paths.local.available
          ? 'The local helper is configured but offline.'
          : 'Not configured.',
    },
    {
      id: 'direct',
      label: 'Direct router connection',
      state: snapshot.paths.direct.online ? 'pass' : snapshot.paths.direct.available ? 'ready' : 'not_configured',
      detail: snapshot.paths.direct.online
        ? 'The router was recently reached directly.'
        : snapshot.paths.direct.available
          ? 'Direct credentials are saved and can be tried as a fallback.'
          : 'Not configured.',
    },
  ];

  return {
    ...snapshot,
    checks,
    next_action: snapshot.state === 'connected'
      ? 'none'
      : snapshot.paths.cloud.available && !snapshot.paths.cloud.online
        ? 'reconnect_cloud'
        : snapshot.paths.local.available && !snapshot.paths.local.online
          ? 'start_local_helper'
          : snapshot.paths.direct.available
            ? 'test_direct'
            : 'connect_router',
  };
}

export async function testRouterReadiness(router) {
  const startedAt = Date.now();
  try {
    const result = await executeConnectorOperation('test', {
      host: router.host,
      port: router.api_port,
      username: router.api_username,
      password: router.api_password_encrypted ? decrypt(router.api_password_encrypted) : null,
      secure: router.api_tls,
    });
    return {
      success: true,
      elapsed_ms: Date.now() - startedAt,
      router: result,
      message: 'The router responded successfully.',
    };
  } catch (error) {
    return {
      success: false,
      elapsed_ms: Date.now() - startedAt,
      message: explainRouterError(error),
      code: error.code || 'ROUTER_TEST_FAILED',
    };
  }
}
