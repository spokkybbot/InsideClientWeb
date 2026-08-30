(function icPrivacy(){
  const grid = document.getElementById('privacy-grid');
  const msgEl = document.getElementById('privacy-msg');
  if(!grid) return;
  let privacy = {showOnline:true,showServer:true,showAnarchy:true,showCoords:true};
  function setMsg(t){ msgEl.textContent=t||''; setTimeout(()=>{ if(msgEl.textContent===t) msgEl.textContent=''; }, 2000); }
  function applyToUI(){
    grid.querySelectorAll('.switch').forEach(el=>{
      const k=el.dataset.key;
      el.classList.toggle('on', !!privacy[k]);
    });
  }
  async function load(){
    try{
      const data=await icApiGet('/api/privacy');
      if(data.privacy) privacy=Object.assign(privacy, data.privacy);
      applyToUI();
    }catch(e){ setMsg(e.message); }
  }
  async function save(){
    try{
      const data=await icApiPost('/api/privacy', privacy);
      if(data.privacy) privacy=data.privacy;
      setMsg('Сохранено');
    }catch(e){ setMsg(e.message); }
  }
  grid.addEventListener('click', e=>{
    const sw=e.target.closest('.switch');
    if(!sw) return;
    const k=sw.dataset.key;
    privacy[k]=!privacy[k];
    applyToUI();
    save();
  });
  document.addEventListener('ic:session-ready', load, {once:true});
})();
