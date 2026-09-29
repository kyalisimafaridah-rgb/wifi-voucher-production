import 'dotenv/config';
import WebSocket from 'ws';
import { testConnection, createHotspotUsers, deleteHotspotUsers, getHotspotUserUsage } from '../src/services/mikrotik.js';

const required = ['WIFI_VOUCHER_URL', 'CONNECTOR_TOKEN', 'ROUTER_HOST', 'ROUTER_USERNAME', 'ROUTER_PASSWORD'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) { console.error('Missing connector settings:', missing.join(', ')); process.exit(1); }

const baseUrl = process.env.WIFI_VOUCHER_URL.replace(/\/$/, '');
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/connector/ws';
const router = {
  host: process.env.ROUTER_HOST,
  port: Number(process.env.ROUTER_PORT || (process.env.ROUTER_TLS === 'true' ? 8729 : 8728)),
  username: process.env.ROUTER_USERNAME,
  password: process.env.ROUTER_PASSWORD,
  secure: process.env.ROUTER_TLS === 'true',
};

let reconnectDelay = 1000;
let stopping = false;

function connect() {
  if (stopping) return;
  console.log('Connecting to WiFi Voucher cloud...');
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000, headers: { Authorization: 'Bearer ' + process.env.CONNECTOR_TOKEN } });
  ws.on('open', () => { reconnectDelay = 1000; console.log('✓ Connected to WiFi Voucher cloud'); ws.send(JSON.stringify({ type: 'hello', version: '1.0.0' })); });
  ws.on('message', async (raw) => {
    let message; try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 'command') return;
    try {
      const result = await execute(message.operation, message.payload || {});
      ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, ok: false, code: err.code || 'ROUTER_COMMAND_FAILED', error: err.message || 'Router command failed' }));
    }
  });
  ws.on('close', () => { if (stopping) return; console.log('Cloud connection closed; reconnecting...'); setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30000); });
  ws.on('error', (err) => console.error('Connector network error:', err.message));
  ws.on('ping', () => { try { ws.pong(); } catch {} });
}

async function execute(operation, payload) {
  if (operation === 'test') return testConnection(router);
  if (operation === 'create_users') return createHotspotUsers({ ...router, users: payload.users || [] });
  if (operation === 'delete_users') return deleteHotspotUsers({ ...router, names: payload.names || [] });
  if (operation === 'usage') return getHotspotUserUsage({ ...router, codes: payload.codes || [] });
  const err = new Error('Unsupported operation'); err.code = 'UNSUPPORTED_OPERATION'; throw err;
}

function stop() { stopping = true; console.log('Stopping connector...'); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
connect();
