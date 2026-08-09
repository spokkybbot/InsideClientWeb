/* Personal cabinet — renders real account data fetched from /api/me and
   wires each row's action to the backend. */

let icDashUser = null;
let icDashRendering = false;
let icTelegramPending = null; // { code, deepLink, expiresAt }
let icTelegramPollTimer = null;

function icDashInitials(login){
  return (login || '?').trim().charAt(0).toUpperCase();
}

function icDashGroupClass(group){
  if(group === 'Админ') return 'badge-admin';
  if(group === 'Пользователь') return 'badge-user';
  return 'badge-none';
}

function icDashRenderProfile(u){
  const box = document.getElementById('dash-profile');
  if(!box) return;

  const noneLabel = icT('dash.value.none');
  const groupLabel = u.group === 'Нету' ? noneLabel : u.group;

  const badges = [
    `<span class="dash-badge ${icDashGroupClass(u.group)}">${groupLabel}</span>`,
  ];
  if(u.subscriptionActive && u.subscriptionUntil){
    badges.push(`<span class="dash-badge badge-sub">${ICONS.clock}<span>до ${u.subscriptionUntil}</span></span>`);
  }
  if(u.banned){
    badges.push(`<span class="dash-badge badge-banned">Заблокирован</span>`);
  }

  box.innerHTML = `
    <div class="dash-profile-avatar">${icDashInitials(u.login)}</div>
    <div class="dash-profile-info">
      <span class="dash-profile-login">${u.login}</span>
      <span class="dash-profile-uid">UID ${u.uid}</span>
      <div class="dash-profile-badges">${badges.join('')}</div>
    </div>
  `;
}

function icDashField(key, icon, value, extraHtml, wide){
  return `
    <div class="dash-item reveal${wide ? ' dash-item-wide' : ''}">
      <span class="dash-item-icon">${ICONS[icon]}</span>
      <span class="dash-item-body">
        <span class="dash-item-label" data-i18n="dash.field.${key}"></span>
        <span class="dash-item-value">${value}</span>
      </span>
      ${extraHtml || ''}
    </div>
  `;
}

function icDashRender(){
  const grid = document.getElementById('dash-grid');
  const actions = document.getElementById('dash-actions');
  if(!grid || !actions || !icDashUser) return;
  icDashRendering = true;
  const u = icDashUser;

  icDashRenderProfile(u);

  const noneLabel = icT('dash.value.none');
  const notLinkedLabel = icT('dash.value.notLinked');
  const linkedLabel = icT('dash.value.linked');

  const purchasesValue = u.purchasesSummary === 'Нет покупок' ? icT('dash.value.noPurchases') : u.purchasesSummary;
  const telegramValue = u.telegramLinked ? (u.telegram ? '@' + u.telegram : linkedLabel) : notLinkedLabel;
  const hasClient = u.purchasesSummary !== 'Нет покупок';

  const subscriptionValue = (u.subscriptionActive && u.subscriptionUntilFull)
    ? `${icT('dash.value.activeUntil')} ${u.subscriptionUntilFull}`
    : icT('dash.value.noSubscription');

  grid.innerHTML = [
    icDashField('regdate', 'calendar', u.regdate || '—'),
    icDashField('lastlogin', 'clock', u.lastlogin || '—'),
    icDashField('hwid', 'cpu', u.hwid || noneLabel,
      `<button type="button" class="btn btn-outline dash-item-action" id="dash-hwid-reset">${ICONS.lock}<span data-i18n="dash.row.hwidReset"></span></button>`, true),
    icDashField('purchases', 'cart', purchasesValue,
      `<button type="button" class="btn btn-outline dash-item-action" id="dash-purchases-details">${ICONS.info}<span data-i18n="dash.row.details"></span></button>`, true),
    icDashField('subscription', 'clock', subscriptionValue, '', true),
    `<div class="dash-item reveal dash-item-wide has-panel" id="dash-telegram-item">
      <span class="dash-item-icon">${ICONS.telegram}</span>
      <span class="dash-item-body">
        <span class="dash-item-label" data-i18n="dash.field.telegram"></span>
        <span class="dash-item-value">${telegramValue}</span>
      </span>
      <button type="button" class="btn btn-outline dash-item-action" id="dash-telegram-toggle">${ICONS.link}<span data-i18n="${u.telegramLinked ? 'dash.row.unlink' : 'dash.row.link'}"></span></button>
      <div class="dash-telegram-panel hidden" id="dash-telegram-panel">
        <p data-i18n="dash.telegram.hint"></p>
        <div class="dash-telegram-row">
          <a href="#" target="_blank" rel="noopener" class="btn btn-primary" id="dash-telegram-open">${ICONS.telegram}<span data-i18n="dash.telegram.open"></span></a>
          <span class="dash-telegram-code" id="dash-telegram-code"></span>
        </div>
        <p class="dash-telegram-status" id="dash-telegram-status"></p>
      </div>
    </div>`,
    icDashField('keyactivate', 'key',
      `<input type="text" class="dash-item-input" id="dash-key-input" data-i18n-placeholder="dash.row.keyPlaceholder" placeholder="${icT('dash.row.keyPlaceholder')}" autocomplete="off">`,
      `<button type="button" class="btn btn-primary dash-item-action" id="dash-key-activate">${ICONS.key}<span data-i18n="dash.row.activate"></span></button>`,
      true),
  ].join('');

  actions.innerHTML = `
    <button type="button" class="btn btn-outline" id="dash-purchases">${ICONS.cart}<span data-i18n="dash.action.purchases"></span></button>
    ${hasClient ? `<button type="button" class="btn btn-white" id="dash-download">${ICONS.download}<span data-i18n="dash.action.download"></span></button>` : ''}
    <button type="button" class="btn btn-outline" id="dash-password">${ICONS.lock}<span data-i18n="dash.action.password"></span></button>
    <button type="button" class="btn btn-ghost" id="dash-logout">${ICONS.logout}<span data-i18n="dash.action.logout"></span></button>
  `;

  icWireDashActions();
  icApplyLang();
  icInitReveal();
  icDashRendering = false;
}

async function icDashRefresh(){
  const data = await icApiGet('/api/me');
  icDashUser = data.user;
  icDashRender();
}

function icStopTelegramPoll(){
  if(icTelegramPollTimer){ clearInterval(icTelegramPollTimer); icTelegramPollTimer = null; }
}

function icShowTelegramPanel(){
  const panel = document.getElementById('dash-telegram-panel');
  const openLink = document.getElementById('dash-telegram-open');
  const codeEl = document.getElementById('dash-telegram-code');
  const statusEl = document.getElementById('dash-telegram-status');
  if(!panel || !icTelegramPending) return;
  panel.classList.remove('hidden');
  if(openLink) openLink.href = icTelegramPending.deepLink;
  if(codeEl) codeEl.textContent = icTelegramPending.code;
  if(statusEl) statusEl.textContent = icT('dash.telegram.waiting');
}

function icStartTelegramPoll(){
  icStopTelegramPoll();
  icTelegramPollTimer = setInterval(async () => {
    if(!icTelegramPending || Date.now() > icTelegramPending.expiresAt){
      icStopTelegramPoll();
      icTelegramPending = null;
      const statusEl = document.getElementById('dash-telegram-status');
      if(statusEl) statusEl.textContent = icT('dash.telegram.expired');
      return;
    }
    try {
      const data = await icApiGet('/api/me');
      if(data.user.telegramLinked){
        icStopTelegramPoll();
        icTelegramPending = null;
        icDashUser = data.user;
        icToast(icT('toast.telegramLinked'));
        icDashRender();
      }
    } catch (e) { /* ignore transient errors while polling */ }
  }, 3000);
}

function icWireDashActions(){
  document.getElementById('dash-hwid-reset')?.addEventListener('click', () => {
    window.location.href = 'buy.html';
  });

  document.getElementById('dash-purchases-details')?.addEventListener('click', () => {
    const list = icDashUser.purchases;
    if(!list || !list.length){ icToast(icT('dash.value.noPurchases')); return; }
    const lines = list.map(p => `${p.product} — ${p.purchasedAt}`).join('\n');
    icToast(lines);
  });

  document.getElementById('dash-telegram-toggle')?.addEventListener('click', async () => {
    if(icDashUser.telegramLinked){
      try {
        const data = await icApiPost('/api/telegram/unlink');
        icDashUser = data.user;
        icTelegramPending = null;
        icStopTelegramPoll();
        icToast(icT('toast.telegramUnlinked'));
        icDashRender();
      } catch (err) { icToast(err.message); }
      return;
    }
    try {
      const data = await icApiPost('/api/telegram/start-link');
      icTelegramPending = {
        code: data.code,
        deepLink: data.deepLink,
        expiresAt: Date.now() + data.expiresInSeconds * 1000,
      };
      icShowTelegramPanel();
      window.open(data.deepLink, '_blank', 'noopener');
      icStartTelegramPoll();
    } catch (err) { icToast(err.message); }
  });

  if(icTelegramPending && Date.now() < icTelegramPending.expiresAt){
    icShowTelegramPanel();
    if(!icTelegramPollTimer) icStartTelegramPoll();
  }

  document.getElementById('dash-key-activate')?.addEventListener('click', async () => {
    const input = document.getElementById('dash-key-input');
    const key = input ? input.value.trim() : '';
    if(!key){ icToast(icT('toast.keyEmpty')); return; }
    try {
      const data = await icApiPost('/api/key/activate', { key });
      icDashUser = data.user;
      icToast(icT('toast.keyActivated'));
      icDashRender();
    } catch (err) { icToast(err.message); }
  });

  document.getElementById('dash-purchases')?.addEventListener('click', () => {
    document.getElementById('dash-purchases-details')?.click();
  });
  document.getElementById('dash-download')?.addEventListener('click', () => icToast(icT('toast.download')));

  document.getElementById('dash-password')?.addEventListener('click', () => {
    window.location.href = 'password.html';
  });

  document.getElementById('dash-logout')?.addEventListener('click', async () => {
    icStopTelegramPoll();
    icTelegramPending = null;
    try { await icApiPost('/api/logout'); } catch (e) { /* ignore */ }
    icToast(icT('toast.loggedOut'));
    window.location.href = 'login.html';
  });
}

document.addEventListener('ic:session-ready', async (e) => {
  if(!e.detail.user) return; // session.js already redirects to login.html
  icDashUser = e.detail.user;
  icDashRender();
});

document.addEventListener('ic:langchange', () => {
  if(icDashUser && !icDashRendering) icDashRender();
});
