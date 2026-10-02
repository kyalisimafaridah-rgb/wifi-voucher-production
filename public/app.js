/**
 * WiFi Voucher MVP — Frontend
 * Uses Supabase Auth for login/signup, then talks to our Fastify API with the JWT.
 */
const SUPABASE_URL = window.SUPABASE_URL || 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'YOUR_ANON_KEY';

window.__wvSupabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

window.__wvAccessToken = null;
let currentOwner = null;
let routersCache = [];
let profilesCache = [];
let vouchersLimit = 50;
let sessionExpiredHandled = false;
const INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
let inactivityTimer = null;
let inactivityLocked = false;
let lastActivityAt = 0;

// ---------- Helpers ----------
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (window.__wvAccessToken) headers['Authorization'] = `Bearer ${window.__wvAccessToken}`;

  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (networkErr) {
    const err = new Error('Network request failed. Check your Internet connection and try again.');
    err.code = 'NETWORK_ERROR';
    err.original = networkErr?.message;
    throw err;
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (res.status === 401 && window.__wvAccessToken && !sessionExpiredHandled) {
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

// Expose the authenticated API wrapper to the admin console loaded after this file.
window.__wvApi = api;

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
  ['auth-screen', 'recovery-screen', 'expired-screen', 'dashboard', 'admin-screen', 'lock-screen'].forEach((id) => hide($(id)));
}

// ---------- Session expiry (mid-session token invalid/expired) ----------
async function forceSessionExpired() {
  stopInactivityTimer();
  const hadWorkspace = Boolean(currentOwner?.email);
  try { await window.__wvSupabaseClient.auth.signOut(); } catch {}
  window.__wvAccessToken = null;
  if (hadWorkspace) {
    inactivityLocked = true;
    $('lock-email').value = currentOwner?.email || '';
    $('lock-password').value = '';
    setError('lock-error', null);
    hideAllScreens();
    show($('lock-screen'));
    showToast('Your session expired. Unlock your workspace to continue.', 'error');
  } else {
    currentOwner = null;
    hideAllScreens();
    show($('auth-screen'));
    showToast('Your session expired. Please log in again.', 'error');
  }
  sessionExpiredHandled = false;
}

function stopInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

function resetInactivityTimer() {
  if (!window.__wvAccessToken || inactivityLocked) return;
  lastActivityAt = Date.now();
  stopInactivityTimer();
  inactivityTimer = setTimeout(lockForInactivity, INACTIVITY_LIMIT_MS);
}

async function lockForInactivity() {
  if (!window.__wvAccessToken || inactivityLocked) return;
  inactivityLocked = true;
  stopInactivityTimer();
  const email = currentOwner?.email || '';
  $('lock-email').value = email;
  $('lock-password').value = '';
  setError('lock-error', null);
  hideAllScreens();
  show($('lock-screen'));
  try {
    await window.__wvSupabaseClient.auth.signOut();
  } catch (error) {
    // Locking must never depend on a successful network sign-out.
  } finally {
    window.__wvAccessToken = null;
    hideAllScreens();
    show($('lock-screen'));
    showToast('Your workspace was locked after 30 minutes of inactivity.', 'info');
  }
}

function recordUserActivity() {
  if (window.__wvAccessToken && !inactivityLocked) resetInactivityTimer();
}

['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((eventName) => {
  window.addEventListener(eventName, recordUserActivity, { passive: true });
});

function showLockLoginError(message) {
  setError('lock-error', message);
}

async function handleLockLogin(e) {
  e.preventDefault();
  const btn = $('lock-login-btn');
  showLockLoginError(null);
  setBtnLoading(btn, 'Unlocking…');
  try {
    const email = $('lock-email').value.trim();
    const password = $('lock-password').value;
    const { data, error } = await window.__wvSupabaseClient.auth.signInWithPassword({ email, password });
    if (error || !data?.session) throw new Error(error?.message || 'Could not unlock your workspace.');
    window.__wvAccessToken = data.session.access_token;
    inactivityLocked = false;
    await enterDashboard();
    resetInactivityTimer();
  } catch (err) {
    showLockLoginError(err.message || 'Could not unlock your workspace.');
  } finally {
    resetBtn(btn);
  }
}

async function handleLockGoogleAuth() {
  const btn = $('lock-google-btn');
  showLockLoginError(null);
  setBtnLoading(btn, 'Connecting…');
  try {
    const { error } = await window.__wvSupabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/',
        scopes: 'openid email profile https://www.googleapis.com/auth/userinfo.email',
      },
    });
    if (error) throw error;
  } catch (err) {
    showLockLoginError(err.message || 'Google sign-in failed. Please try again.');
    resetBtn(btn);
  }
}

$('lock-login-form').addEventListener('submit', handleLockLogin);
$('lock-google-btn').addEventListener('click', handleLockGoogleAuth);
$('lock-use-different-account').addEventListener('click', () => {
  inactivityLocked = false;
  currentOwner = null;
  hideAllScreens();
  show($('auth-screen'));
  document.querySelector('.tab[data-tab="login"]')?.click();
});

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
async function handleGoogleAuth(e) {
  e?.preventDefault?.();
  setError('auth-error', null);
  const buttons = [$('login-google-btn'), $('signup-google-btn')].filter(Boolean);
  buttons.forEach((btn) => setBtnLoading(btn, 'Connecting…'));
  try {
    const { error } = await window.__wvSupabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/',
        scopes: 'openid email profile https://www.googleapis.com/auth/userinfo.email',
      },
    });
    if (error) throw error;
  } catch (err) {
    const msg = err?.message || '';
    setError(
      'auth-error',
      /provider.*not.*enabled|provider is not enabled/i.test(msg)
        ? 'Google sign-in is not enabled yet. Email login is ready; the app owner needs to finish Google setup in Supabase.'
        : msg || 'Google sign-in failed. Please try again.'
    );
    buttons.forEach((btn) => resetBtn(btn));
  }
}

async function handleLogin(e) {
  e.preventDefault();
  setError('auth-error', null);
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const btn = $('login-submit-btn');

  setBtnLoading(btn, 'Logging in…');
  try {
    const { data, error } = await window.__wvSupabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      setError('auth-error', error.message);
      return;
    }
    window.__wvAccessToken = data.session.access_token;
    inactivityLocked = false;
    await enterDashboard();
    resetInactivityTimer();
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
    if (!email || !password) {
      setError('auth-error', 'Please enter your email and password.');
      return;
    }

    const created = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, full_name: full_name || undefined }),
    });

    if (!created?.success) {
      throw new Error('The account could not be created. Please try again.');
    }

    const { data, error } = await window.__wvSupabaseClient.auth.signInWithPassword({ email, password });
    if (error || !data?.session) {
      throw new Error(error?.message || 'Account created, but automatic login failed. Please use the Login tab.');
    }

    window.__wvAccessToken = data.session.access_token;
    inactivityLocked = false;
    if (full_name) {
      try {
        await api('/me', { method: 'PATCH', body: JSON.stringify({ full_name }) });
      } catch {}
    }
    await enterDashboard();
    resetInactivityTimer();
  } catch (err) {
    if (err.status === 409) {
      setError('auth-error', 'This email is already registered — try logging in instead.');
    } else {
      setError('auth-error', err.data?.message || err.message || 'Signup failed. Please try again.');
    }
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
    const { error } = await window.__wvSupabaseClient.auth.resetPasswordForEmail(email, {
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
    const { error } = await window.__wvSupabaseClient.auth.updateUser({ password });
    if (error) {
      setError('recovery-error', error.message);
      return;
    }
    showToast('Password updated. You are now logged in.', 'success');
    const { data: { session } } = await window.__wvSupabaseClient.auth.getSession();
    if (session) {
      window.__wvAccessToken = session.access_token;
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

let paymentPollTimer = null;
let paymentPollAttempts = 0;

function renderPaymentInstructions(instructions, payment) {
  const box = $('payment-instructions');
  if (!box) return;
  box.classList.remove('hidden');

  if (instructions.mode === 'pesapal_checkout' && instructions.redirect_url) {
    box.innerHTML = `
      <strong>Secure checkout ready</strong>
      <div>You're paying <b>${escapeHtml(Number(instructions.amount_ugx || payment.amount_ugx).toLocaleString())} UGX</b> for your WiFi Voucher subscription.</div>
      <button type="button" class="btn" id="open-pesapal-checkout" style="margin-top:.75rem">Continue to secure payment</button>
      <div class="hint" style="margin-top:.5rem">PesaPal will show any payment-provider charges before you confirm. WiFi Voucher verifies the final payment directly with PesaPal before restoring access.</div>`;
    $('open-pesapal-checkout')?.addEventListener('click', () => window.location.assign(instructions.redirect_url));
    return;
  }

  box.innerHTML = `
    <strong>Payment started</strong>
    <div>Send <b>${escapeHtml(Number(instructions.amount_ugx || payment.amount_ugx).toLocaleString())} UGX</b> to <b>${escapeHtml(instructions.merchant_number || 'the configured merchant number')}</b>.</div>
    <div class="hint" style="margin-top:.5rem">Send the payment from the Mobile Money account whose registered name you saved in your account settings.</div>
    <div class="hint" style="margin-top:.5rem">We will verify the payment before restoring access. Keep the payment confirmation SMS until your payment is verified.</div>`;
}

function stopPaymentPolling() {
  if (paymentPollTimer) clearInterval(paymentPollTimer);
  paymentPollTimer = null;
  paymentPollAttempts = 0;
}

async function pollPayment(id) {
  if (!id) return;
  try {
    const res = await api('/billing/payment-intents/' + encodeURIComponent(id));
    const payment = res.payment;
    const status = $('payment-status');
    if (status) status.textContent = payment.status === 'succeeded'
      ? 'Payment verified. Restoring your account…'
      : payment.status === 'failed'
        ? 'The payment failed. You can start another payment.'
        : payment.status === 'processing'
          ? 'Payment received. Waiting for final confirmation…'
          : 'Waiting for payment verification…';

    if (payment.status === 'succeeded') {
      stopPaymentPolling();
      await enterDashboard();
      return;
    }
    if (['failed','expired','cancelled','refunded','disputed'].includes(payment.status)) {
      stopPaymentPolling();
      if (status) status.textContent = payment.status === 'failed'
        ? 'Payment was not completed. You can safely start a new payment.'
        : 'This payment is no longer active. You can start a new payment.';
    }
  } catch {
    if ($('payment-status')) $('payment-status').textContent = 'Still checking your payment…';
  }

  paymentPollAttempts += 1;
  if (paymentPollAttempts >= 120) {
    stopPaymentPolling();
    if ($('payment-status')) $('payment-status').textContent = 'We stopped automatic checking after 10 minutes. You can log in again later to check the payment.';
  }
}

function startPaymentPolling(id) {
  stopPaymentPolling();
  paymentPollAttempts = 0;
  pollPayment(id);
  paymentPollTimer = setInterval(() => pollPayment(id), 5000);
}

async function startPayment(provider) {
  const optionsEl = $('payment-options');
  const status = $('payment-status');
  try {
    optionsEl?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    if (status) status.textContent = provider === 'pesapal' ? 'Preparing secure checkout…' : 'Creating a secure payment record…';

    const phone = provider === 'pesapal' ? '' : (window.prompt('Mobile Money number (optional):') || '');
    const key = (window.crypto?.randomUUID ? window.crypto.randomUUID() : 'wv-' + Date.now() + '-' + Math.random().toString(36).slice(2));

    const res = await api('/billing/payment-intents', {
      method: 'POST',
      body: JSON.stringify({ provider, payer_phone: phone.trim() || null, idempotency_key: key }),
    });

    renderPaymentInstructions(res.instructions, res.payment);
    if (status) status.textContent = provider === 'pesapal'
      ? 'Opening secure checkout…'
      : 'Waiting for payment verification…';
    startPaymentPolling(res.payment.id);

    if (provider === 'pesapal' && res.instructions.redirect_url) {
      window.setTimeout(() => window.location.assign(res.instructions.redirect_url), 300);
    }
  } catch (err) {
    if (status) status.textContent = err.message || 'Could not start payment.';
    optionsEl?.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

async function loadPaymentOptions() {
  const optionsEl = $('payment-options');
  const amountEl = $('payment-amount');
  const status = $('payment-status');
  if (!optionsEl) return;

  try {
    const res = await api('/billing/payment-options');
    if (amountEl) amountEl.textContent = Number(res.amount_ugx || 0).toLocaleString() + ' UGX / ' + Number(res.period_days || 30) + ' days';

    optionsEl.innerHTML = (res.options || []).map((option) => `
      <button type="button" class="btn payment-option" data-payment-provider="${escapeHtml(option.provider)}" ${option.configured ? '' : 'disabled'}>
        <b>${option.provider === 'pesapal' ? 'PesaPal Secure Checkout' : escapeHtml(option.provider.toUpperCase() + ' Mobile Money')}</b>
        <small>${option.configured
          ? (option.provider === 'pesapal' ? 'Pay through secure checkout' : 'Pay using the merchant account')
          : 'Not configured yet'}</small>
      </button>`).join('');

    if (!res.options?.some((x) => x.configured) && status) status.textContent = 'Payment checkout is not configured yet. Please contact the app owner.';
  } catch (err) {
    optionsEl.innerHTML = '<p class="hint">Payment options could not be loaded. Please try again.</p>';
    if (status) status.textContent = err.message || 'Could not load payment options.';
  }
}

function bindPaymentCheckout() {
  const optionsEl = $('payment-options');
  if (!optionsEl || optionsEl.dataset.bound) return;
  optionsEl.dataset.bound = '1';
  optionsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-payment-provider]');
    if (btn) startPayment(btn.dataset.paymentProvider);
  });
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
    ? 'Your free trial ends today. You can activate your subscription from the Subscription button.'
    : `Your free trial ends in ${daysRemaining} days. You can activate your subscription from the Subscription button.`;
  el.appendChild(div);
}

function showSubscriptionScreen(owner = currentOwner) {
  hideAllScreens();
  show($('expired-screen'));

  const title = $('subscription-title');
  const message = $('expired-message');
  if (owner?.subscription_status === 'expired') {
    if (title) title.textContent = 'Your subscription has ended';
    if (message) message.textContent = 'Choose a payment method below. Your access is restored only after the payment is verified.';
  } else if (owner?.subscription_status === 'trial') {
    if (title) title.textContent = 'Activate your subscription';
    if (message) message.textContent = 'You can pay before your trial ends. Your current access stays available while your trial is active.';
  } else {
    if (title) title.textContent = 'Manage your subscription';
    if (message) message.textContent = 'Choose a payment method below to extend your subscription. Your payment is verified before the subscription is extended.';
  }

  bindPaymentCheckout();
  loadPaymentOptions();
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
    await window.showAdminScreen();
    return;
  }

  if (isSubscriptionExpired(owner)) {
    showSubscriptionScreen(owner);
    return;
  }

  await showOwnerDashboard(owner);
}

async function refreshVoucherStatusesInBackground() {
  const targets = routersCache.filter((r) => r.status === 'connected').slice(0, 3);
  if (!targets.length) return;
  await Promise.allSettled(targets.map((r) => api(`/vouchers/sync?router_id=${r.id}`, { method: 'POST' })));
  try { await loadVouchers(); } catch {}
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
  refreshVoucherStatusesInBackground();
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
  await window.__wvSupabaseClient.auth.signOut();
  window.__wvAccessToken = null;
  currentOwner = null;
  inactivityLocked = false;
  stopInactivityTimer();
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
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⌁</div>
        <h3>Your hotspot starts here</h3>
        <p>Connect your MikroTik once. WiFi Voucher will choose the safest available connection and verify it before you create vouchers.</p>
        <button class="btn primary" data-empty-action="router">Connect my router</button>
      </div>`;
    return;
  }

  const diagnostics = await Promise.all(routersCache.map(async (router) => {
    try {
      const res = await api(`/routers/${router.id}/connection`);
      return [router.id, res.connection];
    } catch {
      return [router.id, null];
    }
  }));
  const diagnosticMap = new Map(diagnostics);

  for (const r of routersCache) {
    const div = document.createElement('div');
    div.className = 'list-item';
    const lastSeen = r.last_connected_at ? new Date(r.last_connected_at).toLocaleString() : 'Never';
    const connection = diagnosticMap.get(r.id);
    const selectedPath = connection?.selected_path;
    const connected = connection?.state === 'connected';
    const state = connection?.state || (r.status || 'unknown');
    const label = connected
      ? 'Connected'
      : state === 'attention'
        ? 'Needs attention'
        : state === 'needs_setup'
          ? 'Setup required'
          : 'Checking connection';
    const detail = connected
      ? (selectedPath === 'cloud' ? 'Secure cloud connection' : selectedPath === 'local' ? 'Local connection helper' : 'Direct router connection')
      : connection?.message || 'We are checking the available connection paths.';
    div.innerHTML = `
      <div class="router-summary">
        <strong><span class="status-dot ${connected ? 'connected' : state === 'attention' ? 'warning' : 'unknown'}"></span>${escapeHtml(r.label)}</strong>
        <div class="meta">${escapeHtml(label)} · ${escapeHtml(detail)}</div>
        <div class="meta">Last confirmed: ${escapeHtml(lastSeen)}</div>
      </div>
      <div class="actions">
        <button class="btn small" data-repair-router="${r.id}">${connected ? 'Check connection' : 'Fix connection'}</button>
        <button class="btn small" data-connector="${r.id}">Remote setup</button>
        <button class="btn small" data-sync-vouchers="${r.id}">Sync status</button>
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
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">◈</div>
        <h3>Create your first package</h3>
        <p>Choose a simple offer such as 1 Hour, 500 MB or 1 Day. You can change it later.</p>
        <button class="btn primary" data-empty-action="profile" ${routersCache.length ? '' : 'disabled'}>Create a package</button>
      </div>`;
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
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">#</div>
        <h3>Your first voucher is one click away</h3>
        <p>Choose a package above, then generate the codes on your connected router.</p>
      </div>`;
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
    headers: { Authorization: `Bearer ${window.__wvAccessToken}` },
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
$('login-google-btn')?.addEventListener('click', handleGoogleAuth);
$('signup-google-btn')?.addEventListener('click', handleGoogleAuth);
$('forgot-form').addEventListener('submit', handleForgotPassword);
$('recovery-form').addEventListener('submit', handleRecoverySubmit);
$('logout-btn').addEventListener('click', logout);
$('expired-logout-btn').addEventListener('click', logout);
$('subscription-back-btn').addEventListener('click', async () => {
  if (currentOwner && !isSubscriptionExpired(currentOwner)) {
    await showOwnerDashboard(currentOwner);
    resetInactivityTimer();
  }
});
$('subscription-btn').addEventListener('click', () => showSubscriptionScreen(currentOwner));
bindPaymentCheckout();
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
  if (onboarding.step === onboarding.total) {
    if (onboarding.verified) {
      closeOnboarding();
    } else {
      onboarding.verifying = false;
      renderOnboarding();
    }
    return;
  }
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

  const repairBtn = e.target.closest('[data-repair-router]');
  if (repairBtn) {
    const id = repairBtn.dataset.repairRouter;
    repairBtn.disabled = true;
    const original = repairBtn.textContent;
    repairBtn.textContent = 'Checking…';
    try {
      const res = await api(`/routers/${id}/repair`, { method: 'POST' });
      showToast(res.message || 'Router connection is healthy.', 'success');
    } catch (err) {
      showToast(err.message || 'We could not restore the router connection.', 'error');
    }
    repairBtn.disabled = false;
    repairBtn.textContent = original;
    await loadRouters();
    return;
  }

  const retest = e.target.closest('[data-retest]');
  if (retest) {
    const id = retest.dataset.retest;
    retest.disabled = true;
    retest.textContent = 'Checking…';
    try {
      const res = await api(`/routers/${id}/repair`, { method: 'POST' });
      showToast(res.message || 'Router connection is healthy.', 'success');
    } catch (err) {
      showToast(err.message || 'Router connection needs attention.', 'error');
    }
    retest.disabled = false;
    retest.textContent = 'Re-test';
    await loadRouters();
    return;
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

  const emptyAction = e.target.closest('[data-empty-action]');
  if (emptyAction) {
    if (emptyAction.dataset.emptyAction === 'router') openOnboarding();
    if (emptyAction.dataset.emptyAction === 'profile' && !emptyAction.disabled) {
      fillProfileSelect();
      $('profile-form').reset();
      show($('modal-profile'));
    }
    return;
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
window.__wvSupabaseClient.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    hideAllScreens();
    show($('recovery-screen'));
  }
});

// ---------- PWA install support ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js?v=20260929-2', {
        scope: '/',
        updateViaCache: 'none',
      });
      await registration.update();
    } catch {
      // Non-fatal — app still works fully as a normal web page without it
    }
  });
}

(async () => {
  // If this page load is a password-recovery link, show that screen immediately
  if (window.location.hash.includes('type=recovery')) {
    hideAllScreens();
    show($('recovery-screen'));
    return;
  }

  const paymentId = new URLSearchParams(window.location.search).get('payment');
  if (paymentId) {
    const { data: { session: paymentSession } } = await window.__wvSupabaseClient.auth.getSession();
    if (paymentSession) {
      window.__wvAccessToken = paymentSession.access_token;
      hideAllScreens();
      show($('expired-screen'));
      bindPaymentCheckout();
      const paymentStatus = new URLSearchParams(window.location.search).get('payment_status');
      if ($('payment-status')) $('payment-status').textContent = paymentStatus === 'succeeded'
        ? 'Payment verified. Restoring your account…'
        : 'Checking your payment…';
      startPaymentPolling(paymentId);
      return;
    }
  }

  const { data: { session } } = await window.__wvSupabaseClient.auth.getSession();
  if (session) {
    window.__wvAccessToken = session.access_token;
    await enterDashboard();
    resetInactivityTimer();
  }
})();


// ---------- Automatic router onboarding ----------
// The customer should not need to understand RouterOS, CGNAT, API ports,
// firewall rules, or connection modes. The product learns those details
// from the router after a small one-time bootstrap.
const onboarding = {
  step: 1,
  total: 4,
  key: null,
  router: null,
  agent: null,
  label: '',
  provisioned: false,
  verified: false,
  verifying: false,
};

function openOnboarding() {
  onboarding.step = 1;
  onboarding.key = localStorage.getItem('wv_onboarding_key') || crypto.randomUUID();
  localStorage.setItem('wv_onboarding_key', onboarding.key);
  onboarding.router = null;
  onboarding.agent = null;
  onboarding.label = '';
  onboarding.provisioned = false;
  onboarding.verified = false;
  onboarding.verifying = false;
  show($('modal-onboarding'));
  renderOnboarding();
}

function closeOnboarding(skip = false) {
  hide($('modal-onboarding'));
  if (skip) {
    localStorage.setItem('wv_onboarding_skipped', '1');
  } else if (onboarding.verified) {
    localStorage.removeItem('wv_onboarding_key');
    localStorage.removeItem('wv_onboarding_skipped');
    localStorage.setItem('wv_onboarding_complete', '1');
  }
}

function onboardingError(err, fallback = 'Setup could not continue.') {
  if (err?.status === 401) return 'Your session expired. Please log in again.';
  if (err?.status === 403) return err.message || 'Your subscription does not currently allow router setup.';
  if (err?.status === 409) return err.message || 'This router is already registered.';
  if (err?.status === 429) return 'Please wait a moment and try again.';
  if (err?.status >= 500) return 'Our server could not finish this step. Nothing was marked complete.';
  if (err?.message?.toLowerCase().includes('failed to fetch')) return 'Your internet connection was interrupted. Please reconnect and try again.';
  return err?.message || fallback;
}

function renderOnboarding() {
  const s = onboarding.step;
  $('onboarding-step-label').textContent = `Step ${s} of ${onboarding.total}`;
  $('onboarding-progress-bar').style.width = `${(s / onboarding.total) * 100}%`;
  $('onboarding-back').classList.toggle('hidden', s === 1 || s === 4);
  $('onboarding-skip').classList.toggle('hidden', s >= 3);
  $('onboarding-next').classList.toggle('hidden', false);
  $('onboarding-next').textContent = s === 3 ? 'Check my router' : (s === 4 ? (onboarding.verified ? 'Done' : 'Retry connection') : 'Continue');
  $('onboarding-status').textContent = '';

  const body = $('onboarding-body');

  if (s === 1) {
    body.innerHTML = `
      <div class="onboarding-hero">
        <span class="eyebrow">Automatic setup</span>
        <h2 id="onboarding-title">Let’s connect your WiFi router.</h2>
        <p>We’ll keep the technical work out of your way. You only need access to the MikroTik for one setup step.</p>
        <div class="onboarding-meta">
          <span>One-time setup</span><span>No router password needed</span><span>Automatic verification</span>
        </div>
      </div>
      <div class="onboarding-checks">
        <div>✓ Detect router version</div>
        <div>✓ Detect hardware</div>
        <div>✓ Check Internet access</div>
        <div>✓ Find the safest connection path</div>
        <div>✓ Test the connection before we say “ready”</div>
      </div>
      <div class="onboarding-callout"><strong>What you need:</strong> access to the MikroTik router. We’ll do the technical diagnosis automatically.</div>
    `;
  } else if (s === 2) {
    body.innerHTML = `
      <h2>Name this router</h2>
      <p class="hint">This is only for you, so you can recognize it later. For example: Shop, Cafe, Hostel or Office.</p>
      <label for="ob-label">Router name</label>
      <input id="ob-label" maxlength="100" value="${escapeHtml(onboarding.label)}" placeholder="My Shop" autocomplete="off" />
      <div class="onboarding-callout"><strong>Next:</strong> we’ll generate a private setup script for this router. You can leave the setup and come back later.</div>
    `;
    $('ob-label').focus();
  } else if (s === 3) {
    body.innerHTML = `
      <h2>One quick setup on your router</h2>
      <p class="hint">This is the only technical step. Copy the private script, open the MikroTik terminal, paste it, and run it once.</p>
      <div class="onboarding-instructions">
        <div class="onboarding-instruction"><b>1</b><span>Copy the private setup script below.</span></div>
        <div class="onboarding-instruction"><b>2</b><span>Open your MikroTik terminal and paste it.</span></div>
        <div class="onboarding-instruction"><b>3</b><span>Run it once, then return here and tap “Check my router”.</span></div>
      </div>
      <div class="onboarding-result">
        <textarea id="onboarding-agent-script" class="code-block" rows="16" readonly>Preparing your private connection…</textarea>
        <button type="button" class="btn small" id="copy-onboarding-script" disabled>Copy setup script</button>
        <div class="onboarding-callout"><strong>Keep it private.</strong> This script contains a private connection token for this router. We never need you to type the router password here.</div>
      </div>
    `;
    if (!onboarding.provisioned) provisionOnboarding();
  } else {
    body.innerHTML = `
      <h2>Checking your router</h2>
      <div id="onboarding-verify-content">
        <div class="onboarding-wait"><span class="onboarding-wait-dot"></span><span><strong>Looking for your router…</strong><br><small class="hint">This can take a few moments.</small></span></div>
        <div class="onboarding-checks">
          <div>⏳ Finding your router</div>
          <div>⏳ Reading router details</div>
          <div>⏳ Checking Internet access</div>
          <div>⏳ Testing the connection</div>
        </div>
      </div>
    `;
    if (!onboarding.verified && !onboarding.verifying) verifyOnboarding();
  }
}

function collectOnboardingStep() {
  if (onboarding.step === 2) {
    onboarding.label = $('ob-label').value.trim();
    if (!onboarding.label) {
      $('onboarding-status').textContent = 'Please enter a name for this router.';
      return false;
    }
  }
  return true;
}

async function nextOnboarding() {
  if (!collectOnboardingStep()) return;
  if (onboarding.step < onboarding.total) {
    onboarding.step++;
    renderOnboarding();
  } else {
    closeOnboarding();
  }
}

async function provisionOnboarding() {
  const scriptBox = $('onboarding-agent-script');
  const copyBtn = $('copy-onboarding-script');
  try {
    const saved = await api('/routers', {
      method: 'POST',
      body: JSON.stringify({
        label: onboarding.label,
        connection_mode: 'agent',
        api_port: 8729,
        api_tls: true,
        onboarding_key: onboarding.key,
      }),
    });
    onboarding.router = saved.router;

    const agent = await api(`/routers/${saved.router.id}/agent`, { method: 'POST' });
    onboarding.agent = agent.agent;

    scriptBox.value = agent.script || 'Setup script could not be generated. Please retry.';
    copyBtn.disabled = !agent.script;
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(agent.script);
        showToast('Setup script copied.', 'success');
      } catch {
        scriptBox.focus();
        scriptBox.select();
        showToast('Select the script and copy it manually.', 'info');
      }
    };
    onboarding.provisioned = true;
    $('onboarding-status').textContent = 'Paste the script into your router, run it once, then press Continue.';
  } catch (err) {
    scriptBox.value = onboardingError(err, 'We could not prepare the router connection.');
    $('onboarding-status').textContent = 'Nothing was marked complete. You can retry.';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyOnboarding() {
  if (onboarding.verifying || onboarding.verified) return;
  onboarding.verifying = true;
  const out = $('onboarding-verify-content');

  try {
    if (!onboarding.router) throw new Error('No router connection was created.');
    if (!onboarding.provisioned) { onboarding.step = 3; renderOnboarding(); return; }

    const deadline = Date.now() + 90000;
    let agent = null;

    while (Date.now() < deadline) {
      const status = await api(`/routers/${onboarding.router.id}/agent`);
      agent = status.agent;
      if (agent?.status === 'online') break;
      out.innerHTML = `
        <p><strong>Waiting for your router…</strong></p>
        <p class="hint">The router has not checked in yet. Keep the router online and make sure the setup script was run.</p>
        <div class="onboarding-callout">You do not need to change IP addresses, ports, CGNAT or firewall settings. WiFi Voucher is handling that diagnosis.</div>
      `;
      await sleep(4000);
    }

    if (!agent || agent.status !== 'online') {
      throw new Error('Your router has not connected yet. Run the setup script once on the router, then try again.');
    }

    out.innerHTML = `
      <p><strong>Router found. Reading its details…</strong></p>
      <div class="onboarding-checks">
        <div>✓ Router is online</div>
        <div>✓ Internet connection detected</div>
        <div>✓ Router details detected</div>
        <div>✓ Selecting connection automatically</div>
      </div>
    `;

    const result = await api(`/routers/${onboarding.router.id}/readiness`, { method: 'POST' });
    if (!result?.success) throw new Error(result?.message || 'Router verification failed.');

    const detected = result.result || {};
    const version = detected.version || agent.routeros_version || 'detected';
    const board = detected.board || agent.board_name || 'MikroTik hardware';

    if (detected.hotspot_ready === false) {
      throw new Error('Your router is connected, but the MikroTik Hotspot service is not configured yet. Finish the Hotspot setup, then check the router again.');
    }

    out.innerHTML = `
      <div class="success-result">
        <h3>You’re connected and ready.</h3>
        <p>WiFi Voucher found your <strong>${escapeHtml(board)}</strong> running RouterOS <strong>${escapeHtml(version)}</strong>.</p>
        <span class="connection-pill">✓ Secure connection verified</span>
        <div class="onboarding-checks">
          <div>✓ Router identified</div>
          <div>✓ Connection path verified</div>
          <div>✓ Hotspot service detected</div>
          <div>✓ Ready for vouchers</div>
        </div>
      </div>
    `;
    onboarding.verified = true;
    localStorage.setItem('wv_onboarding_complete', '1');
    $('onboarding-next').textContent = 'Done';
    $('onboarding-next').classList.remove('hidden');
    $('onboarding-back').classList.add('hidden');
    $('onboarding-skip').classList.add('hidden');
    await loadRouters();
    await loadProfiles();
    updatePrerequisiteHints();
  } catch (err) {
    out.innerHTML = `
      <div class="onboarding-result error">
        <strong>We could not finish the connection yet.</strong>
        <p>${escapeHtml(onboardingError(err, 'The router is not reachable yet.'))}</p>
        <p class="hint">No router setup is marked complete until we verify it.</p>
      </div>
    `;
    $('onboarding-next').textContent = 'Retry';
    $('onboarding-next').classList.remove('hidden');

  } finally {
    onboarding.verifying = false;
  }
}
