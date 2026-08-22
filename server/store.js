'use strict';

const { newId, all, get, run } = require('./db');

const now = () => Date.now();

/** Id fixo do bot integrado (ver server/bot/index.js). */
const BOT_USER_ID = 'nexy-bot-0001';

const AVATAR_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#00b0f4', '#f47b67', '#9b59b6', '#1abc9c', '#e67e22'];
const pickColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

/* ------------------------------------------------------------------ users */

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    tag: u.tag,
    handle: `${u.username}#${u.tag}`,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url || null,
    status: u.status,
    customStatus: u.custom_status || null,
    bio: u.bio || null,
    isBot: !!u.is_bot,
    createdAt: u.created_at
  };
}

function freeTag(username) {
  for (let i = 0; i < 200; i++) {
    const tag = String(Math.floor(1000 + Math.random() * 9000));
    if (!get('SELECT 1 FROM users WHERE username = ? AND tag = ?', username, tag)) return tag;
  }
  throw new Error('Sem tags disponiveis para este nome');
}

function createUser({ username, email, passwordHash, isBot = false, id = null }) {
  const uid = id || newId();
  run(
    `INSERT INTO users (id, username, tag, email, password_hash, avatar_color, status, is_bot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid, username, freeTag(username), email || null, passwordHash || null,
    pickColor(), isBot ? 'online' : 'offline', isBot ? 1 : 0, now()
  );
  return getUser(uid);
}

const getUser = (id) => get('SELECT * FROM users WHERE id = ?', id);
const getUserByEmail = (email) => get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
const getUserByGoogleSub = (sub) => get('SELECT * FROM users WHERE google_sub = ?', sub);

function getUserByHandle(handle) {
  const m = /^(.+)#(\d{4})$/.exec(String(handle).trim());
  if (!m) return null;
  return get('SELECT * FROM users WHERE lower(username) = lower(?) AND tag = ?', m[1], m[2]);
}

function searchUsers(query, limit = 20) {
  const q = `%${String(query).trim()}%`;
  return all('SELECT * FROM users WHERE username LIKE ? AND is_bot = 0 LIMIT ?', q, limit).map(publicUser);
}

const setStatus = (userId, status) => run('UPDATE users SET status = ? WHERE id = ?', status, userId);

function updateProfile(userId, patch) {
  const map = { avatarColor: 'avatar_color', customStatus: 'custom_status', bio: 'bio', status: 'status' };
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) run(`UPDATE users SET ${col} = ? WHERE id = ?`, patch[key], userId);
  }
  return getUser(userId);
}

/* ----------------------------------------------------------------- guilds */

function guildPayload(g) {
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    iconColor: g.icon_color,
    iconUrl: g.icon_url || null,
    ownerId: g.owner_id,
    inviteCode: g.invite_code,
    createdAt: g.created_at
  };
}

function freeInviteCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!get('SELECT 1 FROM guilds WHERE invite_code = ?', code)) return code;
  }
}

function createGuild({ name, ownerId }) {
  const id = newId();
  run(
    'INSERT INTO guilds (id, name, icon_color, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, name, pickColor(), ownerId, freeInviteCode(), now()
  );
  run('INSERT INTO guild_settings (guild_id) VALUES (?)', id);
  addMember(id, ownerId, 'owner');
  addMember(id, BOT_USER_ID, 'mod');
  createChannel({ guildId: id, name: 'geral', type: 'text', topic: 'Canal principal do servidor' });
  createChannel({ guildId: id, name: 'bot-comandos', type: 'text', topic: 'Use os comandos do bot aqui' });
  createChannel({ guildId: id, name: 'Sala de Voz', type: 'voice' });
  return getGuild(id);
}

const getGuild = (id) => get('SELECT * FROM guilds WHERE id = ?', id);
const getGuildByInvite = (code) => get('SELECT * FROM guilds WHERE invite_code = ?', String(code).trim().toLowerCase());
const deleteGuild = (id) => run('DELETE FROM guilds WHERE id = ?', id);

const listGuildsOfUser = (userId) =>
  all(
    `SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id = g.id
     WHERE m.user_id = ? ORDER BY m.joined_at`, userId
  ).map(guildPayload);

function addMember(guildId, userId, role = 'member') {
  run(
    'INSERT OR IGNORE INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    guildId, userId, role, now()
  );
  return getMember(guildId, userId);
}

const getMember = (guildId, userId) =>
  get('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId);

const removeMember = (guildId, userId) =>
  run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId);

const memberCount = (guildId) =>
  get('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?', guildId)?.n ?? 0;

function memberPayload(row) {
  return {
    ...publicUser(row),
    nickname: row.nickname || null,
    displayName: row.nickname || row.username,
    role: row.role,
    joinedAt: row.joined_at,
    level: row.level,
    xp: row.xp,
    coins: row.coins,
    bank: row.bank,
    mutedUntil: row.muted_until
  };
}

const listMembers = (guildId) =>
  all(
    `SELECT u.*, m.nickname, m.role, m.joined_at, m.level, m.xp, m.coins, m.bank, m.muted_until
     FROM guild_members m JOIN users u ON u.id = m.user_id
     WHERE m.guild_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'mod' THEN 2 ELSE 3 END, u.username`,
    guildId
  ).map(memberPayload);

function findMemberByName(guildId, query) {
  const q = String(query || '').trim().replace(/^@/, '');
  if (!q) return null;
  const byHandle = getUserByHandle(q);
  if (byHandle && getMember(guildId, byHandle.id)) return getMember(guildId, byHandle.id) && byHandle;
  const row = get(
    `SELECT u.* FROM guild_members m JOIN users u ON u.id = m.user_id
     WHERE m.guild_id = ? AND (lower(u.username) = lower(?) OR lower(m.nickname) = lower(?) OR u.id = ?)`,
    guildId, q, q, q
  );
  if (row) return row;
  return get(
    `SELECT u.* FROM guild_members m JOIN users u ON u.id = m.user_id
     WHERE m.guild_id = ? AND lower(u.username) LIKE lower(?) LIMIT 1`,
    guildId, `${q}%`
  );
}

const ROLE_RANK = { owner: 3, admin: 2, mod: 1, member: 0 };
function rank(guildId, userId) {
  const m = getMember(guildId, userId);
  return m ? (ROLE_RANK[m.role] ?? 0) : -1;
}

const setRole = (guildId, userId, role) =>
  run('UPDATE guild_members SET role = ? WHERE guild_id = ? AND user_id = ?', role, guildId, userId);

const isBanned = (guildId, userId) =>
  !!get('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?', guildId, userId);

const banMember = (guildId, userId, reason, by) => {
  run(
    'INSERT OR REPLACE INTO guild_bans (guild_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?)',
    guildId, userId, reason || null, by || null, now()
  );
  removeMember(guildId, userId);
};

const unbanMember = (guildId, userId) =>
  run('DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?', guildId, userId);

const listBans = (guildId) =>
  all('SELECT * FROM guild_bans WHERE guild_id = ?', guildId)
    .map((b) => ({ user: publicUser(getUser(b.user_id)), reason: b.reason, createdAt: b.created_at }));

/* --------------------------------------------------------------- channels */

function channelPayload(c) {
  if (!c) return null;
  return {
    id: c.id,
    guildId: c.guild_id,
    name: c.name,
    type: c.type,
    topic: c.topic || null,
    position: c.position,
    createdAt: c.created_at
  };
}

function createChannel({ guildId, name, type = 'text', topic = null }) {
  const id = newId();
  const pos = get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE guild_id = ?', guildId)?.p ?? 0;
  run(
    'INSERT INTO channels (id, guild_id, name, type, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, guildId || null, name, type, topic, pos, now()
  );
  return getChannel(id);
}

const getChannel = (id) => get('SELECT * FROM channels WHERE id = ?', id);
const listChannels = (guildId) =>
  all("SELECT * FROM channels WHERE guild_id = ? ORDER BY (type = 'voice'), position", guildId).map(channelPayload);
const deleteChannel = (id) => run('DELETE FROM channels WHERE id = ?', id);
const renameChannel = (id, name) => run('UPDATE channels SET name = ? WHERE id = ?', name, id);

function findChannelByName(guildId, name) {
  const q = String(name || '').trim().replace(/^#/, '');
  return get('SELECT * FROM channels WHERE guild_id = ? AND lower(name) = lower(?)', guildId, q)
      || get('SELECT * FROM channels WHERE id = ?', q);
}

/** Canal de DM entre dois usuarios; criado sob demanda. */
function getOrCreateDM(userA, userB) {
  const found = get(
    `SELECT c.* FROM channels c
     JOIN dm_participants p1 ON p1.channel_id = c.id AND p1.user_id = ?
     JOIN dm_participants p2 ON p2.channel_id = c.id AND p2.user_id = ?
     WHERE c.type = 'dm'`,
    userA, userB
  );
  if (found) return found;
  const ch = createChannel({ guildId: null, name: 'dm', type: 'dm' });
  run('INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)', ch.id, userA);
  run('INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)', ch.id, userB);
  return ch;
}

const dmParticipants = (channelId) =>
  all('SELECT user_id FROM dm_participants WHERE channel_id = ?', channelId).map((r) => r.user_id);

function listDMs(userId) {
  const rows = all(
    `SELECT c.* FROM channels c
     JOIN dm_participants p ON p.channel_id = c.id
     WHERE p.user_id = ? AND c.type = 'dm'`,
    userId
  );
  return rows.map((c) => {
    const otherId = dmParticipants(c.id).find((id) => id !== userId);
    const last = get('SELECT created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1', c.id);
    return {
      ...channelPayload(c),
      recipient: publicUser(getUser(otherId)),
      lastMessageAt: last ? last.created_at : c.created_at
    };
  }).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/** O usuario pode ler/escrever neste canal? */
function canAccess(userId, channel) {
  if (!channel) return false;
  if (channel.type === 'dm') return dmParticipants(channel.id).includes(userId);
  return !!getMember(channel.guild_id, userId);
}

/* --------------------------------------------------------------- messages */

function messagePayload(m) {
  if (!m) return null;
  const reactions = all('SELECT emoji, user_id FROM reactions WHERE message_id = ?', m.id);
  const grouped = {};
  for (const r of reactions) (grouped[r.emoji] ||= []).push(r.user_id);

  let replyTo = null;
  if (m.reply_to) {
    const parent = get('SELECT * FROM messages WHERE id = ?', m.reply_to);
    if (parent) {
      replyTo = { id: parent.id, content: parent.content, author: publicUser(getUser(parent.author_id)) };
    }
  }
  return {
    id: m.id,
    channelId: m.channel_id,
    author: publicUser(getUser(m.author_id)),
    content: m.content,
    embed: m.embed ? JSON.parse(m.embed) : null,
    replyTo,
    reactions: Object.entries(grouped).map(([emoji, users]) => ({ emoji, users, count: users.length })),
    createdAt: m.created_at,
    editedAt: m.edited_at || null
  };
}

function createMessage({ channelId, authorId, content = '', embed = null, replyTo = null }) {
  const id = newId();
  run(
    'INSERT INTO messages (id, channel_id, author_id, content, embed, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, channelId, authorId, content, embed ? JSON.stringify(embed) : null, replyTo, now()
  );
  return messagePayload(get('SELECT * FROM messages WHERE id = ?', id));
}

const getMessage = (id) => get('SELECT * FROM messages WHERE id = ?', id);

function listMessages(channelId, { before = null, limit = 50 } = {}) {
  const rows = before
    ? all(
        `SELECT * FROM messages WHERE channel_id = ?
           AND created_at < (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY created_at DESC LIMIT ?`, channelId, before, limit)
    : all('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?', channelId, limit);
  return rows.reverse().map(messagePayload);
}

function editMessage(id, content) {
  run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, now(), id);
  return messagePayload(get('SELECT * FROM messages WHERE id = ?', id));
}

const deleteMessage = (id) => run('DELETE FROM messages WHERE id = ?', id);

function purgeMessages(channelId, count) {
  const rows = all('SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?', channelId, count);
  for (const r of rows) deleteMessage(r.id);
  return rows.map((r) => r.id);
}

function toggleReaction(messageId, userId, emoji) {
  const existing = get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  if (existing) run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  else run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', messageId, userId, emoji);
  return messagePayload(get('SELECT * FROM messages WHERE id = ?', messageId));
}

/* --------------------------------------------------------------- amizades */

function friendshipBetween(a, b) {
  return get(
    `SELECT * FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    a, b, b, a
  );
}

function sendFriendRequest(fromId, toId) {
  if (fromId === toId) throw new Error('Voce nao pode adicionar a si mesmo');
  const existing = friendshipBetween(fromId, toId);
  if (existing) {
    if (existing.status === 'accepted') throw new Error('Voces ja sao amigos');
    if (existing.status === 'blocked') throw new Error('Nao foi possivel enviar o pedido');
    if (existing.requester_id === fromId) throw new Error('Pedido ja enviado');
    run("UPDATE friendships SET status = 'accepted' WHERE id = ?", existing.id);
    return { ...existing, status: 'accepted' };
  }
  const id = newId();
  run(
    "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    id, fromId, toId, now()
  );
  return get('SELECT * FROM friendships WHERE id = ?', id);
}

function respondFriendRequest(friendshipId, userId, accept) {
  const f = get('SELECT * FROM friendships WHERE id = ?', friendshipId);
  if (!f || f.addressee_id !== userId || f.status !== 'pending') throw new Error('Pedido invalido');
  if (accept) run("UPDATE friendships SET status = 'accepted' WHERE id = ?", friendshipId);
  else run('DELETE FROM friendships WHERE id = ?', friendshipId);
  return { ...f, status: accept ? 'accepted' : 'declined' };
}

function removeFriend(userId, otherId) {
  const f = friendshipBetween(userId, otherId);
  if (f && f.status !== 'blocked') run('DELETE FROM friendships WHERE id = ?', f.id);
  return f;
}

function blockUser(userId, otherId) {
  const f = friendshipBetween(userId, otherId);
  if (f) run('DELETE FROM friendships WHERE id = ?', f.id);
  run(
    "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'blocked', ?)",
    newId(), userId, otherId, now()
  );
}

const unblockUser = (userId, otherId) =>
  run("DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'blocked'", userId, otherId);

function listFriends(userId) {
  const friends = all(
    "SELECT * FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)",
    userId, userId
  ).map((f) => publicUser(getUser(f.requester_id === userId ? f.addressee_id : f.requester_id)));

  const incoming = all(
    "SELECT * FROM friendships WHERE status = 'pending' AND addressee_id = ?", userId
  ).map((f) => ({ id: f.id, user: publicUser(getUser(f.requester_id)), createdAt: f.created_at }));

  const outgoing = all(
    "SELECT * FROM friendships WHERE status = 'pending' AND requester_id = ?", userId
  ).map((f) => ({ id: f.id, user: publicUser(getUser(f.addressee_id)), createdAt: f.created_at }));

  const blocked = all(
    "SELECT * FROM friendships WHERE status = 'blocked' AND requester_id = ?", userId
  ).map((f) => publicUser(getUser(f.addressee_id)));

  return { friends: friends.filter(Boolean), incoming, outgoing, blocked: blocked.filter(Boolean) };
}

const areFriends = (a, b) => friendshipBetween(a, b)?.status === 'accepted';

const isBlocked = (a, b) => {
  const f = friendshipBetween(a, b);
  return f?.status === 'blocked';
};

/* -------------------------------------------------------- config do guild */

function getSettings(guildId) {
  let s = get('SELECT * FROM guild_settings WHERE guild_id = ?', guildId);
  if (!s) {
    run('INSERT INTO guild_settings (guild_id) VALUES (?)', guildId);
    s = get('SELECT * FROM guild_settings WHERE guild_id = ?', guildId);
  }
  return s;
}

const SETTING_COLUMNS = new Set([
  'prefix', 'welcome_channel_id', 'welcome_message', 'goodbye_message', 'log_channel_id',
  'levels_enabled', 'levelup_message', 'economy_enabled',
  'automod_links', 'automod_spam', 'automod_caps', 'automod_words'
]);

function updateSettings(guildId, patch) {
  getSettings(guildId);
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_COLUMNS.has(key)) continue;
    run(`UPDATE guild_settings SET ${key} = ? WHERE guild_id = ?`, value, guildId);
  }
  return getSettings(guildId);
}

/* ---------------------------------------------------------------- leitura */

const markRead = (userId, channelId) =>
  run(
    `INSERT INTO read_state (user_id, channel_id, last_read) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read = excluded.last_read`,
    userId, channelId, now()
  );

function unreadCounts(userId) {
  const rows = all(
    `SELECT m.channel_id AS cid, COUNT(*) AS n
     FROM messages m
     LEFT JOIN read_state r ON r.channel_id = m.channel_id AND r.user_id = ?
     WHERE m.author_id != ?
       AND m.created_at > COALESCE(r.last_read, 0)
       AND (
         m.channel_id IN (SELECT channel_id FROM dm_participants WHERE user_id = ?)
         OR m.channel_id IN (
           SELECT c.id FROM channels c JOIN guild_members gm ON gm.guild_id = c.guild_id
           WHERE gm.user_id = ?
         )
       )
     GROUP BY m.channel_id`,
    userId, userId, userId, userId
  );
  const out = {};
  for (const r of rows) out[r.cid] = r.n;
  return out;
}

module.exports = {
  now, pickColor, publicUser, BOT_USER_ID,
  createUser, getUser, getUserByEmail, getUserByGoogleSub, getUserByHandle, searchUsers, setStatus, updateProfile,
  guildPayload, createGuild, getGuild, getGuildByInvite, deleteGuild, listGuildsOfUser,
  addMember, getMember, removeMember, memberCount, listMembers, memberPayload, findMemberByName,
  rank, ROLE_RANK, setRole, isBanned, banMember, unbanMember, listBans,
  channelPayload, createChannel, getChannel, listChannels, deleteChannel, renameChannel, findChannelByName,
  getOrCreateDM, dmParticipants, listDMs, canAccess,
  messagePayload, createMessage, getMessage, listMessages, editMessage, deleteMessage, purgeMessages, toggleReaction,
  sendFriendRequest, respondFriendRequest, removeFriend, blockUser, unblockUser,
  listFriends, areFriends, isBlocked, friendshipBetween,
  getSettings, updateSettings,
  markRead, unreadCounts
};
