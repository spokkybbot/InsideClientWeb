/* Runs on every page after the header/footer are mounted.
   - Updates the header "Авторизация" button to show the logged-in user.
   - Redirects away from login/register if already authenticated.
   - Guards dashboard.html for anonymous visitors. */

(async function icBootSession(){
  const page = document.body.dataset.page;
  let user = null;

  try {
    const data = await icApiGet('/api/me');
    user = data.user;
  } catch (e) {
    user = null;
  }

  window.icCurrentUser = user;

  if (user) {
    const loginBtn = document.querySelector('#app-header a[href="login.html"]');
    if (loginBtn) {
      loginBtn.setAttribute('href', 'dashboard.html');
      const label = loginBtn.querySelector('.btn-label');
      if (label) { label.removeAttribute('data-i18n'); label.textContent = user.login; }
    }
    if (page === 'login' || page === 'register') {
      window.location.href = 'dashboard.html';
      return;
    }
  } else if (page === 'dashboard' || page === 'password') {
    window.location.href = 'login.html';
    return;
  }

  document.dispatchEvent(new CustomEvent('ic:session-ready', { detail: { user } }));
})();
