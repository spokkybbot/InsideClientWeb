'use strict';

/**
 * Друзья + живые состояния (для виджета «Друзья» в клиенте и личного кабинета).
 *
 * Авторизация — как у /api/client/configs/*: либо по HWID (сам клиент, у
 * которого нет cookie-сессии), либо по сессии (личный кабинет в браузере).
 * Клиент шлёт { "hwid": "<sha256>", ... }; кабинет — просто cookie ic_sid.
 *
 * Эндпоинты (все POST, тело JSON):
 *   POST /api/client/friends/state   — клиент пишет своё live-состояние
 *   POST /api/client/friends/list    — возвращает друзей + их live-состояния
 *   POST /api/client/friends/add     — добавить друга по логину сайта
 *   POST /api/client/friends/remove  — удалить друга по логину
 */

const db = require('./db');

/* ---------------------------------------------------------------------- */
/* Rate limiter — как у configs-client: до 30 запросов/мин с одного IP.   */
/* ---------------------------------------------------------------------- */

const WINDOW_MS = 60 * 1000;
const MAX_REQ_IP = 30;

const ipBuckets = new Map();

function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    ipBuckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count > MAX_REQ_IP;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) {
    if (now > b.resetAt) ipBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

const HWID_RE = /^[0-9a-fA-F]{64}$/;
const SESSION_COOKIE = 'ic_sid';

function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 32 * 1024;
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleCors(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
  return true;
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

function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) || null;
}

/** Резолвит пользователя либо по сессии (кабинет), либо по HWID (клиент). */
function resolveUser(req, body) {
  const sess = getSessionUser(req);
  if (sess) return sess;

  const hwid = String(body.hwid || '').trim().toLowerCase();
  if (!HWID_RE.test(hwid)) return null;
  const user = db.prepare('SELECT * FROM users WHERE hwid = ? COLLATE NOCASE').get(hwid);
  if (!user) return null;
  if (user.banned) return null;
  const hasSubscription = user.subscription_until &&
    new Date(user.subscription_until).getTime() > Date.now();
  if (!hasSubscription) return null;
  return user;
}

function onlinedAt(updatedAtIso) {
  if (!updatedAtIso) return false;
  const ts = new Date(updatedAtIso).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < 5 * 60 * 1000;
}

function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/* ---------------------------------------------------------------------- */
/* Handlers                                                                */
/* ---------------------------------------------------------------------- */

async function handleFriendsState(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  if (isRateLimited(getIp(req))) {
    return sendJson(res, 429, { status: 'reject', error: 'rate_limited' });
  }

  let body;
  try { body = await readJsonBody(req); } catch (e) {
    return sendJson(res, 400, { status: 'reject', error: 'bad_request' });
  }

  const user = resolveUser(req, body);
  if (!user) return sendJson(res, 401, { status: 'reject', error: 'auth' });

  const now = new Date().toISOString();
  const armor = Array.isArray(body.armor) ? JSON.stringify(body.armor) : (body.armor || null);
  const items = Array.isArray(body.items) ? JSON.stringify(body.items) : (body.items || null);
  const num = (x) => (typeof x === 'number' && !Number.isNaN(x) ? x : null);

  db.prepare(`
    INSERT INTO live_states
      (user_id, login, nick, server, anarchy_num, x, y, z, armor, hp, items, head, hidden, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      login=excluded.login, nick=excluded.nick, server=excluded.server,
      anarchy_num=excluded.anarchy_num, x=excluded.x, y=excluded.y, z=excluded.z,
      armor=excluded.armor, hp=excluded.hp, items=excluded.items, head=excluded.head,
      hidden=excluded.hidden, updated_at=excluded.updated_at;
  `).run(
    user.id,
    user.login,
    body.nick != null ? String(body.nick) : null,
    body.server != null ? String(body.server) : null,
    num(body.anarchy_num),
    num(body.x), num(body.y), num(body.z),
    armor,
    typeof body.hp === 'number' && !Number.isNaN(body.hp) ? body.hp : null,
    items,
    body.head != null ? String(body.head) : null,
    body.hidden ? 1 : 0,
    now
  );

  sendJson(res, 200, { status: 'access', ok: true });
}

async function handleFriendsList(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  if (isRateLimited(getIp(req))) {
    return sendJson(res, 429, { status: 'reject', error: 'rate_limited' });
  }

  let body;
  try { body = await readJsonBody(req); } catch (e) {
    return sendJson(res, 400, { status: 'reject', error: 'bad_request' });
  }

  const user = resolveUser(req, body);
  if (!user) return sendJson(res, 401, { status: 'reject', error: 'auth' });

  const rows = db.prepare(`
    SELECT
      u.login AS login,
      ls.nick AS nick, ls.server AS server, ls.anarchy_num AS anarchy_num,
      ls.x AS x, ls.y AS y, ls.z AS z, ls.armor AS armor, ls.hp AS hp,
      ls.items AS items, ls.head AS head, ls.hidden AS hidden, ls.updated_at AS updated_at
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    LEFT JOIN live_states ls ON ls.user_id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.login COLLATE NOCASE
  `).all(user.id);

  const friends = rows.map((r) => {
    // Друг включил «скрыть информацию обо мне» — данных нет намеренно.
    if (r.hidden) {
      return { login: r.login, hidden: true, online: false };
    }
    // Нет live-состояния вообще (друг не в сети / не запускал клиент).
    if (!r.nick) {
      return { login: r.login, hidden: false, online: false, offline: true };
    }
    return {
      login: r.login,
      nick: r.nick,
      server: r.server || null,
      anarchy_num: r.anarchy_num,
      x: r.x, y: r.y, z: r.z,
      armor: parseJsonField(r.armor),
      hp: r.hp,
      items: parseJsonField(r.items),
      head: r.head || null,
      hidden: false,
      online: onlinedAt(r.updated_at),
      updated_at: r.updated_at,
    };
  });

  sendJson(res, 200, { status: 'access', friends });
}

async function handleFriendsAdd(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  if (isRateLimited(getIp(req))) {
    return sendJson(res, 429, { status: 'reject', error: 'rate_limited' });
  }

  let body;
  try { body = await readJsonBody(req); } catch (e) {
    return sendJson(res, 400, { status: 'reject', error: 'bad_request' });
  }

  const user = resolveUser(req, body);
  if (!user) return sendJson(res, 401, { status: 'reject', error: 'auth' });

  const login = String(body.login || '').trim();
  if (!login) return sendJson(res, 400, { status: 'reject', error: 'empty_login' });

  const target = db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(login);
  if (!target) return sendJson(res, 404, { status: 'reject', error: 'not_found' });
  if (target.id === user.id) return sendJson(res, 400, { status: 'reject', error: 'self' });

  const now = new Date().toISOString();
  // Взаимная дружба: обе связки.
  db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(user.id, target.id, now);
  db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(target.id, user.id, now);

  sendJson(res, 200, { status: 'access', friend: { login: target.login } });
}

async function handleFriendsRemove(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  if (isRateLimited(getIp(req))) {
    return sendJson(res, 429, { status: 'reject', error: 'rate_limited' });
  }

  let body;
  try { body = await readJsonBody(req); } catch (e) {
    return sendJson(res, 400, { status: 'reject', error: 'bad_request' });
  }

  const user = resolveUser(req, body);
  if (!user) return sendJson(res, 401, { status: 'reject', error: 'auth' });

  const login = String(body.login || '').trim();
  if (!login) return sendJson(res, 400, { status: 'reject', error: 'empty_login' });

  const target = db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(login);
  if (!target) return sendJson(res, 404, { status: 'reject', error: 'not_found' });

  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(user.id, target.id);
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(target.id, user.id);

  sendJson(res, 200, { status: 'access', ok: true });
}

module.exports = {
  handleFriendsState,
  handleFriendsList,
  handleFriendsAdd,
  handleFriendsRemove,
};
