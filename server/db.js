'use strict';

/**
 * Banco: Postgres (Supabase), assincrono. Era SQLite local (node:sqlite),
 * mas sem disco persistente no Render free o arquivo zerava a cada deploy
 * ou reinicio por inatividade — perda de dado real, aconteceu de verdade.
 * Postgres externo resolve isso: o processo do servidor pode nascer e
 * morrer a vontade, o banco continua vivo em outro lugar.
 *
 * all/get/run aceitam SQL com `?` (estilo antigo, SQLite) e convertem pra
 * `$1, $2...` (estilo Postgres) por baixo — assim quase nenhuma query
 * espalhada pelo resto do codigo precisou ser reescrita.
 */

const { Pool, types } = require('pg');

// BIGINT (oid 20) volta do driver como string por padrao, pra nao perder
// precisao acima de 2^53. Todo BIGINT daqui e timestamp em milissegundos —
// bem dentro do intervalo seguro — entao converte pra Number direto, senao
// vira bug silencioso em toda comparacao/aritmetica de data no resto do app.
types.setTypeParser(20, (val) => parseInt(val, 10));

const CONNECTION_STRING = process.env.DATABASE_URL;
if (!CONNECTION_STRING) throw new Error('DATABASE_URL nao definida — configure a connection string do Postgres');

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('pg pool: erro inesperado', err.message));

/** Troca `?` posicional (estilo SQLite) por `$1 $2 ...` (estilo Postgres). */
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params) {
  return pool.query(toPgSql(sql), params);
}

const all = async (sql, ...params) => (await query(sql, params)).rows;
const get = async (sql, ...params) => (await query(sql, params)).rows[0];
const run = async (sql, ...params) => query(sql, params);

/** Gera um id curto ordenavel por tempo, no estilo snowflake. */
let seq = 0;
function newId() {
  seq = (seq + 1) % 4096;
  return Date.now().toString(36) + seq.toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 6);
}

const SCHEMA = `
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
  created_at    BIGINT NOT NULL,
  UNIQUE (username, tag)
);

CREATE TABLE IF NOT EXISTS guilds (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_color  TEXT NOT NULL DEFAULT '#5865f2',
  icon_url    TEXT,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  xp        INTEGER NOT NULL DEFAULT 0,
  level     INTEGER NOT NULL DEFAULT 0,
  coins     INTEGER NOT NULL DEFAULT 0,
  bank      INTEGER NOT NULL DEFAULT 0,
  last_daily   BIGINT NOT NULL DEFAULT 0,
  last_work    BIGINT NOT NULL DEFAULT 0,
  last_crime   BIGINT NOT NULL DEFAULT 0,
  last_message BIGINT NOT NULL DEFAULT 0,
  muted_until  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_bans (
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  banned_by  TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'text',
  topic      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
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
  created_at  BIGINT NOT NULL,
  edited_at   BIGINT
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
  created_at   BIGINT NOT NULL,
  UNIQUE (requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS read_state (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read  BIGINT NOT NULL DEFAULT 0,
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
  created_at BIGINT NOT NULL
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
  remind_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS polls (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,
  votes      TEXT NOT NULL DEFAULT '{}',
  closed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signup_codes (
  code       TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  note       TEXT,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signup_code_uses (
  code    TEXT NOT NULL,
  user_id TEXT NOT NULL,
  used_at BIGINT NOT NULL,
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS email_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS marriages (
  guild_id  TEXT NOT NULL,
  user_a    TEXT NOT NULL,
  user_b    TEXT NOT NULL,
  since     BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_a)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target_id  TEXT,
  meta       TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_guild ON audit_log(guild_id, created_at);
`;

/** Roda o schema inteiro + migracoes aditivas. Chamado uma vez, na subida. */
async function migrate() {
  await pool.query(SCHEMA);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS org_domain TEXT`);
}

module.exports = { pool, newId, all, get, run, migrate };
