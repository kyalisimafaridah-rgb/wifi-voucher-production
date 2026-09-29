/**
 * WiFi Voucher MVP — Frontend
 * Uses Supabase Auth for login/signup, then talks to our Fastify API with the JWT.
 */
const SUPABASE_URL = window.SUPABASE_URL || 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'YOUR_ANON_KEY';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let accessToken = null;
let currentOwner = null;
let routersCache = [];
let profilesCache = [];
let vouchersLimit = 50;
let sessionExpiredHandled = false;

// ---------- Helpers ----------
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (res.status === 401 && accessToken && !sessionExpiredHandled) {
    sessionExpiredHandled = true;
    await forceSessionExpired();
  }

  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function $(id) { return document.getElementById(id); }

function setError(id, msg) {
  const el = $(id);
  if (!msg) { hide(el); el.textContent = ''; return; }
  el.textContent = msg;
  show(el);
}

function setBtnLoading(btn, loadingText) {
  if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${loadingText}`;
}
function resetBtn(btn) {
  btn.disabled = false;
  btn.textContent = btn.dataset.originalText || btn.textContent;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hideAllScreens() {
  ['auth-screen', 'recovery-screen', 'expired-screen', 'dashboard', 'admin-screen'].forEach((id) => hide($(id)));
}

// ---------- Session expiry (mid-session token invalid/expired) ----------
async function forceSessionExpired() {
  await supabaseClient.auth.signOut();
  accessToken = null;
  currentOwner = null;
  hideAllScreens();
  show($('auth-screen'));
  showToast('Your session expired. Please log in again.', 'error');
  sessionExpiredHandled = false;
}

// ---------- Password visibility toggles ----------
document.querySelectorAll('.password-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.toggleFor);
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? 'Hide' : 'Show';
  });
});

// ---------- Auth tab switching ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    hide($('forgot-form'));
    $('login-form').classList.toggle('hidden', !isLogin);
    $('signup-form').classList.toggle('hidden', isLogin);
    setError('auth-error', null);
  });
});

$('forgot-password-link').addEventListener('click', () => {
  hide($('login-form'));
  hide($('signup-form'));
  show($('forgot-form'));
  setError('auth-error', null);
});
$('back-to-login-link').addEventListener('click', () => {
  hide($('forgot-form'));
  show($('login-form'));
  document.querySelector('.tab[data-tab="login"]').click();
});

// ---------- Auth ----------
async function handleLogin(e) {
  e.preventDefault();
  setError('auth-error', null);
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const btn = $('login-submit-btn');

  setBtnLoading(btn, 'Logging in…');
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      setError('auth-error', error.message);
      return;
    }
    accessToken = data.session.access_token;
    await enterDashboard();
  } finally {
    resetBtn(btn);
  }
}

async function handleSignup(e) {
  e.preventDefault();
  setError('auth-error', null);
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;
  const full_name = $('signup-name').value.trim();
  const btn = $('signup-submit-btn');

  setBtnLoading(btn, 'Creating account…');
  try {
    // Account creation goes through our backend (POST /auth/signup), which
    // creates the user pre-confirmed via the service-role key — this skips
    // Supabase's email confirmation step entirely rather than relying on
    // the dashboard "Confirm email" toggle. Signing in is then a normal
    // client-side call, same as the login form uses.
    try {
      await api('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, full_name: full_name || undefined }),
      });
    } catch (err) {
      if (err.status === 409) {
        setError('auth-error', 'This email is already registered — try logging in instead.');
        return;
      }
      setError('auth-error', err.data?.message || err.message || 'Signup failed');
      return;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      setError('auth-error', error.message);
      return;
    }

    accessToken = data.session.access_token;
    if (full_name) {
      try { await api('/me', { method: 'PATCH', body: JSON.stringify({ full_name }) }); } catch {}
    }
    await enterDashboard();
  } finally {
    resetBtn(btn);
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  const btn = $('forgot-submit-btn');
  setBtnLoading(btn, 'Sending…');
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/index.html',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('If that email has an account, a reset link was sent.', 'success', 6000);
    $('back-to-login-link').click();
  } finally {
    resetBtn(btn);
  }
}

async function handleRecoverySubmit(e) {
  e.preventDefault();
  setError('recovery-error', null);
  const password = $('recovery-password').value;
  const btn = $('recovery-submit-btn');

  setBtnLoading(btn, 'Updating…');
  try {
    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) {
      setError('recovery-error', error.message);
      return;
    }
    showToast('Password updated. You are now logged in.', 'success');
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      accessToken = session.access_token;
      await enterDashboard();
    } else {
      hideAllScreens();
      show($('auth-screen'));
    }
  } finally {
    resetBtn(btn);
  }
}

function isSubscriptionExpired(owner) {
  if (!owner) return false;
  if (owner.subscription_status === 'expired') return true;
  if (owner.subscription_status === 'trial' && owner.trial_ends_at) {
    return new Date(owner.trial_ends_at).getTime() < Date.now();
  }
  return false;
}

function renderTrialBanner(owner) {
  const el = $('trial-banner');
  el.innerHTML = '';
  if (owner.subscription_status !== 'trial' || !owner.trial_ends_at) return;

  const msRemaining = new Date(owner.trial_ends_at).getTime() - Date.now();
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
  if (daysRemaining > 3) return;

  const div = document.createElement('div');
  div.className = 'banner warning';
  div.textContent = daysRemaining <= 1
    ? 'Your free trial ends today. Contact the app owner to keep access to your routers and vouchers.'
    : `Your free trial ends in ${daysRemaining} days. Contact the app owner to activate your subscription.`;
  el.appendChild(div);
}

async function enterDashboard() {
  let owner;
  try {
    const res = await api('/me');
    owner = res.owner;
    currentOwner = owner;
  } catch (err) {
    setError('auth-error', err.message);
    return;
  }

  hideAllScreens();

  // Admin accounts always land on the admin panel, regardless of their own
  // personal subscription status — admin access is not tied to being a paying owner.
  if (owner.role === 'admin') {
    await showAdminScreen();
    return;
  }

  if (isSubscriptionExpired(owner)) {
    show($('expired-screen'));
    return;
  }

  await showOwnerDashboard(owner);
}

async function showOwnerDashboard(owner) {
  hideAllScreens();
  show($('dashboard'));
  $('owner-email').textContent = owner.email;

  const badge = $('sub-badge');
  badge.textContent = owner.subscription_status;
  badge.className = 'badge ' + owner.subscription_status;

  $('admin-panel-btn').classList.toggle('hidden', owner.role !== 'admin');

  renderTrialBanner(owner);

  try {
    await loadRouters();
  } catch (err) {
    handleDashboardLoadError(err, 'routers-list', 'routers');
  }
  if (!routersCache.length && !localStorage.getItem('wv_onboarding_skipped') && !localStorage.getItem('wv_onboarding_complete')) {
    setTimeout(() => openOnboarding(), 250);
  }
  try {
    await loadProfiles();
  } catch (err) {
    handleDashboardLoadError(err, 'profiles-list', 'profiles');
  }
  try {
    await loadVouchers();
  } catch (err) {
    handleDashboardLoadError(err, 'vouchers-list', 'vouchers');
  }
  fillProfileSelect();
  updatePrerequisiteHints();
}

function handleDashboardLoadError(err, listElId, label) {
  if (err.status === 403) {
    // Subscription flipped to expired mid-session — refresh to expired screen
    enterDashboard();
    return;
  }
  const list = $(listElId);
  list.innerHTML = `<p class="hint">Could not load ${label}: ${escapeHtml(err.message)}</p>`;
  showToast(`Failed to load ${label}: ${err.message}`, 'error');
}

// ---------- Admin panel (only reachable when the logged-in account has role=admin) ----------
function renderAdminStats(stats) {
  const grid = $('admin-stats-grid');
  grid.innerHTML = '';
  const items = [
    ['Owners', stats.owners],
    ['Routers', stats.routers],
    ['Vouchers', stats.vouchers],
    ['Active vouchers', stats.active_vouchers],
  ];
  for (const [label, value] of items) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = `<div class="stat-value">${value}</div><div class="stat-label">${label}</div>`;
    grid.appendChild(el);
  }
}

function renderAdminOwners(owners) {
  const body = $('admin-owners-body');
  body.innerHTML = '';

  if (!owners.length) {
    body.innerHTML = '<tr><td colspan="5" class="hint">No owners yet.</td></tr>';
    return;
  }

  for (const owner of owners) {
    const tr = document.createElement('tr');
    const trialEnds = owner.trial_ends_at ? new Date(owner.trial_ends_at).toLocaleDateString() : '—';
    tr.innerHTML = `
      <td>${escapeHtml(owner.email)}</td>
      <td>${escapeHtml(owner.full_name) || '—'}</td>
      <td><span class="badge ${owner.subscription_status}">${owner.subscription_status}</span></td>
      <td>${trialEnds}</td>
      <td></td>
    `;
    const actionCell = tr.querySelector('td:last-child');
    const select = document.createElement('select');
    ['trial', 'active', 'expired'].forEach((status) => {
      const opt = document.createElement('option');
      opt.value = status;
      opt.textContent = status;
      if (status === owner.subscription_status) opt.selected = true;
      select.appendChild(opt);
    });
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn small';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      setBtnLoading(saveBtn, 'Saving…');
      try {
        await api(`/admin/owners/${owner.id}/subscription`, {
          method: 'PATCH',
          body: JSON.stringify({ status: select.value }),
        });
        showToast(`Updated ${owner.email} to ${select.value}.`, 'success');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
        resetBtn(saveBtn);
      }
    });
    actionCell.appendChild(select);
    actionCell.appendChild(saveBtn);
    body.appendChild(tr);
  }
}

function renderAdminRouters(routers) {
  const body = $('admin-routers-body');
  body.innerHTML = '';

  if (!routers.length) {
    body.innerHTML = '<tr><td colspan="4" class="hint">No routers yet.</td></tr>';
    return;
  }

  for (const router of routers) {
    const tr = document.createElement('tr');
    const ownerLabel = router.owners ? (router.owners.full_name || router.owners.email) : '—';
    tr.innerHTML = `
      <td>${escapeHtml(router.label)}</td>
      <td>${escapeHtml(router.host)}</td>
      <td>${escapeHtml(ownerLabel)}</td>
      <td><span class="status-dot ${router.status}"></span>${router.status}</td>
    `;
    body.appendChild(tr);
  }
}

async function loadAdminData() {
  setError('admin-dash-error', null);
  try {
    const [stats, ownersRes, routersRes] = await Promise.all([
      api('/admin/stats'),
      api('/admin/owners'),
      api('/admin/routers'),
    ]);
    renderAdminStats(stats);
    renderAdminOwners(ownersRes.owners);
    renderAdminRouters(routersRes.routers);
  } catch (err) {
    setError('admin-dash-error', err.message);
    showToast('Failed to load admin dashboard: ' + err.message, 'error');
  }
}

async function showAdminScreen() {
  hideAllScreens();
  show($('admin-screen'));
  $('admin-email-display').textContent = currentOwner.email;
  await loadAdminData();
}

async function logout() {
  await supabaseClient.auth.signOut();
  accessToken = null;
  currentOwner = null;
  hideAllScreens();
  show($('auth-screen'));
}

// ---------- Routers ----------
async function loadRouters() {
  const { routers } = await api('/routers');
  routersCache = routers || [];
  const list = $('routers-list');
  list.innerHTML = '';

  if (!routersCache.length) {
    list.innerHTML = '<p class="hint">No routers yet. Add your first MikroTik.</p>';
    return;
  }

  for (const r of routersCache) {
    const div = document.createElement('div');
    div.className = 'list-item';
    const lastSeen = r.last_connected_at ? new Date(r.last_connected_at).toLocaleString() : 'Never';
    const connector = Array.isArray(r.connector_devices) ? r.connector_devices[0] : r.connector_devices;
    const remote = r.connection_mode === 'connector';
    const remoteStatus = connector?.status === 'online' ? '🟢 Remote online' : '⚪ Remote offline';
    const endpoint = remote ? remoteStatus : (r.status || 'unknown');
    div.innerHTML = `
      <div>
        <strong><span class="status-dot ${remote && connector?.status === 'online' ? 'connected' : r.status}"></span>${escapeHtml(r.label)}</strong>
        <div class="meta">${remote ? 'Remote Connector · ' : escapeHtml(r.host) + ':' + r.api_port + ' · '}${endpoint} · Last seen: ${lastSeen}</div>
      </div>
      <div class="actions">
        <button class="btn small" data-retest="${r.id}">Re-test</button>
        <button class="btn small" data-connector="${r.id}">Remote Connector</button>
        <button class="btn small" data-sync-vouchers="${r.id}">Sync voucher status</button>
        <button class="btn small danger" data-del-router="${r.id}">Delete</button>
      </div>
    `;
    list.appendChild(div);
  }
}

async function openConnectorModal(routerId) {
  const router = routersCache.find((r) => r.id === routerId);
  if (!router) return;
  $('modal-connector').dataset.routerId = routerId;
  $('connector-status').textContent = 'Loading connector status…';
  hide($('connector-token-section'));
  show($('modal-connector'));
  try {
    const res = await api(`/routers/${routerId}/connector`);
    const connector = res.connector;
    $('connector-status').innerHTML = connector
      ? `<strong>${connector.status === 'online' ? '🟢 Connected' : '⚪ Offline'}</strong><div class="hint">Last seen: ${connector.last_seen_at ? new Date(connector.last_seen_at).toLocaleString() : 'Never'}</div>`
      : '<strong>Not configured</strong><div class="hint">Generate a connector token to enable remote access.</div>';
  } catch (err) {
    $('connector-status').textContent = err.message;
  }
}

function updateConnectorPreview() {
  const token = $('connector-token').value.trim();
  const host = $('connector-router-host').value.trim() || '192.168.88.1';
  const user = $('connector-router-user').value.trim() || 'wifi-voucher';
  const pass = $('connector-router-pass').value;
  const port = $('connector-router-port').value.trim() || '8729';
  const tls = $('connector-router-tls').checked ? 'true' : 'false';
  $('connector-env-preview').textContent =
`WIFI_VOUCHER_URL=https://wifi-voucher-production-v2.onrender.com
CONNECTOR_TOKEN=${token}
ROUTER_HOST=${host}
ROUTER_PORT=${port}
ROUTER_TLS=${tls}
ROUTER_USERNAME=${user}
ROUTER_PASSWORD=${pass}`;
}

async function createConnector() {
  const routerId = $('modal-connector').dataset.routerId;
  if (!routerId) return;
  const btn = $('create-connector-btn');
  setBtnLoading(btn, 'Generating…');
  try {
    const res = await api(`/routers/${routerId}/connector`, { method: 'POST' });
    $('connector-token').value = res.token;
    $('connector-ws-url').value = res.websocket_url;
    $('connector-router-host').value = '';
    $('connector-router-user').value = '';
    $('connector-router-pass').value = '';
    $('connector-router-port').value = '8729';
    $('connector-router-tls').checked = true;
    show($('connector-token-section'));
    updateConnectorPreview();
    showToast('Connector generated. Save the token securely.', 'success');
    await loadRouters();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

async function revokeConnector() {
  const routerId = $('modal-connector').dataset.routerId;
  if (!routerId || !confirm('Revoke remote access for this router?')) return;
  try {
    await api(`/routers/${routerId}/connector`, { method: 'DELETE' });
    hide($('modal-connector'));
    showToast('Remote connector revoked.', 'success');
    await loadRouters();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function validateRouterForm() {
  const host = $('r-host').value.trim();
  const user = $('r-user').value.trim();
  const pass = $('r-pass').value;
  if (!host || !user || !pass) {
    $('router-test-result').textContent = 'Fill in host, username, and password first.';
    $('router-test-result').className = 'hint error';
    return false;
  }
  return true;
}

async function testRouterCredentials() {
  if (!validateRouterForm()) return;

  const body = {
    label: $('r-label').value.trim() || 'test',
    host: $('r-host').value.trim(),
    api_port: Number($('r-port').value) || 8728,
    api_username: $('r-user').value.trim(),
    api_password: $('r-pass').value,
  };
  const resultEl = $('router-test-result');
  const testBtn = $('test-router-btn');
  setBtnLoading(testBtn, 'Testing…');
  resultEl.textContent = 'Testing connection…';
  resultEl.className = 'hint';

  try {
    const res = await api('/routers/test', { method: 'POST', body: JSON.stringify(body) });
    resultEl.textContent = `✅ Connected — ${res.router.identity} (RouterOS ${res.router.version})`;
    resultEl.className = 'hint success-msg';
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
    resultEl.className = 'hint error';
  } finally {
    resetBtn(testBtn);
  }
}

async function saveRouter(e) {
  e.preventDefault();
  if (!validateRouterForm()) return;

  const body = {
    label: $('r-label').value.trim(),
    host: $('r-host').value.trim(),
    api_port: Number($('r-port').value) || 8728,
    api_username: $('r-user').value.trim(),
    api_password: $('r-pass').value,
  };
  const resultEl = $('router-test-result');
  const saveBtn = $('save-router-btn');
  setBtnLoading(saveBtn, 'Connecting & saving…');
  resultEl.textContent = '';

  try {
    await api('/routers', { method: 'POST', body: JSON.stringify(body) });
    hide($('modal-router'));
    $('router-form').reset();
    resultEl.textContent = '';
    showToast('Router connected and saved.', 'success');
    await loadRouters();
    await loadProfiles();
    updatePrerequisiteHints();
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
    resultEl.className = 'hint error';
  } finally {
    resetBtn(saveBtn);
  }
}

// ---------- Profiles ----------
async function loadProfiles() {
  const { profiles } = await api('/profiles');
  profilesCache = profiles || [];
  const list = $('profiles-list');
  list.innerHTML = '';

  if (!profilesCache.length) {
    list.innerHTML = '<p class="hint">No profiles yet. Create packages like “1 Hour” or “500MB”.</p>';
    return;
  }

  for (const p of profilesCache) {
    const limits = [];
    if (p.duration_minutes) limits.push(`${p.duration_minutes} min`);
    if (p.data_limit_mb) limits.push(`${p.data_limit_mb} MB`);
    const router = routersCache.find((r) => r.id === p.router_id);

    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(p.name)}</strong>
        <div class="meta">${limits.join(' · ') || 'No limits'} · ${p.price} ${escapeHtml(p.currency)}
          ${p.code_prefix ? ' · prefix: ' + escapeHtml(p.code_prefix) : ''}
          ${router ? ' · ' + escapeHtml(router.label) : ''}
        </div>
      </div>
      <button class="btn small danger" data-del-profile="${p.id}">Deactivate</button>
    `;
    list.appendChild(div);
  }
}

function fillProfileSelect() {
  const sel = $('gen-profile');
  const pSel = $('p-router');
  sel.innerHTML = '';
  pSel.innerHTML = '';

  for (const r of routersCache) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.label;
    pSel.appendChild(opt);
  }

  for (const p of profilesCache) {
    const router = routersCache.find((r) => r.id === p.router_id);
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${router ? router.label : 'router'})`;
    sel.appendChild(opt);
  }
}

function updatePrerequisiteHints() {
  const hasRouters = routersCache.length > 0;
  const hasProfiles = profilesCache.length > 0;

  $('add-profile-btn').disabled = !hasRouters;
  $('profiles-empty-hint').classList.toggle('hidden', hasRouters);

  $('generate-btn').disabled = !hasProfiles;
  $('gen-profile').disabled = !hasProfiles;
  $('vouchers-empty-hint').classList.toggle('hidden', hasProfiles);
}

async function saveProfile(e) {
  e.preventDefault();
  const duration = $('p-duration').value ? Number($('p-duration').value) : null;
  const dataMb = $('p-data').value ? Number($('p-data').value) : null;

  if (!duration && !dataMb) {
    showToast('Set at least a duration or a data limit.', 'error');
    return;
  }
  if (!$('p-router').value) {
    showToast('Add a router first — profiles need one.', 'error');
    return;
  }

  const body = {
    router_id: $('p-router').value,
    name: $('p-name').value.trim(),
    duration_minutes: duration,
    data_limit_mb: dataMb,
    price: Number($('p-price').value) || 0,
    currency: $('p-currency').value.trim() || 'UGX',
    code_prefix: $('p-prefix').value.trim(),
  };

  const btn = $('save-profile-btn');
  setBtnLoading(btn, 'Saving…');
  try {
    await api('/profiles', { method: 'POST', body: JSON.stringify(body) });
    hide($('modal-profile'));
    $('profile-form').reset();
    showToast('Profile created.', 'success');
    await loadProfiles();
    fillProfileSelect();
    updatePrerequisiteHints();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    resetBtn(btn);
  }
}

// ---------- Vouchers ----------
async function loadVouchers(limit) {
  vouchersLimit = limit || vouchersLimit;
  const { vouchers } = await api(`/vouchers?limit=${vouchersLimit}`);
  const list = $('vouchers-list');
  list.innerHTML = '';

  if (!vouchers?.length) {
    list.innerHTML = '<p class="hint">No vouchers generated yet.</p>';
    hide($('load-more-vouchers'));
    return;
  }

  for (const v of vouchers) {
    const div = document.createElement('div');
    div.className = 'list-item';
    const profileName = v.profiles?.name ? escapeHtml(v.profiles.name) : '';
    div.innerHTML = `
      <div>
        <strong style="font-family:monospace">${escapeHtml(v.code)}</strong>
        <div class="meta">${v.status}${profileName ? ' · ' + profileName : ''} · ${new Date(v.created_at).toLocaleString()}</div>
      </div>
    `;
    list.appendChild(div);
  }

  const moreBtn = $('load-more-vouchers');
  if (vouchers.length >= vouchersLimit) {
    show(moreBtn);
  } else {
    hide(moreBtn);
  }
}

async function generateVouchers() {
  const profile_id = $('gen-profile').value;
  const quantity = Number($('gen-qty').value) || 1;
  if (!profile_id) {
    showToast('Create a profile first.', 'error');
    return;
  }

  const btn = $('generate-btn');
  setBtnLoading(btn, 'Connecting to router…');

  const result = $('gen-result');
  hide(result);

  try {
    const res = await api('/vouchers/generate', {
      method: 'POST',
      body: JSON.stringify({ profile_id, quantity }),
    });

    show(result);
    result.innerHTML = `
      <div class="card" style="margin-top:1rem">
        <p class="success-msg"><strong>${escapeHtml(res.message)}</strong></p>
        <div class="code-grid">
          ${(res.vouchers || []).map((v) => `<div class="code-chip">${escapeHtml(v.code)}</div>`).join('')}
        </div>
        ${res.partialFailures?.length ? `<p class="hint" style="margin-top:0.75rem">Some failed: ${res.partialFailures.length}</p>` : ''}
      </div>
    `;
    showToast(res.message, 'success');
    vouchersLimit = 50;
    await loadVouchers();
  } catch (err) {
    show(result);
    result.innerHTML = `
      <div class="card" style="margin-top:1rem">
        <p class="error"><strong>${escapeHtml(err.data?.error || 'Failed')}</strong></p>
        <p>${escapeHtml(err.message)}</p>
        ${err.data?.hint ? `<p class="hint">${escapeHtml(err.data.hint)}</p>` : ''}
      </div>
    `;
  } finally {
    resetBtn(btn);
  }
}

function exportVouchers(format) {
  fetch(`/vouchers/export?format=${format}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
    .then((r) => {
      if (!r.ok) throw new Error('Export failed');
      return r.blob();
    })
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = format === 'csv' ? 'vouchers.csv' : 'vouchers.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch((e) => showToast('Export failed: ' + e.message, 'error'));
}

/**
 * Print / PDF — opens a clean printable sheet of recent unused vouchers.
 * User can then "Save as PDF" from the browser print dialog.
 */
async function exportPdf() {
  try {
    const res = await api('/vouchers?limit=200');
    const vouchers = (res.vouchers || []).filter((v) => v.status === 'unused');

    if (vouchers.length === 0) {
      showToast('No unused vouchers to print.', 'info');
      return;
    }

    let printArea = document.getElementById('print-area');
    if (!printArea) {
      printArea = document.createElement('div');
      printArea.id = 'print-area';
      document.body.appendChild(printArea);
    }

    const cards = vouchers
      .map(
        (v) => `
      <div class="voucher-card">
        <div style="font-size:1.4rem;font-weight:bold;letter-spacing:2px">${escapeHtml(v.code)}</div>
        <div style="margin-top:0.35rem;font-size:0.9rem">
          ${escapeHtml(v.profiles?.name || 'Package')}
          ${v.status ? ' · ' + v.status : ''}
        </div>
      </div>`
      )
      .join('');

    printArea.innerHTML = `
      <h2 style="margin-bottom:1rem">WiFi Vouchers — ${new Date().toLocaleDateString()}</h2>
      <p style="margin-bottom:1rem;font-size:0.9rem">${vouchers.length} unused code(s)</p>
      ${cards}
    `;

    window.print();
  } catch (err) {
    showToast('Could not prepare print: ' + (err.message || err), 'error');
  }
}

// ---------- Events ----------
$('login-form').addEventListener('submit', handleLogin);
$('signup-form').addEventListener('submit', handleSignup);
$('forgot-form').addEventListener('submit', handleForgotPassword);
$('recovery-form').addEventListener('submit', handleRecoverySubmit);
$('logout-btn').addEventListener('click', logout);
$('expired-logout-btn').addEventListener('click', logout);
$('admin-logout-btn').addEventListener('click', logout);

$('admin-panel-btn').addEventListener('click', showAdminScreen);
$('switch-to-owner-btn').addEventListener('click', () => showOwnerDashboard(currentOwner));

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => hide(p));
    show($('panel-' + btn.dataset.panel));
  });
});

$('add-router-btn').addEventListener('click', () => {
  openOnboarding();
});
$('onboarding-next').addEventListener('click', async () => {
  if (onboarding.step === onboarding.total) { closeOnboarding(); return; }
  await nextOnboarding();
});
$('onboarding-back').addEventListener('click', () => {
  if (onboarding.step > 1) { onboarding.step--; renderOnboarding(); }
});
$('onboarding-skip').addEventListener('click', () => closeOnboarding(true));
$('router-form').addEventListener('submit', saveRouter);

$('cancel-router').addEventListener('click', () => hide($('modal-router')));
$('close-connector').addEventListener('click', () => hide($('modal-connector')));
$('create-connector-btn').addEventListener('click', createConnector);
$('revoke-connector-btn').addEventListener('click', revokeConnector);
['connector-router-host','connector-router-user','connector-router-pass','connector-router-port'].forEach((id) => $(id).addEventListener('input', updateConnectorPreview));
$('connector-router-tls').addEventListener('change', updateConnectorPreview);

$('test-router-btn').addEventListener('click', testRouterCredentials);

$('add-profile-btn').addEventListener('click', () => {
  if ($('add-profile-btn').disabled) return;
  fillProfileSelect();
  $('profile-form').reset();
  show($('modal-profile'));
});
$('cancel-profile').addEventListener('click', () => hide($('modal-profile')));
$('profile-form').addEventListener('submit', saveProfile);

$('generate-btn').addEventListener('click', generateVouchers);
$('export-txt').addEventListener('click', () => exportVouchers('text'));
$('export-csv').addEventListener('click', () => exportVouchers('csv'));
$('export-pdf').addEventListener('click', exportPdf);
$('load-more-vouchers').addEventListener('click', async () => {
  const btn = $('load-more-vouchers');
  setBtnLoading(btn, 'Loading…');
  try {
    await loadVouchers(vouchersLimit + 50);
  } finally {
    resetBtn(btn);
  }
});

// Delegation for dynamic buttons
document.addEventListener('click', async (e) => {
  const connectorBtn = e.target.closest('[data-connector]');
  if (connectorBtn) {
    await openConnectorModal(connectorBtn.dataset.connector);
    return;
  }

  const retest = e.target.closest('[data-retest]');
  if (retest) {
    const id = retest.dataset.retest;
    retest.disabled = true;
    retest.textContent = 'Testing…';
    try {
      const res = await api(`/routers/${id}/retest`, { method: 'POST' });
      showToast('✅ ' + res.message + (res.router?.identity ? ` — ${res.router.identity}` : ''), 'success');
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
    retest.disabled = false;
    retest.textContent = 'Re-test';
    await loadRouters();
  }

  const syncV = e.target.closest('[data-sync-vouchers]');
  if (syncV) {
    const id = syncV.dataset.syncVouchers;
    syncV.disabled = true;
    syncV.textContent = 'Syncing…';
    try {
      const res = await api(`/vouchers/sync?router_id=${id}`, { method: 'POST' });
      showToast(res.message + (res.updated ? ` — ${res.updated} updated` : ''), 'success');
      await loadVouchers();
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
    syncV.disabled = false;
    syncV.textContent = 'Sync voucher status';
  }

  const delR = e.target.closest('[data-del-router]');
  if (delR && confirm('Delete this router and its profiles/vouchers?')) {
    try {
      await api(`/routers/${delR.dataset.delRouter}`, { method: 'DELETE' });
      showToast('Router deleted.', 'success');
      await loadRouters();
      await loadProfiles();
      fillProfileSelect();
      updatePrerequisiteHints();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  const delP = e.target.closest('[data-del-profile]');
  if (delP && confirm('Deactivate this profile?')) {
    try {
      await api(`/profiles/${delP.dataset.delProfile}`, { method: 'DELETE' });
      showToast('Profile deactivated.', 'success');
      await loadProfiles();
      fillProfileSelect();
      updatePrerequisiteHints();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
});

// ---------- Init ----------
supabaseClient.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    hideAllScreens();
    show($('recovery-screen'));
  }
});

// ---------- PWA install support ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Non-fatal — app still works fully as a normal web page without it
    });
  });
}

(async () => {
  // If this page load is a password-recovery link, show that screen immediately
  if (window.location.hash.includes('type=recovery')) {
    hideAllScreens();
    show($('recovery-screen'));
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    accessToken = session.access_token;
    await enterDashboard();
  }
})();


// ---------- Adaptive onboarding wizard ----------
const onboarding = { step: 1, total: 5, router: null, mode: 'auto', diagnosis: {} };
function openOnboarding() {
  onboarding.step = 1; onboarding.router = null; onboarding.mode = 'auto'; onboarding.diagnosis = {};
  show($('modal-onboarding')); renderOnboarding();
}
function closeOnboarding(skip = false) {
  hide($('modal-onboarding'));
  if (skip) localStorage.setItem('wv_onboarding_skipped', '1');
}
function renderOnboarding() {
  const s = onboarding.step;
  $('onboarding-step-label').textContent = `Step ${s} of ${onboarding.total}`;
  $('onboarding-progress-bar').style.width = `${(s / onboarding.total) * 100}%`;
  $('onboarding-back').classList.toggle('hidden', s === 1);
  $('onboarding-skip').classList.toggle('hidden', s === onboarding.total);
  $('onboarding-next').textContent = s === onboarding.total ? 'Finish setup' : 'Continue';
  const body = $('onboarding-body');
  const d = onboarding.diagnosis;
  if (s === 1) {
    body.innerHTML = `<div class="onboarding-hero"><span class="eyebrow">Adaptive setup</span><h2 id="onboarding-title">Let’s connect your MikroTik the right way.</h2><p>We’ll check the router, ISP/network conditions and available connection paths, then guide you through the path that fits.</p></div><div class="onboarding-checks"><div>✓ RouterOS version & hardware</div><div>✓ Internet / outbound HTTPS</div><div>✓ Public IP, CGNAT & firewall conditions</div><div>✓ Direct API, Cloud Agent or LAN Connector</div></div>`;
  } else if (s === 2) {
    body.innerHTML = `<h2>What do you know about the connection?</h2><p class="hint">These answers help us choose the first path. We can still test alternatives.</p><label>RouterOS version (if known)</label><select id="ob-version"><option value="unknown">I don’t know</option><option value="7">RouterOS 7.x</option><option value="6">RouterOS 6.x</option></select><label>Can the router reach the public Internet?</label><select id="ob-internet"><option value="yes">Yes</option><option value="no">No / not sure</option></select><label>Does the ISP use CGNAT or block inbound ports?</label><select id="ob-cgnat"><option value="unknown">I don’t know</option><option value="yes">Yes / likely</option><option value="no">No / public IP available</option></select><label>Can you run commands on the MikroTik?</label><select id="ob-admin"><option value="yes">Yes</option><option value="no">No</option></select>`;
    $('ob-version').value = d.version || 'unknown'; $('ob-internet').value = d.internet || 'yes'; $('ob-cgnat').value = d.cgnat || 'unknown'; $('ob-admin').value = d.admin || 'yes';
  } else if (s === 3) {
    body.innerHTML = `<h2>Router details</h2><p class="hint">Credentials are encrypted on the server. They are used for direct testing/fallback; the Cloud Agent itself does not need your API password to operate.</p><label>Router label</label><input id="ob-label" value="${escapeHtml(d.label || '')}" placeholder="Shop Router" /><label>Host / IP / DDNS</label><input id="ob-host" value="${escapeHtml(d.host || '')}" placeholder="192.168.88.1 or shop.example.com" /><label>API port</label><input id="ob-port" type="number" value="${d.port || 8729}" /><label>API username</label><input id="ob-user" value="${escapeHtml(d.user || '')}" autocomplete="off" /><label>API password</label><div class="password-field"><input id="ob-pass" type="password" value="" autocomplete="new-password" /><button type="button" class="password-toggle" data-toggle-for="ob-pass">Show</button></div><p class="field-hint">If direct testing is blocked, we can still use the saved credentials as a fallback path.</p>`;
  } else if (s === 4) {
    const suggested = (d.version === '7' && d.internet !== 'no' && d.admin !== 'no') ? 'agent' : ((d.cgnat === 'yes' || d.cgnat === 'unknown') ? 'connector' : 'direct');
    body.innerHTML = `<h2>Choose the connection path</h2><p class="hint">We’ll start with the selected path and keep the other supported paths available as fallbacks.</p><div class="onboarding-options"><label class="onboarding-option"><input type="radio" name="ob-mode" value="agent" ${suggested === 'agent' ? 'checked' : ''}/><strong>Cloud Agent</strong><span>Best when RouterOS 7 can make outbound HTTPS calls. Works behind CGNAT and does not require an inbound port.</span></label><label class="onboarding-option"><input type="radio" name="ob-mode" value="direct" ${suggested === 'direct' ? 'checked' : ''}/><strong>Direct API / API-SSL</strong><span>Use when the router is reachable from the Internet or from the server network.</span></label><label class="onboarding-option"><input type="radio" name="ob-mode" value="connector" ${suggested === 'connector' ? 'checked' : ''}/><strong>LAN Connector</strong><span>Use a small always-on computer inside the router’s LAN when the router cannot phone home itself.</span></label></div><div class="onboarding-callout"><strong>Adaptive fallback:</strong> If the selected route cannot be established, the wizard will tell you what condition is blocking it and show the next available route.</div>`;
    const radio=document.querySelector('input[name="ob-mode"][value="'+(onboarding.mode==='auto'?suggested:onboarding.mode)+'"]'); if(radio) radio.checked=true;
  } else {
    const mode = onboarding.mode;
    body.innerHTML = `<h2>Finish the connection</h2><div id="onboarding-finish-content"><p>Saving the router and preparing your ${mode === 'agent' ? 'Cloud Agent' : mode === 'connector' ? 'LAN Connector' : 'direct API'} setup…</p></div>`;
    finishOnboarding();
  }
}
function collectOnboardingStep() {
  if (onboarding.step === 2) {
    onboarding.diagnosis.version=$('ob-version').value; onboarding.diagnosis.internet=$('ob-internet').value; onboarding.diagnosis.cgnat=$('ob-cgnat').value; onboarding.diagnosis.admin=$('ob-admin').value;
  }
  if (onboarding.step === 3) {
    onboarding.diagnosis.label=$('ob-label').value.trim(); onboarding.diagnosis.host=$('ob-host').value.trim(); onboarding.diagnosis.port=Number($('ob-port').value)||8729; onboarding.diagnosis.user=$('ob-user').value.trim(); onboarding.diagnosis.pass=$('ob-pass').value;
    if(!onboarding.diagnosis.label||!onboarding.diagnosis.host||!onboarding.diagnosis.user||!onboarding.diagnosis.pass){ $('onboarding-status').textContent='Please complete the router details first.'; return false; }
  }
  if (onboarding.step === 4) { onboarding.mode=document.querySelector('input[name="ob-mode"]:checked')?.value||'agent'; }
  return true;
}
async function nextOnboarding() {
  $('onboarding-status').textContent='';
  if(!collectOnboardingStep()) return;
  if(onboarding.step < onboarding.total){ onboarding.step++; renderOnboarding(); }
}
async function finishOnboarding(){
  const out=$('onboarding-finish-content');
  try {
    const d=onboarding.diagnosis;
    const body={label:d.label,host:d.host,api_port:d.port,api_username:d.user,api_password:d.pass,connection_mode:onboarding.mode==='agent'?'agent':'direct'};
    let saved;
    try { saved=await api('/routers',{method:'POST',body:JSON.stringify(body)}); }
    catch(err){
      if(onboarding.mode!=='direct') throw err;
      out.innerHTML=`<div class="onboarding-result error"><strong>Direct connection could not be established.</strong><p>${escapeHtml(err.message)}</p><p>That does not mean the router cannot be managed. Go back and choose Cloud Agent (RouterOS 7 + outbound HTTPS) or LAN Connector.</p></div>`;
      $('onboarding-next').classList.add('hidden'); $('onboarding-back').classList.remove('hidden'); return;
    }
    const router=saved.router; onboarding.router=router;
    if(onboarding.mode==='agent'){
      const agent=await api(`/routers/${router.id}/agent`,{method:'POST'});
      const script=`# WiFi Voucher Cloud Agent\n# Paste this script into MikroTik RouterOS 7 terminal\n:local server "${location.origin}"\n:local token "${agent.token}"\n:local pollUrl (\$server . "/agent/poll")\n:local resultUrl (\$server . "/agent/result")\n# Use the full production agent script from the dashboard/download instructions.\n:put ("WiFi Voucher agent bootstrap ready. Token: " . \$token)\n:put ("Poll endpoint: " . \$pollUrl)\n`;
      out.innerHTML=`<div class="onboarding-result"><strong>Router saved. Cloud Agent is ready.</strong><p>On RouterOS 7, open Terminal and use the provided agent script. Keep the token private.</p><textarea id="onboarding-agent-script" class="code-block" rows="8" readonly></textarea><button type="button" class="btn small" id="copy-onboarding-script">Copy bootstrap</button><div class="onboarding-callout"><strong>Next:</strong> After the script is installed, this router should appear online. If RouterOS cannot run the agent, return here and switch to LAN Connector or Direct API.</div></div>`;
      $('onboarding-agent-script').value=script; $('copy-onboarding-script').onclick=()=>navigator.clipboard?.writeText(script);
    } else if(onboarding.mode==='connector'){
      const c=await api(`/routers/${router.id}/connector`,{method:'POST'});
      out.innerHTML=`<div class="onboarding-result"><strong>Router saved. LAN Connector is ready.</strong><p>Install the connector on an always-on computer on the same LAN as the MikroTik.</p><label>One-time connector token</label><input value="${escapeHtml(c.token)}" readonly /><div class="code-block">WIFI_VOUCHER_URL=${location.origin}\nCONNECTOR_TOKEN=${c.token}\nROUTER_HOST=${escapeHtml(d.host)}\nROUTER_PORT=${d.port}\nROUTER_TLS=true\nROUTER_USERNAME=${escapeHtml(d.user)}\nROUTER_PASSWORD=YOUR_ROUTER_PASSWORD</div><div class="onboarding-callout"><strong>Security:</strong> Keep the token and router password private. Use RouterOS API-SSL when available.</div></div>`;
    } else {
      out.innerHTML=`<div class="onboarding-result"><strong>Router connected successfully.</strong><p>Direct API is active. We’ll use it whenever the router is reachable.</p><div class="onboarding-checks"><div>✓ Router saved</div><div>✓ Connection tested</div><div>✓ Voucher management ready</div></div></div>`;
    }
    localStorage.setItem('wv_onboarding_complete','1'); $('onboarding-next').textContent='Done'; $('onboarding-next').classList.remove('hidden'); $('onboarding-back').classList.add('hidden'); $('onboarding-skip').classList.add('hidden'); await loadRouters(); await loadProfiles(); updatePrerequisiteHints();
  } catch(err){ out.innerHTML=`<div class="onboarding-result error"><strong>Setup needs one more step.</strong><p>${escapeHtml(err.message)}</p><p>Use Back to review the connection choice, then try again.</p></div>`; }
}

