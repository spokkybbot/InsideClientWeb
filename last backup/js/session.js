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

      // Admin Panel button, shown only to admins, sitting between "Купить"
      // and the account button ("личный кабинет").
      if (user.isAdmin && loginBtn.parentElement && !document.getElementById('nav-admin-link')) {
        const adminBtn = document.createElement('a');
        adminBtn.id = 'nav-admin-link';
        adminBtn.href = 'adminpanel.html';
        adminBtn.className = `btn ${page === 'admin' ? 'btn-primary' : 'btn-outline'}`;
        adminBtn.innerHTML = `<span class="btn-icon">${ICONS.shield}</span><span class="btn-label">Admin Panel</span>`;
        loginBtn.parentElement.insertBefore(adminBtn, loginBtn);
      }
    }
    if (page === 'login' || page === 'register') {
      window.location.href = 'dashboard.html';
      return;
    }
    if (page === 'admin' && !user.isAdmin) {
      window.location.href = 'dashboard.html';
      return;
    }
  } else if (page === 'dashboard' || page === 'password' || page === 'admin') {
    window.location.href = 'login.html';
    return;
  }

  document.dispatchEvent(new CustomEvent('ic:session-ready', { detail: { user } }));
})();
