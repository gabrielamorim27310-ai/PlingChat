'use strict';

const { Server } = require('socket.io');
const store = require('./store');
const auth = require('./auth');
const botModule = require('./bot');
const push = require('./push');

const guildRoom = (id) => `guild:${id}`;
const channelRoom = (id) => `channel:${id}`;
const userRoom = (id) => `user:${id}`;
const voiceRoom = (id) => `voice:${id}`;

/** @usuario dentro do texto cita essa pessoa? (mesma regra do highlight no front) */
function mentions(content, username) {
  if (!content || !username) return false;
  const name = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${name}\\b`, 'i').test(content);
}

/** Estado de voz em memoria: channelId -> Map<userId, { socketId, state, user }>. */
const voiceState = new Map();

function voiceMembers(channelId) {
  const room = voiceState.get(channelId);
  if (!room) return [];
  return [...room.values()].map((v) => ({ user: v.user, state: v.state }));
}

function attachRealtime(server, app, { originAllowed = () => true } = {}) {
  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => callback(null, originAllowed(origin)),
      credentials: true
    },
    maxHttpBufferSize: 2e6
  });

  /* ------------------------------------------------------- helpers de envio */

  /** Todos os sockets que devem receber eventos de um canal (guild ou DM). */
  async function channelAudience(channel) {
    if (!channel) return [];
    if (channel.type === 'dm') return (await store.dmParticipants(channel.id)).map(userRoom);
    return [guildRoom(channel.guild_id)];
  }

  /** Tem alguma aba/socket dessa pessoa conectada agora? */
  const isOnline = (userId) => (io.sockets.adapter.rooms.get(userRoom(userId))?.size || 0) > 0;

  /**
   * Push so pra quem esta offline (senao a pessoa ja viu pelo socket) e so
   * quando faz sentido interromper: toda DM, ou quando foi citado num canal
   * de servidor. Nunca deixa a falha de push derrubar o resto do fluxo.
   */
  async function notifyOffline(channel, message) {
    if (!push.isEnabled() || !channel) return;
    let targets = [];
    if (channel.type === 'dm') {
      targets = (await store.dmParticipants(channel.id)).filter((id) => id !== message.author.id);
    } else if (channel.guild_id) {
      const members = await store.listMembers(channel.guild_id);
      targets = members
        .filter((m) => m.id !== message.author.id && mentions(message.content, m.username))
        .map((m) => m.id);
    }
    const title = channel.type === 'dm' ? message.author.username : `${message.author.username} em #${channel.name}`;
    for (const userId of targets) {
      if (isOnline(userId)) continue;
      push.notify(userId, {
        title,
        body: (message.content || '').slice(0, 140),
        tag: channel.id,
        url: `/?canal=${channel.id}`
      }).catch(() => {});
    }
  }

  async function deliverMessage(payload) {
    try {
      // Marcadores especiais emitidos pelo bot
      if (payload?.__deleted) {
        const channel = await store.getChannel(payload.channelId);
        for (const room of await channelAudience(channel)) {
          io.to(room).emit('message:delete', { id: payload.id, channelId: payload.channelId });
        }
        return;
      }
      if (payload?.__memberRemoved) {
        io.to(guildRoom(payload.guildId)).emit('guild:members', {
          guildId: payload.guildId, members: await store.listMembers(payload.guildId)
        });
        io.to(userRoom(payload.userId)).emit('guild:removed', { guildId: payload.guildId });
        return;
      }
      if (payload?.__memberUpdated) {
        io.to(guildRoom(payload.guildId)).emit('guild:members', {
          guildId: payload.guildId, members: await store.listMembers(payload.guildId)
        });
        return;
      }
      if (payload?.__settingsUpdated) {
        io.to(guildRoom(payload.guildId)).emit('guild:settings', {
          guildId: payload.guildId, settings: await store.getSettings(payload.guildId)
        });
        return;
      }
      if (payload?.__music) {
        io.to(guildRoom(payload.guildId)).emit('music:state', { guildId: payload.guildId, ...payload.payload });
        return;
      }

      const channel = await store.getChannel(payload.channelId);
      for (const room of await channelAudience(channel)) io.to(room).emit('message:new', payload);
      await notifyOffline(channel, payload);
    } catch (err) {
      console.warn('deliverMessage: falha', err.message);
    }
  }

  botModule.initBot({ deliver: deliverMessage }).catch((err) => console.error('bot: falha ao iniciar', err));

  /* ----------------------------------------------------- hooks para o REST */

  app.locals.onMemberJoin = async (guildId, userId) => {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.userId === userId) s.join(guildRoom(guildId));
    }
    io.to(guildRoom(guildId)).emit('guild:members', { guildId, members: await store.listMembers(guildId) });
    await botModule.onMemberJoin(guildId, userId);
  };

  app.locals.onMemberLeave = async (guildId, userId, username) => {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.userId === userId) s.leave(guildRoom(guildId));
    }
    io.to(guildRoom(guildId)).emit('guild:members', { guildId, members: await store.listMembers(guildId) });
    await botModule.onMemberLeave(guildId, userId, username);
  };

  app.locals.broadcastChannels = async (guildId) =>
    io.to(guildRoom(guildId)).emit('guild:channels', { guildId, channels: await store.listChannels(guildId) });

  app.locals.broadcastMembers = async (guildId) =>
    io.to(guildRoom(guildId)).emit('guild:members', { guildId, members: await store.listMembers(guildId) });

  app.locals.broadcastSettings = (guildId, settings) =>
    io.to(guildRoom(guildId)).emit('guild:settings', { guildId, settings });

  app.locals.broadcastGuildDeleted = (guildId) =>
    io.to(guildRoom(guildId)).emit('guild:removed', { guildId });

  app.locals.broadcastGuildInfo = (guildId, patch) =>
    io.to(guildRoom(guildId)).emit('guild:info', { guildId, ...patch });

  app.locals.notifyFriends = async (userIds) => {
    for (const id of userIds) io.to(userRoom(id)).emit('friends:update', await store.listFriends(id));
  };

  /** Reavisa amigos, servidores em comum e as outras abas/dispositivos da
   * própria pessoa quando o perfil dela muda (nome, foto, cor, bio...) --
   * reaproveita o mesmo evento "presence", que já manda o user inteiro. */
  app.locals.broadcastProfileUpdate = async (userId) => {
    const user = await store.getUser(userId);
    if (user) await broadcastPresence(userId, user.status);
  };

  /** Reavisa quem estiver vendo o canal que uma mensagem mudou (ex: embed de convite resolvido). */
  app.locals.broadcastMessageUpdate = async (message) => {
    const channel = await store.getChannel(message.channelId);
    for (const room of await channelAudience(channel)) io.to(room).emit('message:update', message);
  };

  app.locals.registerDM = async (channelId, userIds) => {
    const channel = await store.getChannel(channelId);
    for (const s of io.sockets.sockets.values()) {
      if (userIds.includes(s.data.userId)) {
        s.join(channelRoom(channelId));
        const otherId = userIds.find((u) => u !== s.data.userId);
        s.emit('dm:new', {
          channel: {
            ...store.channelPayload(channel),
            recipient: store.publicUser(await store.getUser(otherId)),
            lastMessageAt: Date.now()
          }
        });
      }
    }
  };

  /* ------------------------------------------------------------ handshake */

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const userId = token && auth.verifyToken(token);
      if (!userId) return next(new Error('Nao autenticado'));
      const user = await store.getUser(userId);
      if (!user) return next(new Error('Sessao invalida'));
      socket.data.userId = userId;
      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error('Falha de autenticacao'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId;

    socket.join(userRoom(userId));
    for (const g of await store.listGuildsOfUser(userId)) socket.join(guildRoom(g.id));
    for (const dm of await store.listDMs(userId)) socket.join(channelRoom(dm.id));

    await store.setStatus(userId, 'online');
    broadcastPresence(userId, 'online');

    /* ------------------------------------------------------------ mensagens */

    socket.on('message:send', async ({ channelId, content, replyTo } = {}, ack) => {
      try {
        const channel = await store.getChannel(channelId);
        if (!(await store.canAccess(userId, channel))) throw new Error('Sem acesso a este canal');

        const text = String(content || '').slice(0, 4000).trim();
        if (!text) throw new Error('Mensagem vazia');

        if (channel.guild_id) {
          const member = await store.getMember(channel.guild_id, userId);
          if (member?.muted_until > Date.now()) {
            throw new Error(`Voce esta silenciado ate ${new Date(member.muted_until).toLocaleTimeString('pt-BR')}`);
          }
        }
        if (channel.type === 'dm') {
          const other = (await store.dmParticipants(channel.id)).find((id) => id !== userId);
          if (other && (await store.isBlocked(other, userId))) throw new Error('Voce nao pode enviar mensagens para este usuario');
        }

        const message = await store.createMessage({ channelId, authorId: userId, content: text, replyTo: replyTo || null });
        deliverMessage(message);
        ack?.({ ok: true, message });

        await botModule.handleMessage(message);
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('message:edit', async ({ id, content } = {}, ack) => {
      try {
        const row = await store.getMessage(id);
        if (!row || row.author_id !== userId) return ack?.({ ok: false, error: 'Sem permissao' });
        const message = await store.editMessage(id, String(content || '').slice(0, 4000));
        const channel = await store.getChannel(row.channel_id);
        for (const room of await channelAudience(channel)) io.to(room).emit('message:update', message);
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('message:delete', async ({ id } = {}, ack) => {
      try {
        const row = await store.getMessage(id);
        if (!row) return ack?.({ ok: false, error: 'Mensagem nao encontrada' });
        const channel = await store.getChannel(row.channel_id);
        const isMod = channel.guild_id && (await store.rank(channel.guild_id, userId)) >= store.ROLE_RANK.mod;
        if (row.author_id !== userId && !isMod) return ack?.({ ok: false, error: 'Sem permissao' });
        await store.deleteMessage(id);
        for (const room of await channelAudience(channel)) io.to(room).emit('message:delete', { id, channelId: channel.id });
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('message:react', async ({ id, emoji } = {}, ack) => {
      try {
        const row = await store.getMessage(id);
        if (!row) return ack?.({ ok: false });
        const message = await store.toggleReaction(id, userId, String(emoji).slice(0, 8));
        const channel = await store.getChannel(row.channel_id);
        for (const room of await channelAudience(channel)) io.to(room).emit('message:update', message);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('typing', async ({ channelId } = {}) => {
      const channel = await store.getChannel(channelId);
      if (!(await store.canAccess(userId, channel))) return;
      for (const room of await channelAudience(channel)) {
        io.to(room).emit('typing', { channelId, user: store.publicUser(socket.data.user) });
      }
    });

    socket.on('channel:read', async ({ channelId } = {}) => {
      if (!channelId) return;
      await store.markRead(userId, channelId);

      // Confirmação de leitura só em DM, e só se a própria pessoa deixa a
      // leitura visível (recíproco -- ver store.listDMs). Confere no banco
      // em vez de socket.data.user pra não usar um valor desatualizado se
      // ela mudou o ajuste sem reconectar.
      const channel = await store.getChannel(channelId);
      if (channel?.type !== 'dm') return;
      const me = await store.getUser(userId);
      if (!me?.share_read_receipts) return;
      for (const room of await channelAudience(channel)) {
        io.to(room).emit('dm:read', { channelId, userId, at: store.now() });
      }
    });

    socket.on('presence:update', async ({ status } = {}) => {
      const valid = ['online', 'idle', 'dnd', 'invisible'];
      if (!valid.includes(status)) return;
      await store.setStatus(userId, status);
      broadcastPresence(userId, status);
    });

    /* ------------------------------------------------------------- voz/video */

    socket.on('voice:join', async ({ channelId, state } = {}, ack) => {
      try {
        const channel = await store.getChannel(channelId);
        if (!(await store.canAccess(userId, channel))) throw new Error('Sem acesso a este canal');

        await leaveAllVoice(socket, { silent: true });

        if (!voiceState.has(channelId)) voiceState.set(channelId, new Map());
        const room = voiceState.get(channelId);
        const peers = [...room.values()].map((v) => ({ user: v.user, state: v.state, socketId: v.socketId }));

        const entry = {
          socketId: socket.id,
          user: store.publicUser(socket.data.user),
          state: { muted: false, deafened: false, video: false, screen: false, ...(state || {}) }
        };
        room.set(userId, entry);
        socket.data.voiceChannelId = channelId;
        socket.join(voiceRoom(channelId));

        socket.to(voiceRoom(channelId)).emit('voice:peer-joined', {
          channelId, socketId: socket.id, user: entry.user, state: entry.state
        });
        broadcastVoiceState(channelId);

        ack?.({ ok: true, peers, self: { socketId: socket.id, ...entry } });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('voice:leave', () => leaveAllVoice(socket));

    socket.on('voice:state', ({ state } = {}) => {
      const channelId = socket.data.voiceChannelId;
      if (!channelId) return;
      const room = voiceState.get(channelId);
      const entry = room?.get(userId);
      if (!entry) return;
      entry.state = { ...entry.state, ...state };
      io.to(voiceRoom(channelId)).emit('voice:peer-state', { channelId, socketId: socket.id, userId, state: entry.state });
      broadcastVoiceState(channelId);
    });

    /** Sinalizacao WebRTC ponto a ponto (offer/answer/ICE). */
    socket.on('webrtc:signal', ({ to, data } = {}) => {
      if (!to || !data) return;
      io.to(to).emit('webrtc:signal', { from: socket.id, userId, data });
    });

    /* ------------------------------------------------ chamadas diretas (DM) */

    socket.on('call:start', async ({ channelId, video } = {}, ack) => {
      const channel = await store.getChannel(channelId);
      if (!(await store.canAccess(userId, channel)) || channel.type !== 'dm') return ack?.({ ok: false, error: 'Canal invalido' });
      const other = (await store.dmParticipants(channelId)).find((id) => id !== userId);
      io.to(userRoom(other)).emit('call:incoming', {
        channelId,
        video: !!video,
        from: store.publicUser(socket.data.user)
      });
      // Sem isso, quem esta com o app fechado (nao so sem foco) nunca fica
      // sabendo que ligaram -- mensagem ja tinha isso, chamada nao tinha.
      if (push.isEnabled() && !isOnline(other)) {
        push.notify(other, {
          title: `${socket.data.user.username} está ligando`,
          body: video ? 'Chamada de vídeo' : 'Chamada de voz',
          tag: `call:${channelId}`,
          url: `/?canal=${channelId}`
        }).catch(() => {});
      }
      ack?.({ ok: true });
    });

    socket.on('call:decline', async ({ channelId } = {}) => {
      const other = (await store.dmParticipants(channelId)).find((id) => id !== userId);
      io.to(userRoom(other)).emit('call:declined', { channelId, by: store.publicUser(socket.data.user) });
    });

    socket.on('call:cancel', async ({ channelId } = {}) => {
      const other = (await store.dmParticipants(channelId)).find((id) => id !== userId);
      io.to(userRoom(other)).emit('call:cancelled', { channelId });
    });

    /* ---------------------------------------------------------- desconexao */

    socket.on('disconnect', async () => {
      await leaveAllVoice(socket);
      const stillOnline = [...io.sockets.sockets.values()].some(
        (s) => s.id !== socket.id && s.data.userId === userId
      );
      if (!stillOnline) {
        await store.setStatus(userId, 'offline');
        broadcastPresence(userId, 'offline');
      }
    });
  });

  /* --------------------------------------------------------------- helpers */

  async function leaveAllVoice(socket, { silent = false } = {}) {
    const userId = socket.data.userId;
    const channelId = socket.data.voiceChannelId;
    if (!channelId) return;
    const room = voiceState.get(channelId);
    if (room?.get(userId)?.socketId === socket.id) room.delete(userId);
    if (room && room.size === 0) voiceState.delete(channelId);
    socket.leave(voiceRoom(channelId));
    socket.data.voiceChannelId = null;
    if (!silent) {
      socket.to(voiceRoom(channelId)).emit('voice:peer-left', { channelId, socketId: socket.id, userId });
    }
    broadcastVoiceState(channelId);
  }

  async function broadcastVoiceState(channelId) {
    const channel = await store.getChannel(channelId);
    const payload = { channelId, members: voiceMembers(channelId) };
    if (!channel) return io.emit('voice:members', payload);
    if (channel.type === 'dm') {
      for (const id of await store.dmParticipants(channelId)) io.to(userRoom(id)).emit('voice:members', payload);
    } else {
      io.to(guildRoom(channel.guild_id)).emit('voice:members', payload);
    }
  }

  async function broadcastPresence(userId, status) {
    const user = store.publicUser(await store.getUser(userId));
    if (!user) return;
    const payload = { userId, status, user };
    for (const g of await store.listGuildsOfUser(userId)) io.to(guildRoom(g.id)).emit('presence', payload);
    const { friends } = await store.listFriends(userId);
    for (const f of friends) io.to(userRoom(f.id)).emit('presence', payload);
    io.to(userRoom(userId)).emit('presence', payload);
  }

  return io;
}

module.exports = { attachRealtime, voiceMembers };
