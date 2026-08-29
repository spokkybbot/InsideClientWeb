'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'inside-client.sqlite');

// SQLite won't create the containing folder for us — make sure it exists
// (this also covers a fresh checkout where the empty `data/` dir wasn't
// preserved, e.g. after unzipping the project).
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Сайт и бот — два отдельных процесса, оба пишут в один файл SQLite.
// Без busy_timeout второй процесс при конфликте сразу падает с
// "database is locked" вместо того, чтобы недолго подождать снятия блокировки.
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    login             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash     TEXT NOT NULL,
    hwid              TEXT,
    telegram_chat_id  INTEGER UNIQUE,
    telegram_username TEXT,
    created_at        TEXT NOT NULL,
    last_login        TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS telegram_link_codes (
    code       TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    product       TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'shop',
    purchased_at  TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activation_keys (
    activation_key TEXT PRIMARY KEY,
    product         TEXT NOT NULL,
    used            INTEGER NOT NULL DEFAULT 0,
    used_by         INTEGER,
    used_at         TEXT
  );

  -- Постоянная запись "какой Telegram к какому аккаунту привязывался первым".
  -- В отличие от users.telegram_chat_id (который обнуляется при отвязке),
  -- эта таблица никогда не чистится — так один и тот же Telegram-аккаунт
  -- нельзя привязать к другому сайтовому аккаунту даже после отвязки.
  CREATE TABLE IF NOT EXISTS telegram_bindings (
    telegram_chat_id INTEGER PRIMARY KEY,
    user_id          INTEGER NOT NULL,
    linked_at        TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Подстраховка для уже существующих (до этого изменения) привязок: если
// у аккаунта прямо сейчас есть активный telegram_chat_id, но постоянной
// записи о нём ещё нет — создаём её, чтобы старые привязки тоже стали
// постоянными и не обошли новое правило.
db.exec(`
  INSERT OR IGNORE INTO telegram_bindings (telegram_chat_id, user_id, linked_at)
  SELECT telegram_chat_id, id, created_at FROM users WHERE telegram_chat_id IS NOT NULL;
`);

// Seed a handful of demo activation keys, once.
const keyCount = db.prepare('SELECT COUNT(*) AS c FROM activation_keys').get().c;
if (keyCount === 0) {
  const insertKey = db.prepare(
    'INSERT INTO activation_keys (activation_key, product) VALUES (?, ?)'
  );
  const demoKeys = [
    'DEMO-1111-2222-3333',
    'DEMO-4444-5555-6666',
    'DEMO-7777-8888-9999',
  ];
  for (const k of demoKeys) insertKey.run(k, 'Клиент 1.16.5');
}

/* ---------------------------------------------------------------------- */
/* Migrations — ranks (admin), bans, subscriptions, key system upgrade.   */
/* Written as additive ALTER TABLEs guarded by PRAGMA table_info so they  */
/* are safe to run against a pre-existing database file as well as a     */
/* fresh one.                                                             */
/* ---------------------------------------------------------------------- */

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
}

function addColumnIfMissing(table, columnDef) {
  const name = columnDef.trim().split(/\s+/)[0];
  if (!columnExists(table, name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

// users: rank/ban/subscription
addColumnIfMissing('users', 'is_admin INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'banned INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'subscription_until TEXT');
// users: profile avatar — stored as a data: URL (small, resized client-side).
addColumnIfMissing('users', 'avatar TEXT');

// users: профиль — доступ к боту (выдаётся отдельным типом ключа)
addColumnIfMissing('users', 'bot_access INTEGER NOT NULL DEFAULT 0');

// activation_keys: richer key system (duration, uses, reward type)
addColumnIfMissing('activation_keys', "reward_type TEXT NOT NULL DEFAULT 'subscription'");
addColumnIfMissing('activation_keys', 'max_uses INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('activation_keys', 'uses_count INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('activation_keys', 'hours_valid INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('activation_keys', 'subscription_days INTEGER');
addColumnIfMissing('activation_keys', 'created_at TEXT');
addColumnIfMissing('activation_keys', 'expires_at TEXT');
addColumnIfMissing('activation_keys', 'created_by INTEGER');

// activation_keys: минутная точность для срока действия ключа и срока
// подписки (позволяет создавать ключи от 1 минуты, а не только от часа/дня).
// Старые колонки hours_valid/subscription_days остаются в базе ради обратной
// совместимости, но вся новая логика работает через *_minutes.
addColumnIfMissing('activation_keys', 'key_valid_minutes INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('activation_keys', 'subscription_minutes INTEGER');

// Backfill created_at/uses_count for keys that existed before this migration
// (the three demo keys), so the new logic has sane values to work with.
db.exec(`
  UPDATE activation_keys SET created_at = COALESCE(created_at, datetime('now'));
  UPDATE activation_keys SET uses_count = used WHERE uses_count = 0 AND used = 1;
  UPDATE activation_keys SET key_valid_minutes = hours_valid * 60 WHERE key_valid_minutes = 0 AND hours_valid > 0;
  UPDATE activation_keys SET subscription_minutes = subscription_days * 24 * 60
    WHERE subscription_minutes IS NULL AND subscription_days IS NOT NULL;
`);

// Per-activation log — lets the admin checker show *every* key a user has
// ever redeemed (a key can now be reused up to max_uses times, possibly by
// different accounts, so activation_keys.used_by alone is no longer enough).
db.exec(`
  CREATE TABLE IF NOT EXISTS key_uses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    activation_key TEXT NOT NULL,
    user_id        INTEGER NOT NULL,
    used_at        TEXT NOT NULL,
    FOREIGN KEY(activation_key) REFERENCES activation_keys(activation_key),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Migrate any pre-existing single-use redemptions into the new log so old
// demo-key activations still show up in the admin checker.
db.exec(`
  INSERT INTO key_uses (activation_key, user_id, used_at)
  SELECT activation_key, used_by, COALESCE(used_at, datetime('now'))
  FROM activation_keys
  WHERE used_by IS NOT NULL
    AND activation_key NOT IN (SELECT activation_key FROM key_uses);
`);

// Grant admin rank to any logins listed in ADMIN_LOGINS (comma-separated),
// e.g. `ADMIN_LOGINS=owner,alice node server/server.js`. Re-applied on every
// boot so it also picks up accounts that register after this env var is set.
const adminLogins = (process.env.ADMIN_LOGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (adminLogins.length) {
  const placeholders = adminLogins.map(() => '?').join(',');
  db.prepare(`UPDATE users SET is_admin = 1 WHERE login COLLATE NOCASE IN (${placeholders})`).run(
    ...adminLogins
  );
}

/* ---------------------------------------------------------------------- */
/* Тикеты поддержки (бот).                                                */
/* ---------------------------------------------------------------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    username    TEXT,
    category    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    closed_at   TEXT,
    closed_by   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_chat_status ON tickets(chat_id, status);
  CREATE INDEX IF NOT EXISTS idx_tickets_status_updated ON tickets(status, updated_at);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id      INTEGER NOT NULL,
    from_moderator INTEGER NOT NULL DEFAULT 0,
    author         TEXT,
    text           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES tickets(id)
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);

  -- Telegram chat_id известных модераторов поддержки (username берутся из
  -- переменной окружения MODERATOR_USERNAMES, а chat_id узнаём автоматически,
  -- как только модератор первый раз что-то напишет боту).
  CREATE TABLE IF NOT EXISTS bot_moderators (
    chat_id    INTEGER PRIMARY KEY,
    username   TEXT,
    updated_at TEXT NOT NULL
  );
`);

/* ---------------------------------------------------------------------- */
/* HWID-верификация: таблица логов                                         */
/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- */
/* Облачные конфиги: именованные пресеты настроек клиента на аккаунт.     */
/* Контент — обычный текст/JSON, хранится прямо в SQLite (пресеты          */
/* небольшие), лимиты по количеству/размеру проверяются на уровне API.    */
/* ---------------------------------------------------------------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS configs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- Имена пресетов уникальны в рамках одного аккаунта (без учёта регистра).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_user_name ON configs(user_id, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_configs_user ON configs(user_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS verify_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hwid       TEXT,
    client_ip  TEXT,
    server_ip  TEXT,
    result     TEXT NOT NULL,
    user_id    INTEGER,
    created_at TEXT NOT NULL
  );

  -- Один и тот же HWID не может быть привязан больше чем к одному аккаунту
  -- одновременно (частичный индекс — NULL'ы, т.е. непривязанные аккаунты,
  -- не участвуют в проверке уникальности).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hwid_unique ON users(hwid) WHERE hwid IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_verify_log_hwid       ON verify_log(hwid);
  CREATE INDEX IF NOT EXISTS idx_verify_log_result     ON verify_log(result);
  CREATE INDEX IF NOT EXISTS idx_verify_log_created    ON verify_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_verify_log_user       ON verify_log(user_id);
`);

/* ---------------------------------------------------------------------- */
/* Друзья + живые состояния (координаты/броня/хп/предметы/голова).        */
/* Данные пишет клиент (по HWID, как /api/client/configs/*) и смотрит      */
/* сам клиент (виджет «Друзья» в HUD) и личный кабинет (по сессии).       */
/* Дружба взаимная: при добавлении создаются обе связки (A->B и B->A).    */
/* ---------------------------------------------------------------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS live_states (
    user_id     INTEGER PRIMARY KEY,
    login       TEXT NOT NULL,
    nick        TEXT,
    server      TEXT,
    anarchy_num INTEGER,
    x           INTEGER,
    y           INTEGER,
    z           INTEGER,
    armor       TEXT,
    hp          REAL,
    items       TEXT,
    head        TEXT,
    hidden      INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friends (
    user_id    INTEGER NOT NULL,
    friend_id  INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(friend_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_friends_user    ON friends(user_id);
  CREATE INDEX IF NOT EXISTS idx_friends_friend  ON friends(friend_id);
`);

module.exports = db;
