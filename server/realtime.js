'use strict';

const { Server } = require('socket.io');
const store = require('./store');
const auth = require('./auth');
const botModule = require('./bot');

const guildRoom = (id) => `guild:${id}`;
const channelRoom = (id) => `channel:${id}`;
const userRoom = (id) => `user:${id}`;
const voiceRoom = (id) => `voice:${id}`;

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

  const emitToChannel = (channelId, event, payload) => io.to(channelRoom(channelId)).emit(event, payload);

  /** Todos os sockets que devem receber eventos de um canal (guild ou DM). */
  function channelAudience(channel) {
    if (!channel) return [];
    if (channel.type === 'dm') return store.dmParticipants(channel.id).map(userRoom);
    return [guildRoom(channel.guild_id)];
  }

  function deliverMessage(payload) {
    // Marcadores especiais emitidos pelo bot
    if (payload?.__deleted) {
      const channel = store.getChannel(payload.channelId);
      for (const room of channelAudience(channel)) {
        io.to(room).emit('message:delete', { id: payload.id, channelId: payload.channelId });
      }
      return;
    }
    if (payload?.__memberRemoved) {
      io.to(guildRoom(payload.guildId)).emit('guild:members', {
        guildId: payload.guildId, members: store.listMembers(payload.guildId)
      });
      io.to(userRoom(payload.userId)).emit('guild:removed', { guildId: payload.guildId });
      return;
    }
    if (payload?.__memberUpdated) {
      io.to(guildRoom(payload.guildId)).emit('guild:members', {
        guildId: payload.guildId, members: store.listMembers(payload.guildId)
      });
      return;
    }
    if (payload?.__settingsUpdated) {
      io.to(guildRoom(payload.guildId)).emit('guild:settings', {
        guildId: payload.guildId, settings: store.getSettings(payload.guildId)
      });
      return;
    }
    if (payload?.__music) {
      io.to(guildRoom(payload.guildId)).emit('music:state', { guildId: payload.guildId, ...payload.payload });
      return;
    }

    const channel = store.getChannel(payload.channelId);
    for (const room of channelAudience(channel)) io.to(room).emit('message:new', payload);
  }

  botModule.initBot({ deliver: deliverMessage });

  /* ----------------------------------------------------- hooks para o REST */

  app.locals.onMemberJoin = (guildId, userId) => {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.userId === userId) s.join(guildRoom(guildId));
    }
    io.to(guildRoom(guildId)).emit('guild:members', { guildId, members: store.listMembers(guildId) });
    botModule.onMemberJoin(guildId, userId);
  };

  app.locals.onMemberLeave = (guildId, userId, username) => {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.userId === userId) s.leave(guildRoom(guildId));
    }
    io.to(guildRoom(guildId)).emit('guild:members', { guildId, members: store.listMembers(guildId) });
    botModule.onMemberLeave(guildId, userId, username);
  };

  app.locals.broadcastChannels = (guildId) =>
    io.to(guildRoom(guildId)).emit('guild:channels', { guildId, channels: store.listChannels(guildId) });

  app.locals.broadcastMembers = (guildId) =>
    io.to(guildRoom(guildId)).emit('guild:members', { guildId, members: store.listMembers(guildId) });

  app.locals.broadcastSettings = (guildId, settings) =>
    io.to(guildRoom(guildId)).emit('guild:settings', { guildId, settings });

  app.locals.broadcastGuildDeleted = (guildId) =>
    io.to(guildRoom(guildId)).emit('guild:removed', { guildId });

  app.locals.notifyFriends = (userIds) => {
    for (const id of userIds) io.to(userRoom(id)).emit('friends:update', store.listFriends(id));
  };

  app.locals.registerDM = (channelId, userIds) => {
    for (const s of io.sockets.sockets.values()) {
      if (userIds.includes(s.data.userId)) {
        s.join(channelRoom(channelId));
        s.emit('dm:new', {
          channel: {
            ...store.channelPayload(store.getChannel(channelId)),
            recipient: store.publicUser(store.getUser(userIds.find((u) => u !== s.data.userId))),
            lastMessageAt: Date.now()
          }
        });
      }
    }
  };

  /* ------------------------------------------------------------ handshake */

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const userId = token && auth.verifyToken(token);
    if (!userId) return next(new Error('Nao autenticado'));
    const user = store.getUser(userId);
    if (!user) return next(new Error('Sessao invalida'));
    socket.data.userId = userId;
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    socket.join(userRoom(userId));
    for (const g of store.listGuildsOfUser(userId)) socket.join(guildRoom(g.id));
    for (const dm of store.listDMs(userId)) socket.join(channelRoom(dm.id));

    store.setStatus(userId, 'online');
    broadcastPresence(userId, 'online');

    /* ------------------------------------------------------------ mensagens */

    socket.on('message:send', async ({ channelId, content, replyTo } = {}, ack) => {
      try {
        const channel = store.getChannel(channelId);
        if (!store.canAccess(userId, channel)) throw new Error('Sem acesso a este canal');

        const text = String(content || '').slice(0, 4000).trim();
        if (!text) throw new Error('Mensagem vazia');

        if (channel.guild_id) {
          const member = store.getMember(channel.guild_id, userId);
          if (member?.muted_until > Date.now()) {
            throw new Error(`Voce esta silenciado ate ${new Date(member.muted_until).toLocaleTimeString('pt-BR')}`);
          }
        }
        if (channel.type === 'dm') {
          const other = store.dmParticipants(channel.id).find((id) => id !== userId);
          if (other && store.isBlocked(other, userId)) throw new Error('Voce nao pode enviar mensagens para este usuario');
        }

        const message = store.createMessage({ channelId, authorId: userId, content: text, replyTo: replyTo || null });
        deliverMessage(message);
        ack?.({ ok: true, message });

        await botModule.handleMessage(message);
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('message:edit', ({ id, content } = {}, ack) => {
      const row = store.getMessage(id);
      if (!row || row.author_id !== userId) return ack?.({ ok: false, error: 'Sem permissao' });
      const message = store.editMessage(id, String(content || '').slice(0, 4000));
      const channel = store.getChannel(row.channel_id);
      for (const room of channelAudience(channel)) io.to(room).emit('message:update', message);
      ack?.({ ok: true, message });
    });

    socket.on('message:delete', ({ id } = {}, ack) => {
      const row = store.getMessage(id);
      if (!row) return ack?.({ ok: false, error: 'Mensagem nao encontrada' });
      const channel = store.getChannel(row.channel_id);
      const isMod = channel.guild_id && store.rank(channel.guild_id, userId) >= store.ROLE_RANK.mod;
      if (row.author_id !== userId && !isMod) return ack?.({ ok: false, error: 'Sem permissao' });
      store.deleteMessage(id);
      for (const room of channelAudience(channel)) io.to(room).emit('message:delete', { id, channelId: channel.id });
      ack?.({ ok: true });
    });

    socket.on('message:react', ({ id, emoji } = {}, ack) => {
      const row = store.getMessage(id);
      if (!row) return ack?.({ ok: false });
      const message = store.toggleReaction(id, userId, String(emoji).slice(0, 8));
      const channel = store.getChannel(row.channel_id);
      for (const room of channelAudience(channel)) io.to(room).emit('message:update', message);
      ack?.({ ok: true });
    });

    socket.on('typing', ({ channelId } = {}) => {
      const channel = store.getChannel(channelId);
      if (!store.canAccess(userId, channel)) return;
      for (const room of channelAudience(channel)) {
        io.to(room).emit('typing', { channelId, user: store.publicUser(socket.data.user) });
      }
    });

    socket.on('channel:read', ({ channelId } = {}) => {
      if (channelId) store.markRead(userId, channelId);
    });

    socket.on('presence:update', ({ status } = {}) => {
      const valid = ['online', 'idle', 'dnd', 'invisible'];
      if (!valid.includes(status)) return;
      store.setStatus(userId, status);
      broadcastPresence(userId, status);
    });

    /* ------------------------------------------------------------- voz/video */

    socket.on('voice:join', ({ channelId, state } = {}, ack) => {
      try {
        const channel = store.getChannel(channelId);
        if (!store.canAccess(userId, channel)) throw new Error('Sem acesso a este canal');

        leaveAllVoice(socket, { silent: true });

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

    socket.on('call:start', ({ channelId, video } = {}, ack) => {
      const channel = store.getChannel(channelId);
      if (!store.canAccess(userId, channel) || channel.type !== 'dm') return ack?.({ ok: false, error: 'Canal invalido' });
      const other = store.dmParticipants(channelId).find((id) => id !== userId);
      io.to(userRoom(other)).emit('call:incoming', {
        channelId,
        video: !!video,
        from: store.publicUser(socket.data.user)
      });
      ack?.({ ok: true });
    });

    socket.on('call:decline', ({ channelId } = {}) => {
      const other = store.dmParticipants(channelId).find((id) => id !== userId);
      io.to(userRoom(other)).emit('call:declined', { channelId, by: store.publicUser(socket.data.user) });
    });

    socket.on('call:cancel', ({ channelId } = {}) => {
      const other = store.dmParticipants(channelId).find((id) => id !== userId);
      io.to(userRoom(other)).emit('call:cancelled', { channelId });
    });

    /* ---------------------------------------------------------- desconexao */

    socket.on('disconnect', () => {
      leaveAllVoice(socket);
      const stillOnline = [...io.sockets.sockets.values()].some(
        (s) => s.id !== socket.id && s.data.userId === userId
      );
      if (!stillOnline) {
        store.setStatus(userId, 'offline');
        broadcastPresence(userId, 'offline');
      }
    });
  });

  /* --------------------------------------------------------------- helpers */

  function leaveAllVoice(socket, { silent = false } = {}) {
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

  function broadcastVoiceState(channelId) {
    const channel = store.getChannel(channelId);
    const payload = { channelId, members: voiceMembers(channelId) };
    if (!channel) return io.emit('voice:members', payload);
    if (channel.type === 'dm') {
      for (const id of store.dmParticipants(channelId)) io.to(userRoom(id)).emit('voice:members', payload);
    } else {
      io.to(guildRoom(channel.guild_id)).emit('voice:members', payload);
    }
  }

  function broadcastPresence(userId, status) {
    const user = store.publicUser(store.getUser(userId));
    if (!user) return;
    const payload = { userId, status, user };
    for (const g of store.listGuildsOfUser(userId)) io.to(guildRoom(g.id)).emit('presence', payload);
    const { friends } = store.listFriends(userId);
    for (const f of friends) io.to(userRoom(f.id)).emit('presence', payload);
    io.to(userRoom(userId)).emit('presence', payload);
  }

  return io;
}

module.exports = { attachRealtime, voiceMembers };
