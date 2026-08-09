'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Same list db.js applies at boot — re-checked on every register/login too,
// so granting admin to a login that doesn't have an account yet (or wasn't
// in ADMIN_LOGINS when the server last started) doesn't need a restart.
const ADMIN_LOGINS = (process.env.ADMIN_LOGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function maybePromoteAdmin(user) {
  if (!user.is_admin && ADMIN_LOGINS.includes(user.login.toLowerCase())) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  return user;
}

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

function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 1e6;
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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
  if (user.banned) {
    fail(res, 403, 'Аккаунт заблокирован.');
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.is_admin) {
    fail(res, 403, 'Доступ только для администраторов.');
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

// Exact "dd:mm:yy:hh:mm:ss" format for the subscription-state field in the
// dashboard, as requested — down to the second, colon-separated.
function formatDateFull(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}:${pad(d.getMonth() + 1)}:${pad(d.getFullYear() % 100)}:${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isSubscriptionActive(user) {
  return Boolean(user.subscription_until && new Date(user.subscription_until).getTime() > Date.now());
}

// Rank/group. Admin is a manually-assigned flag and always wins; otherwise
// the existing "Пользователь"/"Нету" logic (derived from ownership) applies,
// now also counting an active timed subscription as ownership.
function computeGroup(user, clientPurchases) {
  if (user.is_admin) return 'Админ';
  if (isSubscriptionActive(user) || clientPurchases.length) return 'Пользователь';
  return 'Нету';
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
    isAdmin: Boolean(user.is_admin),
    banned: Boolean(user.banned),
    group: computeGroup(user, clientPurchases),
    regdate: formatDate(user.created_at),
    lastlogin: formatDate(user.last_login),
    hwid: user.hwid || null,
    telegram: user.telegram_username || null,
    telegramLinked: Boolean(user.telegram_chat_id),
    avatar: user.avatar || null,
    subscriptionActive: isSubscriptionActive(user),
    subscriptionUntil: user.subscription_until ? formatDate(user.subscription_until) : null,
    subscriptionUntilFull: user.subscription_until ? formatDateFull(user.subscription_until) : null,
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

  const user = maybePromoteAdmin(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));

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
  if (user.banned) {
    return fail(res, 403, 'Аккаунт заблокирован.');
  }

  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowIso(), user.id);
  const freshUser = maybePromoteAdmin(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));

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

const AVATAR_MAX_BYTES = 900 * 1024; // источник уже уменьшен/сжат на клиенте до этого размера
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

async function handleAvatarUpload(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  let body;
  try {
    body = await readJsonBody(req, AVATAR_MAX_BYTES + 2048);
  } catch (e) {
    return fail(res, 413, 'Файл слишком большой.');
  }

  const avatar = String(body.avatar || '');
  if (!avatar || !AVATAR_DATA_URL_RE.test(avatar)) {
    return fail(res, 400, 'Некорректное изображение.');
  }
  if (avatar.length > AVATAR_MAX_BYTES) {
    return fail(res, 413, 'Файл слишком большой.');
  }

  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: userToDto(fresh) });
}

function handleAvatarDelete(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: userToDto(fresh) });
}

const PLAN_PRODUCT = {
  month1: 'Клиент 1.16.5',
  month3: 'Клиент 1.16.5',
  year: 'Клиент 1.16.5',
  forever: 'Клиент 1.16.5',
  bot: 'Доступ к боту',
};

// Каждый тариф ведёт на свой конкретный лот FunPay.
const PLAN_LINKS = {
  month1: 'https://funpay.com/lots/offer?id=74713087',
  month3: 'https://funpay.com/lots/offer?id=74713134',
  year: 'https://funpay.com/lots/offer?id=74713169',
  forever: 'https://funpay.com/lots/offer?id=74713197',
  hwid: 'https://funpay.com/lots/offer?id=74713229',
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

  if (PLAN_LINKS[plan]) {
    // Реальной оплаты пока нет — вместо мгновенной "фейковой" покупки
    // отправляем на конкретный лот FunPay. Telegram уже гарантированно
    // привязан (проверка выше), это условие площадки.
    return sendJson(res, 200, { redirect: PLAN_LINKS[plan] });
  }

  if (PLAN_PRODUCT[plan]) {
    // Для тарифов без выделенного лота (например «Доступ к боту») —
    // отправляем на общий магазин FunPay.
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

  const inputKey = String(body.key || '').trim();
  if (!inputKey) return fail(res, 400, 'Введите ключ.');

  const row = db.prepare('SELECT * FROM activation_keys WHERE activation_key = ? COLLATE NOCASE').get(inputKey);
  if (!row) return fail(res, 404, 'Ключ не найден.');
  const key = row.activation_key; // canonical casing as stored

  const maxUses = row.max_uses || 1;
  const usesCount = row.uses_count || row.used || 0;
  if (usesCount >= maxUses) return fail(res, 409, 'Ключ уже активирован максимальное количество раз.');

  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return fail(res, 410, 'Срок действия ключа истёк.');
  }

  const alreadyUsedByThisUser = db
    .prepare('SELECT 1 FROM key_uses WHERE activation_key = ? AND user_id = ?')
    .get(key, user.id);
  if (alreadyUsedByThisUser) return fail(res, 409, 'Вы уже активировали этот ключ.');

  const rewardType = row.reward_type || 'subscription';
  let productLabel = row.product;

  if (rewardType === 'hwid_reset') {
    db.prepare('UPDATE users SET hwid = NULL WHERE id = ?').run(user.id);
    productLabel = 'Сброс HWID';
  } else if (row.subscription_days) {
    // Per spec, both the key's own validity window *and* the subscription
    // duration it grants start counting from the moment the key was
    // created, not from the moment it's redeemed.
    const base = row.created_at ? new Date(row.created_at).getTime() : Date.now();
    const grantedUntil = base + row.subscription_days * 24 * 60 * 60 * 1000;
    const currentUntil = user.subscription_until ? new Date(user.subscription_until).getTime() : 0;
    const newUntil = Math.max(currentUntil, grantedUntil);
    db.prepare('UPDATE users SET subscription_until = ? WHERE id = ?').run(
      new Date(newUntil).toISOString(),
      user.id
    );
    productLabel = `Подписка (${row.subscription_days} дн.)`;
  }

  db.prepare('INSERT INTO purchases (user_id, product, source, purchased_at) VALUES (?, ?, ?, ?)').run(
    user.id,
    productLabel,
    'key',
    nowIso()
  );
  db.prepare('INSERT INTO key_uses (activation_key, user_id, used_at) VALUES (?, ?, ?)').run(
    key,
    user.id,
    nowIso()
  );

  const newUsesCount = usesCount + 1;
  db.prepare('UPDATE activation_keys SET uses_count = ?, used = ?, used_by = ?, used_at = ? WHERE activation_key = ?').run(
    newUsesCount,
    newUsesCount >= maxUses ? 1 : 0,
    user.id,
    nowIso(),
    key
  );

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: userToDto(fresh) });
}

/* ---------------------------------------------------------------------- */
/* Admin — rank, account checker, key creation                            */
/* ---------------------------------------------------------------------- */

function findUserByQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return null;

  if (/^\d+$/.test(q)) {
    const byId = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(q));
    if (byId) return byId;
  }

  const byLogin = db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(q);
  if (byLogin) return byLogin;

  const tgHandle = q.replace(/^@/, '');
  const byTelegram = db
    .prepare('SELECT * FROM users WHERE telegram_username = ? COLLATE NOCASE')
    .get(tgHandle);
  if (byTelegram) return byTelegram;

  return null;
}

function handleAdminUserLookup(req, res, url) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const query = url.searchParams.get('query');
  const user = findUserByQuery(query);
  if (!user) return fail(res, 404, 'Пользователь не найден.');

  const keyUses = db
    .prepare(
      `SELECT ku.activation_key, ku.used_at, ak.product, ak.reward_type, ak.subscription_days
       FROM key_uses ku
       JOIN activation_keys ak ON ak.activation_key = ku.activation_key
       WHERE ku.user_id = ?
       ORDER BY ku.used_at DESC`
    )
    .all(user.id);

  sendJson(res, 200, {
    profile: {
      ...userToDto(user),
      keysActivated: keyUses.map((k) => ({
        key: k.activation_key,
        product: k.product,
        rewardType: k.reward_type,
        activatedAt: formatDate(k.used_at),
      })),
    },
  });
}

async function handleAdminBan(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const uid = Number(body.uid);
  const banned = Boolean(body.banned);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return fail(res, 404, 'Пользователь не найден.');

  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, uid);
  if (banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  sendJson(res, 200, { user: userToDto(fresh) });
}

async function handleAdminRevokeSubscription(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const uid = Number(body.uid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return fail(res, 404, 'Пользователь не найден.');

  db.prepare('UPDATE users SET subscription_until = NULL WHERE id = ?').run(uid);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  sendJson(res, 200, { user: userToDto(fresh) });
}

// Key format: xxxx-xxxx-xxxx-xxxx — four fully random lowercase a-z0-9
// segments. Hours-valid / max-uses / reward / subscription-days are *not*
// encoded into the visible key anymore — they're just stored on the
// activation_keys row (see handleAdminCreateKey below) and looked up by the
// key string at redemption time.
const KEY_SEGMENT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomKeySegment(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += KEY_SEGMENT_ALPHABET[bytes[i] % KEY_SEGMENT_ALPHABET.length];
  return out;
}

function generateActivationKey() {
  return [randomKeySegment(4), randomKeySegment(4), randomKeySegment(4), randomKeySegment(4)].join('-');
}

async function handleAdminCreateKey(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, 400, 'Некорректный запрос.');
  }

  const hoursValid = Math.max(0, Math.min(999999, parseInt(body.hoursValid, 10) || 0));
  const maxUses = Math.max(1, Math.min(9999, parseInt(body.maxUses, 10) || 1));
  const rewardType = body.rewardType === 'hwid_reset' ? 'hwid_reset' : 'subscription';
  const subscriptionDays =
    rewardType === 'subscription' ? Math.max(1, Math.min(9999, parseInt(body.subscriptionDays, 10) || 0)) : null;

  if (rewardType === 'subscription' && !subscriptionDays) {
    return fail(res, 400, 'Укажите срок подписки в днях.');
  }

  const createdAt = nowIso();
  const expiresAt = hoursValid > 0 ? new Date(Date.now() + hoursValid * 60 * 60 * 1000).toISOString() : null;
  const product = rewardType === 'hwid_reset' ? 'Сброс HWID' : `Подписка (${subscriptionDays} дн.)`;

  let activationKey = null;
  for (let attempt = 0; attempt < 5 && !activationKey; attempt++) {
    const candidate = generateActivationKey();
    const exists = db.prepare('SELECT 1 FROM activation_keys WHERE activation_key = ? COLLATE NOCASE').get(candidate);
    if (!exists) activationKey = candidate;
  }
  if (!activationKey) return fail(res, 500, 'Не удалось сгенерировать уникальный ключ, попробуйте ещё раз.');

  db.prepare(
    `INSERT INTO activation_keys
       (activation_key, product, reward_type, max_uses, uses_count, hours_valid, subscription_days, created_at, expires_at, created_by)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).run(activationKey, product, rewardType, maxUses, hoursValid, subscriptionDays, createdAt, expiresAt, admin.id);

  sendJson(res, 201, {
    key: {
      activationKey,
      product,
      rewardType,
      maxUses,
      hoursValid,
      subscriptionDays,
      createdAt: formatDate(createdAt),
      expiresAt: expiresAt ? formatDate(expiresAt) : 'Бессрочно',
    },
  });
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
  'POST /api/me/avatar': handleAvatarUpload,
  'DELETE /api/me/avatar': handleAvatarDelete,
  'POST /api/purchases/buy': handleBuy,
  'POST /api/key/activate': handleKeyActivate,
  'GET /api/admin/user': handleAdminUserLookup,
  'POST /api/admin/ban': handleAdminBan,
  'POST /api/admin/subscription/revoke': handleAdminRevokeSubscription,
  'POST /api/admin/keys/create': handleAdminCreateKey,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (url.pathname.startsWith('/api/')) {
    const handler = API_ROUTES[key];
    if (!handler) return fail(res, 404, 'Неизвестный маршрут.');
    Promise.resolve(handler(req, res, url)).catch((err) => {
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
