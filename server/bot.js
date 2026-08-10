'use strict';

/**
 * Inside Client — Telegram-бот для привязки аккаунта, покупки и поддержки.
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
 *
 * Система тикетов поддержки:
 *   Модераторы задаются переменной окружения MODERATOR_USERNAMES —
 *   список Telegram-username через запятую, без "@" (см. RAILWAY-DEPLOY.md).
 *   chat_id модератора бот узнаёт сам, как только тот первый раз напишет
 *   боту что угодно (таблица bot_moderators) — это нужно, чтобы бот мог
 *   присылать уведомления о новых тикетах.
 */

const db = require('./db');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || 'xikik0mori';
// TODO: заменить на реальную ссылку на карточку/профиль после того, как
// появится настоящий листинг на FunPay — это временная заглушка.
const FUNPAY_URL = process.env.FUNPAY_URL || 'https://funpay.com/';

// Модераторы поддержки — Telegram-username через запятую, без "@".
// Пример в Railway Variables: MODERATOR_USERNAMES=ivan_support,anna_help
const MODERATOR_USERNAMES = (process.env.MODERATOR_USERNAMES || '')
  .split(',')
  .map((s) => s.trim().replace(/^@/, '').toLowerCase())
  .filter(Boolean);

const BTN_LINK = '🔗 Привязать аккаунт';
const BTN_SUPPORT = '💬 Связаться с поддержкой';
const BTN_BUY = '🛒 Купить клиент';
const BTN_TICKETS = '🎫 Тикеты';

const CATEGORIES = {
  payment: { label: 'Оплата', emoji: '💳' },
  client: { label: 'Клиент (программа)', emoji: '🖥' },
  account: { label: 'Сайт / Аккаунт', emoji: '👤' },
  other: { label: 'Другое', emoji: '❓' },
};

const PAGE_SIZE = 5;

// Модератор, который нажал "Ответить" — ждём от него следующего текстового
// сообщения, чтобы переслать его в тикет. Живёт только в памяти процесса:
// это осознанно, при рестарте бота модератору достаточно нажать "Ответить"
// ещё раз, зато не плодим лишние таблицы/состояния в БД.
const pendingReply = new Map(); // chatId -> ticketId

function nowIso() {
  return new Date().toISOString();
}

function isModerator(username) {
  return !!username && MODERATOR_USERNAMES.includes(username.toLowerCase());
}

function mainKeyboardFor(username) {
  const rows = [[BTN_LINK], [BTN_SUPPORT], [BTN_BUY]];
  if (isModerator(username)) rows.push([BTN_TICKETS]);
  return { keyboard: rows, resize_keyboard: true };
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
    ...extra,
  });
}

// Как sendMessage, но всегда переустанавливает нижнюю клавиатуру под
// конкретного пользователя (важно, чтобы у модераторов появлялась кнопка
// "Тикеты", а у обычных юзеров — нет).
function sendWithMainKeyboard(chatId, username, text, extra) {
  return sendMessage(chatId, text, { reply_markup: mainKeyboardFor(username), ...extra });
}

function answerCallback(id, text) {
  return tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: false }).catch((err) => {
    console.error('Не удалось ответить на callback', err.message);
  });
}

// Запоминаем chat_id модератора, чтобы иметь возможность слать ему
// уведомления о тикетах. Вызывается на каждом апдейте от известного
// модератора (по username из MODERATOR_USERNAMES).
function trackModerator(chatId, username) {
  if (!isModerator(username)) return;
  db.prepare(
    `INSERT INTO bot_moderators (chat_id, username, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, updated_at = excluded.updated_at`
  ).run(chatId, username, nowIso());
}

function notifyModerators(text, extra) {
  const mods = db.prepare('SELECT chat_id FROM bot_moderators').all();
  for (const m of mods) {
    sendMessage(m.chat_id, text, extra).catch((err) => {
      console.error('Не удалось уведомить модератора', m.chat_id, err.message);
    });
  }
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
    return sendWithMainKeyboard(chatId, fromUsername, `Привет! 👋\n\n${linkInstructionsText()}`);
  }

  const code = payload.trim().toUpperCase();
  const result = linkByCode(code, chatId, fromUsername);

  switch (result.status) {
    case 'not_found':
      return sendWithMainKeyboard(chatId, fromUsername, 'Такой код не найден. Получите новый в личном кабинете на сайте.');
    case 'used':
      return sendWithMainKeyboard(chatId, fromUsername, 'Этот код уже использован. Получите новый в личном кабинете на сайте.');
    case 'expired':
      return sendWithMainKeyboard(chatId, fromUsername, 'Срок действия кода истёк (коды живут 10 минут). Получите новый в личном кабинете на сайте.');
    case 'locked':
      return sendWithMainKeyboard(
        chatId,
        fromUsername,
        `Этот Telegram уже был привязан к аккаунту <b>${result.lockedLogin}</b> ранее. ` +
          'Привязка одноразовая и постоянная — привязать этот Telegram к другому аккаунту нельзя, ' +
          `даже если отвязать его от «${result.lockedLogin}». Обратитесь в поддержку (${BTN_SUPPORT}), если это ошибка.`
      );
    case 'conflict':
      return sendWithMainKeyboard(
        chatId,
        fromUsername,
        `Этот Telegram уже привязан к другому аккаунту (${result.conflictLogin}). ` +
          'Сначала отвяжите его в личном кабинете того аккаунта.'
      );
    case 'already':
      return sendWithMainKeyboard(chatId, fromUsername, `Этот Telegram уже привязан к аккаунту <b>${result.login}</b>.`);
    case 'ok':
      return sendWithMainKeyboard(chatId, fromUsername, `Готово! Telegram привязан к аккаунту <b>${result.login}</b>.`);
    default:
      return sendWithMainKeyboard(chatId, fromUsername, 'Что-то пошло не так, попробуйте ещё раз.');
  }
}

/* ---------------------------------------------------------------------- */
/* Тикеты поддержки.                                                       */
/* ---------------------------------------------------------------------- */

function categoryLabel(key) {
  const c = CATEGORIES[key];
  return c ? `${c.emoji} ${c.label}` : key;
}

function ticketHeader(t) {
  return `#${t.id} (${categoryLabel(t.category)}${t.status === 'closed' ? ', закрыт' : ''})`;
}

function ticketHeaderById(id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  return t ? ticketHeader(t) : `#${id}`;
}

function getOpenTicketByChat(chatId) {
  return db.prepare("SELECT * FROM tickets WHERE chat_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(chatId);
}

function listTickets(status, offset) {
  const rows = db
    .prepare('SELECT * FROM tickets WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
    .all(status, PAGE_SIZE + 1, offset);
  const hasMore = rows.length > PAGE_SIZE;
  return { rows: rows.slice(0, PAGE_SIZE), hasMore };
}

// Юзер нажал кнопку "Связаться с поддержкой".
function openSupportMenu(chatId, username) {
  const openTicket = getOpenTicketByChat(chatId);
  if (openTicket) {
    return sendMessage(
      chatId,
      `У вас уже есть открытый тикет ${ticketHeader(openTicket)}.\n\n` +
        'Просто напишите сообщение сюда — оно уйдёт в поддержку. Либо закройте тикет кнопкой ниже.',
      { reply_markup: { inline_keyboard: [[{ text: '🔒 Закрыть тикет', callback_data: `t:close:${openTicket.id}` }]] } }
    );
  }
  return sendMessage(
    chatId,
    'Опишем проблему и заведём тикет — так поддержка точно его не пропустит.\n\n' +
      'Нажмите кнопку ниже, чтобы выбрать тему обращения 👇',
    { reply_markup: { inline_keyboard: [[{ text: '📝 Создать тикет', callback_data: 'sup:new' }]] } }
  );
}

function sendCategoryMenu(chatId) {
  const keys = Object.keys(CATEGORIES);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(
      keys.slice(i, i + 2).map((k) => ({ text: `${CATEGORIES[k].emoji} ${CATEGORIES[k].label}`, callback_data: `cat:${k}` }))
    );
  }
  return sendMessage(chatId, 'Выберите, к какой теме относится проблема:', {
    reply_markup: { inline_keyboard: rows },
  });
}

function createTicket(chatId, username, key) {
  if (!CATEGORIES[key]) {
    return sendMessage(chatId, 'Неизвестная категория, попробуйте ещё раз.');
  }
  const existing = getOpenTicketByChat(chatId);
  if (existing) {
    return sendMessage(chatId, `У вас уже есть открытый тикет ${ticketHeader(existing)}. Допишите сообщение туда или закройте его.`);
  }

  const now = nowIso();
  const info = db
    .prepare('INSERT INTO tickets (chat_id, username, category, status, created_at, updated_at) VALUES (?, ?, ?, \'open\', ?, ?)')
    .run(chatId, username || null, key, now, now);
  const ticketId = info.lastInsertRowid;

  sendMessage(
    chatId,
    `Тикет ${ticketHeaderById(ticketId)} создан ✅\n\n` +
      'Опишите проблему подробно одним сообщением — так поддержка ответит быстрее ' +
      '(имя/логин, что произошло, что вы уже пробовали). Дальше просто пишите сюда, ' +
      'все сообщения попадут в этот тикет.',
    { reply_markup: { inline_keyboard: [[{ text: '🔒 Закрыть тикет', callback_data: `t:close:${ticketId}` }]] } }
  );

  notifyModerators(
    `🆕 Новый тикет ${ticketHeaderById(ticketId)}\n` +
      `От: ${username ? '@' + username : 'id ' + chatId}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✍️ Ответить', callback_data: `t:reply:${ticketId}` },
            { text: '👀 Открыть', callback_data: `t:view:${ticketId}` },
          ],
        ],
      },
    }
  );
}

// Обычное текстовое сообщение юзера, у которого уже есть открытый тикет —
// добавляем его в переписку и пересылаем модераторам.
function handleTicketUserMessage(ticket, username, text) {
  db.prepare('INSERT INTO ticket_messages (ticket_id, from_moderator, author, text, created_at) VALUES (?, 0, ?, ?, ?)').run(
    ticket.id,
    username || null,
    text,
    nowIso()
  );
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso(), ticket.id);

  notifyModerators(
    `✉️ Сообщение в тикет ${ticketHeaderById(ticket.id)} от ${username ? '@' + username : 'id ' + ticket.chat_id}:\n\n${text}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✍️ Ответить', callback_data: `t:reply:${ticket.id}` },
            { text: '🔒 Закрыть', callback_data: `t:close:${ticket.id}` },
          ],
        ],
      },
    }
  );

  return sendMessage(ticket.chat_id, '✅ Сообщение отправлено в поддержку, ожидайте ответа.');
}

// Модератор отправил текст после нажатия "Ответить" — пересылаем юзеру.
function handleModeratorReply(chatId, username, text) {
  const ticketId = pendingReply.get(chatId);
  pendingReply.delete(chatId);

  if (!isModerator(username)) {
    return sendWithMainKeyboard(chatId, username, 'Недоступно.');
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return sendMessage(chatId, 'Тикет не найден.');
  if (ticket.status !== 'open') return sendMessage(chatId, 'Этот тикет уже закрыт.');

  db.prepare('INSERT INTO ticket_messages (ticket_id, from_moderator, author, text, created_at) VALUES (?, 1, ?, ?, ?)').run(
    ticketId,
    username || null,
    text,
    nowIso()
  );
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso(), ticketId);

  sendMessage(ticket.chat_id, `💬 Ответ поддержки (тикет ${ticketHeaderById(ticketId)}):\n\n${text}`);
  return sendMessage(chatId, '✅ Отправлено.');
}

async function startReply(cq, ticketId) {
  const chatId = cq.message.chat.id;
  const username = cq.from.username || null;

  if (!isModerator(username)) {
    return answerCallback(cq.id, 'Недоступно');
  }
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return answerCallback(cq.id, 'Тикет не найден');
  if (ticket.status !== 'open') return answerCallback(cq.id, 'Тикет уже закрыт');

  pendingReply.set(chatId, ticketId);
  await answerCallback(cq.id);
  return sendMessage(chatId, `Напишите ответ для тикета ${ticketHeaderById(ticketId)} следующим сообщением.`);
}

async function closeTicketFlow(cq, ticketId) {
  const chatId = cq.message.chat.id;
  const username = cq.from.username || null;

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return answerCallback(cq.id, 'Тикет не найден');
  if (ticket.status !== 'open') return answerCallback(cq.id, 'Уже закрыт');

  const moderator = isModerator(username);
  const owner = ticket.chat_id === chatId;
  if (!moderator && !owner) return answerCallback(cq.id, 'Недоступно');

  const closedBy = moderator ? (username ? '@' + username : 'модератор') : 'пользователь';
  db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(
    nowIso(),
    closedBy,
    ticketId
  );

  // Если кто-то из модераторов как раз собирался ответить в этот тикет —
  // снимаем ожидание, чтобы его следующее сообщение не улетело в закрытый тикет.
  for (const [cid, tId] of pendingReply.entries()) {
    if (tId === ticketId) pendingReply.delete(cid);
  }

  await answerCallback(cq.id, 'Тикет закрыт');

  if (moderator) {
    sendWithMainKeyboard(ticket.chat_id, ticket.username, `🔒 Ваш тикет ${ticketHeaderById(ticketId)} закрыт поддержкой.`);
  } else {
    sendWithMainKeyboard(chatId, username, `🔒 Тикет ${ticketHeaderById(ticketId)} закрыт.`);
    notifyModerators(`🔒 Тикет ${ticketHeaderById(ticketId)} закрыт пользователем.`);
  }
}

function sendTicketList(chatId, username, statusRaw, offset) {
  if (!isModerator(username)) return sendMessage(chatId, 'Недоступно.');

  const status = statusRaw === 'closed' ? 'closed' : 'open';
  const { rows, hasMore } = listTickets(status, offset);
  const otherStatus = status === 'open' ? 'closed' : 'open';
  const toggleLabel = status === 'open' ? '📁 Закрытые тикеты' : '📂 Открытые тикеты';

  if (!rows.length) {
    return sendMessage(chatId, status === 'open' ? 'Открытых тикетов нет 🎉' : 'Закрытых тикетов пока нет.', {
      reply_markup: { inline_keyboard: [[{ text: toggleLabel, callback_data: `t:list:${otherStatus}:0` }]] },
    });
  }

  const buttons = rows.map((t) => [
    { text: `${ticketHeader(t)} — ${t.username ? '@' + t.username : 'id ' + t.chat_id}`, callback_data: `t:view:${t.id}` },
  ]);

  const nav = [];
  if (offset > 0) nav.push({ text: '⬅️ Назад', callback_data: `t:list:${status}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (hasMore) nav.push({ text: 'Вперёд ➡️', callback_data: `t:list:${status}:${offset + PAGE_SIZE}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: toggleLabel, callback_data: `t:list:${otherStatus}:0` }]);

  return sendMessage(chatId, status === 'open' ? '🎫 Открытые тикеты:' : '🎫 Закрытые тикеты:', {
    reply_markup: { inline_keyboard: buttons },
  });
}

function sendTicketDetail(chatId, username, ticketId) {
  if (!isModerator(username)) return sendMessage(chatId, 'Недоступно.');

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return sendMessage(chatId, 'Тикет не найден.');

  const messages = db
    .prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 10')
    .all(ticketId)
    .reverse();
  const history = messages.length
    ? messages.map((m) => `${m.from_moderator ? '🛠 Поддержка' : '👤 Пользователь'}: ${m.text}`).join('\n\n')
    : 'Сообщений пока нет.';

  const text =
    `Тикет ${ticketHeader(ticket)}\n` +
    `Автор: ${ticket.username ? '@' + ticket.username : 'id ' + ticket.chat_id}\n` +
    `Создан: ${ticket.created_at}\n` +
    (ticket.status === 'closed' ? `Закрыт: ${ticket.closed_at} (${ticket.closed_by})\n` : '') +
    `\n— Последние сообщения —\n${history}`;

  const buttons = [];
  if (ticket.status === 'open') {
    buttons.push([
      { text: '✍️ Ответить', callback_data: `t:reply:${ticket.id}` },
      { text: '🔒 Закрыть', callback_data: `t:close:${ticket.id}` },
    ]);
  }
  buttons.push([{ text: '⬅️ К списку', callback_data: `t:list:${ticket.status}:0` }]);

  return sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

/* ---------------------------------------------------------------------- */
/* Роутинг апдейтов.                                                       */
/* ---------------------------------------------------------------------- */

function handleOther(message) {
  const chatId = message.chat.id;
  const username = message.from.username || null;
  const text = (message.text || '').trim();

  if (text === BTN_LINK) {
    return sendWithMainKeyboard(chatId, username, linkInstructionsText());
  }
  if (text === BTN_SUPPORT) {
    return openSupportMenu(chatId, username);
  }
  if (text === BTN_BUY) {
    return sendWithMainKeyboard(chatId, username, buyText());
  }
  if (text === BTN_TICKETS) {
    if (!isModerator(username)) {
      return sendWithMainKeyboard(chatId, username, 'Эта функция доступна только модераторам поддержки.');
    }
    return sendTicketList(chatId, username, 'open', 0);
  }

  return sendWithMainKeyboard(chatId, username, 'Выберите действие на клавиатуре ниже 👇');
}

async function handleCallback(cq) {
  const data = cq.data || '';
  const chatId = cq.message.chat.id;
  const username = cq.from.username || null;
  trackModerator(chatId, username);

  try {
    if (data === 'sup:new') {
      await answerCallback(cq.id);
      return sendCategoryMenu(chatId);
    }
    if (data.startsWith('cat:')) {
      const key = data.slice('cat:'.length);
      await answerCallback(cq.id);
      return createTicket(chatId, username, key);
    }
    if (data.startsWith('t:list:')) {
      const parts = data.split(':'); // ['t','list',status,offset]
      await answerCallback(cq.id);
      return sendTicketList(chatId, username, parts[2], parseInt(parts[3], 10) || 0);
    }
    if (data.startsWith('t:view:')) {
      const id = Number(data.slice('t:view:'.length));
      await answerCallback(cq.id);
      return sendTicketDetail(chatId, username, id);
    }
    if (data.startsWith('t:reply:')) {
      const id = Number(data.slice('t:reply:'.length));
      return startReply(cq, id);
    }
    if (data.startsWith('t:close:')) {
      const id = Number(data.slice('t:close:'.length));
      return closeTicketFlow(cq, id);
    }
    return answerCallback(cq.id);
  } catch (err) {
    console.error('Ошибка обработки callback', data, err);
    return answerCallback(cq.id, 'Ошибка, попробуйте ещё раз');
  }
}

function handleUpdate(update) {
  if (update.callback_query) {
    return handleCallback(update.callback_query);
  }

  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const username = message.from.username || null;
  trackModerator(chatId, username);

  const text = message.text.trim();

  if (text.startsWith('/start')) {
    const payload = text.slice('/start'.length).trim();
    return handleStart(message, payload);
  }

  // Модератор только что нажал "Ответить" на какой-то тикет — это
  // сообщение уходит туда, а не в обычную обработку кнопок.
  if (pendingReply.has(chatId)) {
    return handleModeratorReply(chatId, username, text);
  }

  // Нажатия кнопок нижней клавиатуры не должны улетать как сообщение в
  // открытый тикет — обрабатываем их как обычно.
  const isKeyboardButton = [BTN_LINK, BTN_SUPPORT, BTN_BUY, BTN_TICKETS].includes(text);

  if (!isKeyboardButton) {
    const openTicket = getOpenTicketByChat(chatId);
    if (openTicket) {
      return handleTicketUserMessage(openTicket, username, text);
    }
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
    allowed_updates: ['message', 'callback_query'],
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
  if (MODERATOR_USERNAMES.length) {
    console.log(`Модераторы поддержки: ${MODERATOR_USERNAMES.map((u) => '@' + u).join(', ')}`);
  } else {
    console.log('MODERATOR_USERNAMES не задан — кнопка "Тикеты" никому не будет доступна.');
  }

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

module.exports = { linkByCode, handleStart, handleUpdate, isModerator, MODERATOR_USERNAMES };

if (require.main === module) {
  main();
}
