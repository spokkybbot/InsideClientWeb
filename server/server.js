'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const db = require('./db');
const { hashPassword, verifyPassword, newToken, newLinkCode } = require('./auth-utils');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const SESSION_COOKIE = 'ic_sid';
const SESSION_SHORT_MS = 2 * 24 * 60 * 60 * 1000;   // 2 days
const SESSION_LONG_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days ("remember me")

const LOGIN_RE = /^[A-Za-z0-9_]{3,20}$/;
const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'InsideClientBot';
// TODO: заменить на реальную ссылку на карточку/профиль после того, как
// появится настоящий листинг на FunPay — это временная заглушка вместо
// реальной оплаты.
const FUNPAY_URL = process.env.FUNPAY_URL || 'https://funpay.com/';

/* ---------------------------------------------------------------------- */
/* Small helpers                                                          */
/* ---------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token, maxAgeMs) {
  const seconds = Math.floor(maxAgeMs / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${seconds}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/* ---------------------------------------------------------------------- */
/* Session / auth                                                         */
/* ---------------------------------------------------------------------- */

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  return user || null;
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    fail(res, 401, 'Требуется авторизация.');
    return null;
  }
  return user;
}

/* ---------------------------------------------------------------------- */
/* DTO builders                                                           */
/* ---------------------------------------------------------------------- */

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function userToDto(user) {
  const purchases = db
    .prepare('SELECT product, source, purchased_at FROM purchases WHERE user_id = ? ORDER BY purchased_at DESC')
    .all(user.id);

  // "HWID reset" service purchases don't count as owning the client.
  const clientPurchases = purchases.filter((p) => p.product !== 'Сброс HWID');

  return {
    uid: user.id,
    login: user.login,
    group: clientPurchases.length ? 'Пользователь' : 'Нету',
    regdate: formatDate(user.created_at),
    lastlogin: formatDate(user.last_login),
    hwid: user.hwid || null,
    telegram: user.telegram_username || null,
    telegramLinked: Boolean(user.telegram_chat_id),
    purchases: clientPurchases.map((p) => ({
      product: p.product,
      purchasedAt: formatDate(p.purchased_at),
    })),
    purchasesSummary: clientPurchases.length ? clientPurchases[0].product : 'Нет покупок',
  };
}

/* ---------------------------------------------------------------------- */
/* API routes                                                             */
/* ---------------------------------------------------------------------- */

async function handleRegister(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const login = String(body.login || '').trim();
  const password = String(body.password || '');

  if (!login || !password) {
    return fail(res, 400, 'Заполните все поля.');
  }
  if (!LOGIN_RE.test(login)) {
    return fail(res, 400, 'Логин: 3–20 символов (буквы, цифры, "_").');
  }
  if (password.length < 6) {
    return fail(res, 400, 'Пароль должен быть не короче 6 символов.');
  }

  const loginTaken = db.prepare('SELECT 1 FROM users WHERE login = ? COLLATE NOCASE').get(login);
  if (loginTaken) return fail(res, 409, 'Этот логин уже занят.');

  const passwordHash = hashPassword(password);
  const createdAt = nowIso();

  const info = db
    .prepare('INSERT INTO users (login, password_hash, created_at, last_login) VALUES (?, ?, ?, ?)')
    .run(login, passwordHash, createdAt, createdAt);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_LONG_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    user.id,
    nowIso(),
    expiresAt
  );
  setSessionCookie(res, token, SESSION_LONG_MS);

  sendJson(res, 201, { user: userToDto(user) });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const identifier = String(body.login || '').trim();
  const password = String(body.password || '');
  const remember = Boolean(body.remember);

  if (!identifier || !password) {
    return fail(res, 400, 'Введите логин и пароль.');
  }

  const user = db
    .prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE')
    .get(identifier);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return fail(res, 401, 'Неверный логин или пароль.');
  }

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowIso(), user.id);
  const freshUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

  const token = newToken();
  const maxAge = remember ? SESSION_LONG_MS : SESSION_SHORT_MS;
  const expiresAt = new Date(Date.now() + maxAge).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    user.id,
    nowIso(),
    expiresAt
  );
  setSessionCookie(res, token, maxAge);

  sendJson(res, 200, { user: userToDto(freshUser) });
}

function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  sendJson(res, 200, { user: userToDto(user) });
}

function handleHwidReset(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  if (!user.hwid) {
    return sendJson(res, 200, { user: userToDto(user), notice: 'HWID и так не привязан.' });
  }

  db.prepare('UPDATE users SET hwid = NULL WHERE id = ?').run(user.id);
  db.prepare('INSERT INTO purchases (user_id, product, source, purchased_at) VALUES (?, ?, ?, ?)').run(
    user.id,
    'Сброс HWID',
    'hwid-reset',
    nowIso()
  );
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: userToDto(fresh) });
}

async function handleTelegramStartLink(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  if (user.telegram_chat_id) {
    return fail(res, 409, 'Telegram уже привязан к этому аккаунту.');
  }
  if (!BOT_USERNAME) {
    return fail(res, 500, 'Бот пока не настроен на сервере (нет TELEGRAM_BOT_USERNAME).');
  }

  // Invalidate any earlier still-pending codes for this user so only the
  // freshest one works — avoids confusion if they click "Привязать" twice.
  db.prepare('UPDATE telegram_link_codes SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

  const code = newLinkCode();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO telegram_link_codes (code, user_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)'
  ).run(code, user.id, createdAt, expiresAt);

  sendJson(res, 200, {
    code,
    deepLink: `https://t.me/${BOT_USERNAME}?start=${code}`,
    expiresInSeconds: Math.floor(LINK_CODE_TTL_MS / 1000),
  });
}

function handleTelegramUnlink(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  db.prepare('UPDATE users SET telegram_chat_id = NULL, telegram_username = NULL WHERE id = ?').run(user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: userToDto(fresh) });
}

async function handlePasswordChange(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');

  if (!verifyPassword(oldPassword, user.password_hash)) {
    return fail(res, 401, 'Текущий пароль указан неверно.');
  }
  if (newPassword.length < 6) {
    return fail(res, 400, 'Новый пароль должен быть не короче 6 символов.');
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  sendJson(res, 200, { ok: true });
}

const PLAN_PRODUCT = {
  month1: 'Клиент 1.16.5',
  month3: 'Клиент 1.16.5',
  year: 'Клиент 1.16.5',
  forever: 'Клиент 1.16.5',
};

async function handleBuy(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  if (!user.telegram_chat_id) {
    return fail(res, 403, 'Перед покупкой привяжите Telegram.');
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const plan = String(body.plan || '');

  if (plan === 'hwid') {
    db.prepare('UPDATE users SET hwid = NULL WHERE id = ?').run(user.id);
    db.prepare('INSERT INTO purchases (user_id, product, source, purchased_at) VALUES (?, ?, ?, ?)').run(
      user.id,
      'Сброс HWID',
      'shop',
      nowIso()
    );
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return sendJson(res, 200, { user: userToDto(fresh) });
  }

  if (PLAN_PRODUCT[plan]) {
    // Реальной оплаты пока нет — вместо мгновенной "фейковой" покупки
    // отправляем на FunPay. Telegram уже гарантированно привязан (проверка
    // выше), это условие площадки.
    return sendJson(res, 200, { redirect: FUNPAY_URL });
  }

  return fail(res, 400, 'Неизвестный тариф.');
}

async function handleKeyActivate(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const key = String(body.key || '').trim().toUpperCase();
  if (!key) return fail(res, 400, 'Введите ключ.');

  const row = db.prepare('SELECT * FROM activation_keys WHERE activation_key = ?').get(key);
  if (!row) return fail(res, 404, 'Ключ не найден.');
  if (row.used) return fail(res, 409, 'Ключ уже активирован.');

  db.prepare('UPDATE activation_keys SET used = 1, used_by = ?, used_at = ? WHERE activation_key = ?').run(
    user.id,
    nowIso(),
    key
  );
  db.prepare('INSERT INTO purchases (user_id, product, source, purchased_at) VALUES (?, ?, ?, ?)').run(
    user.id,
    row.product,
    'key',
    nowIso()
  );

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: userToDto(fresh) });
}

/* ---------------------------------------------------------------------- */
/* Static file serving                                                    */
/* ---------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.split('?')[0];
  const filePath = path.normalize(path.join(ROOT, rel));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------------------------------------------------------------- */
/* Router                                                                 */
/* ---------------------------------------------------------------------- */

const API_ROUTES = {
  'POST /api/register': handleRegister,
  'POST /api/login': handleLogin,
  'POST /api/logout': handleLogout,
  'GET /api/me': handleMe,
  'POST /api/hwid/reset': handleHwidReset,
  'POST /api/telegram/start-link': handleTelegramStartLink,
  'POST /api/telegram/unlink': handleTelegramUnlink,
  'POST /api/password/change': handlePasswordChange,
  'POST /api/purchases/buy': handleBuy,
  'POST /api/key/activate': handleKeyActivate,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (url.pathname.startsWith('/api/')) {
    const handler = API_ROUTES[key];
    if (!handler) return fail(res, 404, 'Неизвестный маршрут.');
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error(err);
      fail(res, 500, 'Внутренняя ошибка сервера.');
    });
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, url.pathname);

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Inside Client запущен: http://localhost:${PORT}`);
});
