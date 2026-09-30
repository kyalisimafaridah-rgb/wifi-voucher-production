(function () {
  'use strict';

  var adminBound = false;
  var activeTab = 'overview';

  function esc(v) {
    return typeof window.escapeHtml === 'function' ? window.escapeHtml(v == null ? '' : String(v)) : String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[c];
    });
  }
  function money(v) { return new Intl.NumberFormat('en-UG').format(Number(v || 0)) + ' UGX'; }
  function date(v) { return v ? new Date(v).toLocaleString() : '—'; }
  function shortDate(v) { return v ? new Date(v).toLocaleDateString() : '—'; }
  function statusBadge(s) { return '<span class="badge ' + esc(String(s || 'unknown')) + '">' + esc(String(s || 'unknown')) + '</span>'; }
  function el(id) { return document.getElementById(id); }

  async function get(path) {
    return window.__wvApi ? window.__wvApi(path) : Promise.reject(new Error('Admin API is not ready. Refresh the page.'));
  }
  async function send(path, options) {
    return window.__wvApi ? window.__wvApi(path, options) : Promise.reject(new Error('Admin API is not ready. Refresh the page.'));
  }

  function showError(err) {
    var box = el('admin-dash-error');
    if (!box) return;
    box.textContent = err && err.message ? err.message : String(err);
    box.classList.remove('hidden');
  }
  function clearError() {
    var box = el('admin-dash-error');
    if (box) { box.textContent = ''; box.classList.add('hidden'); }
  }

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.admin-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-admin-tab') === tab);
      b.setAttribute('aria-selected', b.getAttribute('data-admin-tab') === tab ? 'true' : 'false');
    });
    document.querySelectorAll('.admin-tab-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.id !== 'admin-tab-' + tab);
    });
    if (tab === 'customers') loadCustomers();
    if (tab === 'routers') loadAdminRouters();
    if (tab === 'payments') loadPayments();
    if (tab === 'health') loadHealth();
    if (tab === 'audit') loadAudit();
  }

  function bind() {
    if (adminBound) return;
    adminBound = true;
    document.querySelectorAll('.admin-tab').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-admin-tab')); });
    });
    el('admin-refresh-btn')?.addEventListener('click', loadAll);
    el('admin-customer-status')?.addEventListener('change', loadCustomers);
    el('admin-router-status')?.addEventListener('change', loadAdminRouters);
    el('admin-payment-status')?.addEventListener('change', loadPayments);
    var searchTimer;
    el('admin-customer-search')?.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadCustomers, 250);
    });
    el('admin-owner-close')?.addEventListener('click', closeOwnerDetail);
  }

  function renderStats(s) {
    var grid = el('admin-stats-grid');
    if (!grid) return;
    var cards = [
      ['Customers', s.owners, s.active_owners + ' active'],
      ['Trial', s.trial_owners, 'currently in trial'],
      ['Expired', s.expired_owners, 'need renewal'],
      ['Routers', s.routers, s.connected_routers + ' connected'],
      ['Vouchers', s.vouchers, s.active_vouchers + ' active'],
      ['Revenue', money(s.revenue_ugx), money(s.revenue_30d_ugx) + ' / 30 days'],
      ['Agents', s.agents, s.online_agents + ' online'],
      ['Attention', s.payments_needing_review + s.failed_commands, s.payments_needing_review + ' payments · ' + s.failed_commands + ' commands'],
    ];
    grid.innerHTML = cards.map(function (c) {
      return '<div class="admin-stat-card"><span>' + esc(c[0]) + '</span><strong>' + esc(c[1]) + '</strong><em>' + esc(c[2]) + '</em></div>';
    }).join('');
    el('admin-business-pulse').innerHTML =
      '<div class="admin-metric-row"><span>Matched payments</span><strong>' + esc(s.matched_payments) + '</strong></div>' +
      '<div class="admin-metric-row"><span>Matched in last 30 days</span><strong>' + esc(s.matched_payments_30d) + '</strong></div>' +
      '<div class="admin-metric-row"><span>Offline routers</span><strong>' + esc(s.offline_routers) + '</strong></div>' +
      '<div class="admin-metric-row"><span>Failed agent commands</span><strong>' + esc(s.failed_commands) + '</strong></div>';
    var attention = [];
    if (s.expired_owners) attention.push(['Customers expired', s.expired_owners, 'customers']);
    if (s.offline_routers) attention.push(['Routers unreachable', s.offline_routers, 'routers']);
    if (s.payments_needing_review) attention.push(['Payments to review', s.payments_needing_review, 'payments']);
    if (s.failed_commands) attention.push(['Failed router commands', s.failed_commands, 'health']);
    el('admin-attention-list').innerHTML = attention.length ? attention.map(function (a) {
      return '<button class="admin-attention-row" data-attention-tab="' + a[2] + '"><span>' + esc(a[0]) + '</span><strong>' + esc(a[1]) + '</strong><span>›</span></button>';
    }).join('') : '<div class="success-result"><strong>Everything looks quiet.</strong><span>No current admin action is flagged.</span></div>';
    document.querySelectorAll('[data-attention-tab]').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.attentionTab); }); });
  }

  async function loadCustomers() {
    var body = el('admin-customers-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6" class="loading-placeholder">Loading customers…</td></tr>';
    try {
      var q = new URLSearchParams();
      var search = el('admin-customer-search')?.value.trim();
      var status = el('admin-customer-status')?.value;
      if (search) q.set('search', search);
      if (status) q.set('status', status);
      var data = await get('/admin/owners?' + q.toString());
      if (!data.owners.length) { body.innerHTML = '<tr><td colspan="6" class="hint">No customers match this filter.</td></tr>'; return; }
      body.innerHTML = data.owners.map(function (o) {
        return '<tr>' +
          '<td><strong>' + esc(o.full_name || 'Unnamed') + '</strong><div class="table-sub">' + esc(o.email) + '</div></td>' +
          '<td>' + statusBadge(o.effective_status) + '</td>' +
          '<td>' + esc(o.router_count) + '</td>' +
          '<td>' + esc(o.voucher_count) + '</td>' +
          '<td>' + esc(shortDate(o.subscription_paid_until)) + '</td>' +
          '<td class="admin-actions"><button class="btn small" data-owner-detail="' + esc(o.id) + '">Open</button><button class="btn small primary" data-owner-renew="' + esc(o.id) + '">Renew</button></td>' +
          '</tr>';
      }).join('');
      body.querySelectorAll('[data-owner-detail]').forEach(function (b) { b.addEventListener('click', function () { openOwnerDetail(b.dataset.ownerDetail); }); });
      body.querySelectorAll('[data-owner-renew]').forEach(function (b) { b.addEventListener('click', function () { renewOwner(b.dataset.ownerRenew); }); });
    } catch (err) { body.innerHTML = '<tr><td colspan="6" class="error">' + esc(err.message) + '</td></tr>'; }
  }

  async function renewOwner(id) {
    var raw = window.prompt('Renew this customer for how many days?', '30');
    if (raw === null) return;
    var days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) { window.alert('Enter a whole number from 1 to 3650.'); return; }
    try {
      await send('/admin/owners/' + encodeURIComponent(id) + '/renew', { method: 'POST', body: JSON.stringify({ days: days }) });
      if (window.showToast) window.showToast('Subscription renewed for ' + days + ' days.', 'success');
      await loadCustomers();
      await loadAll();
    } catch (err) { window.alert(err.message || 'Renewal failed.'); }
  }

  async function openOwnerDetail(id) {
    var modal = el('admin-owner-modal');
    var body = el('admin-owner-detail');
    if (!modal || !body) return;
    modal.classList.remove('hidden');
    body.innerHTML = '<p class="loading-placeholder">Loading customer…</p>';
    try {
      var d = await get('/admin/owners/' + encodeURIComponent(id));
      el('admin-owner-title').textContent = d.owner.full_name || d.owner.email;
      el('admin-owner-subtitle').textContent = d.owner.email + ' · ' + d.owner.effective_status;
      var routers = d.routers || [];
      var agents = d.agents || [];
      var payments = d.payments || [];
      var audit = d.audit || [];
      body.innerHTML =
        '<div class="admin-detail-grid">' +
          '<div><span>Status</span><strong>' + statusBadge(d.owner.effective_status) + '</strong></div>' +
          '<div><span>Created</span><strong>' + esc(shortDate(d.owner.created_at)) + '</strong></div>' +
          '<div><span>Paid until</span><strong>' + esc(shortDate(d.owner.subscription_paid_until)) + '</strong></div>' +
          '<div><span>MoMo name</span><strong>' + esc(d.owner.momo_registered_name || 'Not set') + '</strong></div>' +
        '</div>' +
        '<div class="admin-detail-section"><div class="panel-header"><h3>Subscription</h3><div class="admin-actions"><button class="btn small primary" data-detail-renew="' + esc(d.owner.id) + '">Renew</button><button class="btn small danger" data-detail-expire="' + esc(d.owner.id) + '">Mark expired</button></div></div></div>' +
        '<div class="admin-detail-section"><h3>Routers</h3>' + (routers.length ? routers.map(function(r){ var a=agents.find(function(x){return x.router_id===r.id;}); return '<div class="admin-detail-row"><div><strong>'+esc(r.label)+'</strong><span>'+esc(r.connection_mode||'direct')+'</span></div><div>'+statusBadge(a?.status || r.status)+'</div><div>'+esc(a?.routeros_version || '—')+'</div><div>Last seen '+esc(date(a?.last_seen_at || r.last_connected_at))+'</div></div>'; }).join('') : '<p class="hint">No routers yet.</p>') + '</div>' +
        '<div class="admin-detail-section"><h3>Recent payments</h3>' + (payments.length ? payments.slice(0,10).map(function(p){return '<div class="admin-detail-row"><div><strong>'+esc(p.network.toUpperCase())+'</strong><span>'+esc(p.transaction_id||'No transaction ID')+'</span></div><div>'+money(p.parsed_amount_ugx)+'</div><div>'+statusBadge(p.status)+'</div><div>'+esc(date(p.created_at))+'</div></div>';}).join('') : '<p class="hint">No matched payments recorded.</p>') + '</div>' +
        '<div class="admin-detail-section"><h3>Admin history</h3>' + (audit.length ? audit.slice(0,10).map(function(a){return '<div class="admin-detail-row"><div><strong>'+esc(a.action)+'</strong></div><div>'+esc(date(a.created_at))+'</div><div>'+esc(JSON.stringify(a.metadata||{}))+'</div></div>';}).join('') : '<p class="hint">No admin actions recorded.</p>') + '</div>';
      body.querySelector('[data-detail-renew]')?.addEventListener('click', function(){ renewOwner(d.owner.id); });
      body.querySelector('[data-detail-expire]')?.addEventListener('click', async function(){
        if (!window.confirm('Mark this subscription expired?')) return;
        try { await send('/admin/owners/'+encodeURIComponent(d.owner.id)+'/mark-expired',{method:'POST'}); if(window.showToast) window.showToast('Subscription marked expired.','success'); await openOwnerDetail(d.owner.id); await loadAll(); } catch(e){ window.alert(e.message); }
      });
    } catch (err) { body.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; }
  }

  function closeOwnerDetail() { el('admin-owner-modal')?.classList.add('hidden'); }

  async function loadAdminRouters() {
    var body = el('admin-routers-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6" class="loading-placeholder">Loading routers…</td></tr>';
    try {
      var status = el('admin-router-status')?.value || '';
      var data = await get('/admin/routers?limit=500' + (status ? '&status=' + encodeURIComponent(status) : ''));
      body.innerHTML = data.routers.length ? data.routers.map(function(r){
        var a = Array.isArray(r.router_agents) ? r.router_agents[0] : r.router_agents;
        var owner = r.owners || {};
        return '<tr><td><strong>'+esc(r.label)+'</strong><div class="table-sub">'+esc(r.host || 'Agent-managed')+'</div></td><td>'+esc(owner.full_name || owner.email || '—')+'</td><td>'+esc(r.connection_mode || 'direct')+'</td><td>'+esc(a?.routeros_version || '—')+'</td><td>'+esc(date(a?.last_seen_at || r.last_connected_at))+'</td><td>'+statusBadge(a?.status || r.status)+'</td></tr>';
      }).join('') : '<tr><td colspan="6" class="hint">No routers match this filter.</td></tr>';
    } catch(err) { body.innerHTML = '<tr><td colspan="6" class="error">'+esc(err.message)+'</td></tr>'; }
  }

  async function loadPayments() {
    var body = el('admin-payments-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6" class="loading-placeholder">Loading payments…</td></tr>';
    try {
      var status = el('admin-payment-status')?.value || '';
      var data = await get('/admin/payments?limit=200' + (status ? '&status=' + encodeURIComponent(status) : ''));
      body.innerHTML = data.payments.length ? data.payments.map(function(p){
        var owner = p.owners || {};
        return '<tr><td>'+esc(date(p.created_at))+'</td><td>'+esc(String(p.network||'').toUpperCase())+'</td><td><strong>'+esc(money(p.parsed_amount_ugx))+'</strong></td><td>'+esc(owner.full_name || owner.email || p.parsed_reason_name || 'Unmatched')+'</td><td>'+statusBadge(p.status)+'</td><td>'+esc(p.transaction_id || '—')+'</td></tr>';
      }).join('') : '<tr><td colspan="6" class="hint">No payments match this filter.</td></tr>';
    } catch(err) { body.innerHTML = '<tr><td colspan="6" class="error">'+esc(err.message)+'</td></tr>'; }
  }

  async function loadHealth() {
    try {
      var d = await get('/admin/health');
      el('admin-agents-list').innerHTML = d.agents.length ? d.agents.map(function(a){
        return '<div class="admin-list-row"><div><strong>'+esc(a.routers?.label || 'Router')+'</strong><span>'+esc(a.owners?.full_name || a.owners?.email || '—')+'</span></div><div>'+statusBadge(a.status)+'</div><div><span>RouterOS '+esc(a.routeros_version||'—')+'</span><span>Last seen '+esc(date(a.last_seen_at))+'</span></div></div>';
      }).join('') : '<p class="hint">No cloud agents registered.</p>';
      var failed = d.commands.filter(function(c){return c.status==='failed'||c.status==='expired';});
      el('admin-command-list').innerHTML = failed.length ? failed.slice(0,20).map(function(c){return '<div class="admin-list-row"><div><strong>'+esc(c.operation)+'</strong><span>'+esc(c.error_message||'Command failed')+'</span></div><div>'+statusBadge(c.status)+'</div><div>'+esc(date(c.created_at))+'</div></div>';}).join('') : '<p class="hint">No recent failed or expired commands.</p>';
      el('admin-problem-routers').innerHTML = d.problem_routers.length ? d.problem_routers.map(function(r){return '<div class="admin-list-row"><div><strong>'+esc(r.label)+'</strong><span>'+esc(r.owners?.full_name||r.owners?.email||'—')+'</span></div><div>'+statusBadge(r.status)+'</div><div>'+esc(r.connection_mode||'direct')+'</div></div>';}).join('') : '<p class="hint">No routers are currently flagged.</p>';
    } catch(err) { showError(err); }
  }

  async function loadAudit() {
    var body = el('admin-audit-body');
    if (!body) return;
    try {
      var d = await get('/admin/audit?limit=200');
      body.innerHTML = d.audit.length ? d.audit.map(function(a){return '<tr><td>'+esc(date(a.created_at))+'</td><td><strong>'+esc(a.action)+'</strong></td><td>'+esc((a.target_type||'')+' '+(a.target_id||''))+'</td><td><code>'+esc(JSON.stringify(a.metadata||{}))+'</code></td></tr>';}).join('') : '<tr><td colspan="4" class="hint">No admin actions yet.</td></tr>';
    } catch(err) { body.innerHTML = '<tr><td colspan="4" class="error">'+esc(err.message)+'</td></tr>'; }
  }

  async function loadAll() {
    clearError();
    bind();
    try {
      var stats = await get('/admin/stats');
      renderStats(stats);
      await Promise.all([loadCustomers(), loadAdminRouters(), loadPayments(), loadHealth(), loadAudit()]);
    } catch (err) {
      showError(err);
      if (window.showToast) window.showToast('Admin data could not be loaded: ' + err.message, 'error');
    }
  }

  window.showAdminScreen = async function () {
    ['auth-screen','recovery-screen','expired-screen','dashboard'].forEach(function(id){ var node=el(id); if(node) node.classList.add('hidden'); });
    var admin = el('admin-screen');
    if (admin) admin.classList.remove('hidden');
    try { var me = await get('/me'); el('admin-email-display').textContent = me.owner?.email || me.email || ''; } catch (_) {}
    bind();
    await loadAll();
    setTab(activeTab);
  };
  window.loadAdminData = loadAll;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
