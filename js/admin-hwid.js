/* admin-hwid.js — управление HWID и просмотр логов верификации */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resultBadge(result) {
    const map = {
      access:       ['✅', 'color:var(--accent)'],
      banned:       ['🚫', 'color:#e74c3c'],
      not_found:    ['❌', 'color:#e74c3c'],
      no_license:   ['⛔', 'color:#e67e22'],
      rate_limited: ['⏱️', 'color:#888'],
      invalid_hwid: ['⚠️', 'color:#888'],
    };
    const [icon, style] = map[result] || ['❓', ''];
    return `<span style="${style}">${icon} ${esc(result)}</span>`;
  }

  /* ------------------------------------------------------------------ */
  /* Секция 1: Список пользователей + управление HWID                   */
  /* ------------------------------------------------------------------ */

  const usersTableEl   = document.getElementById('hwid-users-table');
  const usersLoadBtn   = document.getElementById('hwid-load-btn');
  const usersSearchEl  = document.getElementById('hwid-search');
  const hwidSetForm    = document.getElementById('hwid-set-form');
  const hwidSetResult  = document.getElementById('hwid-set-result');

  let allUsers = [];

  function renderUsers(users) {
    if (!usersTableEl) return;
    if (!users.length) {
      usersTableEl.innerHTML = '<p style="color:var(--text-muted)">Нет пользователей.</p>';
      return;
    }

    const rows = users.map((u) => `
      <tr>
        <td>${esc(u.uid)}</td>
        <td>${esc(u.login)}</td>
        <td style="font-family:monospace;font-size:11px;word-break:break-all">
          ${u.hwid ? esc(u.hwid) : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td>${u.banned ? '🚫' : u.isAdmin ? '🛡' : '👤'}</td>
        <td>
          <button class="btn btn-xs btn-outline" data-hwid-edit="${esc(u.uid)}" data-login="${esc(u.login)}" data-current="${esc(u.hwid || '')}">✏️ Изменить</button>
          ${u.hwid ? `<button class="btn btn-xs btn-danger" data-hwid-clear="${esc(u.uid)}" style="margin-left:4px">🗑️ Сбросить</button>` : ''}
        </td>
      </tr>
    `).join('');

    usersTableEl.innerHTML = `
      <table class="admin-table" style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th>UID</th><th>Логин</th><th>HWID</th><th>Статус</th><th>Действия</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    // Кнопки «Изменить»
    usersTableEl.querySelectorAll('[data-hwid-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid     = btn.dataset.hwidEdit;
        const login   = btn.dataset.login;
        const current = btn.dataset.current;
        openHwidSetForm(uid, login, current);
      });
    });

    // Кнопки «Сбросить»
    usersTableEl.querySelectorAll('[data-hwid-clear]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.hwidClear;
        if (!confirm(`Сбросить HWID пользователя #${uid}?`)) return;
        try {
          await icApi('DELETE', '/api/admin/hwid/clear', { uid: Number(uid) });
          showMsg(hwidSetResult, '✅ HWID сброшен.', false);
          loadUsers();
        } catch (e) {
          showMsg(hwidSetResult, '❌ ' + e.message, true);
        }
      });
    });
  }

  function openHwidSetForm(uid, login, current) {
    if (!hwidSetForm) return;
    hwidSetForm.style.display = 'block';
    hwidSetForm.querySelector('[name=uid]').value  = uid;
    hwidSetForm.querySelector('[name=hwid]').value = current;
    hwidSetForm.querySelector('.hwid-form-target').textContent = `Пользователь #${uid} (${login})`;
    hwidSetResult.textContent = '';
  }

  async function loadUsers() {
    if (!usersTableEl) return;
    usersTableEl.innerHTML = '<p style="color:var(--text-muted)">Загрузка…</p>';
    try {
      const data = await icApiGet('/api/admin/users?limit=100');
      allUsers = data.users || [];
      filterAndRender();
    } catch (e) {
      usersTableEl.innerHTML = `<p style="color:#e74c3c">Ошибка: ${esc(e.message)}</p>`;
    }
  }

  function filterAndRender() {
    const q = (usersSearchEl?.value || '').trim().toLowerCase();
    const filtered = q
      ? allUsers.filter((u) =>
          String(u.uid).includes(q) ||
          u.login.toLowerCase().includes(q) ||
          (u.hwid && u.hwid.includes(q))
        )
      : allUsers;
    renderUsers(filtered);
  }

  usersLoadBtn?.addEventListener('click', loadUsers);
  usersSearchEl?.addEventListener('input', filterAndRender);

  hwidSetForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const uid  = Number(hwidSetForm.querySelector('[name=uid]').value);
    const hwid = hwidSetForm.querySelector('[name=hwid]').value.trim();
    try {
      await icApi('POST', '/api/admin/hwid/set', { uid, hwid });
      showMsg(hwidSetResult, '✅ HWID обновлён.', false);
      hwidSetForm.style.display = 'none';
      loadUsers();
    } catch (e) {
      showMsg(hwidSetResult, '❌ ' + e.message, true);
    }
  });

  hwidSetForm?.querySelector('.hwid-form-cancel')?.addEventListener('click', () => {
    hwidSetForm.style.display = 'none';
  });

  /* ------------------------------------------------------------------ */
  /* Секция 2: Лог верификаций                                          */
  /* ------------------------------------------------------------------ */

  const logTableEl    = document.getElementById('verify-log-table');
  const logLoadBtn    = document.getElementById('verify-log-load-btn');
  const logFilterEl   = document.getElementById('verify-log-filter');

  async function loadLog() {
    if (!logTableEl) return;
    logTableEl.innerHTML = '<p style="color:var(--text-muted)">Загрузка…</p>';
    const result = logFilterEl?.value || '';
    const url = result ? `/api/admin/verify-log?result=${encodeURIComponent(result)}&limit=100` : '/api/admin/verify-log?limit=100';
    try {
      const data = await icApiGet(url);
      const logs = data.logs || [];
      if (!logs.length) {
        logTableEl.innerHTML = '<p style="color:var(--text-muted)">Записей нет.</p>';
        return;
      }
      const rows = logs.map((l) => `
        <tr>
          <td>${esc(l.id)}</td>
          <td style="font-family:monospace">${esc(l.hwid || '—')}</td>
          <td>${esc(l.clientIp || '—')}</td>
          <td>${resultBadge(l.result)}</td>
          <td>${l.uid ? `#${esc(l.uid)} ${esc(l.login || '')}` : '—'}</td>
          <td>${esc(l.createdAt || '—')}</td>
        </tr>
      `).join('');
      logTableEl.innerHTML = `
        <table class="admin-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr><th>#</th><th>HWID (начало)</th><th>IP клиента</th><th>Результат</th><th>Пользователь</th><th>Время</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (e) {
      logTableEl.innerHTML = `<p style="color:#e74c3c">Ошибка: ${esc(e.message)}</p>`;
    }
  }

  logLoadBtn?.addEventListener('click', loadLog);

  /* ------------------------------------------------------------------ */
  /* Misc                                                                */
  /* ------------------------------------------------------------------ */

  function showMsg(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#e74c3c' : 'var(--accent)';
  }

  // Автозагрузка при открытии страницы
  loadUsers();
  loadLog();
})();
