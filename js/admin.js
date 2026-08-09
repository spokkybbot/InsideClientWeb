/* Admin Panel — account checker + activation key creation.
   session.js already redirects non-admins away from this page, so
   everything here can assume window.icCurrentUser.isAdmin === true. */

function icAdminGroupLabel(g){
  return g === 'Нету' ? 'Нету' : g;
}

function icAdminRenderProfile(p){
  const box = document.getElementById('admin-search-result');
  if(!box) return;

  const keysHtml = (p.keysActivated && p.keysActivated.length)
    ? p.keysActivated.map(k => `<li>${k.key} — ${k.product} <span class="admin-muted">(${k.activatedAt})</span></li>`).join('')
    : '<li class="admin-muted">Нет активированных ключей</li>';

  const avatarHtml = p.avatar
    ? `<img src="${p.avatar}" alt="" class="admin-profile-avatar">`
    : `<div class="admin-profile-avatar admin-profile-avatar-placeholder">${ICONS.user || ''}</div>`;

  box.innerHTML = `
    <div class="admin-profile-card">
      <div class="admin-profile-head">
        ${avatarHtml}
        <div>
          <div class="admin-profile-head-login">${p.login}</div>
          <div class="admin-profile-head-uid">UID ${p.uid}</div>
        </div>
      </div>
      <div class="admin-profile-grid">
        <div><span class="admin-profile-key">UID</span><span class="admin-profile-val">${p.uid}</span></div>
        <div><span class="admin-profile-key">Логин</span><span class="admin-profile-val">${p.login}</span></div>
        <div><span class="admin-profile-key">Группа</span><span class="admin-profile-val">${icAdminGroupLabel(p.group)}</span></div>
        <div><span class="admin-profile-key">Статус</span><span class="admin-profile-val">${p.banned ? '🚫 Забанен' : '✅ Активен'}</span></div>
        <div><span class="admin-profile-key">Регистрация</span><span class="admin-profile-val">${p.regdate || '—'}</span></div>
        <div><span class="admin-profile-key">Последний вход</span><span class="admin-profile-val">${p.lastlogin || '—'}</span></div>
        <div><span class="admin-profile-key">Telegram</span><span class="admin-profile-val">${p.telegram ? '@' + p.telegram : (p.telegramLinked ? 'Привязан' : 'Не привязан')}</span></div>
        <div><span class="admin-profile-key">HWID</span><span class="admin-profile-val">${p.hwid || 'Нету'}</span></div>
        <div><span class="admin-profile-key">Подписка</span><span class="admin-profile-val">${p.subscriptionActive ? 'До ' + p.subscriptionUntil : 'Нет'}</span></div>
      </div>
      <div class="admin-profile-keys">
        <span class="admin-profile-key">Активированные ключи</span>
        <ul>${keysHtml}</ul>
      </div>
      <div class="admin-profile-actions">
        <button type="button" class="btn btn-outline" id="admin-toggle-ban" data-uid="${p.uid}" data-banned="${p.banned}">${p.banned ? 'Разбанить' : 'Забанить'}</button>
        <button type="button" class="btn btn-outline" id="admin-revoke-sub" data-uid="${p.uid}" ${p.subscriptionActive ? '' : 'disabled'}>Снять подписку</button>
      </div>
    </div>
  `;

  document.getElementById('admin-toggle-ban')?.addEventListener('click', async (e) => {
    const uid = Number(e.currentTarget.dataset.uid);
    const currentlyBanned = e.currentTarget.dataset.banned === 'true';
    try {
      await icApiPost('/api/admin/ban', { uid, banned: !currentlyBanned });
      icToast(currentlyBanned ? 'Пользователь разбанен.' : 'Пользователь забанен.');
      icAdminSearch(String(uid), 'uid');
    } catch (err) { icToast(err.message); }
  });

  document.getElementById('admin-revoke-sub')?.addEventListener('click', async (e) => {
    const uid = Number(e.currentTarget.dataset.uid);
    try {
      await icApiPost('/api/admin/subscription/revoke', { uid });
      icToast('Подписка снята.');
      icAdminSearch(String(uid), 'uid');
    } catch (err) { icToast(err.message); }
  });
}

function icAdminSearchTypeLabel(type){
  if(type === 'uid') return 'UID';
  if(type === 'username') return 'логин';
  if(type === 'telegram') return 'Telegram username';
  return 'значение';
}

async function icAdminSearch(query, type){
  const box = document.getElementById('admin-search-result');
  if(!query){ icToast(`Введите ${icAdminSearchTypeLabel(type)}.`); return; }
  try {
    const data = await icApiGet(`/api/admin/user?query=${encodeURIComponent(query)}&type=${encodeURIComponent(type || '')}`);
    icAdminRenderProfile(data.profile);
  } catch (err) {
    if(box) box.innerHTML = '';
    icToast(err.message);
  }
}

document.addEventListener('ic:session-ready', (e) => {
  if(!e.detail.user || !e.detail.user.isAdmin) return; // session.js already redirects

  const searchTypeSelect = document.getElementById('admin-search-type');
  const searchInput = document.getElementById('admin-search-input');

  function syncSearchPlaceholder(){
    if(!searchTypeSelect || !searchInput) return;
    const type = searchTypeSelect.value;
    if(type === 'uid'){
      searchInput.placeholder = 'Например, 1024';
      searchInput.type = 'number';
    } else if(type === 'telegram'){
      searchInput.placeholder = 'username (с @ или без)';
      searchInput.type = 'text';
    } else {
      searchInput.placeholder = 'Логин пользователя';
      searchInput.type = 'text';
    }
  }
  searchTypeSelect?.addEventListener('change', syncSearchPlaceholder);
  syncSearchPlaceholder();

  document.getElementById('admin-search-btn')?.addEventListener('click', () => {
    icAdminSearch(searchInput ? searchInput.value.trim() : '', searchTypeSelect ? searchTypeSelect.value : 'uid');
  });
  document.getElementById('admin-search-input')?.addEventListener('keydown', (ev) => {
    if(ev.key === 'Enter'){ ev.preventDefault(); document.getElementById('admin-search-btn')?.click(); }
  });

  const rewardSelect = document.getElementById('key-reward');
  const daysField = document.getElementById('key-days-field');
  function syncRewardFields(){
    if(!rewardSelect || !daysField) return;
    daysField.style.display = rewardSelect.value === 'hwid_reset' ? 'none' : '';
  }
  rewardSelect?.addEventListener('change', syncRewardFields);
  syncRewardFields();

  document.getElementById('admin-key-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const hoursValid = Number(document.getElementById('key-hours').value);
    const maxUses = Number(document.getElementById('key-uses').value);
    const rewardType = document.getElementById('key-reward').value;
    const subscriptionDays = Number(document.getElementById('key-days').value);

    try {
      const data = await icApiPost('/api/admin/keys/create', { hoursValid, maxUses, rewardType, subscriptionDays });
      const resultBox = document.getElementById('admin-key-result');
      if(resultBox){
        const rewardLabel = data.key.rewardType === 'hwid_reset'
          ? 'Сброс HWID'
          : `Подписка ${data.key.subscriptionDays} дн.`;
        resultBox.innerHTML = `
          <div class="admin-key-created">
            <span class="admin-key-value" id="admin-key-value">${data.key.activationKey}</span>
            <button type="button" class="btn btn-outline" id="admin-key-copy">Скопировать</button>
          </div>
          <p class="admin-key-meta">${rewardLabel} · использований: ${data.key.maxUses} · доступен до: ${data.key.expiresAt}</p>
        `;
        document.getElementById('admin-key-copy')?.addEventListener('click', () => {
          navigator.clipboard?.writeText(data.key.activationKey);
          icToast('Ключ скопирован.');
        });
      }
      icToast('Ключ создан.');
    } catch (err) { icToast(err.message); }
  });
});
