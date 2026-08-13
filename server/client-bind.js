'use strict';

/**
 * POST /api/client/bind — первый запуск клиента.
 *
 * Клиент вызывает этот эндпоинт РОВНО ОДИН РАЗ (при первом старте, когда
 * локально ещё нет сохранённого HWID/подтверждения) — по логину и паролю
 * привязывает вычисленный HWID к аккаунту. Дальше клиент работает по HWID
 * (см. /api/verify и /api/status) и больше пароль нигде не хранит и не шлёт.
 *
 * { "login": "...", "password": "...", "hwid": "<sha256>", "ip": "<опц.>" }
 *
 * Ответы:
 *  200 { "status": "access", "uid": "123", "username": "Игрок" }
 *      — HWID успешно привязан (или уже был привязан именно к этому HWID)
 *  200 { "status": "reject", "message": "..." }
 *      — неверные данные / нет подписки / забанен / HWID уже занят другим
 *        устройством (в этом случае пользователю нужно оформить сброс HWID
 *        в личном кабинете/через покупку — см. /api/hwid/reset)
 *
 * HTTP-статус всегда 200 при бизнес-отказе (как и /api/verify) — клиент
 * должен смотреть на поле "status", а не на код ответа. 4xx/5xx означают
 * реальную ошибку запроса/сервера.
 */

const db = require('./db');
const { verifyPassword } = require('./auth-utils');

/* ---------------------------------------------------------------------- */
/* Rate limiter — тут есть пароль, поэтому лимиты строже, чем у /api/verify */
/* Окно: 10 минут. Лимит: 5 попыток на IP и 5 попыток на логин.           */
/* ---------------------------------------------------------------------- */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const ipBuckets = new Map();    // Map<ip, { count, resetAt }>
const loginBuckets = new Map(); // Map<login_lowercase, { count, resetAt }>

function hit(map, key) {
  const now = Date.now();
  let b = map.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    map.set(key, b);
  }
  b.count++;
  return b.count > MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of ipBuckets) if (now > b.resetAt) ipBuckets.delete(k);
  for (const [k, b] of loginBuckets) if (now > b.resetAt) loginBuckets.delete(k);
}, 5 * 60 * 1000).unref();

function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

const HWID_RE = /^[0-9a-fA-F]{64}$/;

function nowIso() {
  return new Date().toISOString();
}

function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 8 * 1024;
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

function logAttempt(hwid, clientIp, serverIp, result, userId) {
  try {
    db.prepare(
      `INSERT INTO verify_log (hwid, client_ip, server_ip, result, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(hwid || null, clientIp || null, serverIp || null, result, userId || null, nowIso());
  } catch (e) {
    console.error('[client-bind] log error:', e.message);
  }
}

/* ---------------------------------------------------------------------- */
/* Main handler                                                            */
/* ---------------------------------------------------------------------- */

async function handleClientBind(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  const realIp = getIp(req);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { status: 'reject', message: 'Некорректный запрос.' });
  }

  const login = String(body.login || '').trim();
  const password = String(body.password || '');
  const hwid = String(body.hwid || '').trim().toLowerCase();
  const clientIp = String(body.ip || realIp || '').trim();

  if (!login || !password) {
    return sendJson(res, 400, { status: 'reject', message: 'Введите логин и пароль.' });
  }
  if (!HWID_RE.test(hwid)) {
    logAttempt(hwid, clientIp, realIp, 'invalid_hwid');
    return sendJson(res, 400, { status: 'reject', message: 'Некорректный формат HWID.' });
  }

  // Rate limit: и по IP, и по логину — не даём перебирать пароли ни с одного
  // адреса, ни по конкретному аккаунту с разных адресов.
  const loginKey = login.toLowerCase();
  const limitedByIp = hit(ipBuckets, realIp);
  const limitedByLogin = hit(loginBuckets, loginKey);
  if (limitedByIp || limitedByLogin) {
    logAttempt(hwid, clientIp, realIp, 'rate_limited');
    return sendJson(res, 429, { status: 'reject', message: 'Слишком много попыток. Подождите 10 минут.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(login);

  if (!user || !verifyPassword(password, user.password_hash)) {
    logAttempt(hwid, clientIp, realIp, 'bad_credentials', user ? user.id : null);
    return sendJson(res, 200, { status: 'reject', message: 'Неверный логин или пароль.' });
  }

  if (user.banned) {
    logAttempt(hwid, clientIp, realIp, 'banned', user.id);
    return sendJson(res, 200, { status: 'reject', message: 'Аккаунт заблокирован.' });
  }

  const hasSubscription = user.subscription_until &&
    new Date(user.subscription_until).getTime() > Date.now();
  if (!hasSubscription) {
    logAttempt(hwid, clientIp, realIp, 'no_license', user.id);
    return sendJson(res, 200, { status: 'reject', message: 'Нет активной подписки. Активируйте ключ в личном кабинете.' });
  }

  if (user.hwid && user.hwid.toLowerCase() !== hwid) {
    // Аккаунт уже привязан к другому устройству — не перезаписываем молча.
    logAttempt(hwid, clientIp, realIp, 'hwid_mismatch', user.id);
    return sendJson(res, 200, {
      status: 'reject',
      message: 'Аккаунт уже привязан к другому устройству. Сбросьте HWID в личном кабинете.',
    });
  }

  if (!user.hwid) {
    // Первая привязка. idx_users_hwid_unique (частичный UNIQUE-индекс в
    // db.js) физически не даст привязать этот HWID второй раз, даже если
    // два запроса на разные аккаунты придут одновременно — второй упадёт
    // с constraint error, который мы ловим ниже.
    try {
      db.prepare('UPDATE users SET hwid = ? WHERE id = ? AND hwid IS NULL').run(hwid, user.id);
    } catch (e) {
      logAttempt(hwid, clientIp, realIp, 'bind_race_lost', user.id);
      return sendJson(res, 200, { status: 'reject', message: 'Это устройство уже привязано к другому аккаунту.' });
    }
    logAttempt(hwid, clientIp, realIp, 'bind', user.id);
  } else {
    // user.hwid === hwid — переустановка клиента на том же ПК, просто ОК.
    logAttempt(hwid, clientIp, realIp, 'access', user.id);
  }

  return sendJson(res, 200, { status: 'access', uid: String(user.id), username: user.login });
}

module.exports = { handleClientBind };
