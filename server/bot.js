'use strict';

/**
 * Inside Client — Telegram-бот для привязки аккаунта.
 *
 * Работает через long polling (getUpdates), поэтому не требует ни домена,
 * ни HTTPS, ни открытых портов — бот сам стучится к Telegram. Использует
 * встроенный в Node 22 fetch, никаких npm-зависимостей.
 *
 * Запуск:
 *   TELEGRAM_BOT_TOKEN=123456:AA... node server/bot.js
 *
 * База данных — та же SQLite, что использует сайт (server/db.js), бот
 * читает/пишет напрямую, без похода через HTTP API сайта.
 */

const db = require('./db');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

function nowIso() {
  return new Date().toISOString();
}

async function tg(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

function sendMessage(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

/* ---------------------------------------------------------------------- */
/* Linking logic — pure DB operations, no network calls, so this part can */
/* be unit-tested without talking to the real Telegram API.               */
/* ---------------------------------------------------------------------- */

/**
 * Resolves a /start <code> attempt against the DB.
 * Returns { status, ...details } where status is one of:
 *   'ok'         — linked successfully, details: { login }
 *   'not_found'  — no such code
 *   'used'       — code already consumed
 *   'expired'    — code past its TTL
 *   'conflict'   — this chat is already linked to a *different* account, details: { conflictLogin }
 *   'already'    — this chat is already linked to the *same* account, details: { login }
 */
function linkByCode(code, chatId, username) {
  const row = db.prepare('SELECT * FROM telegram_link_codes WHERE code = ?').get(code);

  if (!row) return { status: 'not_found' };
  if (row.used) return { status: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { status: 'expired' };

  const existing = db.prepare('SELECT id, login FROM users WHERE telegram_chat_id = ?').get(chatId);
  if (existing && existing.id !== row.user_id) {
    return { status: 'conflict', conflictLogin: existing.login };
  }

  const user = db.prepare('SELECT id, login FROM users WHERE id = ?').get(row.user_id);
  if (!user) return { status: 'not_found' };

  if (existing && existing.id === row.user_id) {
    db.prepare('UPDATE telegram_link_codes SET used = 1 WHERE code = ?').run(code);
    return { status: 'already', login: user.login };
  }

  db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ? WHERE id = ?').run(
    chatId,
    username || null,
    user.id
  );
  db.prepare('UPDATE telegram_link_codes SET used = 1 WHERE code = ?').run(code);

  return { status: 'ok', login: user.login };
}

function handleStart(message, payload) {
  const chatId = message.chat.id;
  const fromUsername = message.from.username || null;

  if (!payload) {
    return sendMessage(
      chatId,
      'Привет! Чтобы привязать Telegram к аккаунту на сайте, зайдите в личный кабинет ' +
        'и нажмите «Привязать» — оттуда откроется ссылка сюда с кодом.'
    );
  }

  const code = payload.trim().toUpperCase();
  const result = linkByCode(code, chatId, fromUsername);

  switch (result.status) {
    case 'not_found':
      return sendMessage(chatId, 'Такой код не найден. Получите новый в личном кабинете на сайте.');
    case 'used':
      return sendMessage(chatId, 'Этот код уже использован. Получите новый в личном кабинете на сайте.');
    case 'expired':
      return sendMessage(chatId, 'Срок действия кода истёк (коды живут 10 минут). Получите новый в личном кабинете на сайте.');
    case 'conflict':
      return sendMessage(
        chatId,
        `Этот Telegram уже привязан к другому аккаунту (${result.conflictLogin}). ` +
          'Сначала отвяжите его в личном кабинете того аккаунта.'
      );
    case 'already':
      return sendMessage(chatId, `Этот Telegram уже привязан к аккаунту <b>${result.login}</b>.`);
    case 'ok':
      return sendMessage(chatId, `Готово! Telegram привязан к аккаунту <b>${result.login}</b>.`);
    default:
      return sendMessage(chatId, 'Что-то пошло не так, попробуйте ещё раз.');
  }
}

function handleOther(message) {
  return sendMessage(
    message.chat.id,
    'Чтобы привязать аккаунт, нажмите «Привязать Telegram» в личном кабинете на сайте — ' +
      'оттуда придёте сюда с готовой ссылкой.'
  );
}

function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;

  const text = message.text.trim();
  if (text.startsWith('/start')) {
    const payload = text.slice('/start'.length).trim();
    return handleStart(message, payload);
  }
  return handleOther(message);
}

/* ---------------------------------------------------------------------- */
/* Long polling loop                                                      */
/* ---------------------------------------------------------------------- */

let offset = 0;

async function pollOnce() {
  const updates = await tg('getUpdates', {
    offset,
    timeout: 30,
    allowed_updates: ['message'],
  });

  for (const update of updates) {
    offset = update.update_id + 1;
    try {
      await handleUpdate(update);
    } catch (err) {
      console.error('Ошибка обработки апдейта', update.update_id, err);
    }
  }
}

async function main() {
  if (!TOKEN) {
    console.error('Не задан TELEGRAM_BOT_TOKEN. Запуск: TELEGRAM_BOT_TOKEN=... node server/bot.js');
    process.exit(1);
  }

  const me = await tg('getMe', {});
  console.log(`Бот запущен: @${me.username} (long polling)`);

  // Best-effort cleanup of long-expired codes so the table doesn't grow forever.
  db.prepare("DELETE FROM telegram_link_codes WHERE expires_at < ?").run(
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  );

  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('Ошибка long polling, повтор через 5 секунд:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

module.exports = { linkByCode, handleStart, handleUpdate };

if (require.main === module) {
  main();
}
