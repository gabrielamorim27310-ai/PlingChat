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
    emailVerified: !!u.email_verified,
    hasEmail: !!u.email,
    createdAt: Number(u.created_at)
  };
}

/** Mesmo com a #tag, dois usuários com o mesmo nome confundem -- nome tem
 * que ser único (sem diferenciar maiúscula/minúscula). */
const usernameTaken = async (username) => !!(await get('SELECT 1 FROM users WHERE lower(username) = lower(?)', username));

async function freeTag(username) {
  for (let i = 0; i < 200; i++) {
    const tag = String(Math.floor(1000 + Math.random() * 9000));
    if (!(await get('SELECT 1 FROM users WHERE username = ? AND tag = ?', username, tag))) return tag;
  }
  throw new Error('Sem tags disponiveis para este nome');
}

async function createUser({ username, email, passwordHash, isBot = false, id = null }) {
  const uid = id || newId();
  await run(
    `INSERT INTO users (id, username, tag, email, password_hash, avatar_color, status, is_bot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid, username, await freeTag(username), email || null, passwordHash || null,
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

async function searchUsers(query, limit = 20) {
  const q = `%${String(query).trim()}%`;
  return (await all('SELECT * FROM users WHERE username LIKE ? AND is_bot = 0 LIMIT ?', q, limit)).map(publicUser);
}

const setStatus = (userId, status) => run('UPDATE users SET status = ? WHERE id = ?', status, userId);

async function updateProfile(userId, patch) {
  const map = { avatarColor: 'avatar_color', avatarUrl: 'avatar_url', customStatus: 'custom_status', bio: 'bio', status: 'status' };
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) await run(`UPDATE users SET ${col} = ? WHERE id = ?`, patch[key], userId);
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
    createdAt: Number(g.created_at)
  };
}

async function freeInviteCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!(await get('SELECT 1 FROM guilds WHERE invite_code = ?', code))) return code;
  }
}

async function createGuild({ name, ownerId }) {
  const id = newId();
  await run(
    'INSERT INTO guilds (id, name, icon_color, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, name, pickColor(), ownerId, await freeInviteCode(), now()
  );
  await run('INSERT INTO guild_settings (guild_id) VALUES (?)', id);
  await addMember(id, ownerId, 'owner');
  await addMember(id, BOT_USER_ID, 'mod');
  await createChannel({ guildId: id, name: 'geral', type: 'text', topic: 'Canal principal do servidor' });
  await createChannel({ guildId: id, name: 'bot-comandos', type: 'text', topic: 'Use os comandos do bot aqui' });
  await createChannel({ guildId: id, name: 'Sala de Voz', type: 'voice' });
  return getGuild(id);
}

const getGuild = (id) => get('SELECT * FROM guilds WHERE id = ?', id);
const getGuildByInvite = (code) => get('SELECT * FROM guilds WHERE invite_code = ?', String(code).trim().toLowerCase());
const deleteGuild = (id) => run('DELETE FROM guilds WHERE id = ?', id);

const listGuildsOfUser = async (userId) =>
  (await all(
    `SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id = g.id
     WHERE m.user_id = ? ORDER BY m.joined_at`, userId
  )).map(guildPayload);

async function addMember(guildId, userId, role = 'member') {
  await run(
    `INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    guildId, userId, role, now()
  );
  return getMember(guildId, userId);
}

const getMember = (guildId, userId) =>
  get('SELECT * FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId);

const removeMember = (guildId, userId) =>
  run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', guildId, userId);

const memberCount = async (guildId) =>
  Number((await get('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?', guildId))?.n ?? 0);

function memberPayload(row) {
  return {
    ...publicUser(row),
    nickname: row.nickname || null,
    displayName: row.nickname || row.username,
    role: row.role,
    joinedAt: Number(row.joined_at),
    level: row.level,
    xp: row.xp,
    coins: row.coins,
    bank: row.bank,
    mutedUntil: Number(row.muted_until)
  };
}

const listMembers = async (guildId) =>
  (await all(
    `SELECT u.*, m.nickname, m.role, m.joined_at, m.level, m.xp, m.coins, m.bank, m.muted_until
     FROM guild_members m JOIN users u ON u.id = m.user_id
     WHERE m.guild_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'mod' THEN 2 ELSE 3 END, u.username`,
    guildId
  )).map(memberPayload);

async function findMemberByName(guildId, query) {
  const q = String(query || '').trim().replace(/^@/, '');
  if (!q) return null;
  const byHandle = await getUserByHandle(q);
  if (byHandle && (await getMember(guildId, byHandle.id))) return byHandle;
  const row = await get(
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
async function rank(guildId, userId) {
  const m = await getMember(guildId, userId);
  return m ? (ROLE_RANK[m.role] ?? 0) : -1;
}

const setRole = (guildId, userId, role) =>
  run('UPDATE guild_members SET role = ? WHERE guild_id = ? AND user_id = ?', role, guildId, userId);

const isBanned = async (guildId, userId) =>
  !!(await get('SELECT 1 FROM guild_bans WHERE guild_id = ? AND user_id = ?', guildId, userId));

const banMember = async (guildId, userId, reason, by) => {
  await run(
    `INSERT INTO guild_bans (guild_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at`,
    guildId, userId, reason || null, by || null, now()
  );
  await removeMember(guildId, userId);
};

const unbanMember = (guildId, userId) =>
  run('DELETE FROM guild_bans WHERE guild_id = ? AND user_id = ?', guildId, userId);

async function listBans(guildId) {
  const rows = await all('SELECT * FROM guild_bans WHERE guild_id = ?', guildId);
  const out = [];
  for (const b of rows) out.push({ user: publicUser(await getUser(b.user_id)), reason: b.reason, createdAt: Number(b.created_at) });
  return out;
}

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
    createdAt: Number(c.created_at)
  };
}

async function createChannel({ guildId, name, type = 'text', topic = null }) {
  const id = newId();
  const pos = Number((await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE guild_id = ?', guildId))?.p ?? 0);
  await run(
    'INSERT INTO channels (id, guild_id, name, type, topic, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, guildId || null, name, type, topic, pos, now()
  );
  return getChannel(id);
}

const getChannel = (id) => get('SELECT * FROM channels WHERE id = ?', id);
const listChannels = async (guildId) =>
  (await all("SELECT * FROM channels WHERE guild_id = ? ORDER BY (type = 'voice'), position", guildId)).map(channelPayload);
const deleteChannel = (id) => run('DELETE FROM channels WHERE id = ?', id);
const renameChannel = (id, name) => run('UPDATE channels SET name = ? WHERE id = ?', name, id);

async function findChannelByName(guildId, name) {
  const q = String(name || '').trim().replace(/^#/, '');
  return (await get('SELECT * FROM channels WHERE guild_id = ? AND lower(name) = lower(?)', guildId, q))
      || get('SELECT * FROM channels WHERE id = ?', q);
}

/** Canal de DM entre dois usuarios; criado sob demanda. */
async function getOrCreateDM(userA, userB) {
  const found = await get(
    `SELECT c.* FROM channels c
     JOIN dm_participants p1 ON p1.channel_id = c.id AND p1.user_id = ?
     JOIN dm_participants p2 ON p2.channel_id = c.id AND p2.user_id = ?
     WHERE c.type = 'dm'`,
    userA, userB
  );
  if (found) return found;
  const ch = await createChannel({ guildId: null, name: 'dm', type: 'dm' });
  await run('INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)', ch.id, userA);
  await run('INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)', ch.id, userB);
  return ch;
}

const dmParticipants = async (channelId) =>
  (await all('SELECT user_id FROM dm_participants WHERE channel_id = ?', channelId)).map((r) => r.user_id);

async function listDMs(userId) {
  const rows = await all(
    `SELECT c.* FROM channels c
     JOIN dm_participants p ON p.channel_id = c.id
     WHERE p.user_id = ? AND c.type = 'dm'`,
    userId
  );
  const out = [];
  for (const c of rows) {
    const participants = await dmParticipants(c.id);
    const otherId = participants.find((id) => id !== userId);
    const last = await get('SELECT created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1', c.id);
    out.push({
      ...channelPayload(c),
      recipient: publicUser(await getUser(otherId)),
      lastMessageAt: last ? Number(last.created_at) : Number(c.created_at)
    });
  }
  return out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/** O usuario pode ler/escrever neste canal? */
async function canAccess(userId, channel) {
  if (!channel) return false;
  if (channel.type === 'dm') return (await dmParticipants(channel.id)).includes(userId);
  return !!(await getMember(channel.guild_id, userId));
}

/* --------------------------------------------------------------- messages */

async function messagePayload(m) {
  if (!m) return null;
  const reactions = await all('SELECT emoji, user_id FROM reactions WHERE message_id = ?', m.id);
  const grouped = {};
  for (const r of reactions) (grouped[r.emoji] ||= []).push(r.user_id);

  let replyTo = null;
  if (m.reply_to) {
    const parent = await get('SELECT * FROM messages WHERE id = ?', m.reply_to);
    if (parent) {
      replyTo = { id: parent.id, content: parent.content, author: publicUser(await getUser(parent.author_id)) };
    }
  }
  return {
    id: m.id,
    channelId: m.channel_id,
    author: publicUser(await getUser(m.author_id)),
    content: m.content,
    embed: m.embed ? JSON.parse(m.embed) : null,
    replyTo,
    reactions: Object.entries(grouped).map(([emoji, users]) => ({ emoji, users, count: users.length })),
    createdAt: Number(m.created_at),
    editedAt: m.edited_at ? Number(m.edited_at) : null
  };
}

async function createMessage({ channelId, authorId, content = '', embed = null, replyTo = null }) {
  const id = newId();
  await run(
    'INSERT INTO messages (id, channel_id, author_id, content, embed, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, channelId, authorId, content, embed ? JSON.stringify(embed) : null, replyTo, now()
  );
  return messagePayload(await get('SELECT * FROM messages WHERE id = ?', id));
}

const getMessage = (id) => get('SELECT * FROM messages WHERE id = ?', id);

async function listMessages(channelId, { before = null, limit = 50 } = {}) {
  const rows = before
    ? await all(
        `SELECT * FROM messages WHERE channel_id = ?
           AND created_at < (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY created_at DESC LIMIT ?`, channelId, before, limit)
    : await all('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?', channelId, limit);
  const ordered = rows.reverse();
  const out = [];
  for (const r of ordered) out.push(await messagePayload(r));
  return out;
}

async function editMessage(id, content) {
  await run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, now(), id);
  return messagePayload(await get('SELECT * FROM messages WHERE id = ?', id));
}

/** Atualiza so o embed de uma mensagem (usado por embeds interativos, tipo convite de servidor). */
async function setMessageEmbed(id, embed) {
  await run('UPDATE messages SET embed = ? WHERE id = ?', embed ? JSON.stringify(embed) : null, id);
  return messagePayload(await get('SELECT * FROM messages WHERE id = ?', id));
}

const deleteMessage = (id) => run('DELETE FROM messages WHERE id = ?', id);

async function purgeMessages(channelId, count) {
  const rows = await all('SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?', channelId, count);
  for (const r of rows) await deleteMessage(r.id);
  return rows.map((r) => r.id);
}

async function toggleReaction(messageId, userId, emoji) {
  const existing = await get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  if (existing) await run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  else await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', messageId, userId, emoji);
  return messagePayload(await get('SELECT * FROM messages WHERE id = ?', messageId));
}

/* --------------------------------------------------------------- amizades */

function friendshipBetween(a, b) {
  return get(
    `SELECT * FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    a, b, b, a
  );
}

async function sendFriendRequest(fromId, toId) {
  if (fromId === toId) throw new Error('Voce nao pode adicionar a si mesmo');
  const existing = await friendshipBetween(fromId, toId);
  if (existing) {
    if (existing.status === 'accepted') throw new Error('Voces ja sao amigos');
    if (existing.status === 'blocked') throw new Error('Nao foi possivel enviar o pedido');
    if (existing.requester_id === fromId) throw new Error('Pedido ja enviado');
    await run("UPDATE friendships SET status = 'accepted' WHERE id = ?", existing.id);
    return { ...existing, status: 'accepted' };
  }
  const id = newId();
  await run(
    "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    id, fromId, toId, now()
  );
  return get('SELECT * FROM friendships WHERE id = ?', id);
}

/** Amizade automatica, ja aceita — usada quando o convite de cadastro embute amizade. */
async function autoFriend(a, b) {
  if (a === b || (await friendshipBetween(a, b))) return;
  await run(
    "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'accepted', ?)",
    newId(), a, b, now()
  );
}

async function respondFriendRequest(friendshipId, userId, accept) {
  const f = await get('SELECT * FROM friendships WHERE id = ?', friendshipId);
  if (!f || f.addressee_id !== userId || f.status !== 'pending') throw new Error('Pedido invalido');
  if (accept) await run("UPDATE friendships SET status = 'accepted' WHERE id = ?", friendshipId);
  else await run('DELETE FROM friendships WHERE id = ?', friendshipId);
  return { ...f, status: accept ? 'accepted' : 'declined' };
}

async function removeFriend(userId, otherId) {
  const f = await friendshipBetween(userId, otherId);
  if (f && f.status !== 'blocked') await run('DELETE FROM friendships WHERE id = ?', f.id);
  return f;
}

async function blockUser(userId, otherId) {
  const f = await friendshipBetween(userId, otherId);
  if (f) await run('DELETE FROM friendships WHERE id = ?', f.id);
  await run(
    "INSERT INTO friendships (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'blocked', ?)",
    newId(), userId, otherId, now()
  );
}

const unblockUser = (userId, otherId) =>
  run("DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'blocked'", userId, otherId);

async function listFriends(userId) {
  const acceptedRows = await all(
    "SELECT * FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)",
    userId, userId
  );
  const friends = [];
  for (const f of acceptedRows) friends.push(publicUser(await getUser(f.requester_id === userId ? f.addressee_id : f.requester_id)));

  const incomingRows = await all("SELECT * FROM friendships WHERE status = 'pending' AND addressee_id = ?", userId);
  const incoming = [];
  for (const f of incomingRows) incoming.push({ id: f.id, user: publicUser(await getUser(f.requester_id)), createdAt: Number(f.created_at) });

  const outgoingRows = await all("SELECT * FROM friendships WHERE status = 'pending' AND requester_id = ?", userId);
  const outgoing = [];
  for (const f of outgoingRows) outgoing.push({ id: f.id, user: publicUser(await getUser(f.addressee_id)), createdAt: Number(f.created_at) });

  const blockedRows = await all("SELECT * FROM friendships WHERE status = 'blocked' AND requester_id = ?", userId);
  const blocked = [];
  for (const f of blockedRows) blocked.push(publicUser(await getUser(f.addressee_id)));

  return { friends: friends.filter(Boolean), incoming, outgoing, blocked: blocked.filter(Boolean) };
}

const areFriends = async (a, b) => (await friendshipBetween(a, b))?.status === 'accepted';

const isBlocked = async (a, b) => {
  const f = await friendshipBetween(a, b);
  return f?.status === 'blocked';
};

/* -------------------------------------------------------- config do guild */

async function getSettings(guildId) {
  let s = await get('SELECT * FROM guild_settings WHERE guild_id = ?', guildId);
  if (!s) {
    await run('INSERT INTO guild_settings (guild_id) VALUES (?)', guildId);
    s = await get('SELECT * FROM guild_settings WHERE guild_id = ?', guildId);
  }
  return s;
}

const SETTING_COLUMNS = new Set([
  'prefix', 'welcome_channel_id', 'welcome_message', 'goodbye_message', 'log_channel_id',
  'levels_enabled', 'levelup_message', 'economy_enabled',
  'automod_links', 'automod_spam', 'automod_caps', 'automod_words',
  'org_domain'
]);

async function updateSettings(guildId, patch) {
  await getSettings(guildId);
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_COLUMNS.has(key)) continue;
    await run(`UPDATE guild_settings SET ${key} = ? WHERE guild_id = ?`, value, guildId);
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

async function unreadCounts(userId) {
  const rows = await all(
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
  for (const r of rows) out[r.cid] = Number(r.n);
  return out;
}

/**
 * Log de auditoria por servidor. Toda acao administrativa relevante passa
 * por aqui — banir, mutar, mudar cargo, trocar configuracao sensivel — pra
 * quem administra uma organizacao conseguir ver quem fez o que, quando.
 */
const logAudit = (guildId, actorId, action, targetId = null, meta = null) =>
  run(
    'INSERT INTO audit_log (id, guild_id, actor_id, action, target_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(), guildId, actorId || null, action, targetId || null, meta ? JSON.stringify(meta) : null, now()
  );

async function listAuditLog(guildId, { before = null, limit = 50 } = {}) {
  const rows = before
    ? await all('SELECT * FROM audit_log WHERE guild_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?', guildId, before, Math.min(limit, 100))
    : await all('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?', guildId, Math.min(limit, 100));
  const out = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      actor: r.actor_id ? publicUser(await getUser(r.actor_id)) : null,
      action: r.action,
      target: r.target_id ? publicUser(await getUser(r.target_id)) : null,
      meta: r.meta ? JSON.parse(r.meta) : null,
      createdAt: Number(r.created_at)
    });
  }
  return out;
}

/** Emails com esse dominio entram no servidor sozinhos, sem convite. */
const domainMatches = async (guildId, email) => {
  const domain = (await getSettings(guildId)).org_domain;
  if (!domain) return false;
  return String(email || '').toLowerCase().endsWith('@' + domain.toLowerCase());
};

/** Notificacoes push (Web Push). Uma linha por dispositivo/navegador inscrito. */
const saveSubscription = (userId, sub) =>
  run(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, now()
  );

const removeSubscription = (endpoint) => run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);

const listSubscriptions = (userId) => all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);

module.exports = {
  now, pickColor, publicUser, BOT_USER_ID,
  createUser, usernameTaken, getUser, getUserByEmail, getUserByGoogleSub, getUserByHandle, searchUsers, setStatus, updateProfile,
  guildPayload, createGuild, getGuild, getGuildByInvite, deleteGuild, listGuildsOfUser,
  addMember, getMember, removeMember, memberCount, listMembers, memberPayload, findMemberByName,
  rank, ROLE_RANK, setRole, isBanned, banMember, unbanMember, listBans,
  channelPayload, createChannel, getChannel, listChannels, deleteChannel, renameChannel, findChannelByName,
  getOrCreateDM, dmParticipants, listDMs, canAccess,
  messagePayload, createMessage, getMessage, listMessages, editMessage, setMessageEmbed, deleteMessage, purgeMessages, toggleReaction,
  sendFriendRequest, respondFriendRequest, removeFriend, blockUser, unblockUser, autoFriend,
  listFriends, areFriends, isBlocked, friendshipBetween,
  getSettings, updateSettings,
  markRead, unreadCounts,
  saveSubscription, removeSubscription, listSubscriptions,
  logAudit, listAuditLog, domainMatches
};
