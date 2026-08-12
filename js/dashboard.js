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
  if(group === 'Доступ к боту') return 'badge-bot';
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

  const avatarInner = u.avatar
    ? `<img src="${u.avatar}" alt="" class="dash-profile-avatar-img">`
    : icDashInitials(u.login);

  box.innerHTML = `
    <div class="dash-avatar-wrap">
      <button type="button" class="dash-profile-avatar" id="dash-avatar-btn" title="${icT('dash.avatar.change')}">${avatarInner}<span class="dash-avatar-hint">${ICONS.camera}</span></button>
      ${u.avatar ? `<button type="button" class="dash-avatar-remove" id="dash-avatar-remove" title="${icT('dash.avatar.remove')}">${ICONS.close}</button>` : ''}
      <input type="file" accept="image/png,image/jpeg,image/webp" id="dash-avatar-input" class="dash-avatar-input" hidden>
    </div>
    <div class="dash-profile-info">
      <span class="dash-profile-login">${u.login}</span>
      <span class="dash-profile-uid">UID ${u.uid}</span>
      <div class="dash-profile-badges">${badges.join('')}</div>
    </div>
  `;

  icWireAvatarUpload();
}

const IC_AVATAR_SIZE = 256;
const IC_AVATAR_MAX_BYTES = 850 * 1024;

function icReadAvatarFile(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(icT('dash.avatar.errorRead')));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(icT('dash.avatar.errorRead')));
      img.onload = () => {
        const size = IC_AVATAR_SIZE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Crop to a centered square, then scale down to a fixed size —
        // keeps every stored avatar small and uniform.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

        let quality = 0.9;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while(dataUrl.length > IC_AVATAR_MAX_BYTES && quality > 0.35){
          quality -= 0.12;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        if(dataUrl.length > IC_AVATAR_MAX_BYTES){
          reject(new Error(icT('dash.avatar.errorTooBig')));
          return;
        }
        resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function icWireAvatarUpload(){
  const btn = document.getElementById('dash-avatar-btn');
  const input = document.getElementById('dash-avatar-input');
  const removeBtn = document.getElementById('dash-avatar-remove');
  if(!btn || !input) return;

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if(!file) return;
    if(!/^image\/(png|jpeg|webp)$/.test(file.type)){
      icToast(icT('dash.avatar.errorType'));
      return;
    }
    try {
      const dataUrl = await icReadAvatarFile(file);
      const data = await icApiPost('/api/me/avatar', { avatar: dataUrl });
      icDashUser = data.user;
      icToast(icT('dash.avatar.saved'));
      icDashRenderProfile(icDashUser);
    } catch (err) {
      icToast(err.message);
    }
  });

  removeBtn?.addEventListener('click', async () => {
    try {
      const data = await icApiDelete('/api/me/avatar');
      icDashUser = data.user;
      icToast(icT('dash.avatar.removed'));
      icDashRenderProfile(icDashUser);
    } catch (err) {
      icToast(err.message);
    }
  });
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

function icDashSection(title){
  return `<div class="dash-section-title reveal dash-item-wide">${title}</div>`;
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
  const hasClient = u.hasClient;

  const subscriptionValue = (u.subscriptionActive && u.subscriptionUntilFull)
    ? `${icT('dash.value.activeUntil')} ${u.subscriptionUntilFull}`
    : icT('dash.value.noSubscription');

  const botAccessValue = u.botAccess ? '@Sp00kyEventsBot' : noneLabel;

  grid.innerHTML = [
    icDashSection('Аккаунт'),
    icDashField('regdate', 'calendar', u.regdate || '—'),
    icDashField('lastlogin', 'clock', u.lastlogin || '—'),

    icDashSection('Подписка и доступ'),
    icDashField('purchases', 'cart', purchasesValue,
      `<button type="button" class="btn btn-outline dash-item-action" id="dash-purchases-details">${ICONS.info}<span data-i18n="dash.row.details"></span></button>`, true),
    icDashField('subscription', 'clock', subscriptionValue, '', true),
    icDashField('botaccess', 'chat', botAccessValue, '', true),
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
  ].join('');

  actions.innerHTML = `
    <button type="button" class="btn btn-outline" id="dash-purchases">${ICONS.cart}<span data-i18n="dash.action.purchases"></span></button>
    <button type="button" class="btn btn-outline" id="dash-activate">${ICONS.key}<span data-i18n="dash.action.activate"></span></button>
    ${hasClient ? `<button type="button" class="btn btn-outline" id="dash-configs-page">${ICONS.cloud}<span data-i18n="dash.action.configs"></span></button>` : ''}
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

  document.getElementById('dash-purchases')?.addEventListener('click', () => {
    document.getElementById('dash-purchases-details')?.click();
  });

  document.getElementById('dash-activate')?.addEventListener('click', () => {
    window.location.href = 'activate.html';
  });
  document.getElementById('dash-configs-page')?.addEventListener('click', () => {
    window.location.href = 'configs.html';
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

