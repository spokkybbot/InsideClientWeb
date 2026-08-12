'use strict';

/**
 * /api/client/configs/* — доступ к облачным конфигам для самого клиента
 * (тот же принцип, что и /api/verify: клиент знает только свой HWID,
 * логина/пароля/cookie у него нет).
 *
 * POST /api/client/configs/list
 * { "hwid": "<SHA-256 хеш>" }
 * -> { "status": "access", "configs": [{ "name", "sizeBytes", "updatedAt" }] }
 * -> { "status": "reject", "message": "..." }
 *
 * POST /api/client/configs/get
 * { "hwid": "<SHA-256 хеш>", "name": "<имя пресета>" }
 * -> { "status": "access", "name", "content", "updatedAt" }
 * -> { "status": "reject", "message": "..." }
 *
 * Доступ даётся ровно на тех же условиях, что и сама лицензия клиента:
 * HWID должен быть привязан к аккаунту, аккаунт не забанен, подписка активна.
 */

const db = require('./db');

/* ---------------------------------------------------------------------- */
/* Rate limiter — тот же принцип, что в verify.js, отдельный бакет.       */
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
const MAX_NAME_LEN = 40;

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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

/**
 * Общая проверка HWID -> активный, не забаненный пользователь с подпиской.
 * Возвращает user или null (в случае null сам пишет ответ reject).
 */
function resolveLicensedUser(req, res, hwid) {
  if (!HWID_RE.test(hwid)) {
    sendJson(res, 400, { status: 'reject', message: 'Некорректный формат HWID.' });
    return null;
  }

  const user = db.prepare('SELECT * FROM users WHERE hwid = ? COLLATE NOCASE').get(hwid);
  if (!user) {
    sendJson(res, 200, { status: 'reject', message: 'Лицензия не найдена.' });
    return null;
  }
  if (user.banned) {
    sendJson(res, 200, { status: 'reject', message: 'Аккаунт заблокирован.' });
    return null;
  }
  const hasSubscription = user.subscription_until &&
    new Date(user.subscription_until).getTime() > Date.now();
  if (!hasSubscription) {
    sendJson(res, 200, { status: 'reject', message: 'Подписка истекла или была отозвана.' });
    return null;
  }
  return user;
}

/* ---------------------------------------------------------------------- */
/* Handlers                                                                */
/* ---------------------------------------------------------------------- */

async function handleClientConfigsList(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  if (isRateLimited(getIp(req))) {
    return sendJson(res, 429, { status: 'reject', message: 'Слишком много запросов. Подождите минуту.' });
  }

  let body;
  try { body = await readJsonBody(req); } catch (e) {
    return sendJson(res, 400, { status: 'reject', message: 'Некорректный запрос.' });
  }

  const hwid = String(body.hwid || '').trim().toLowerCase();
  const user = resolveLicensedUser(req, res, hwid);
  if (!user) return;

  const rows = db.prepare(
    'SELECT name, size_bytes, updated_at FROM configs WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(user.id);

  sendJson(res, 200, {
    status: 'access',
    configs: rows.map((r) => ({
      name: r.name,
      sizeBytes: r.size_bytes,
      updatedAt: r.updated_at,
    })),
  });
}

async function handleClientConfigsGet(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  if (isRateLimited(getIp(req))) {
    return sendJson(res, 429, { status: 'reject', message: 'Слишком много запросов. Подождите минуту.' });
  }

  let body;
  try { body = await readJsonBody(req); } catch (e) {
    return sendJson(res, 400, { status: 'reject', message: 'Некорректный запрос.' });
  }

  const hwid = String(body.hwid || '').trim().toLowerCase();
  const user = resolveLicensedUser(req, res, hwid);
  if (!user) return;

  const name = String(body.name || '').trim();
  if (!name || name.length > MAX_NAME_LEN) {
    return sendJson(res, 400, { status: 'reject', message: 'Некорректное имя конфига.' });
  }

  const row = db.prepare(
    'SELECT content, updated_at FROM configs WHERE user_id = ? AND name = ? COLLATE NOCASE'
  ).get(user.id, name);

  if (!row) {
    return sendJson(res, 200, { status: 'reject', message: 'Конфиг не найден.' });
  }

  sendJson(res, 200, {
    status: 'access',
    name,
    content: row.content,
    updatedAt: row.updated_at,
  });
}

module.exports = { handleClientConfigsList, handleClientConfigsGet };
