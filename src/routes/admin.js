import { z } from 'zod';
import { supabase, createUserClient } from '../db/supabase.js';

const adminRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

async function writeAudit({ adminId, action, targetType = null, targetId = null, metadata = {} }) {
  try {
    await supabase.from('admin_audit_logs').insert({ admin_id: adminId || null, action, target_type: targetType, target_id: targetId || null, metadata });
  } catch {}
}

function effectiveSubscription(owner) {
  if (!owner) return 'unknown';
  if (owner.subscription_status === 'active') return 'active';
  if (owner.subscription_status === 'expired') return 'expired';
  if (owner.subscription_status === 'trial' && owner.trial_ends_at && new Date(owner.trial_ends_at) < new Date()) return 'expired';
  return owner.subscription_status;
}

async function countsForOwners(ownerIds) {
  if (!ownerIds.length) return { routers: {}, vouchers: {}, profiles: {} };
  const [routersQ, vouchersQ, profilesQ] = await Promise.all([
    supabase.from('routers').select('id,owner_id').in('owner_id', ownerIds).limit(5000),
    supabase.from('vouchers').select('id,owner_id,status').in('owner_id', ownerIds).limit(10000),
    supabase.from('profiles').select('id,router_id').limit(10000),
  ]);
  const routerMap = {}, voucherMap = {}, profileMap = {};
  const routerOwner = {};
  for (const row of routersQ.data || []) { routerMap[row.owner_id] = (routerMap[row.owner_id] || 0) + 1; routerOwner[row.id] = row.owner_id; }
  for (const row of vouchersQ.data || []) {
    voucherMap[row.owner_id] ||= { total: 0, unused: 0, active: 0, expired: 0, disabled: 0 };
    voucherMap[row.owner_id].total += 1;
    if (voucherMap[row.owner_id][row.status] !== undefined) voucherMap[row.owner_id][row.status] += 1;
  }
  for (const row of profilesQ.data || []) {
    const ownerId = routerOwner[row.router_id];
    if (ownerId) profileMap[ownerId] = (profileMap[ownerId] || 0) + 1;
  }
  return { routers: routerMap, vouchers: voucherMap, profiles: profileMap };
}

export default async function adminRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    const secret = request.headers['x-admin-secret'];
    if (process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET) return;
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Unauthorized', message: 'Admin authentication required' });

    const token = authHeader.slice(7);
    const userSupabase = createUserClient(token);
    const { data: { user }, error: userError } = await userSupabase.auth.getUser(token);
    if (userError || !user) return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });

    const { data: owner, error: ownerError } = await supabase.from('owners')
      .select('id,email,full_name,role').eq('id', user.id).single();
    if (ownerError || owner?.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', message: 'Admin role required' });
    request.user = user;
    request.admin = owner;
  });

  fastify.get('/admin/stats', adminRateLimit, async (request) => {
    const [ownersQ, routersQ, vouchersQ, activeQ, profilesQ, agentsQ, onlineAgentsQ, failedQ, paymentsQ] = await Promise.all([
      supabase.from('owners').select('id,subscription_status,trial_ends_at', { count: 'exact' }),
      supabase.from('routers').select('id,status', { count: 'exact' }),
      supabase.from('vouchers').select('id', { count: 'exact', head: true }),
      supabase.from('vouchers').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('router_agents').select('id,status', { count: 'exact' }),
      supabase.from('router_agents').select('id', { count: 'exact', head: true }).eq('status', 'online'),
      supabase.from('router_agent_commands').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      supabase.rpc('admin_payment_summary'),
    ]);
    const owners = ownersQ.data || [];
    const ownerStatus = owners.reduce((acc, o) => { const s = effectiveSubscription(o); acc[s] = (acc[s] || 0) + 1; return acc; }, { trial: 0, active: 0, expired: 0 });
    const p = paymentsQ.data?.[0] || {};
    return {
      owners: ownersQ.count || 0, active_owners: ownerStatus.active, trial_owners: ownerStatus.trial, expired_owners: ownerStatus.expired,
      routers: routersQ.count || 0, connected_routers: (routersQ.data || []).filter(r => r.status === 'connected').length,
      offline_routers: (routersQ.data || []).filter(r => r.status === 'unreachable').length,
      vouchers: vouchersQ.count || 0, active_vouchers: activeQ.count || 0, profiles: profilesQ.count || 0,
      agents: agentsQ.count || 0, online_agents: onlineAgentsQ.count || 0, failed_commands: failedQ.count || 0,
      revenue_ugx: Number(p.matched_amount_ugx || 0), revenue_30d_ugx: Number(p.matched_30d_amount_ugx || 0),
      matched_payments: Number(p.matched_count || 0), matched_payments_30d: Number(p.matched_30d_count || 0),
      payments_needing_review: Number(p.pending_review_count || 0),
    };
  });

  fastify.get('/admin/owners', adminRateLimit, async (request) => {
    const limit = Math.min(Math.max(Number(request.query?.limit) || 100, 1), 200);
    const search = String(request.query?.search || '').trim().toLowerCase();
    const status = String(request.query?.status || '').trim();
    const { data, error } = await supabase.from('owners')
      .select('id,email,full_name,role,subscription_status,trial_ends_at,subscription_paid_until,momo_registered_name,created_at,updated_at')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    let owners = (data || []).map(o => ({ ...o, effective_status: effectiveSubscription(o) }));
    if (search) owners = owners.filter(o => [o.email, o.full_name, o.momo_registered_name].some(v => String(v || '').toLowerCase().includes(search)));
    if (status === 'admin') owners = owners.filter(o => o.role === 'admin');
    else if (['trial','active','expired'].includes(status)) owners = owners.filter(o => o.effective_status === status);
    owners = owners.slice(0, limit);
    const maps = await countsForOwners(owners.map(o => o.id));
    return { owners: owners.map(o => ({ ...o, router_count: maps.routers[o.id] || 0, profile_count: maps.profiles[o.id] || 0, voucher_count: maps.vouchers[o.id]?.total || 0, active_voucher_count: maps.vouchers[o.id]?.active || 0 })) };
  });

  fastify.get('/admin/owners/:id', adminRateLimit, async (request, reply) => {
    const id = request.params.id;
    const [ownerQ, routersQ, vouchersQ, agentsQ, paymentsQ, logsQ] = await Promise.all([
      supabase.from('owners').select('id,email,full_name,role,subscription_status,trial_ends_at,subscription_paid_until,momo_registered_name,created_at,updated_at').eq('id', id).maybeSingle(),
      supabase.from('routers').select('id,label,host,status,connection_mode,last_connected_at,created_at,updated_at').eq('owner_id', id).order('created_at', { ascending: false }).limit(100),
      supabase.from('vouchers').select('id,code,status,profile_id,router_id,created_at,activated_at,expires_at,last_synced_at').eq('owner_id', id).order('created_at', { ascending: false }).limit(100),
      supabase.from('router_agents').select('id,router_id,status,routeros_version,architecture,board_name,agent_version,last_ip,last_seen_at,last_error,last_error_at,created_at,updated_at').eq('owner_id', id).limit(100),
      supabase.from('momo_events').select('id,transaction_id,network,parsed_amount_ugx,parsed_reason_name,status,note,created_at').eq('matched_owner_id', id).order('created_at', { ascending: false }).limit(100),
      supabase.from('admin_audit_logs').select('id,admin_id,action,target_type,target_id,metadata,created_at').eq('target_id', id).order('created_at', { ascending: false }).limit(100),
    ]);
    if (ownerQ.error || !ownerQ.data) return reply.code(404).send({ error: 'Owner not found' });
    return { owner: { ...ownerQ.data, effective_status: effectiveSubscription(ownerQ.data) }, routers: routersQ.data || [], vouchers: vouchersQ.data || [], agents: agentsQ.data || [], payments: paymentsQ.data || [], audit: logsQ.data || [] };
  });

  fastify.get('/admin/routers', adminRateLimit, async (request) => {
    const limit = Math.min(Math.max(Number(request.query?.limit) || 200, 1), 500);
    const status = String(request.query?.status || '').trim();
    const { data, error } = await supabase.from('routers')
      .select('id,label,host,status,connection_mode,owner_id,last_connected_at,created_at,updated_at,owners(email,full_name),router_agents(id,status,routeros_version,architecture,board_name,agent_version,last_ip,last_seen_at,last_error,last_error_at)')
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    let routers = data || [];
    if (status) routers = routers.filter(r => r.status === status || r.router_agents?.[0]?.status === status);
    return { routers };
  });

  fastify.get('/admin/payments', adminRateLimit, async (request) => {
    const limit = Math.min(Math.max(Number(request.query?.limit) || 100, 1), 200);
    const status = String(request.query?.status || '').trim();
    const intentStatuses = ['created', 'pending', 'processing', 'succeeded', 'failed', 'expired', 'refunded', 'disputed', 'cancelled'];
    const [eventsQ, intentsQ] = await Promise.all([
      supabase.from('momo_events')
        .select('id,transaction_id,network,parsed_amount_ugx,parsed_reason_name,parsed_reason_phone,status,matched_owner_id,note,created_at,owners(email,full_name)')
        .order('created_at', { ascending: false }).limit(limit),
      supabase.from('payment_intents')
        .select('id,merchant_reference,provider,amount_ugx,payer_phone,status,provider_transaction_id,created_at,confirmed_at,owner_id,owners(email,full_name)')
        .order('created_at', { ascending: false }).limit(limit),
    ]);
    if (eventsQ.error) throw eventsQ.error;
    if (intentsQ.error) throw intentsQ.error;

    const events = (eventsQ.data || []).map((p) => ({
      ...p, source: 'momo_event', amount: p.parsed_amount_ugx, reference: p.transaction_id || p.parsed_reason_name,
    }));
    const intents = (intentsQ.data || []).map((p) => ({
      ...p, source: 'payment_intent', network: p.provider, parsed_amount_ugx: p.amount_ugx,
      parsed_reason_name: p.merchant_reference, transaction_id: p.provider_transaction_id,
      matched_owner_id: p.owner_id, note: p.payer_phone ? 'Payer: ' + p.payer_phone : null,
      created_at: p.created_at, amount: p.amount_ugx, reference: p.merchant_reference,
    }));

    let payments;
    if (intentStatuses.includes(status)) payments = intents.filter((p) => p.status === status);
    else if (status) payments = events.filter((p) => p.status === status);
    else payments = [...events, ...intents].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);

    return { payments, intents, events };
  });

  fastify.get('/admin/health', adminRateLimit, async () => {
    const [agents, commands, routers] = await Promise.all([
      supabase.from('router_agents').select('id,router_id,status,routeros_version,architecture,board_name,agent_version,last_ip,last_seen_at,last_error,last_error_at,owners(email,full_name),routers(label)'),
      supabase.from('router_agent_commands').select('id,agent_id,operation,status,error_message,created_at,started_at,completed_at,expires_at').order('created_at', { ascending: false }).limit(100),
      supabase.from('routers').select('id,label,status,connection_mode,owner_id,owners(email,full_name)').in('status', ['unreachable','unknown']).order('updated_at', { ascending: false }).limit(100),
    ]);
    return { agents: agents.data || [], commands: commands.data || [], problem_routers: routers.data || [] };
  });

  fastify.get('/admin/audit', adminRateLimit, async (request) => {
    const limit = Math.min(Math.max(Number(request.query?.limit) || 100, 1), 200);
    const { data, error } = await supabase.from('admin_audit_logs')
      .select('id,admin_id,action,target_type,target_id,metadata,created_at').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return { audit: data || [] };
  });

  const subscriptionSchema = z.object({
    status: z.enum(['trial', 'active', 'expired']),
    trial_ends_at: z.string().datetime().optional().nullable(),
    paid_until: z.string().datetime().optional().nullable(),
    days: z.number().int().min(1).max(3650).optional(),
    note: z.string().trim().max(500).optional(),
  });

  fastify.patch('/admin/owners/:id/subscription', adminRateLimit, async (request, reply) => {
    const { id } = request.params;
    const parsed = subscriptionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });
    const { data: before } = await supabase.from('owners').select('id,email,subscription_status,trial_ends_at,subscription_paid_until').eq('id', id).maybeSingle();
    if (!before) return reply.code(404).send({ error: 'Owner not found' });

    const update = { subscription_status: parsed.data.status };
    if (parsed.data.trial_ends_at !== undefined) update.trial_ends_at = parsed.data.trial_ends_at;
    if (parsed.data.paid_until !== undefined) update.subscription_paid_until = parsed.data.paid_until;
    if (parsed.data.days) {
      const base = before.subscription_paid_until && new Date(before.subscription_paid_until) > new Date() ? new Date(before.subscription_paid_until) : new Date();
      base.setUTCDate(base.getUTCDate() + parsed.data.days);
      update.subscription_paid_until = base.toISOString();
      update.subscription_status = 'active';
      update.trial_ends_at = null;
    } else if (parsed.data.status === 'active' && parsed.data.paid_until === undefined) update.trial_ends_at = null;

    const { data, error } = await supabase.from('owners').update(update).eq('id', id)
      .select('id,email,full_name,subscription_status,trial_ends_at,subscription_paid_until').single();
    if (error) return reply.code(500).send({ error: error.message });
    await writeAudit({ adminId: request.user?.id, action: parsed.data.days ? 'subscription.extend' : 'subscription.update', targetType: 'owner', targetId: id, metadata: { before, after: data, days: parsed.data.days || null, note: parsed.data.note || null } });
    return { success: true, owner: { ...data, effective_status: effectiveSubscription(data) } };
  });

  fastify.post('/admin/owners/:id/renew', adminRateLimit, async (request, reply) => {
    const parsed = z.object({ days: z.number().int().min(1).max(3650), note: z.string().trim().max(500).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'days must be between 1 and 3650' });
    const { data: before } = await supabase.from('owners').select('id,email,subscription_paid_until').eq('id', request.params.id).maybeSingle();
    if (!before) return reply.code(404).send({ error: 'Owner not found' });
    const base = before.subscription_paid_until && new Date(before.subscription_paid_until) > new Date() ? new Date(before.subscription_paid_until) : new Date();
    base.setUTCDate(base.getUTCDate() + parsed.data.days);
    const { data, error } = await supabase.from('owners').update({ subscription_status: 'active', subscription_paid_until: base.toISOString(), trial_ends_at: null })
      .eq('id', request.params.id).select('id,email,subscription_status,subscription_paid_until').single();
    if (error) return reply.code(500).send({ error: error.message });
    await writeAudit({ adminId: request.user?.id, action: 'subscription.renew', targetType: 'owner', targetId: request.params.id, metadata: { days: parsed.data.days, before, after: data, note: parsed.data.note || null } });
    return { success: true, owner: data };
  });

  fastify.post('/admin/owners/:id/mark-expired', adminRateLimit, async (request, reply) => {
    const { data, error } = await supabase.from('owners').update({ subscription_status: 'expired' }).eq('id', request.params.id)
      .select('id,email,subscription_status').maybeSingle();
    if (error) return reply.code(500).send({ error: error.message });
    if (!data) return reply.code(404).send({ error: 'Owner not found' });
    await writeAudit({ adminId: request.user?.id, action: 'subscription.expire', targetType: 'owner', targetId: request.params.id });
    return { success: true, owner: data };
  });
}
