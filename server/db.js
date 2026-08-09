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

module.exports = db;
