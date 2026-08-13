/* configs.js — отдельная страница «Облачные конфиги» (вынесено из
   личного кабинета). Именованные пресеты настроек клиента: список,
   создание, редактирование (вручную или загрузкой файла), удаление.
   Клиент сам скачивает их через /api/client/configs/*, отдельно от
   этой страницы. */

let icConfigsList = [];
let icConfigsEditing = null; // { id, name, content } | null (id=null -> новый)
const IC_CONFIG_MAX_BYTES = 256 * 1024;

function icFormatBytes(n){
  if(n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

async function icConfigsRefresh(){
  try {
    const data = await icApiGet('/api/configs');
    icConfigsList = data.configs || [];
  } catch (e) {
    icConfigsList = [];
  }
  icConfigsRender();
}

function icConfigRow(cfg){
  return `
    <div class="dash-item reveal dash-item-wide dash-config-row" data-id="${cfg.id}">
      <span class="dash-item-icon">${ICONS.file}</span>
      <span class="dash-item-body">
        <span class="dash-item-label">${icT('dash.configs.updated')} ${cfg.updatedAt}</span>
        <span class="dash-item-value">${cfg.name}</span>
      </span>
      <span class="dash-config-size">${icFormatBytes(cfg.sizeBytes)}</span>
      <button type="button" class="btn btn-outline dash-item-action dash-config-edit" title="${icT('dash.configs.edit')}">${ICONS.edit}</button>
      <button type="button" class="btn btn-outline dash-item-action dash-config-delete" title="${icT('dash.configs.delete')}">${ICONS.trash}</button>
    </div>
  `;
}

function icConfigEditorHtml(){
  if(!icConfigsEditing) return '';
  const escName = (icConfigsEditing.name || '').replace(/"/g, '&quot;');
  const escContent = (icConfigsEditing.content || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hasContent = !!(icConfigsEditing.content || '').length;
  const statusText = hasContent ? icT('dash.configs.fileLoaded') : icT('dash.configs.fileNotLoaded');
  return `
    <div class="dash-config-editor reveal" id="dash-config-editor">
      <div class="dash-config-editor-row">
        <input type="text" class="dash-item-input" id="dash-config-name"
               maxlength="40" placeholder="${icT('dash.configs.namePlaceholder')}" value="${escName}">
      </div>
      <div class="dash-config-upload-row">
        <button type="button" class="btn btn-outline" id="dash-config-upload-btn">${ICONS.file}<span>${icT('dash.configs.uploadFile')}</span></button>
        <input type="file" id="dash-config-upload-input" class="dash-avatar-input" accept=".insideclient" hidden>
        <span class="dash-config-upload-status" id="dash-config-upload-status">${statusText}</span>
      </div>
      <p class="dash-configs-hint">${icT('dash.configs.txtOnlyHint')}</p>
      <input type="hidden" id="dash-config-content" value="${escContent}">
      <div class="dash-config-editor-actions">
        <button type="button" class="btn btn-primary" id="dash-config-save">${ICONS.check}<span>${icT('dash.configs.save')}</span></button>
        <button type="button" class="btn btn-ghost" id="dash-config-cancel">${icT('dash.configs.cancel')}</button>
      </div>
    </div>
  `;
}

function icConfigsRender(){
  const box = document.getElementById('dash-configs');
  if(!box) return;

  const rows = icConfigsList.map(icConfigRow).join('');
  const empty = icConfigsList.length
    ? ''
    : `<div class="dash-configs-empty">${icT('dash.configs.empty')}</div>`;

  box.innerHTML = `
    <p class="dash-configs-hint">${icT('dash.configs.hint')}</p>
    <div class="dash-configs-list">${rows}</div>
    ${empty}
    ${icConfigsEditing ? icConfigEditorHtml() : `<button type="button" class="btn btn-outline" id="dash-config-add">${ICONS.plus}<span>${icT('dash.configs.add')}</span></button>`}
  `;

  icWireConfigsActions();
  icApplyLang();
  icInitReveal();
}

function icReadConfigFile(file){
  return new Promise((resolve, reject) => {
    const nameOk = /\.insideclient$/i.test(file.name || '');
    const typeOk = !file.type || file.type === 'text/plain';
    if(!nameOk || !typeOk){
      reject(new Error(icT('dash.configs.uploadWrongType')));
      return;
    }
    if(file.size > IC_CONFIG_MAX_BYTES){
      reject(new Error(icT('dash.configs.uploadTooBig')));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(icT('dash.configs.uploadError')));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}

function icWireConfigsActions(){
  document.getElementById('dash-config-add')?.addEventListener('click', () => {
    icConfigsEditing = { id: null, name: '', content: '' };
    icConfigsRender();
    document.getElementById('dash-config-name')?.focus();
  });

  document.querySelectorAll('.dash-config-edit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.closest('.dash-config-row').dataset.id);
      const cfg = icConfigsList.find((c) => c.id === id);
      if(!cfg) return;
      try {
        const data = await icApiGet(`/api/configs/get?id=${id}`);
        icConfigsEditing = { id, name: data.config.name, content: data.config.content };
        icConfigsRender();
        document.getElementById('dash-config-content')?.focus();
      } catch (err) { icToast(err.message); }
    });
  });

  document.querySelectorAll('.dash-config-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.closest('.dash-config-row').dataset.id);
      const cfg = icConfigsList.find((c) => c.id === id);
      if(!cfg) return;
      if(!confirm(`${icT('dash.configs.confirmDelete')} «${cfg.name}»?`)) return;
      try {
        await icApiPost('/api/configs/delete', { id });
        icToast(icT('dash.configs.deleted'));
        await icConfigsRefresh();
      } catch (err) { icToast(err.message); }
    });
  });

  document.getElementById('dash-config-cancel')?.addEventListener('click', () => {
    icConfigsEditing = null;
    icConfigsRender();
  });

  document.getElementById('dash-config-upload-btn')?.addEventListener('click', () => {
    document.getElementById('dash-config-upload-input')?.click();
  });

  document.getElementById('dash-config-upload-input')?.addEventListener('change', async (e) => {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if(!file) return;
    try {
      const text = await icReadConfigFile(file);
      const contentBox = document.getElementById('dash-config-content');
      if(contentBox) contentBox.value = text;
      const statusBox = document.getElementById('dash-config-upload-status');
      if(statusBox) statusBox.textContent = icT('dash.configs.fileLoaded');
      const nameBox = document.getElementById('dash-config-name');
      if(nameBox && !nameBox.value.trim()){
        const base = file.name.replace(/\.[^.]+$/, '') || file.name;
        nameBox.value = base.slice(0, 40);
      }
      icToast(icT('dash.configs.uploaded'));
    } catch (err) { icToast(err.message); }
  });

  document.getElementById('dash-config-save')?.addEventListener('click', async () => {
    const name = document.getElementById('dash-config-name')?.value.trim() || '';
    const content = document.getElementById('dash-config-content')?.value ?? '';
    if(!name){ icToast(icT('dash.configs.nameRequired')); return; }
    if(!content){ icToast(icT('dash.configs.fileRequired')); return; }

    try {
      if(icConfigsEditing.id === null){
        await icApiPost('/api/configs/create', { name, content });
        icToast(icT('dash.configs.created'));
      } else {
        await icApiPost('/api/configs/update', { id: icConfigsEditing.id, name, content });
        icToast(icT('dash.configs.saved'));
      }
      icConfigsEditing = null;
      await icConfigsRefresh();
    } catch (err) { icToast(err.message); }
  });
}

document.addEventListener('ic:session-ready', (e) => {
  if(!e.detail.user) return; // session.js already redirects to login.html
  icConfigsRefresh();
});

document.addEventListener('ic:langchange', () => {
  icConfigsRender();
});
