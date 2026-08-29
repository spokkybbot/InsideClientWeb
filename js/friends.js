/* Друзья: добавление/удаление по логину сайта + живой список состояний.
   Работает по сессии (ic_sid) — cookie шлётся icApi автоматически. */

(function icFriends(){
  const listEl   = document.getElementById('friends-list');
  const emptyEl  = document.getElementById('friends-empty');
  const inputEl  = document.getElementById('friend-login');
  const addBtn   = document.getElementById('friend-add-btn');
  const msgEl    = document.getElementById('friend-add-msg');

  if (!listEl) return;

  let timer = null;

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setMsg(text, isErr){
    msgEl.textContent = text || '';
    msgEl.className = 'friend-msg' + (isErr ? ' err' : '');
  }

  function fmtCoords(f){
    if (f.x == null || f.y == null || f.z == null) return null;
    return `${f.x}, ${f.y}, ${f.z}`;
  }

  function armorSummary(armor){
    if (!Array.isArray(armor) || !armor.length) return null;
    return armor.filter(Boolean).join(', ');
  }
  function itemsSummary(items){
    if (!Array.isArray(items) || !items.length) return null;
    return items.filter(Boolean).join(', ');
  }

  function cardHtml(f){
    if (f.hidden) {
      return `
        <div class="friend-card hidden-friend">
          <div class="fc-top">
            <span class="fc-login">${esc(f.login)}</span>
            <span class="badge badge-hide">скрыто</span>
          </div>
          <div class="fc-nick">Скрывает информацию о себе</div>
          <div class="fc-del">
            <button type="button" class="btn btn-outline" data-remove="${esc(f.login)}">Удалить</button>
          </div>
        </div>`;
    }
    const coords = fmtCoords(f);
    const armor = armorSummary(f.armor);
    const items = itemsSummary(f.items);
    const online = (f.online && !f.offline)
      ? '<span class="badge badge-on">в сети</span>'
      : '<span class="badge badge-off">не в сети</span>';
    const anarchy = f.anarchy_num != null ? `Анархия ${f.anarchy_num}` : (f.server ? esc(f.server) : '—');

    return `
      <div class="friend-card">
        <div class="fc-top">
          <span class="fc-login">${esc(f.login)}</span>
          ${online}
        </div>
        <div class="fc-nick">${esc(f.nick || f.login)}</div>
        ${f.offline ? `<div class="fc-row">Нет данных (друг не в сети)</div>` : `
        <div class="fc-row"><b>Сервер:</b> ${anarchy}</div>
        ${coords ? `<div class="fc-row"><b>Координаты:</b> ${esc(coords)}</div>` : ''}
        ${f.hp != null ? `<div class="fc-row"><b>ХП:</b> ${esc(f.hp)}</div>` : ''}
        ${armor ? `<div class="fc-row"><b>Броня:</b> ${esc(armor)}</div>` : ''}
        ${items ? `<div class="fc-row"><b>Предметы:</b> ${esc(items)}</div>` : ''}
        `}
        <div class="fc-del">
          <button type="button" class="btn btn-outline" data-remove="${esc(f.login)}">Удалить</button>
        </div>
      </div>`;
  }

  function render(friends){
    if (!Array.isArray(friends) || !friends.length) {
      listEl.innerHTML = '';
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = friends.map(cardHtml).join('');
    listEl.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => removeFriend(btn.dataset.remove));
    });
  }

  async function load(){
    try {
      const data = await icApiPost('/api/client/friends/list', {});
      render((data && data.friends) || []);
    } catch (e) {
      // тихо — следующий тик попробует снова
    }
  }

  async function addFriend(){
    const login = (inputEl.value || '').trim();
    if (!login) { setMsg('Введите логин.', true); return; }
    addBtn.disabled = true;
    setMsg('');
    try {
      await icApiPost('/api/client/friends/add', { login });
      inputEl.value = '';
      setMsg('Друг добавлен.');
      load();
    } catch (e) {
      setMsg(e.message || 'Не удалось добавить.', true);
    } finally {
      addBtn.disabled = false;
    }
  }

  async function removeFriend(login){
    try {
      await icApiPost('/api/client/friends/remove', { login });
      load();
    } catch (e) {
      icToast(e.message || 'Не удалось удалить.');
    }
  }

  addBtn.addEventListener('click', addFriend);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });

  // Показываем сразу, как только сессия готова, и обновляем каждые 5 c.
  document.addEventListener('ic:session-ready', () => {
    load();
    timer = setInterval(load, 5000);
  }, { once: true });

  window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); });
})();
