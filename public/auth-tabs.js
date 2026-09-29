/**
 * Standalone auth tab switcher.
 * No dependencies: Login/Sign up remains usable even if
 * Supabase or the main application script fails to load.
 */
(function () {
  function bindAuthTabs() {
    var tabs = document.querySelectorAll('.tab');
    var login = document.getElementById('login-form');
    var signup = document.getElementById('signup-form');
    var forgot = document.getElementById('forgot-form');
    var error = document.getElementById('auth-error');
    if (!tabs.length || !login || !signup) return;

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var isLogin = tab.getAttribute('data-tab') === 'login';
        tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
        login.classList.toggle('hidden', !isLogin);
        signup.classList.toggle('hidden', isLogin);
        if (forgot) forgot.classList.add('hidden');
        if (error) {
          error.classList.add('hidden');
          error.textContent = '';
        }
      });
    });
  }


  function bindAuthSubmitGuards() {
    var login = document.getElementById('login-form');
    var signup = document.getElementById('signup-form');
    if (!login || !signup) return;

    function guard(form, handlerName) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        var handler = window[handlerName];
        if (typeof handler === 'function') {
          handler(event);
        } else {
          var error = document.getElementById('auth-error');
          if (error) {
            error.textContent = 'Authentication is still loading. Please refresh the page and try again.';
            error.classList.remove('hidden');
          }
        }
      }, true);
    }

    guard(login, 'handleLogin');
    guard(signup, 'handleSignup');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindAuthTabs(); bindAuthSubmitGuards(); });
  } else {
    bindAuthTabs();
    bindAuthSubmitGuards();
  }
})();
