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

// activation_keys: richer key system (duration, uses, reward type)
addColumnIfMissing('activation_keys', "reward_type TEXT NOT NULL DEFAULT 'subscription'");
addColumnIfMissing('activation_keys', 'max_uses INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('activation_keys', 'uses_count INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('activation_keys', 'hours_valid INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('activation_keys', 'subscription_days INTEGER');
addColumnIfMissing('activation_keys', 'created_at TEXT');
addColumnIfMissing('activation_keys', 'expires_at TEXT');
addColumnIfMissing('activation_keys', 'created_by INTEGER');

// Backfill created_at/uses_count for keys that existed before this migration
// (the three demo keys), so the new logic has sane values to work with.
db.exec(`
  UPDATE activation_keys SET created_at = COALESCE(created_at, datetime('now'));
  UPDATE activation_keys SET uses_count = used WHERE uses_count = 0 AND used = 1;
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

module.exports = db;
