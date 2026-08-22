'use strict';

const express = require('express');
const store = require('./store');
const auth = require('./auth');
const { all, get, run } = require('./db');
const botModule = require('./bot');

const router = express.Router();

const fail = (res, code, message) => res.status(code).json({ error: message });
const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    fail(res, 400, err.message || 'Erro inesperado');
  }
};

/* ------------------------------------------------------------------ auth */

router.post('/auth/register', wrap(async (req, res) => {
  res.json(await auth.register(req.body || {}));
}));

router.post('/auth/login', wrap(async (req, res) => {
  res.json(await auth.login(req.body || {}));
}));

router.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: store.publicUser(req.user) });
});

router.patch('/me', auth.requireAuth, wrap(async (req, res) => {
  const { avatarColor, customStatus, bio, status } = req.body || {};
  const user = store.updateProfile(req.user.id, { avatarColor, customStatus, bio, status });
  res.json({ user: store.publicUser(user) });
}));

/* --------------------------------------------------------------- bootstrap */

/** Tudo que o cliente precisa para montar a interface logo apos o login. */
router.get('/bootstrap', auth.requireAuth, wrap(async (req, res) => {
  const guilds = store.listGuildsOfUser(req.user.id);
  res.json({
    user: store.publicUser(req.user),
    guilds: guilds.map((g) => ({
      ...g,
      channels: store.listChannels(g.id),
      members: store.listMembers(g.id),
      settings: store.getSettings(g.id),
      myRole: store.getMember(g.id, req.user.id)?.role ?? 'member'
    })),
    dms: store.listDMs(req.user.id),
    friends: store.listFriends(req.user.id),
    unread: store.unreadCounts(req.user.id),
    bot: {
      user: store.publicUser(store.getUser(botModule.BOT_ID)),
      commands: [...botModule.bot.commands.values()].map((c) => ({
        name: c.name,
        aliases: c.aliases || [],
        description: c.description,
        usage: c.usage || c.name,
        category: c.category,
        permission: c.permission || null
      }))
    }
  });
}));

/* ---------------------------------------------------------------- guilds */

router.post('/guilds', auth.requireAuth, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2 || name.length > 40) throw new Error('O nome do servidor precisa ter de 2 a 40 caracteres');
  const guild = store.createGuild({ name, ownerId: req.user.id });
  res.json({
    guild: {
      ...store.guildPayload(guild),
      channels: store.listChannels(guild.id),
      members: store.listMembers(guild.id),
      settings: store.getSettings(guild.id),
      myRole: 'owner'
    }
  });
}));

router.post('/guilds/join', auth.requireAuth, wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  const guild = store.getGuildByInvite(code);
  if (!guild) throw new Error('Convite invalido ou expirado');
  if (store.isBanned(guild.id, req.user.id)) throw new Error('Voce esta banido deste servidor');
  if (store.getMember(guild.id, req.user.id)) throw new Error('Voce ja esta neste servidor');

  store.addMember(guild.id, req.user.id);
  req.app.locals.onMemberJoin?.(guild.id, req.user.id);

  res.json({
    guild: {
      ...store.guildPayload(guild),
      channels: store.listChannels(guild.id),
      members: store.listMembers(guild.id),
      settings: store.getSettings(guild.id),
      myRole: 'member'
    }
  });
}));

router.delete('/guilds/:id/leave', auth.requireAuth, wrap(async (req, res) => {
  const guild = store.getGuild(req.params.id);
  if (!guild) throw new Error('Servidor nao encontrado');
  if (guild.owner_id === req.user.id) throw new Error('O dono nao pode sair. Exclua o servidor.');
  store.removeMember(guild.id, req.user.id);
  req.app.locals.onMemberLeave?.(guild.id, req.user.id, req.user.username);
  res.json({ ok: true });
}));

router.delete('/guilds/:id', auth.requireAuth, wrap(async (req, res) => {
  const guild = store.getGuild(req.params.id);
  if (!guild) throw new Error('Servidor nao encontrado');
  if (guild.owner_id !== req.user.id) throw new Error('Apenas o dono pode excluir o servidor');
  store.deleteGuild(guild.id);
  req.app.locals.broadcastGuildDeleted?.(guild.id);
  res.json({ ok: true });
}));

router.get('/guilds/:id/members', auth.requireAuth, wrap(async (req, res) => {
  if (!store.getMember(req.params.id, req.user.id)) throw new Error('Voce nao e membro deste servidor');
  res.json({ members: store.listMembers(req.params.id) });
}));

router.patch('/guilds/:id/settings', auth.requireAuth, wrap(async (req, res) => {
  if (store.rank(req.params.id, req.user.id) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  const settings = store.updateSettings(req.params.id, req.body || {});
  req.app.locals.broadcastSettings?.(req.params.id, settings);
  res.json({ settings });
}));

/* --------------------------------------------------------------- channels */

router.post('/guilds/:id/channels', auth.requireAuth, wrap(async (req, res) => {
  if (store.rank(req.params.id, req.user.id) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  const name = String(req.body?.name || '').trim();
  const type = req.body?.type === 'voice' ? 'voice' : 'text';
  if (!name) throw new Error('Informe o nome do canal');
  const channel = store.createChannel({
    guildId: req.params.id,
    name: type === 'text' ? name.toLowerCase().replace(/\s+/g, '-').slice(0, 32) : name.slice(0, 32),
    type,
    topic: req.body?.topic || null
  });
  req.app.locals.broadcastChannels?.(req.params.id);
  res.json({ channel: store.channelPayload(channel) });
}));

router.delete('/channels/:id', auth.requireAuth, wrap(async (req, res) => {
  const channel = store.getChannel(req.params.id);
  if (!channel || !channel.guild_id) throw new Error('Canal nao encontrado');
  if (store.rank(channel.guild_id, req.user.id) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  store.deleteChannel(channel.id);
  req.app.locals.broadcastChannels?.(channel.guild_id);
  res.json({ ok: true });
}));

router.get('/channels/:id/messages', auth.requireAuth, wrap(async (req, res) => {
  const channel = store.getChannel(req.params.id);
  if (!store.canAccess(req.user.id, channel)) throw new Error('Sem acesso a este canal');
  const messages = store.listMessages(channel.id, {
    before: req.query.before || null,
    limit: Math.min(parseInt(req.query.limit, 10) || 50, 100)
  });
  store.markRead(req.user.id, channel.id);
  res.json({ messages });
}));

/* -------------------------------------------------------------------- dms */

router.post('/dms', auth.requireAuth, wrap(async (req, res) => {
  const otherId = String(req.body?.userId || '');
  const other = store.getUser(otherId);
  if (!other) throw new Error('Usuario nao encontrado');
  if (store.isBlocked(otherId, req.user.id)) throw new Error('Nao e possivel abrir conversa com este usuario');
  const channel = store.getOrCreateDM(req.user.id, otherId);
  req.app.locals.registerDM?.(channel.id, [req.user.id, otherId]);
  res.json({
    channel: { ...store.channelPayload(channel), recipient: store.publicUser(other), lastMessageAt: Date.now() }
  });
}));

/* --------------------------------------------------------------- friends */

router.get('/friends', auth.requireAuth, wrap(async (req, res) => {
  res.json(store.listFriends(req.user.id));
}));

router.post('/friends/request', auth.requireAuth, wrap(async (req, res) => {
  const handle = String(req.body?.handle || '').trim();
  const target = store.getUserByHandle(handle) || get('SELECT * FROM users WHERE lower(username) = lower(?) AND is_bot = 0', handle);
  if (!target) throw new Error('Usuario nao encontrado. Use nome#0000.');
  const friendship = store.sendFriendRequest(req.user.id, target.id);
  req.app.locals.notifyFriends?.([req.user.id, target.id]);
  res.json({ ok: true, status: friendship.status, user: store.publicUser(target) });
}));

router.post('/friends/:id/respond', auth.requireAuth, wrap(async (req, res) => {
  const result = store.respondFriendRequest(req.params.id, req.user.id, !!req.body?.accept);
  req.app.locals.notifyFriends?.([result.requester_id, result.addressee_id]);
  res.json({ ok: true });
}));

router.delete('/friends/:userId', auth.requireAuth, wrap(async (req, res) => {
  store.removeFriend(req.user.id, req.params.userId);
  req.app.locals.notifyFriends?.([req.user.id, req.params.userId]);
  res.json({ ok: true });
}));

router.post('/friends/:userId/block', auth.requireAuth, wrap(async (req, res) => {
  store.blockUser(req.user.id, req.params.userId);
  req.app.locals.notifyFriends?.([req.user.id, req.params.userId]);
  res.json({ ok: true });
}));

router.delete('/friends/:userId/block', auth.requireAuth, wrap(async (req, res) => {
  store.unblockUser(req.user.id, req.params.userId);
  req.app.locals.notifyFriends?.([req.user.id]);
  res.json({ ok: true });
}));

router.get('/users/search', auth.requireAuth, wrap(async (req, res) => {
  res.json({ users: store.searchUsers(String(req.query.q || ''), 15).filter((u) => u.id !== req.user.id) });
}));

/* ------------------------------------------------------------------- bot */

router.get('/bot/commands', auth.requireAuth, (req, res) => {
  res.json({
    commands: [...botModule.bot.commands.values()].map((c) => ({
      name: c.name,
      aliases: c.aliases || [],
      description: c.description,
      usage: c.usage || c.name,
      category: c.category,
      permission: c.permission || null
    }))
  });
});

/** Adiciona (ou remove) o bot de um servidor. */
router.post('/guilds/:id/bot', auth.requireAuth, wrap(async (req, res) => {
  const guildId = req.params.id;
  if (store.rank(guildId, req.user.id) < store.ROLE_RANK.admin) throw new Error('Apenas admins podem gerenciar o bot');
  const enable = req.body?.enable !== false;

  if (enable) {
    store.addMember(guildId, botModule.BOT_ID, 'mod');
    const general = store.listChannels(guildId).find((c) => c.type === 'text');
    if (general) {
      botModule.say(general.id, '', {
        color: botModule.COLORS.brand,
        title: '🤖 Nexy entrou no servidor!',
        description: 'Obrigado por me adicionar. Digite `!ajuda` para ver tudo que eu sei fazer — moderacao, economia, niveis, musica e muito mais.'
      });
    }
  } else {
    store.removeMember(guildId, botModule.BOT_ID);
  }
  req.app.locals.broadcastMembers?.(guildId);
  res.json({ ok: true, enabled: enable, members: store.listMembers(guildId) });
}));

module.exports = router;
