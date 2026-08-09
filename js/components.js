/* Reusable header + footer, mounted into every page from a single source. */

const IC_TELEGRAM_URL = 'https://t.me/InsideJava';

function icRenderHeader(active){
  const langs = ['RU', 'EN', 'KZ'];

  const langHtml = langs.map((l, i) => (
    `<button type="button" data-lang="${l}">${l}</button>${i < langs.length - 1 ? '<span class="sep">|</span>' : ''}`
  )).join('');

  return `
  <div class="container">
    <div class="brand-cluster">
      <a href="index.html" class="brand">
        <span class="brand-mark">${ICONS.logo}</span>
        <span class="brand-name">Inside <b>Client</b></span>
      </a>
      <nav class="lang-switch" aria-label="Language">${langHtml}</nav>
    </div>
    <div class="header-actions">
      <a href="${IC_TELEGRAM_URL}" target="_blank" rel="noopener" class="btn btn-ghost" id="support-link"><span class="btn-icon">${ICONS.chat}</span><span class="btn-label" data-i18n="nav.support">Поддержка</span></a>
      <a href="buy.html" class="btn ${active === 'buy' ? 'btn-primary' : 'btn-outline'}"><span class="btn-icon">${ICONS.cart}</span><span class="btn-label" data-i18n="nav.buy">Купить</span></a>
      <a href="login.html" class="btn ${active === 'login' ? 'btn-primary' : 'btn-white'}"><span class="btn-icon">${ICONS.user}</span><span class="btn-label" data-i18n="nav.login">Авторизация</span></a>
    </div>
  </div>`;
}

function icRenderFooter(){
  const year = new Date().getFullYear();
  return `
  <div class="container">
    <span>© ${year} Inside Client. <span data-i18n="footer.rights">Все права защищены.</span></span>
    <div class="footer-socials">
      <a href="${IC_TELEGRAM_URL}" target="_blank" rel="noopener" class="social-btn" id="footer-telegram" aria-label="Telegram">${ICONS.telegram}</a>
      <a href="#" class="social-btn" id="footer-discord" aria-label="Discord">${ICONS.discord}</a>
      <a href="#" class="social-btn" id="footer-youtube" aria-label="YouTube">${ICONS.youtube}</a>
    </div>
  </div>`;
}

function icMountShell(active){
  const headerEl = document.getElementById('app-header');
  const footerEl = document.getElementById('app-footer');
  if(headerEl){ headerEl.innerHTML = icRenderHeader(active); }
  if(footerEl){ footerEl.innerHTML = icRenderFooter(); }

  document.querySelectorAll('.lang-switch button').forEach(btn => {
    btn.addEventListener('click', () => icSetLang(btn.dataset.lang));
  });

  document.getElementById('footer-discord')?.addEventListener('click', (e) => {
    e.preventDefault();
    icToast(icT('toast.discord'));
  });
  document.getElementById('footer-youtube')?.addEventListener('click', (e) => {
    e.preventDefault();
    icToast(icT('toast.youtube'));
  });

  icApplyLang();
}
