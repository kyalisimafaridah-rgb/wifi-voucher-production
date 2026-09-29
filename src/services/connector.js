import crypto from 'crypto';
import { supabase } from '../db/supabase.js';
import {
  testConnection,
  createHotspotUsers,
  deleteHotspotUsers,
  getHotspotUserUsage,
} from './mikrotik.js';

const sockets = new Map();
const pending = new Map();

export function createConnectorToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashConnectorToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function authenticateConnector(token) {
  if (!token || token.length < 32) return null;
  const tokenHash = hashConnectorToken(token);
  const { data, error } = await supabase
    .from('connector_devices')
    .select('id, owner_id, router_id, label')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  return error || !data ? null : data;
}

export async function registerConnectorSocket(device, socket) {
  const previous = sockets.get(device.id);
  if (previous && previous !== socket) {
    try { previous.close(4001, 'Replaced by a new connector session'); } catch {}
  }
  sockets.set(device.id, socket);
  await supabase.from('connector_devices').update({
    status: 'online',
    last_seen_at: new Date().toISOString(),
  }).eq('id', device.id);

  socket.on('pong', async () => {
    await supabase.from('connector_devices').update({
      status: 'online',
      last_seen_at: new Date().toISOString(),
    }).eq('id', device.id);
  });

  socket.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'hello') return;

    if (message.type === 'result' && message.requestId) {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(Object.assign(new Error(message.error || 'Connector command failed'), { code: message.code || 'CONNECTOR_COMMAND_FAILED' }));
    }
  });

  socket.on('close', async () => {
    if (sockets.get(device.id) === socket) {
      sockets.delete(device.id);
      await supabase.from('connector_devices').update({
        status: 'offline',
        last_seen_at: new Date().toISOString(),
      }).eq('id', device.id);
    }
  });
}

export function startConnectorHeartbeat(socket) {
  const timer = setInterval(() => {
    if (socket.readyState === 1) {
      try { socket.ping(); } catch {}
    } else {
      clearInterval(timer);
    }
  }, 25000);
  socket.on('close', () => clearInterval(timer));
}

export async function sendConnectorCommand(deviceId, operation, payload = {}, timeoutMs = 30000) {
  const socket = sockets.get(deviceId);
  if (!socket || socket.readyState !== 1) {
    const err = new Error('Remote connector is offline. Start the connector on the customer network and try again.');
    err.code = 'CONNECTOR_OFFLINE';
    throw err;
  }

  const requestId = crypto.randomUUID();
  const message = JSON.stringify({ type: 'command', requestId, operation, payload });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      const err = new Error('Remote router command timed out. The connector may have lost its network connection.');
      err.code = 'CONNECTOR_TIMEOUT';
      reject(err);
    }, timeoutMs);

    pending.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });

    try {
      socket.send(message);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(err);
    }
  });
}

export async function executeConnectorOperation(operation, payload) {
  switch (operation) {
    case 'test':
      return testConnection(payload);
    case 'create_users':
      return createHotspotUsers(payload);
    case 'delete_users':
      return deleteHotspotUsers(payload);
    case 'usage':
      return getHotspotUserUsage(payload);
    default: {
      const err = new Error('Unsupported connector operation');
      err.code = 'UNSUPPORTED_CONNECTOR_OPERATION';
      throw err;
    }
  }
}
