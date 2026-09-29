import { z } from 'zod';
import { requireAuth, requireActiveSubscription } from '../middleware/auth.js';
import { supabase } from '../db/supabase.js';
import { createAgentToken, hashAgentToken, authenticateAgent, registerAgent, pollAgent, completeAgentCommand } from '../services/router-agent.js';

export default async function routerAgentRoutes(fastify){
  fastify.post('/routers/:id/agent',async(request,reply)=>{
    // This endpoint uses the owner's JWT and creates a one-time bootstrap token.
    await requireAuth(request,reply); if(reply.sent) return;
    await requireActiveSubscription(request,reply); if(reply.sent) return;
    const id=request.params.id;
    const {data:router,error}=await request.supabase.from('routers').select('id,label,owner_id').eq('id',id).eq('owner_id',request.user.id).single();
    if(error||!router) return reply.code(404).send({error:'Router not found'});
    const token=createAgentToken();
    const {data,error:saveError}=await supabase.from('router_agents').upsert({
      owner_id:request.user.id,router_id:id,token_hash:hashAgentToken(token),status:'offline',last_seen_at:null
    },{onConflict:'router_id'}).select('id,router_id,status').single();
    if(saveError) return reply.code(500).send({error:saveError.message});
    await request.supabase.from('routers').update({connection_mode:'agent'}).eq('id',id).eq('owner_id',request.user.id);
    return {success:true,agent:data,token,endpoint:process.env.APP_URL+'/agent/poll',install:{server:process.env.APP_URL,intervalSeconds:15}};
  });

  fastify.get('/routers/:id/agent',async(request,reply)=>{
    await requireAuth(request,reply); if(reply.sent) return;
    const {data,error}=await request.supabase.from('router_agents').select('id,status,last_seen_at,routeros_version,architecture,board_name,created_at,updated_at').eq('router_id',request.params.id).eq('owner_id',request.user.id).maybeSingle();
    if(error) return reply.code(500).send({error:error.message});
    return {agent:data||null};
  });

  fastify.delete('/routers/:id/agent',async(request,reply)=>{
    await requireAuth(request,reply); if(reply.sent) return;
    const {error}=await supabase.from('router_agents').delete().eq('router_id',request.params.id).eq('owner_id',request.user.id);
    if(error) return reply.code(500).send({error:error.message});
    await request.supabase.from('routers').update({connection_mode:'direct'}).eq('id',request.params.id).eq('owner_id',request.user.id);
    return {success:true};
  });

  // RouterOS phone-home endpoints use token auth, never owner JWT.
  fastify.post('/agent/poll',async(request,reply)=>{
    const auth=request.headers.authorization||'';
    const token=auth.startsWith('Bearer ')?auth.slice(7):'';
    const agent=await authenticateAgent(token);
    if(!agent) return reply.code(401).send({error:'Invalid agent token'});
    const body=request.body||{};
    await registerAgent(agent.id,body);
    const command=await pollAgent(agent.id);
    return {ok:true,command:command?{id:command.id,operation:command.operation,payload:command.payload}:null,serverTime:new Date().toISOString()};
  });

  fastify.post('/agent/result',async(request,reply)=>{
    const auth=request.headers.authorization||'';
    const token=auth.startsWith('Bearer ')?auth.slice(7):'';
    const agent=await authenticateAgent(token);
    if(!agent) return reply.code(401).send({error:'Invalid agent token'});
    const body=z.object({command_id:z.string().uuid(),ok:z.boolean(),result:z.any().optional(),error:z.string().optional()}).parse(request.body);
    const {data:cmd}=await supabase.from('router_agent_commands').select('id,agent_id').eq('id',body.command_id).eq('agent_id',agent.id).single();
    if(!cmd) return reply.code(404).send({error:'Command not found'});
    await completeAgentCommand(cmd.id,body.ok,body.result,body.error);
    await registerAgent(agent.id,{});
    return {ok:true};
  });
}
