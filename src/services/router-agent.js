import crypto from 'crypto';
import { supabase } from '../db/supabase.js';
import { decrypt } from '../utils/encryption.js';
import { executeConnectorOperation } from './mikrotik.js';

const agentSockets = new Map();

export function createAgentToken() { return crypto.randomBytes(32).toString('base64url'); }
export function hashAgentToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

export async function authenticateAgent(token) {
  if (!token || token.length < 32) return null;
  const { data, error } = await supabase.from('router_agents')
    .select('id,owner_id,router_id').eq('token_hash', hashAgentToken(token)).maybeSingle();
  return error || !data ? null : data;
}

export async function agentHeartbeat(agentId, meta = {}) {
  await supabase.from('router_agents').update({
    status:'online',
    last_seen_at:new Date().toISOString(),
    routeros_version: meta.routeros_version || null,
    architecture: meta.architecture || null,
    board_name: meta.board_name || null,
  }).eq('id', agentId);
}

export async function registerAgent(agentId, meta) {
  await agentHeartbeat(agentId, meta);
}

export async function queueAgentCommand(agentId, operation, payload = {}, timeoutMs = 30000) {
  const { data, error } = await supabase.from('router_agent_commands').insert({
    agent_id:agentId, operation, payload, status:'queued'
  }).select('id').single();
  if (error) throw Object.assign(new Error(error.message), { code:'AGENT_QUEUE_FAILED' });

  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const { data: row } = await supabase.from('router_agent_commands')
      .select('status,result,error_message').eq('id',data.id).single();
    if(row?.status==='succeeded') return row.result;
    if(row?.status==='failed') throw Object.assign(new Error(row.error_message || 'Router agent command failed'),{code:'AGENT_COMMAND_FAILED'});
    await new Promise(r=>setTimeout(r,1000));
  }
  await supabase.from('router_agent_commands').update({status:'expired',error_message:'Command timed out',completed_at:new Date().toISOString()}).eq('id',data.id).eq('status','queued');
  throw Object.assign(new Error('Router agent command timed out'),{code:'AGENT_TIMEOUT'});
}

export async function pollAgent(agentId) {
  const { data } = await supabase.from('router_agent_commands')
    .select('id,operation,payload').eq('agent_id',agentId).eq('status','queued')
    .order('created_at',{ascending:true}).limit(1).maybeSingle();
  if(!data) return null;
  const { data: claimed } = await supabase.from('router_agent_commands')
    .update({status:'running',started_at:new Date().toISOString()})
    .eq('id',data.id).eq('status','queued')
    .select('id,operation,payload').maybeSingle();
  return claimed || null;
}

export async function completeAgentCommand(commandId, ok, result, errorMessage) {
  await supabase.from('router_agent_commands').update({
    status:ok?'succeeded':'failed',
    result:ok?(result ?? {}):null,
    error_message:ok?null:(errorMessage || 'Agent command failed'),
    completed_at:new Date().toISOString()
  }).eq('id',commandId).eq('status','running');
}

export async function runAdaptiveRouterOperation(router, operation, payload={}, timeoutMs=30000) {
  // 1) RouterOS cloud agent: outbound HTTPS, works behind NAT/CGNAT.
  const { data: agent } = await supabase.from('router_agents')
    .select('id,status,last_seen_at').eq('router_id',router.id).maybeSingle();
  if(agent?.status==='online' && agent.last_seen_at && Date.now()-new Date(agent.last_seen_at).getTime()<90000){
    try { return await queueAgentCommand(agent.id,operation,payload,timeoutMs); } catch {}
  }

  // 2) Existing outbound LAN connector.
  if(router.connection_mode==='connector'){
    const { data: device } = await supabase.from('connector_devices').select('id,status').eq('router_id',router.id).maybeSingle();
    if(device?.status==='online'){
      const { sendConnectorCommand } = await import('./connector.js');
      try { return await sendConnectorCommand(device.id,operation,payload,timeoutMs); } catch {}
    }
  }

  // 3) Direct RouterOS API/secure API-SSL.
  const password=decrypt(router.api_password_encrypted);
  return executeConnectorOperation(operation,{...payload,host:router.host,port:router.api_port,username:router.api_username,password,secure:router.api_tls});
}
