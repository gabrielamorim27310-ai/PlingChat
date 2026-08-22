'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'nexus.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  tag           TEXT NOT NULL,
  email         TEXT UNIQUE,
  password_hash TEXT,
  avatar_color  TEXT NOT NULL DEFAULT '#5865f2',
  avatar_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'offline',
  custom_status TEXT,
  bio           TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (username, tag)
);

CREATE TABLE IF NOT EXISTS guilds (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_color  TEXT NOT NULL DEFAULT '#5865f2',
  icon_url    TEXT,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  xp        INTEGER NOT NULL DEFAULT 0,
  level     INTEGER NOT NULL DEFAULT 0,
  coins     INTEGER NOT NULL DEFAULT 0,
  bank      INTEGER NOT NULL DEFAULT 0,
  last_daily   INTEGER NOT NULL DEFAULT 0,
  last_work    INTEGER NOT NULL DEFAULT 0,
  last_crime   INTEGER NOT NULL DEFAULT 0,
  last_message INTEGER NOT NULL DEFAULT 0,
  muted_until  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_bans (
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  banned_by  TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'text',
  topic      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_participants (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL DEFAULT '',
  embed       TEXT,
  reply_to    TEXT,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS friendships (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  UNIQUE (requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS read_state (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id           TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  prefix             TEXT NOT NULL DEFAULT '!',
  welcome_channel_id TEXT,
  welcome_message    TEXT DEFAULT 'Bem-vindo(a) {user} ao {server}! Agora somos {count} membros.',
  goodbye_message    TEXT DEFAULT '{user} saiu do servidor.',
  log_channel_id     TEXT,
  levels_enabled     INTEGER NOT NULL DEFAULT 1,
  levelup_message    TEXT DEFAULT 'GG {user}, voce chegou ao nivel **{level}**!',
  economy_enabled    INTEGER NOT NULL DEFAULT 1,
  automod_links      INTEGER NOT NULL DEFAULT 0,
  automod_spam       INTEGER NOT NULL DEFAULT 1,
  automod_caps       INTEGER NOT NULL DEFAULT 0,
  automod_words      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS warns (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  moderator  TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_commands (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS inventory (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  remind_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS polls (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,
  votes      TEXT NOT NULL DEFAULT '{}',
  closed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS marriages (
  guild_id  TEXT NOT NULL,
  user_a    TEXT NOT NULL,
  user_b    TEXT NOT NULL,
  since     INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_a)
);
`);

/**
 * Migracoes aditivas: adiciona colunas que nao existiam em bancos antigos.
 * Rodar isso sempre e barato e mantem bases criadas antes da mudanca.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('users', 'google_sub', 'TEXT');

/** Gera um id curto ordenavel por tempo, no estilo snowflake. */
let seq = 0;
function newId() {
  seq = (seq + 1) % 4096;
  return Date.now().toString(36) + seq.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 6);
}

const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

module.exports = { db, newId, all, get, run, DATA_DIR };
