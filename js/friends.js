/* Друзья: заявки, поиск, карточки, приватность — с красивым поиском как в админке */
(function icFriends(){
  const listEl   = document.getElementById('friends-list');
  const emptyEl  = document.getElementById('friends-empty');
  const inputEl  = document.getElementById('friend-login');
  const addBtn   = document.getElementById('friend-add-btn');
  const msgEl    = document.getElementById('friend-add-msg');
  const searchTypeEl = document.getElementById('friend-search-type');
  const searchInputEl = document.getElementById('friend-search-input');
  const searchBtn = document.getElementById('friend-search-btn');
  const searchClear = document.getElementById('friend-search-clear');
  const incomingEl = document.getElementById('requests-incoming');
  const outgoingEl = document.getElementById('requests-outgoing');
  if (!listEl) return;
  let allFriends = [];
  let timer = null;
  let searchQuery = '';
  let searchType = 'login';

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function setMsg(text,isErr){ msgEl.textContent=text||''; msgEl.className='friend-msg'+(isErr?' err':''); }
  function fmtCoords(f){ if(f.x==null||f.y==null||f.z==null) return null; return `${f.x}, ${f.y}, ${f.z}`; }

  function cardHtml(f){
    const isOnline = !!f.online;
    const badge = isOnline ? '<span class="badge badge-on">в сети</span>' : '<span class="badge badge-off">не в сети</span>';
    const uid = f.uid!=null?`UID ${esc(f.uid)}`:'';
    // privacy already handled server-side, r.hidden not needed for cards now since we show all with privacy
    const serverRow = isOnline && f.server ? `<div class="fc-row"><b>Сервер:</b> ${esc(f.server)}</div>` : '';
    const anarchyRow = isOnline && f.server==='spookytime' && f.anarchy_num!=null ? `<div class="fc-row"><b>Анархия:</b> ${esc(f.anarchy_num)}</div>` : '';
    const coords = fmtCoords(f);
    const coordsRow = isOnline && coords ? `<div class="fc-row"><b>Координаты:</b> ${esc(coords)}</div>` : '';
    const offlineRow = !isOnline ? `<div class="fc-row">Оффлайн</div>` : '';
    return `
      <div class="friend-card">
        <div class="fc-top">
          <span class="fc-login">${esc(f.nick||f.login)}</span>
          ${badge}
        </div>
        <div class="fc-uid">${uid}</div>
        <div class="fc-nick">${esc(f.login)}</div>
        ${offlineRow}
        ${serverRow}
        ${anarchyRow}
        ${coordsRow}
        ${f.hp!=null?`<div class="fc-row"><b>ХП:</b> ${esc(f.hp)}</div>`:''}
        <div class="fc-del">
          <button type="button" class="btn btn-outline" data-remove="${esc(f.login)}">Удалить</button>
        </div>
      </div>`;
  }
  function requestCard(r, type){
    const isIncoming = type==='incoming';
    return `<div class="friend-card">
      <div class="fc-top"><span class="fc-login">${esc(r.login)}</span><span class="badge badge-hide">${isIncoming?'входящая':'исходящая'}</span></div>
      <div class="fc-uid">UID ${esc(r.uid)}</div>
      <div class="fc-del" style="display:flex;gap:8px;">
        ${isIncoming?`<button class="btn btn-primary" data-accept="${esc(r.login)}">Принять</button><button class="btn btn-outline" data-decline="${esc(r.login)}">Отклонить</button>`:`<span style="font-size:12px;color:var(--text-muted)">Ожидает</span>`}
      </div>
    </div>`;
  }
  function applySearchFilter(friends){
    if(!searchQuery) return friends;
    const q=searchQuery.toLowerCase();
    return friends.filter(f=>{
      if(searchType==='uid') return String(f.uid).includes(q);
      if(searchType==='nick') return (f.nick||'').toLowerCase().includes(q);
      return f.login.toLowerCase().includes(q) || (f.nick||'').toLowerCase().includes(q);
    });
  }
  function render(friends){
    const filtered=applySearchFilter(friends);
    if(!Array.isArray(filtered)||!filtered.length){
      listEl.innerHTML=''; emptyEl.style.display=''; emptyEl.textContent = searchQuery ? 'Ничего не найдено.' : 'Пока нет друзей. Найди по поиску выше и кинь заявку.';
      return;
    }
    emptyEl.style.display='none';
    listEl.innerHTML=filtered.map(cardHtml).join('');
    listEl.querySelectorAll('[data-remove]').forEach(btn=>{ btn.addEventListener('click',()=>removeFriend(btn.dataset.remove)); });
  }
  function renderRequests(data){
    if(!incomingEl||!outgoingEl) return;
    const inc=data.incoming||[]; const out=data.outgoing||[];
    incomingEl.innerHTML = inc.length ? inc.map(r=>requestCard(r,'incoming')).join('') : '<p style="color:var(--text-muted);font-size:13px;">Нет входящих</p>';
    outgoingEl.innerHTML = out.length ? out.map(r=>requestCard(r,'outgoing')).join('') : '<p style="color:var(--text-muted);font-size:13px;">Нет исходящих</p>';
    incomingEl.querySelectorAll('[data-accept]').forEach(btn=> btn.addEventListener('click',()=>acceptRequest(btn.dataset.accept)));
    incomingEl.querySelectorAll('[data-decline]').forEach(btn=> btn.addEventListener('click',()=>declineRequest(btn.dataset.decline)));
  }
  async function load(){
    try{
      const data=await icApiPost('/api/client/friends/list',{});
      allFriends=(data&&data.friends)||[];
      render(allFriends);
    }catch(e){}
    try{
      const data2=await icApiPost('/api/friends/requests',{}); // also works via GET
      // fallback to GET
      if(!data2.incoming){ const d=await icApiGet('/api/friends/requests'); renderRequests(d); } else renderRequests(data2);
    }catch(e){
      try{ const d=await icApiGet('/api/friends/requests'); renderRequests(d);}catch(e2){}
    }
  }
  async function addFriend(){
    const login=(inputEl.value||'').trim();
    if(!login){ setMsg('Введите логин.',true); return; }
    addBtn.disabled=true; setMsg('');
    try{
      await icApiPost('/api/friends/request',{login});
      // also try old endpoint for compat
      // await icApiPost('/api/client/friends/add',{login});
      inputEl.value='';
      setMsg('Заявка отправлена.');
      load();
    }catch(e){ setMsg(e.message||'Не удалось отправить заявку.',true); }
    finally{ addBtn.disabled=false; }
  }
  async function removeFriend(login){
    try{ await icApiPost('/api/client/friends/remove',{login}); load(); }catch(e){ icToast(e.message||'Не удалось удалить.'); }
  }
  async function acceptRequest(login){
    try{ await icApiPost('/api/friends/accept',{login}); icToast('Заявка принята'); load(); }catch(e){ icToast(e.message); }
  }
  async function declineRequest(login){
    try{ await icApiPost('/api/friends/decline',{login}); icToast('Отклонено'); load(); }catch(e){ icToast(e.message); }
  }
  function doSearch(){
    searchType=searchTypeEl.value;
    searchQuery=(searchInputEl.value||'').trim();
    render(allFriends);
    // also live search users for adding: if query and not found in friends, show hint
    if(searchQuery && searchType==='login'){
      icApiPost('/api/users/search',{q:searchQuery}).then(data=>{
        // could show dropdown, for now just toast
      }).catch(()=>{});
    }
  }
  addBtn.addEventListener('click',addFriend);
  inputEl.addEventListener('keydown',e=>{ if(e.key==='Enter') addFriend(); });
  searchBtn.addEventListener('click',doSearch);
  searchClear.addEventListener('click',()=>{ searchInputEl.value=''; searchQuery=''; render(allFriends); });
  searchInputEl.addEventListener('keydown',e=>{ if(e.key==='Enter') doSearch(); });
  searchInputEl.addEventListener('input',()=>{ if(!searchInputEl.value) { searchQuery=''; render(allFriends); } });

  document.addEventListener('ic:session-ready',()=>{ load(); timer=setInterval(load,5000); },{once:true});
  window.addEventListener('beforeunload',()=>{ if(timer) clearInterval(timer); });
})();
