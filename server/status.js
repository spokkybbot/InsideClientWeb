'use strict';

/**
 * GET /api/status?hwid=<sha256>
 *
 * Heartbeat-эндпоинт для уже запущенного Minecraft-клиента.
 * Клиент дёргает его каждые ~2 минуты пока работает.
 *
 * Возможные ответы:
 *
 * { "action": "ok",      "secondsLeft": 3600 }   — всё норм, осталось N сек.
 * { "action": "warn",    "secondsLeft": 840  }   — < 15 минут, показать предупреждение
 * { "action": "expired", "secondsLeft": 0    }   — подписка кончилась / снята → закрыть клиент
 * { "action": "banned"                        }   — аккаунт заблокирован → закрыть клиент
 * { "action": "expired", "secondsLeft": 0    }   — HWID не найден → закрыть клиент
 *
 * Статус HTTP всегда 200 — клиент читает поле "action".
 * На сетевую ошибку (5xx, таймаут) клиент должен повторить через 30 сек,
 * а не закрываться — сервер мог временно лечь.
 */

const db = require('./db');

const WARN_SECONDS = 15 * 60; // 900 сек = 15 минут

/* ---------------------------------------------------------------------- */
/* Rate limiter — max 5 запросов в минуту с одного HWID                   */
/* (heartbeat каждые 2 мин это 0.5 req/min — запас x10 на случай лагов)  */
/* ---------------------------------------------------------------------- */

const WINDOW_MS  = 60 * 1000;
const MAX_REQ    = 5;

// Map<hwid, { count, resetAt }>
const hwidBuckets = new Map();

function isRateLimited(hwid) {
  const now = Date.now();
  let b = hwidBuckets.get(hwid);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    hwidBuckets.set(hwid, b);
  }
  b.count++;
  return b.count > MAX_REQ;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of hwidBuckets) if (now > b.resetAt) hwidBuckets.delete(k);
}, 5 * 60 * 1000).unref();

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

const HWID_RE = /^[0-9a-fA-F]{64}$/;

function sendJson(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ---------------------------------------------------------------------- */
/* Handler                                                                 */
/* ---------------------------------------------------------------------- */

function handleStatus(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    return res.end();
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const hwid = String(url.searchParams.get('hwid') || '').trim().toLowerCase();

  if (!HWID_RE.test(hwid)) {
    // Не закрываем клиент по кривому запросу — просто игнорируем
    return sendJson(res, { action: 'expired', secondsLeft: 0, reason: 'invalid_hwid' });
  }

  if (isRateLimited(hwid)) {
    // Слишком частые пинги — говорим «ок» чтобы клиент не закрылся из-за rate limit
    return sendJson(res, { action: 'ok', secondsLeft: WARN_SECONDS + 1 });
  }

  const user = db.prepare('SELECT banned, subscription_until FROM users WHERE hwid = ? COLLATE NOCASE').get(hwid);

  // HWID не найден (удалён/сброшен после запуска)
  if (!user) {
    return sendJson(res, { action: 'expired', secondsLeft: 0, reason: 'hwid_not_found' });
  }

  // Забанен
  if (user.banned) {
    return sendJson(res, { action: 'banned', secondsLeft: 0, reason: 'banned' });
  }

  // Нет подписки вообще
  if (!user.subscription_until) {
    return sendJson(res, { action: 'expired', secondsLeft: 0, reason: 'no_subscription' });
  }

  const now        = Date.now();
  const expiresAt  = new Date(user.subscription_until).getTime();
  const secondsLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));

  // Подписка истекла
  if (secondsLeft === 0) {
    return sendJson(res, { action: 'expired', secondsLeft: 0, reason: 'expired' });
  }

  // Меньше 15 минут — предупреждение
  if (secondsLeft <= WARN_SECONDS) {
    return sendJson(res, { action: 'warn', secondsLeft });
  }

  // Всё нормально
  return sendJson(res, { action: 'ok', secondsLeft });
}

module.exports = { handleStatus };
