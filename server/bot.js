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

const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || 'xikik0mori';
// TODO: заменить на реальную ссылку на карточку/профиль после того, как
// появится настоящий листинг на FunPay — это временная заглушка.
const FUNPAY_URL = process.env.FUNPAY_URL || 'https://funpay.com/';

const BTN_LINK = '🔗 Привязать аккаунт';
const BTN_SUPPORT = '💬 Связаться с поддержкой';
const BTN_BUY = '🛒 Купить клиент';

const MAIN_KEYBOARD = {
  keyboard: [[BTN_LINK], [BTN_SUPPORT], [BTN_BUY]],
  resize_keyboard: true,
};

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

function sendMessage(chatId, text, extra) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: MAIN_KEYBOARD,
    ...extra,
  });
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
 *   'locked'     — this Telegram account was permanently bound to a
 *                  *different* account in the past (even if since
 *                  unlinked) and can never be bound to another one,
 *                  details: { lockedLogin }
 *   'conflict'   — this chat is already linked to a *different* account, details: { conflictLogin }
 *   'already'    — this chat is already linked to the *same* account, details: { login }
 */
function linkByCode(code, chatId, username) {
  const row = db.prepare('SELECT * FROM telegram_link_codes WHERE code = ?').get(code);

  if (!row) return { status: 'not_found' };
  if (row.used) return { status: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { status: 'expired' };

  const user = db.prepare('SELECT id, login FROM users WHERE id = ?').get(row.user_id);
  if (!user) return { status: 'not_found' };

  // Постоянная блокировка: этот Telegram уже когда-либо привязывался к
  // ДРУГОМУ аккаунту — навсегда, даже если сейчас отвязан от него.
  const permanent = db.prepare('SELECT user_id FROM telegram_bindings WHERE telegram_chat_id = ?').get(chatId);
  if (permanent && permanent.user_id !== user.id) {
    const lockedUser = db.prepare('SELECT login FROM users WHERE id = ?').get(permanent.user_id);
    return { status: 'locked', lockedLogin: lockedUser ? lockedUser.login : null };
  }

  const existing = db.prepare('SELECT id, login FROM users WHERE telegram_chat_id = ?').get(chatId);
  if (existing && existing.id !== row.user_id) {
    return { status: 'conflict', conflictLogin: existing.login };
  }

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

  if (!permanent) {
    db.prepare('INSERT INTO telegram_bindings (telegram_chat_id, user_id, linked_at) VALUES (?, ?, ?)').run(
      chatId,
      user.id,
      nowIso()
    );
  }

  return { status: 'ok', login: user.login };
}

function linkInstructionsText() {
  return (
    'Чтобы привязать Telegram к аккаунту на сайте:\n\n' +
    '1. Зайдите на сайт и откройте личный кабинет.\n' +
    '2. Найдите поле «Телеграм» и нажмите «Привязать».\n' +
    '3. Откроется диплинк сюда, в бота, с одноразовым кодом — просто перейдите по нему ' +
    '(или отправьте код вручную командой /start &lt;код&gt;).\n\n' +
    '⚠️ Привязка постоянная: один Telegram-аккаунт можно привязать только к одному ' +
    'аккаунту на сайте, и это нельзя изменить даже после отвязки.'
  );
}

function supportText() {
  return (
    `По всем вопросам поддержки пишите: @${SUPPORT_USERNAME}\n\n` +
    'Совет: сразу пишите суть вопроса одним сообщением, без «можно спросить?» и ' +
    '«вы тут?» — так поддержка увидит вопрос сразу и ответит быстрее ' +
    '(см. nometa.xyz, если интересно почему).'
  );
}

function buyText() {
  return (
    'Купить клиент можно на нашей странице на FunPay:\n' +
    FUNPAY_URL
  );
}

function handleStart(message, payload) {
  const chatId = message.chat.id;
  const fromUsername = message.from.username || null;

  if (!payload) {
    return sendMessage(chatId, `Привет! 👋\n\n${linkInstructionsText()}`);
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
    case 'locked':
      return sendMessage(
        chatId,
        `Этот Telegram уже был привязан к аккаунту <b>${result.lockedLogin}</b> ранее. ` +
          'Привязка одноразовая и постоянная — привязать этот Telegram к другому аккаунту нельзя, ' +
          `даже если отвязать его от «${result.lockedLogin}». Обратитесь в поддержку (${BTN_SUPPORT}), если это ошибка.`
      );
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
  const text = (message.text || '').trim();

  if (text === BTN_LINK) {
    return sendMessage(message.chat.id, linkInstructionsText());
  }
  if (text === BTN_SUPPORT) {
    return sendMessage(message.chat.id, supportText());
  }
  if (text === BTN_BUY) {
    return sendMessage(message.chat.id, buyText());
  }

  return sendMessage(message.chat.id, 'Выберите действие на клавиатуре ниже 👇');
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
