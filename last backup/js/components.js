/* Reusable header + footer, mounted into every page from a single source. */

// Поддержка теперь идёт через бота (кнопка "Связаться с поддержкой" в его
// клавиатуре) — если поменяешь TELEGRAM_BOT_USERNAME на сервере, поменяй
// имя бота и здесь.
const IC_TELEGRAM_URL = 'https://t.me/InsideClientBot';
const IC_DISCORD_URL = 'https://discord.gg/tUJMPKPHxc';

function icRenderHeader(active){
  const langs = ['RU', 'EN', 'KZ'];

  const langHtml = langs.map((l, i) => (
    `<button type="button" data-lang="${l}">${l}</button>${i < langs.length - 1 ? '<span class="sep">|</span>' : ''}`
  )).join('');

  const themeSwatchesHtml = IC_THEMES.map(t => (
    `<button type="button" class="theme-swatch" data-theme="${t.id}"><span class="swatch-dot swatch-${t.id}"></span>${t.label}</button>`
  )).join('');
  const customHex = icGetCustomAccentHex();

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
      <button type="button" class="theme-switch-btn audio-toggle-btn" id="audio-toggle-btn" aria-label="Звук" aria-pressed="false"></button>
      <div class="theme-switch" id="theme-switch">
        <button type="button" class="theme-switch-btn" id="theme-switch-btn" aria-label="Тема оформления">${ICONS.brush}</button>
        <div class="theme-switch-menu hidden" id="theme-switch-menu">
          <div class="theme-switch-head">${ICONS.brush}<span class="theme-switch-title" data-i18n="theme.title">Тема оформления</span></div>
          <div class="theme-switch-grid">${themeSwatchesHtml}</div>
          <div class="theme-switch-divider"></div>
          <label class="theme-custom-row" id="theme-swatch-custom" for="theme-custom-color">
            <input type="color" id="theme-custom-color" class="swatch-custom-input" value="${customHex}" aria-label="${icT('theme.custom.pick')}">
            <span data-i18n="theme.custom">Своя тема</span>
            <span class="theme-custom-icon">${ICONS.palette}</span>
          </label>
        </div>
      </div>
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
      <a href="${IC_DISCORD_URL}" target="_blank" rel="noopener" class="social-btn" id="footer-discord" aria-label="Discord">${ICONS.discord}</a>
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

  document.getElementById('footer-youtube')?.addEventListener('click', (e) => {
    e.preventDefault();
    icToast(icT('toast.youtube'));
  });

  icInitThemeSwitch();
  icApplyLang();
}
