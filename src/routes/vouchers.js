import { z } from 'zod';
import crypto from 'crypto';
import { requireAuth, requireActiveSubscription } from '../middleware/auth.js';
import { runAdaptiveRouterOperation } from '../services/router-agent.js';
import {
  minutesToUptime,
  mbToBytes,
} from '../services/mikrotik.js';

// Unguessable codes — 10 chars from unambiguous alphabet (no 0/O/1/I)
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateCode() {
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Generate `quantity` codes guaranteed not to already exist in the DB.
 * Collisions are astronomically unlikely (32^10 possibilities) but we check
 * anyway — we never want to create a user on the router with a code we
 * can't actually save, or worse, one that collides with someone else's.
 */
async function generateUniqueCodes(supabase, prefix, quantity) {
  const codes = new Set();
  let attempts = 0;

  while (codes.size < quantity && attempts < quantity + 20) {
    attempts++;
    const candidate = prefix + generateCode();
    if (!codes.has(candidate)) codes.add(candidate);
  }

  const candidateList = Array.from(codes);
  const { data: collisions } = await supabase
    .from('vouchers')
    .select('code')
    .in('code', candidateList);

  const collidingCodes = new Set((collisions || []).map((c) => c.code));
  if (collidingCodes.size === 0) {
    return candidateList.slice(0, quantity);
  }

  // Extremely rare path: regenerate just the colliding ones
  const clean = candidateList.filter((c) => !collidingCodes.has(c));
  const stillNeeded = quantity - clean.length;
  if (stillNeeded > 0) {
    const extra = await generateUniqueCodes(supabase, prefix, stillNeeded);
    return clean.concat(extra);
  }
  return clean.slice(0, quantity);
}

const generateSchema = z.object({
  profile_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(100), // hard limit per request
});

export default async function voucherRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireActiveSubscription);

  /**
   * POST /vouchers/generate
   * The most critical endpoint.
   * 1. Load profile + router
   * 2. Soft rate-limit check
   * 3. Live connection test
   * 4. Generate codes
   * 5. Create users on MikroTik
   * 6. Only then save vouchers to DB
   * If step 5 fails → nothing is saved.
   */
  fastify.post('/vouchers/generate', async (request, reply) => {
    const body = generateSchema.parse(request.body);
    const ownerId = request.user.id;

    // 1. Load profile + router (ownership enforced)
    const { data: profile, error: profileError } = await request.supabase
      .from('profiles')
      .select(`
        *,
        routers!inner (
          id, host, api_port, api_tls, api_username, api_password_encrypted, connection_mode, status, owner_id
        )
      `)
      .eq('id', body.profile_id)
      .eq('routers.owner_id', ownerId)
      .eq('is_active', true)
      .single();

    if (profileError || !profile) {
      return reply.code(404).send({ error: 'Profile not found' });
    }

    const router = profile.routers;

    // 2. Soft daily limit (500 per day per owner — adjustable later)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { count: todayCount } = await request.supabase
      .from('voucher_generation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('success', true)
      .gte('created_at', startOfDay.toISOString());

    if ((todayCount || 0) + body.quantity > 500) {
      return reply.code(429).send({
        error: 'Daily limit reached',
        message: `You can generate up to 500 vouchers per day. Today you have already generated ${todayCount || 0}.`,
      });
    }

    // 3. Verify the router path. Connector mode checks the outbound connector;
    // direct mode checks RouterOS directly.
    try {
      await runAdaptiveRouterOperation(router, 'test');
    } catch (err) {
      await request.supabase.from('voucher_generation_logs').insert({
        owner_id: ownerId,
        router_id: router.id,
        quantity: body.quantity,
        success: false,
        error_message: err.message,
      });
      await request.supabase.from('routers').update({ status: 'unreachable' }).eq('id', router.id);
      return reply.code(400).send({
        success: false,
        error: router.connection_mode === 'connector' ? 'Remote router unavailable' : 'Router unreachable',
        message: err.message,
        hint: 'Vouchers were NOT created. Check the router or connector connection and try again.',
      });
    }

    // 5. Generate codes — checked against the DB for collisions first
    const prefix = profile.code_prefix || '';
    const codes = await generateUniqueCodes(request.supabase, prefix, body.quantity);

    // Prepare MikroTik user objects
    const limitUptime = minutesToUptime(profile.duration_minutes);
    const limitBytes = mbToBytes(profile.data_limit_mb);

    const mikrotikUsers = codes.map((code) => ({
      name: code,
      password: code, // simple: code is both username & password
      limitUptime: limitUptime || undefined,
      limitBytesTotal: limitBytes || undefined,
      comment: `Voucher | ${profile.name} | generated ${new Date().toISOString().slice(0, 10)}`,
    }));

    // 6. Create on the router FIRST
    let createResult;
    try {
      createResult = await runAdaptiveRouterOperation(router, 'create_users', { users: mikrotikUsers }, 30000);
    } catch (err) {
      await request.supabase.from('voucher_generation_logs').insert({
        owner_id: ownerId,
        router_id: router.id,
        quantity: body.quantity,
        success: false,
        error_message: err.message,
      });

      return reply.code(500).send({
        success: false,
        error: 'Failed to create users on the router',
        message: err.message,
        details: err.details || null,
        hint: 'No vouchers were saved. The router rejected the users.',
      });
    }

    // If some failed but some succeeded, we only keep the successful ones
    const successfulCodes = createResult.created;

    if (successfulCodes.length === 0) {
      return reply.code(500).send({
        success: false,
        error: 'No users were created on the router',
        details: createResult.errors,
      });
    }

    // 7. Only now save successful vouchers to DB
    const voucherRows = successfulCodes.map((code) => ({
      profile_id: profile.id,
      router_id: router.id,
      owner_id: ownerId,
      code,
      status: 'unused',
    }));

    const { data: savedVouchers, error: saveError } = await request.supabase
      .from('vouchers')
      .insert(voucherRows)
      .select('id, code, status, created_at');

    if (saveError) {
      let cleanup = null;
      try {
        cleanup = await runAdaptiveRouterOperation(router, 'delete_users', { names: successfulCodes }, 30000);
      } catch (cleanupError) {
        cleanup = { deleted: [], errors: [{ code: 'CLEANUP_FAILED', error: cleanupError.message }] };
      }
      console.error('CRITICAL: Router voucher users reconciled after DB save failure', { saveError, cleanup });
      return reply.code(500).send({
        success: false,
        error: 'Voucher records could not be saved safely',
        message: cleanup?.errors?.length
          ? 'The router could not be fully reconciled. Contact support before selling these codes.'
          : 'Voucher creation was rolled back because the database could not save the records.',
        cleanup,
      });
    }

    // Update router last_connected
    await request.supabase
      .from('routers')
      .update({
        status: 'connected',
        last_connected_at: new Date().toISOString(),
      })
      .eq('id', router.id);

    // Log success
    await request.supabase.from('voucher_generation_logs').insert({
      owner_id: ownerId,
      router_id: router.id,
      quantity: successfulCodes.length,
      success: true,
    });

    return {
      success: true,
      message: `Successfully created ${successfulCodes.length} voucher(s)`,
      vouchers: savedVouchers,
      partialFailures: createResult.errors.length > 0 ? createResult.errors : undefined,
    };
  });

  /**
   * POST /vouchers/sync
   * Reads real usage back from the router (time/data actually
   * consumed per voucher) and updates status accordingly — this is
   * what makes the dashboard reflect reality instead of showing
   * every voucher as "unused" forever. On-demand (owner clicks
   * "Refresh status"), not a background job — no scheduler exists
   * in this app yet and adding one is a separate decision.
   */
  fastify.post('/vouchers/sync', async (request, reply) => {
    const { router_id } = z.object({ router_id: z.string().uuid() }).parse(request.query);
    const ownerId = request.user.id;

    const { data: router, error: routerError } = await request.supabase
      .from('routers')
      .select('id, host, api_port, api_tls, api_username, api_password_encrypted, connection_mode')
      .eq('id', router_id)
      .eq('owner_id', ownerId)
      .single();

    if (routerError || !router) {
      return reply.code(404).send({ error: 'Router not found' });
    }

    // Only vouchers that could still be mid-life — no point re-checking
    // ones already marked expired/disabled.
    const { data: vouchers, error: vouchersError } = await request.supabase
      .from('vouchers')
      .select('id, code, status, activated_at, profiles(duration_minutes)')
      .eq('router_id', router_id)
      .eq('owner_id', ownerId)
      .in('status', ['unused', 'active']);

    if (vouchersError) {
      return reply.code(500).send({ error: vouchersError.message });
    }
    if (!vouchers || vouchers.length === 0) {
      return { success: true, message: 'Nothing to sync', updated: 0 };
    }

    let usage;
    try {
      usage = await runAdaptiveRouterOperation(router, 'usage', {
        codes: vouchers.map((v) => v.code),
      }, 20000);
;
    } catch (err) {
      return reply.code(400).send({
        error: 'Router unreachable',
        message: err.message,
        hint: 'Voucher statuses were not changed.',
      });
    }

    const now = new Date().toISOString();
    let updatedCount = 0;

    for (const voucher of vouchers) {
      const u = usage[voucher.code];
      if (!u) continue;

      let newStatus = voucher.status;
      if (!u.exists) {
        // No longer on the router — someone/something removed it there.
        newStatus = 'disabled';
      } else {
        const exhausted =
          (u.limitUptimeSeconds > 0 && u.uptimeSeconds >= u.limitUptimeSeconds) ||
          (u.limitBytesTotal > 0 && u.bytesTotal >= u.limitBytesTotal);
        const used = u.uptimeSeconds > 0 || u.bytesTotal > 0;
        newStatus = exhausted ? 'expired' : used ? 'active' : 'unused';
      }

      if (newStatus === voucher.status) continue;

      const updates = { status: newStatus };
      if (newStatus !== 'unused' && !voucher.activated_at) {
        updates.activated_at = now;
        const durationMinutes = voucher.profiles?.duration_minutes;
        if (durationMinutes) {
          updates.expires_at = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
        }
      }

      const { error: updateError } = await request.supabase
        .from('vouchers')
        .update(updates)
        .eq('id', voucher.id);

      if (!updateError) updatedCount++;
    }

    return { success: true, message: `Synced ${vouchers.length} voucher(s)`, updated: updatedCount };
  });

  /**
   * GET /vouchers
   * List vouchers with optional filters
   */
  fastify.get('/vouchers', async (request, reply) => {
    const { router_id, profile_id, status, limit = 100 } = request.query;

    let query = request.supabase
      .from('vouchers')
      .select('id, code, status, created_at, activated_at, expires_at, profile_id, router_id, profiles(name)')
      .eq('owner_id', request.user.id)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(limit) || 100, 500));

    if (router_id) query = query.eq('router_id', router_id);
    if (profile_id) query = query.eq('profile_id', profile_id);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    return { vouchers: data };
  });

  /**
   * GET /vouchers/export
   * Simple text/CSV export
   */
  fastify.get('/vouchers/export', async (request, reply) => {
    const { router_id, profile_id, format = 'text' } = request.query;

    let query = request.supabase
      .from('vouchers')
      .select('code, status, created_at, profiles(name)')
      .eq('owner_id', request.user.id)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (router_id) query = query.eq('router_id', router_id);
    if (profile_id) query = query.eq('profile_id', profile_id);

    const { data, error } = await query;

    if (error) {
      return reply.code(500).send({ error: error.message });
    }

    if (format === 'csv') {
      const header = 'code,status,profile,created_at\n';
      const rows = (data || [])
        .map((v) => `${v.code},${v.status},${v.profiles?.name || ''},${v.created_at}`)
        .join('\n');
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="vouchers.csv"');
      return header + rows;
    }

    // Plain text — one code per line (easy to copy/print)
    const text = (data || []).map((v) => v.code).join('\n');
    reply.header('Content-Type', 'text/plain');
    reply.header('Content-Disposition', 'attachment; filename="vouchers.txt"');
    return text;
  });
}
