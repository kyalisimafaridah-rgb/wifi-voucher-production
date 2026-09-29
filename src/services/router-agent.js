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
  const patch = { status:'online', last_seen_at:new Date().toISOString(), last_error:null, last_error_at:null };
  for (const key of ['routeros_version','architecture','board_name','agent_version','last_ip']) {
    if (meta[key] !== undefined) patch[key] = meta[key];
  }
  await supabase.from('router_agents').update(patch).eq('id', agentId);
}

export async function registerAgent(agentId, meta) {
  await agentHeartbeat(agentId, meta);
}

export async function queueAgentCommand(agentId, operation, payload = {}, timeoutMs = 30000) {
  if (JSON.stringify(payload).length > 65536) throw Object.assign(new Error('Router command payload is too large'), { code:'AGENT_PAYLOAD_TOO_LARGE' });
  const expiresAt = new Date(Date.now() + timeoutMs + 15000).toISOString();
  const { data, error } = await supabase.from('router_agent_commands').insert({
    agent_id:agentId, operation, payload, status:'queued', expires_at:expiresAt
  }).select('id').single();
  if (error) throw Object.assign(new Error(error.message), { code:'AGENT_QUEUE_FAILED' });
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const { data: row } = await supabase.from('router_agent_commands').select('status,result,error_message').eq('id',data.id).single();
    if(row?.status==='succeeded') return row.result;
    if(row?.status==='failed') throw Object.assign(new Error(row.error_message || 'Router agent command failed'),{code:'AGENT_COMMAND_FAILED'});
    if(row?.status==='expired') throw Object.assign(new Error(row.error_message || 'Router agent command expired'),{code:'AGENT_TIMEOUT'});
    await new Promise(r=>setTimeout(r,1000));
  }
  await supabase.from('router_agent_commands').update({status:'expired',error_message:'Command timed out',completed_at:new Date().toISOString()}).eq('id',data.id).in('status',['queued','running']);
  throw Object.assign(new Error('Router agent command timed out'),{code:'AGENT_TIMEOUT'});
}

export async function pollAgent(agentId) {
  await supabase.from('router_agent_commands').update({status:'expired',error_message:'Command expired before delivery',completed_at:new Date().toISOString()}).eq('agent_id',agentId).eq('status','queued').lt('expires_at',new Date().toISOString());
  const { data } = await supabase.from('router_agent_commands').select('id,operation,payload,expires_at').eq('agent_id',agentId).eq('status','queued').order('created_at',{ascending:true}).limit(1).maybeSingle();
  if(!data) return null;
  const { data: claimed } = await supabase.from('router_agent_commands').update({status:'running',started_at:new Date().toISOString(),claimed_at:new Date().toISOString()}).eq('id',data.id).eq('status','queued').select('id,operation,payload,expires_at').maybeSingle();
  return claimed || null;
}

export async function completeAgentCommand(commandId, ok, result, errorMessage) {
  await supabase.from('router_agent_commands').update({
    status:ok?'succeeded':'failed',
    result:ok?(result ?? {}):null,
    error_message:ok?null:(errorMessage || 'Agent command failed'),
    completed_at:new Date().toISOString()
  }).eq('id',commandId).eq('status','running').gt('expires_at',new Date().toISOString());
}


export function buildRouterOSAgentScript({ server, token }) {
  const safeServer = String(server).replace(/"/g, '\\\"');
  const safeToken = String(token).replace(/"/g, '\\\"');
  return `:local server "${safeServer}"
:local token "${safeToken}"
:local pollUrl ($server . "/agent/poll")
:local resultUrl ($server . "/agent/result")
:local interval 15s

:local jsonEscape do={
  :local v $1
  :set v [:tostr $v]
  :set v [:replace $v "\\\\" "\\\\\\\\"]
  :set v [:replace $v "\"" "\\\\\""]
  :set v [:replace $v "\r" ""]
  :set v [:replace $v "\n" " "]
  :return $v
}

:local postResult do={
  :local commandId $1
  :local ok $2
  :local result $3
  :local errorText $4
  :local body ("{\\"command_id\\":\\"" . $commandId . "\\",\\"ok\\":" . ([:tostr $ok]) . ",\\"result\\":" . $result . ",\\"error\\":\\"" . [$jsonEscape $errorText] . "\\"}")
  :onerror e in={
    /tool fetch url=$resultUrl http-method=post http-header-field=(\\"Authorization: Bearer \" . $token . \",Content-Type: application/json\\") http-data=$body output=none keep-result=no
  } do={ :log warning ("WiFi Voucher agent result failed: " . $e) }
}

:local runCommand do={
  :local cmd $1
  :local operation ($cmd->"operation")
  :local payload ($cmd->"payload")
  :local commandId ($cmd->"id")
  :local result "{\\"ok\\":true}"
  :local errorText ""

  :onerror e in={
    :if ($operation = "test") do={
      :local r [/system resource get [find] version]
      :local identity [/system identity get [find] name]
      :local board [/system resource get [find] board-name]
      :local arch [/system resource get [find] architecture-name]
      :set result ("{\\"success\\":true,\\"identity\\":\\"" . [$jsonEscape $identity] . "\\",\\"version\\":\\"" . [$jsonEscape $r] . "\\",\\"board\\":\\"" . [$jsonEscape $board] . "\\",\\"architecture\\":\\"" . [$jsonEscape $arch] . "\\"}")
    }
    :if ($operation = "create_users") do={
      :local created ""
      :local errors ""
      :foreach u in=($payload->"users") do={
        :local name ($u->"name")
        :local password ($u->"password")
        :local uptime ($u->"limitUptime")
        :local bytes ($u->"limitBytesTotal")
        :local comment ($u->"comment")
        :onerror one in={
          :local args ("name=" . $name . " password=" . $password)
          :if ([:typeof $uptime] != "nil") do={ :set args ($args . " limit-uptime=" . $uptime) }
          :if ([:typeof $bytes] != "nil") do={ :set args ($args . " limit-bytes-total=" . $bytes) }
          :if ([:typeof $comment] != "nil") do={ :set args ($args . " comment=" . $comment) }
          /ip hotspot user add $args
          :if ([:len $created] > 0) do={ :set created ($created . ",") }
          :set created ($created . "\\"" . [$jsonEscape $name] . "\\"")
        } do={
          :if ([:len $errors] > 0) do={ :set errors ($errors . ",") }
          :set errors ($errors . "{\\"code\\":\\"" . [$jsonEscape $name] . "\\",\\"error\\":\\"" . [$jsonEscape $one] . "\\"}")
        }
      }
      :set result ("{\\"created\\":[" . $created . "],\\"errors\\":[" . $errors . "]}")
    }
    :if ($operation = "delete_users") do={
      :local deleted ""
      :local errors ""
      :foreach name in=($payload->"names") do={
        :local ids [/ip hotspot user find where name=$name]
        :foreach id in=$ids do={
          :onerror one in={
            /ip hotspot user remove $id
            :if ([:len $deleted] > 0) do={ :set deleted ($deleted . ",") }
            :set deleted ($deleted . "\\"" . [$jsonEscape $name] . "\\"")
          } do={
            :if ([:len $errors] > 0) do={ :set errors ($errors . ",") }
            :set errors ($errors . "{\\"code\\":\\"" . [$jsonEscape $name] . "\\",\\"error\\":\\"" . [$jsonEscape $one] . "\\"}")
          }
        }
      }
      :set result ("{\\"deleted\\":[" . $deleted . "],\\"errors\\":[" . $errors . "]}")
    }
    :if ($operation = "usage") do={
      :local out "{"
      :foreach code in=($payload->"codes") do={
        :local row [/ip hotspot user get [find where name=$code]]
        :if ([:len $out] > 1) do={ :set out ($out . ",") }
        :if ([:len $row] = 0) do={
          :set out ($out . "\\"" . [$jsonEscape $code] . "\\":{\\"exists\\":false}")
        } else={
          :set out ($out . "\\"" . [$jsonEscape $code] . "\\":{\\"exists\\":true,\\"uptime\\":\\"" . [$jsonEscape ($row->"uptime")] . "\\",\\"limit-uptime\\":\\"" . [$jsonEscape ($row->"limit-uptime")] . "\\",\\"bytes-in\\":\\"" . [$jsonEscape ($row->"bytes-in")] . "\\",\\"bytes-out\\":\\"" . [$jsonEscape ($row->"bytes-out")] . "\\",\\"limit-bytes-total\\":\\"" . [$jsonEscape ($row->"limit-bytes-total")] . "\\"}")
        }
      }
      :set result ($out . "}")
    }
  } do={ :set errorText $e; :set result "{\\"ok\\":false}" }

  [$postResult $commandId ([:len $errorText] = 0) $result $errorText]
}

:while (true) do={
  :local meta ("{\\"routeros_version\\":\\"" . [$jsonEscape [/system resource get [find] version]] . "\\",\\"architecture\\":\\"" . [$jsonEscape [/system resource get [find] architecture-name]] . "\\",\\"board_name\\":\\"" . [$jsonEscape [/system resource get [find] board-name]] . "\\"}")
  :local response ""
  :onerror err in={
    :set response [/tool fetch url=$pollUrl http-method=post http-header-field=(\\"Authorization: Bearer \" . $token . \",Content-Type: application/json\\") http-data=$meta output=user as-value keep-result=no]
    :if (($response->"status") = "finished") do={
      :local data ($response->"data")
      :if ([:len $data] > 0) do={
        :local parsed [:deserialize $data from=json]
        :if (($parsed->"command") != nil) do={ [$runCommand ($parsed->"command")] }
      }
    }
  } do={ :log warning ("WiFi Voucher agent poll failed: " . $err) }
  :delay $interval
}
`;
}

export async function runAdaptiveRouterOperation(router, operation, payload={}, timeoutMs=30000) {
  // 1) RouterOS cloud agent: outbound HTTPS, works behind NAT/CGNAT.
  const { data: agent } = await supabase.from('router_agents')
    .select('id,status,last_seen_at').eq('router_id',router.id).maybeSingle();
  if(agent?.status==='online' && agent.last_seen_at && Date.now()-new Date(agent.last_seen_at).getTime()<90000){
    try { return await queueAgentCommand(agent.id,operation,payload,timeoutMs); }
    catch (err) {
      if (!['AGENT_TIMEOUT','AGENT_COMMAND_FAILED'].includes(err.code)) throw err;
      if (err.code === 'AGENT_COMMAND_FAILED') throw err;
    }
  }

  // 2) Existing outbound LAN connector.
  if(router.connection_mode==='connector'){
    const { data: device } = await supabase.from('connector_devices').select('id,status').eq('router_id',router.id).maybeSingle();
    if(device?.status==='online'){
      const { sendConnectorCommand } = await import('./connector.js');
      try { return await sendConnectorCommand(device.id,operation,payload,timeoutMs); }
      catch (err) {
        if (err.code === 'CONNECTOR_COMMAND_FAILED') throw err;
      }
    }
  }

  // 3) Direct RouterOS API/secure API-SSL.
  const password=decrypt(router.api_password_encrypted);
  return executeConnectorOperation(operation,{...payload,host:router.host,port:router.api_port,username:router.api_username,password,secure:router.api_tls});
}
