'use strict';

const express = require('express');
const store = require('./store');
const auth = require('./auth');
const { get } = require('./db');
const botModule = require('./bot');
const google = require('./google');
const invites = require('./invites');
const mailer = require('./mailer');
const turnstile = require('./turnstile');
const push = require('./push');
const rl = require('./ratelimit');

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

router.post('/auth/register', rl.limit(rl.presets.register), wrap(async (req, res) => {
  await turnstile.verify(req.body?.turnstileToken, rl.clientIp(req));
  const result = await auth.register(req.body || {});

  // O envio nao pode derrubar o cadastro: se falhar, o usuario reenvia depois.
  if (mailer.isEnabled()) {
    store.getUser(result.user.id)
      .then((u) => mailer.sendVerification(u))
      .catch((err) => console.warn('verificacao de e-mail:', err.message));
  }
  res.json({ ...result, verificationSent: mailer.isEnabled() });
}));

router.post('/auth/login', rl.limit({ ...rl.presets.login, by: (req) => String(req.body?.email || '').toLowerCase() }),
  wrap(async (req, res) => {
    await turnstile.verify(req.body?.turnstileToken, rl.clientIp(req));
    const result = await auth.login(req.body || {});
    rl.reset(req.rateLimitKey); // login valido zera o contador
    res.json(result);
  }));

router.post('/auth/google', rl.limit(rl.presets.google), wrap(async (req, res) => {
  res.json(await google.loginWithGoogle(req.body?.credential, req.body?.inviteCode));
}));

/* ------------------------------------------------- recuperacao de senha */

router.post('/auth/forgot', rl.limit(rl.presets.forgot), wrap(async (req, res) => {
  await turnstile.verify(req.body?.turnstileToken, rl.clientIp(req));

  if (!mailer.isEnabled()) throw new Error('A recuperacao de senha nao esta configurada neste servidor');

  const user = await store.getUserByEmail(String(req.body?.email || '').trim().toLowerCase());

  // Resposta identica exista ou nao a conta, para nao revelar quem tem cadastro.
  if (user?.email) {
    mailer.sendPasswordReset(user).catch((err) => console.warn('reset de senha:', err.message));
  }
  res.json({ ok: true });
}));

router.post('/auth/reset', rl.limit(rl.presets.reset), wrap(async (req, res) => {
  const userId = await mailer.consumeToken(req.body?.token, 'reset');
  const user = await auth.setPassword(userId, req.body?.password);
  await mailer.markVerified(userId); // so recebe o link quem controla a caixa
  res.json({ user: store.publicUser(user), token: auth.signToken(userId) });
}));

router.post('/auth/verify', wrap(async (req, res) => {
  const userId = await mailer.consumeToken(req.body?.token, 'verify');
  await mailer.markVerified(userId);
  res.json({ ok: true, user: store.publicUser(await store.getUser(userId)) });
}));

router.post('/auth/resend-verification', auth.requireAuth, rl.limit(rl.presets.forgot), wrap(async (req, res) => {
  if (!mailer.isEnabled()) throw new Error('O envio de e-mail nao esta configurado');
  if (req.user.email_verified) throw new Error('Seu e-mail ja esta confirmado');
  await mailer.sendVerification(req.user);
  res.json({ ok: true });
}));

/* ----------------------------------------------------------- convites */

router.get('/invites', auth.requireAuth, wrap(async (req, res) => {
  res.json({
    codes: await invites.listCodes(req.user.id),
    max: invites.MAX_ACTIVE_PER_USER,
    maxUses: invites.MAX_USES_PER_CODE,
    unlimited: req.user.id === invites.OWNER_USER_ID
  });
}));

router.post('/invites', auth.requireAuth, rl.limit(rl.presets.invite), wrap(async (req, res) => {
  const code = await invites.createCode(req.user.id, { note: req.body?.note || null });
  res.json({ code: code.code, codes: await invites.listCodes(req.user.id) });
}));

router.delete('/invites/:code', auth.requireAuth, wrap(async (req, res) => {
  await invites.revokeCode(req.params.code, req.user.id);
  res.json({ ok: true, codes: await invites.listCodes(req.user.id) });
}));

/** Configuracao publica que o front precisa conhecer antes do login. */
router.get('/config', wrap(async (req, res) => {
  res.json({
    googleClientId: google.isEnabled() ? google.CLIENT_ID : null,
    turnstileSiteKey: turnstile.isEnabled() ? turnstile.SITE_KEY : null,
    signupMode: (await invites.isOpen()) ? 'open' : 'invite',
    passwordResetEnabled: mailer.isEnabled(),
    vapidPublicKey: push.isEnabled() ? push.PUBLIC_KEY : null
  });
}));

/** Inscricao/cancelamento de notificacoes push (Web Push). */
router.post('/push/subscribe', auth.requireAuth, wrap(async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Inscricao invalida');
  await store.saveSubscription(req.user.id, sub);
  res.json({ ok: true });
}));

router.post('/push/unsubscribe', auth.requireAuth, wrap(async (req, res) => {
  if (req.body?.endpoint) await store.removeSubscription(req.body.endpoint);
  res.json({ ok: true });
}));

router.get('/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: store.publicUser(req.user) });
});

router.patch('/me', auth.requireAuth, wrap(async (req, res) => {
  const { avatarColor, avatarUrl, customStatus, bio, status, shareReadReceipts } = req.body || {};

  let nextAvatarUrl;
  if (avatarUrl !== undefined) {
    if (avatarUrl === null) {
      nextAvatarUrl = null; // remove a foto, volta pro avatar de cor
    } else if (typeof avatarUrl === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatarUrl)) {
      if (avatarUrl.length > 900_000) throw new Error('Imagem muito grande. Escolha uma foto menor.');
      nextAvatarUrl = avatarUrl;
    } else {
      throw new Error('Formato de imagem invalido');
    }
  }

  const user = await store.updateProfile(req.user.id, {
    avatarColor, avatarUrl: nextAvatarUrl, customStatus, bio, status, shareReadReceipts
  });
  req.app.locals.broadcastProfileUpdate?.(req.user.id);
  res.json({ user: store.publicUser(user) });
}));

/* --------------------------------------------------------------- bootstrap */

/** Tudo que o cliente precisa para montar a interface logo apos o login. */
router.get('/bootstrap', auth.requireAuth, wrap(async (req, res) => {
  const guilds = await store.listGuildsOfUser(req.user.id);
  const fullGuilds = [];
  for (const g of guilds) {
    fullGuilds.push({
      ...g,
      channels: await store.listChannels(g.id),
      members: await store.listMembers(g.id),
      settings: await store.getSettings(g.id),
      myRole: (await store.getMember(g.id, req.user.id))?.role ?? 'member'
    });
  }
  const botUser = await store.getUser(botModule.BOT_ID);
  await botModule.ensureWelcomeDM(req.user.id);
  res.json({
    user: store.publicUser(req.user),
    guilds: fullGuilds,
    dms: await store.listDMs(req.user.id),
    friends: await store.listFriends(req.user.id),
    unread: await store.unreadCounts(req.user.id),
    bot: {
      user: store.publicUser(botUser),
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

router.post('/guilds', auth.requireAuth, rl.limit(rl.presets.guild), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2 || name.length > 40) throw new Error('O nome do servidor precisa ter de 2 a 40 caracteres');
  const guild = await store.createGuild({ name, ownerId: req.user.id });
  res.json({
    guild: {
      ...store.guildPayload(guild),
      channels: await store.listChannels(guild.id),
      members: await store.listMembers(guild.id),
      settings: await store.getSettings(guild.id),
      myRole: 'owner'
    }
  });
}));

router.post('/guilds/join', auth.requireAuth, wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  const guild = await store.getGuildByInvite(code);
  if (!guild) throw new Error('Convite invalido ou expirado');
  if (await store.isBanned(guild.id, req.user.id)) throw new Error('Voce esta banido deste servidor');
  if (await store.getMember(guild.id, req.user.id)) throw new Error('Voce ja esta neste servidor');
  const orgDomain = (await store.getSettings(guild.id)).org_domain;
  if (orgDomain && !(await store.domainMatches(guild.id, req.user))) {
    throw new Error(`Esse servidor é restrito a e-mails @${orgDomain}`);
  }

  await store.addMember(guild.id, req.user.id);
  await store.logAudit(guild.id, req.user.id, 'member_joined_invite');
  req.app.locals.onMemberJoin?.(guild.id, req.user.id);

  res.json({
    guild: {
      ...store.guildPayload(guild),
      channels: await store.listChannels(guild.id),
      members: await store.listMembers(guild.id),
      settings: await store.getSettings(guild.id),
      myRole: 'member'
    }
  });
}));

/** Convite direto: adiciona um amigo já existente ao servidor, sem precisar de código. */
/** Manda um convite pro amigo aceitar ou nao -- nao entra sozinho no servidor. */
router.post('/guilds/:id/invite-friend', auth.requireAuth, wrap(async (req, res) => {
  const guild = await store.getGuild(req.params.id);
  if (!guild || !(await store.getMember(guild.id, req.user.id))) throw new Error('Sem acesso a este servidor');

  const friendId = String(req.body?.userId || '');
  if (!(await store.areFriends(req.user.id, friendId))) throw new Error('Só dá pra convidar quem já é seu amigo');
  if (await store.isBanned(guild.id, friendId)) throw new Error('Essa pessoa está banida deste servidor');
  if (await store.getMember(guild.id, friendId)) throw new Error('Essa pessoa já está no servidor');
  const orgDomain = (await store.getSettings(guild.id)).org_domain;
  if (orgDomain) {
    const friendUser = await store.getUser(friendId);
    if (!(await store.domainMatches(guild.id, friendUser))) {
      throw new Error(`Esse servidor é restrito a e-mails @${orgDomain}`);
    }
  }

  const dmChannel = await store.getOrCreateDM(req.user.id, friendId);
  const message = await botModule.say(dmChannel.id, '', {
    color: botModule.COLORS.brand,
    title: '🎟️ Convite para servidor',
    description: `**${req.user.username}** te convidou para entrar em **${guild.name}**.`,
    guildInvite: { guildId: guild.id, guildName: guild.name, status: 'pending' }
  });
  req.app.locals.registerDM?.(dmChannel.id, [req.user.id, friendId]);

  res.json({ ok: true, message });
}));

/** Aceita ou recusa um convite de servidor recebido por DM. */
router.post('/messages/:id/guild-invite', auth.requireAuth, wrap(async (req, res) => {
  const message = await store.getMessage(req.params.id);
  const embed = message?.embed ? JSON.parse(message.embed) : null;
  if (!embed?.guildInvite) throw new Error('Convite não encontrado');
  if (embed.guildInvite.status !== 'pending') throw new Error('Esse convite já foi respondido');

  const channel = await store.getChannel(message.channel_id);
  if (!channel || channel.type !== 'dm') throw new Error('Convite inválido');
  const participants = await store.dmParticipants(channel.id);
  if (!participants.includes(req.user.id) || req.user.id === message.author_id) {
    throw new Error('Você não pode responder esse convite');
  }

  const accept = !!req.body?.accept;
  const guildId = embed.guildInvite.guildId;
  let fullGuild = null;

  if (accept) {
    const guild = await store.getGuild(guildId);
    if (!guild) throw new Error('Esse servidor não existe mais');
    if (await store.isBanned(guildId, req.user.id)) throw new Error('Você está banido deste servidor');
    if (!(await store.getMember(guildId, req.user.id))) {
      await store.addMember(guildId, req.user.id);
      await store.logAudit(guildId, message.author_id, 'member_invited', req.user.id);
      req.app.locals.onMemberJoin?.(guildId, req.user.id);
    }
    fullGuild = {
      ...store.guildPayload(guild),
      channels: await store.listChannels(guildId),
      members: await store.listMembers(guildId),
      settings: await store.getSettings(guildId),
      myRole: (await store.getMember(guildId, req.user.id))?.role ?? 'member'
    };
  }

  const updated = await store.setMessageEmbed(message.id, {
    ...embed, guildInvite: { ...embed.guildInvite, status: accept ? 'accepted' : 'declined' }
  });
  req.app.locals.broadcastMessageUpdate?.(updated);

  res.json({ ok: true, message: updated, guild: fullGuild });
}));

/** Auto-cadastro por e-mail corporativo verificado: sem convite, sem código. */
router.post('/guilds/:id/join-by-domain', auth.requireAuth, wrap(async (req, res) => {
  const guild = await store.getGuild(req.params.id);
  if (!guild) throw new Error('Servidor nao encontrado');
  if (await store.isBanned(guild.id, req.user.id)) throw new Error('Voce esta banido deste servidor');
  if (await store.getMember(guild.id, req.user.id)) throw new Error('Voce ja esta neste servidor');
  if (!(await store.domainMatches(guild.id, req.user))) {
    throw new Error('Seu e-mail precisa ser desse domínio e estar verificado pra entrar sozinho.');
  }

  await store.addMember(guild.id, req.user.id);
  await store.logAudit(guild.id, req.user.id, 'member_joined_domain');
  req.app.locals.onMemberJoin?.(guild.id, req.user.id);

  res.json({
    guild: {
      ...store.guildPayload(guild),
      channels: await store.listChannels(guild.id),
      members: await store.listMembers(guild.id),
      settings: await store.getSettings(guild.id),
      myRole: 'member'
    }
  });
}));

router.delete('/guilds/:id/leave', auth.requireAuth, wrap(async (req, res) => {
  const guild = await store.getGuild(req.params.id);
  if (!guild) throw new Error('Servidor nao encontrado');
  if (guild.owner_id === req.user.id) throw new Error('O dono nao pode sair. Exclua o servidor.');
  await store.removeMember(guild.id, req.user.id);
  req.app.locals.onMemberLeave?.(guild.id, req.user.id, req.user.username);
  res.json({ ok: true });
}));

router.delete('/guilds/:id', auth.requireAuth, wrap(async (req, res) => {
  const guild = await store.getGuild(req.params.id);
  if (!guild) throw new Error('Servidor nao encontrado');
  if (guild.owner_id !== req.user.id) throw new Error('Apenas o dono pode excluir o servidor');
  await store.deleteGuild(guild.id);
  req.app.locals.broadcastGuildDeleted?.(guild.id);
  res.json({ ok: true });
}));

router.get('/guilds/:id/members', auth.requireAuth, wrap(async (req, res) => {
  if (!(await store.getMember(req.params.id, req.user.id))) throw new Error('Voce nao e membro deste servidor');
  res.json({ members: await store.listMembers(req.params.id) });
}));

router.patch('/guilds/:id/settings', auth.requireAuth, wrap(async (req, res) => {
  if ((await store.rank(req.params.id, req.user.id)) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  const settings = await store.updateSettings(req.params.id, req.body || {});
  await store.logAudit(req.params.id, req.user.id, 'settings_update', null, { keys: Object.keys(req.body || {}) });
  req.app.locals.broadcastSettings?.(req.params.id, settings);
  res.json({ settings });
}));

/** Foto/cor do servidor. */
router.patch('/guilds/:id/icon', auth.requireAuth, wrap(async (req, res) => {
  const guild = await store.getGuild(req.params.id);
  if (!guild) throw new Error('Servidor não encontrado');
  if ((await store.rank(guild.id, req.user.id)) < store.ROLE_RANK.admin) throw new Error('Sem permissao');

  const { iconColor, iconUrl } = req.body || {};
  let nextIconUrl;
  if (iconUrl !== undefined) {
    if (iconUrl === null) {
      nextIconUrl = null; // remove a foto, volta pro icone de cor
    } else if (typeof iconUrl === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(iconUrl)) {
      if (iconUrl.length > 900_000) throw new Error('Imagem muito grande. Escolha uma foto menor.');
      nextIconUrl = iconUrl;
    } else {
      throw new Error('Formato de imagem invalido');
    }
  }

  const updated = await store.updateGuildIcon(guild.id, { iconColor, iconUrl: nextIconUrl });
  const payload = store.guildPayload(updated);
  req.app.locals.broadcastGuildInfo?.(guild.id, { name: payload.name, iconColor: payload.iconColor, iconUrl: payload.iconUrl });
  res.json({ guild: payload });
}));

/** Log de auditoria: quem fez o que, quando. So admin/dono ve. */
router.get('/guilds/:id/audit-log', auth.requireAuth, wrap(async (req, res) => {
  if ((await store.rank(req.params.id, req.user.id)) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  const entries = await store.listAuditLog(req.params.id, {
    before: req.query.before ? Number(req.query.before) : null,
    limit: Math.min(parseInt(req.query.limit, 10) || 50, 100)
  });
  res.json({ entries });
}));

/* --------------------------------------------------------------- channels */

router.post('/guilds/:id/channels', auth.requireAuth, wrap(async (req, res) => {
  if ((await store.rank(req.params.id, req.user.id)) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  const name = String(req.body?.name || '').trim();
  const type = req.body?.type === 'voice' ? 'voice' : 'text';
  if (!name) throw new Error('Informe o nome do canal');
  const channel = await store.createChannel({
    guildId: req.params.id,
    name: type === 'text' ? name.toLowerCase().replace(/\s+/g, '-').slice(0, 32) : name.slice(0, 32),
    type,
    topic: req.body?.topic || null
  });
  req.app.locals.broadcastChannels?.(req.params.id);
  res.json({ channel: store.channelPayload(channel) });
}));

router.delete('/channels/:id', auth.requireAuth, wrap(async (req, res) => {
  const channel = await store.getChannel(req.params.id);
  if (!channel || !channel.guild_id) throw new Error('Canal nao encontrado');
  if ((await store.rank(channel.guild_id, req.user.id)) < store.ROLE_RANK.admin) throw new Error('Sem permissao');
  await store.deleteChannel(channel.id);
  await store.logAudit(channel.guild_id, req.user.id, 'channel_deleted', null, { name: channel.name });
  req.app.locals.broadcastChannels?.(channel.guild_id);
  res.json({ ok: true });
}));

router.get('/channels/:id/messages', auth.requireAuth, wrap(async (req, res) => {
  const channel = await store.getChannel(req.params.id);
  if (!(await store.canAccess(req.user.id, channel))) throw new Error('Sem acesso a este canal');
  const messages = await store.listMessages(channel.id, {
    before: req.query.before || null,
    limit: Math.min(parseInt(req.query.limit, 10) || 50, 100)
  });
  await store.markRead(req.user.id, channel.id);
  res.json({ messages });
}));

/* -------------------------------------------------------------------- dms */

router.post('/dms', auth.requireAuth, rl.limit(rl.presets.dm), wrap(async (req, res) => {
  const otherId = String(req.body?.userId || '');
  const other = await store.getUser(otherId);
  if (!other) throw new Error('Usuario nao encontrado');
  if (await store.isBlocked(otherId, req.user.id)) throw new Error('Nao e possivel abrir conversa com este usuario');
  const channel = await store.getOrCreateDM(req.user.id, otherId);
  req.app.locals.registerDM?.(channel.id, [req.user.id, otherId]);
  res.json({
    channel: { ...store.channelPayload(channel), recipient: store.publicUser(other), lastMessageAt: Date.now() }
  });
}));

/* --------------------------------------------------------------- friends */

router.get('/friends', auth.requireAuth, wrap(async (req, res) => {
  res.json(await store.listFriends(req.user.id));
}));

router.post('/friends/request', auth.requireAuth, rl.limit(rl.presets.friend), wrap(async (req, res) => {
  const handle = String(req.body?.handle || '').trim();
  const target = (await store.getUserByHandle(handle)) || (await get('SELECT * FROM users WHERE lower(username) = lower(?) AND is_bot = 0', handle));
  if (!target) throw new Error('Usuario nao encontrado. Use nome#0000.');
  const friendship = await store.sendFriendRequest(req.user.id, target.id);
  req.app.locals.notifyFriends?.([req.user.id, target.id]);
  res.json({ ok: true, status: friendship.status, user: store.publicUser(target) });
}));

/** Cruza e-mails da agenda de contatos do celular com contas que já
 * existem no PlingChat -- "adicionar amigos dos contatos". */
router.post('/friends/match-contacts', auth.requireAuth, rl.limit(rl.presets.contacts), wrap(async (req, res) => {
  const emails = Array.isArray(req.body?.emails) ? req.body.emails.slice(0, 500) : [];
  const users = await store.findUsersByEmails(emails, req.user.id);
  res.json({ users });
}));

router.post('/friends/:id/respond', auth.requireAuth, wrap(async (req, res) => {
  const result = await store.respondFriendRequest(req.params.id, req.user.id, !!req.body?.accept);
  req.app.locals.notifyFriends?.([result.requester_id, result.addressee_id]);
  res.json({ ok: true });
}));

router.delete('/friends/:userId', auth.requireAuth, wrap(async (req, res) => {
  await store.removeFriend(req.user.id, req.params.userId);
  req.app.locals.notifyFriends?.([req.user.id, req.params.userId]);
  res.json({ ok: true });
}));

router.post('/friends/:userId/block', auth.requireAuth, wrap(async (req, res) => {
  await store.blockUser(req.user.id, req.params.userId);
  req.app.locals.notifyFriends?.([req.user.id, req.params.userId]);
  res.json({ ok: true });
}));

router.delete('/friends/:userId/block', auth.requireAuth, wrap(async (req, res) => {
  await store.unblockUser(req.user.id, req.params.userId);
  req.app.locals.notifyFriends?.([req.user.id]);
  res.json({ ok: true });
}));

router.get('/users/search', auth.requireAuth, wrap(async (req, res) => {
  const results = await store.searchUsers(String(req.query.q || ''), 15);
  res.json({ users: results.filter((u) => u.id !== req.user.id) });
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
  if ((await store.rank(guildId, req.user.id)) < store.ROLE_RANK.admin) throw new Error('Apenas admins podem gerenciar o bot');
  const enable = req.body?.enable !== false;

  if (enable) {
    await store.addMember(guildId, botModule.BOT_ID, 'mod');
    const channels = await store.listChannels(guildId);
    const general = channels.find((c) => c.type === 'text');
    if (general) {
      botModule.say(general.id, '', {
        color: botModule.COLORS.brand,
        title: '🤖 Nexy entrou no servidor!',
        description: 'Obrigado por me adicionar. Digite `!ajuda` para ver tudo que eu sei fazer — moderacao, economia, niveis, musica e muito mais.'
      });
    }
  } else {
    await store.removeMember(guildId, botModule.BOT_ID);
  }
  req.app.locals.broadcastMembers?.(guildId);
  res.json({ ok: true, enabled: enable, members: await store.listMembers(guildId) });
}));

module.exports = router;
