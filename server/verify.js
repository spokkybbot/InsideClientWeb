'use strict';

/**
 * /api/verify — HWID-верификация для Minecraft Fabric клиента.
 *
 * POST /api/verify
 * { "hwid": "<SHA-256 хеш>", "ip": "<внешний IP>" }
 *
 * Ответ (доступ открыт):
 * { "status": "access", "uid": "123", "username": "Игрок" }
 *
 * Ответ (отказ):
 * { "status": "reject", "message": "Лицензия не найдена или истекла" }
 */

const crypto = require('crypto');
const db = require('./db');

/* ---------------------------------------------------------------------- */
/* Rate limiter — защита от брутфорса                                     */
/* Окно: 60 сек. Лимиты: 10 запросов с одного IP / 5 разных HWID с IP.   */
/* ---------------------------------------------------------------------- */

const WINDOW_MS   = 60 * 1000; // 1 минута
const MAX_REQ_IP  = 10;        // max запросов с одного IP за окно
const MAX_HWID_IP = 5;         // max разных HWID с одного IP за окно

// Map<ip, { count, hwids: Set, resetAt }>
const ipBuckets = new Map();

function getIp(req) {
  // Railway ставит реальный IP в X-Forwarded-For
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Возвращает true, если запрос заблокирован.
 */
function isRateLimited(ip, hwid) {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, hwids: new Set(), resetAt: now + WINDOW_MS };
    ipBuckets.set(ip, bucket);
  }

  bucket.count++;
  bucket.hwids.add(hwid);

  if (bucket.count > MAX_REQ_IP)  return true;
  if (bucket.hwids.size > MAX_HWID_IP) return true;
  return false;
}

// Периодически чистим протухшие записи (раз в 5 минут)
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) {
    if (now > b.resetAt) ipBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 64 * 1024;
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
    // CORS — разрешаем запросы от клиента (Fabric шлёт напрямую)
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

/* ---------------------------------------------------------------------- */
/* Validate HWID format — SHA-256 = 64 hex символа                       */
/* ---------------------------------------------------------------------- */
const HWID_RE = /^[0-9a-fA-F]{64}$/;

/* ---------------------------------------------------------------------- */
/* Main handler                                                            */
/* ---------------------------------------------------------------------- */

async function handleVerify(req, res) {
  // CORS preflight
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

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { status: 'reject', message: 'Некорректный запрос.' });
  }

  const hwid = String(body.hwid || '').trim().toLowerCase();
  const clientIp = String(body.ip || getIp(req) || '').trim();
  const realIp = getIp(req);

  // Валидация формата HWID
  if (!HWID_RE.test(hwid)) {
    logAttempt(hwid, clientIp, realIp, 'invalid_hwid');
    return sendJson(res, 400, { status: 'reject', message: 'Некорректный формат HWID.' });
  }

  // Rate limit по реальному IP сервера (не тому, что прислал клиент)
  if (isRateLimited(realIp, hwid)) {
    logAttempt(hwid, clientIp, realIp, 'rate_limited');
    return sendJson(res, 429, { status: 'reject', message: 'Слишком много запросов. Подождите минуту.' });
  }

  // Ищем пользователя с таким HWID
  const user = db.prepare('SELECT * FROM users WHERE hwid = ? COLLATE NOCASE').get(hwid);

  if (!user) {
    logAttempt(hwid, clientIp, realIp, 'not_found');
    return sendJson(res, 200, { status: 'reject', message: 'Лицензия не найдена.' });
  }

  if (user.banned) {
    logAttempt(hwid, clientIp, realIp, 'banned', user.id);
    return sendJson(res, 200, { status: 'reject', message: 'Аккаунт заблокирован.' });
  }

  // Единственный критерий доступа — активная подписка (subscription_until).
  // Наличие записей в purchases намеренно НЕ проверяется: подписка могла
  // быть снята администратором, и тогда клиент должен получить REJECT
  // вне зависимости от истории покупок.
  const hasSubscription = user.subscription_until &&
    new Date(user.subscription_until).getTime() > Date.now();

  if (!hasSubscription) {
    logAttempt(hwid, clientIp, realIp, 'no_license', user.id);
    return sendJson(res, 200, { status: 'reject', message: 'Подписка истекла или была отозвана.' });
  }

  // Успех — обновляем last_verify_ip и логируем
  logAttempt(hwid, clientIp, realIp, 'access', user.id);

  return sendJson(res, 200, {
    status: 'access',
    uid: String(user.id),
    username: user.login,
  });
}

/* ---------------------------------------------------------------------- */
/* Logging                                                                 */
/* ---------------------------------------------------------------------- */

function logAttempt(hwid, clientIp, serverIp, result, userId) {
  try {
    db.prepare(
      `INSERT INTO verify_log (hwid, client_ip, server_ip, result, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      hwid || null,
      clientIp || null,
      serverIp || null,
      result,
      userId || null,
      nowIso()
    );
  } catch (e) {
    // Не падаем если лог-вставка упала
    console.error('[verify] log error:', e.message);
  }
}

module.exports = { handleVerify };
