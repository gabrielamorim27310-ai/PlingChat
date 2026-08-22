import { api, token } from './api.js';
import { API_BASE } from './config.js';
import { $, el, avatarNode, renderMarkdown, formatTime, formatDay, dayKey, initials, debounce } from './util.js';
import { VoiceClient } from './voice.js';
import { openModal, closeModal, modals } from './modals.js';

/* ============================================================== estado === */

export const state = {
  me: null,
  guilds: [],
  dms: [],
  friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
  unread: {},
  botCommands: [],
  botUser: null,

  view: 'home',           // 'home' | 'guild'
  activeGuildId: null,
  activeChannelId: null,
  friendTab: 'online',

  messages: new Map(),    // channelId -> [message]
  typing: new Map(),      // channelId -> Map<userId, {user, ts}>
  voiceMembers: new Map(),// channelId -> [{user, state}]
  music: new Map(),       // guildId -> estado do player

  replyTo: null,
  stageCollapsed: false,
  pendingCall: null
};

export let socket = null;
export let voice = null;

export const guild = (id = state.activeGuildId) => state.guilds.find((g) => g.id === id);
export const channelById = (id) => {
  for (const g of state.guilds) {
    const found = g.channels.find((c) => c.id === id);
    if (found) return found;
  }
  return state.dms.find((d) => d.id === id) || null;
};

/* =============================================================== toast === */

export function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 250);
  }, 4200);
}

/* ============================================================== login ==== */

let authMode = 'login';

/** Configuração pública do servidor, carregada antes do login. */
export let appConfig = { googleClientId: null, turnstileSiteKey: null, signupMode: 'open', passwordResetEnabled: false };

const params = new URLSearchParams(location.search);

/** Remove um parâmetro da barra de endereços sem recarregar a página. */
function dropParam(name) {
  params.delete(name);
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
}

/* ------------------------------------------------------------ turnstile */

let turnstileLoaded = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  turnstileLoaded ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return turnstileLoaded;
}

const NO_CAPTCHA = { token: () => null, reset: () => {} };

/** Monta o widget num container e devolve como ler e resetar o token. */
async function mountTurnstile(selector) {
  if (!appConfig.turnstileSiteKey) return NO_CAPTCHA;

  await loadTurnstile();
  const box = $(selector);
  box.hidden = false;

  let token = null;
  const widgetId = window.turnstile.render(box, {
    sitekey: appConfig.turnstileSiteKey,
    theme: 'dark',
    language: 'pt-br',
    callback: (value) => { token = value; },
    'expired-callback': () => { token = null; },
    'error-callback': () => { token = null; }
  });

  return {
    token: () => token,
    reset: () => { token = null; window.turnstile.reset(widgetId); }
  };
}

/* ----------------------------------------------------------------- auth */

function setupAuth() {
  const form = $('#authForm');
  const forgotForm = $('#forgotForm');
  const resetForm = $('#resetForm');
  const error = $('#authError');
  const okBox = $('#authOk');

  let captcha = NO_CAPTCHA;

  const showError = (node, message) => {
    node.textContent = message;
    node.hidden = false;
  };

  /** Alterna entre os três formulários da tela de entrada. */
  function showForm(which) {
    form.hidden = which !== 'auth';
    forgotForm.hidden = which !== 'forgot';
    resetForm.hidden = which !== 'reset';
    $('#googleAuth').hidden = which !== 'auth' || !appConfig.googleClientId;
    $('.auth-switch').hidden = which !== 'auth';
    error.hidden = okBox.hidden = true;
  }

  function applyMode() {
    const isLogin = authMode === 'login';
    $('#fieldUsername').hidden = isLogin;
    $('#fieldUsername').querySelector('input').required = !isLogin;

    const needsInvite = !isLogin && appConfig.signupMode === 'invite';
    $('#fieldInvite').hidden = !needsInvite;
    $('#fieldInvite').querySelector('input').required = needsInvite;

    $('#authTitle').textContent = isLogin ? 'Que bom te ver de novo!' : 'Criar uma conta';
    $('#authSub').textContent = isLogin
      ? 'Entre para conversar, chamar e jogar com a galera.'
      : needsInvite
        ? 'O cadastro é por convite. Use o código que te enviaram.'
        : 'Leva menos de um minuto. Depois é só chamar a galera.';
    $('#authSubmit').textContent = isLogin ? 'Entrar' : 'Criar conta';
    $('#authSwitchText').textContent = isLogin ? 'Precisa de uma conta?' : 'Já tem conta?';
    $('#authSwitch').textContent = isLogin ? 'Registre-se' : 'Entrar';
    $('#authForgotWrap').hidden = !isLogin || !appConfig.passwordResetEnabled;
    form.password.autocomplete = isLogin ? 'current-password' : 'new-password';
    error.hidden = okBox.hidden = true;
  }

  $('#authSwitch').addEventListener('click', () => {
    authMode = authMode === 'login' ? 'register' : 'login';
    applyMode();
  });

  $('#authForgot').addEventListener('click', () => showForm('forgot'));
  $('#forgotBack').addEventListener('click', () => showForm('auth'));

  /* login e cadastro */
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = okBox.hidden = true;
    const button = $('#authSubmit');
    button.disabled = true;

    try {
      const body = {
        email: form.email.value,
        password: form.password.value,
        turnstileToken: captcha.token(),
        ...(authMode === 'register'
          ? { username: form.username.value, inviteCode: form.inviteCode?.value?.trim() || null }
          : {})
      };
      const data = await api.post(`/auth/${authMode}`, body);
      token.set(data.token);
      await start();
    } catch (err) {
      showError(error, err.message);
      captcha.reset();
      button.disabled = false;
    }
  });

  /* pedido de recuperação */
  forgotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#forgotError').hidden = $('#forgotOk').hidden = true;
    try {
      await api.post('/auth/forgot', {
        email: forgotForm.email.value,
        turnstileToken: captcha.token()
      });
      $('#forgotOk').textContent = 'Se existir uma conta com esse e-mail, o link de recuperação já está a caminho.';
      $('#forgotOk').hidden = false;
    } catch (err) {
      showError($('#forgotError'), err.message);
    }
  });

  /* nova senha vinda do link */
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#resetError').hidden = true;
    if (resetForm.password.value !== resetForm.confirm.value) {
      return showError($('#resetError'), 'As senhas não são iguais.');
    }
    try {
      const data = await api.post('/auth/reset', {
        token: params.get('redefinir'),
        password: resetForm.password.value
      });
      token.set(data.token);
      dropParam('redefinir');
      await start();
    } catch (err) {
      showError($('#resetError'), err.message);
    }
  });

  /* estado inicial da tela */
  (async () => {
    try {
      appConfig = await api.get('/config');
    } catch { /* servidor fora do ar; segue com o padrão */ }

    if (params.get('cadastro')) {
      authMode = 'register';
      $('#fieldInvite').querySelector('input').value = params.get('cadastro');
    }
    applyMode();

    if (params.get('verificar')) {
      try {
        await api.post('/auth/verify', { token: params.get('verificar') });
        okBox.textContent = 'E-mail confirmado! Pode entrar normalmente.';
        okBox.hidden = false;
      } catch (err) {
        showError(error, err.message);
      }
      dropParam('verificar');
    }

    if (params.get('redefinir')) {
      $('#authTitle').textContent = 'Criar uma nova senha';
      $('#authSub').textContent = 'Escolha uma senha nova para sua conta.';
      showForm('reset');
    }

    captcha = await mountTurnstile('#turnstileBox').catch(() => NO_CAPTCHA);
    setupGoogleAuth().catch(() => { /* SSO opcional */ });
  })();
}

/**
 * Login com Google. O botão só aparece se o backend tiver GOOGLE_CLIENT_ID
 * configurado — sem isso, o fluxo de e-mail e senha segue sozinho.
 */
async function setupGoogleAuth() {
  if (!appConfig.googleClientId) return;

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });

  google.accounts.id.initialize({
    client_id: appConfig.googleClientId,
    callback: async ({ credential }) => {
      const error = $('#authError');
      try {
        const data = await api.post('/auth/google', {
          credential,
          inviteCode: $('#fieldInvite').querySelector('input').value.trim() || null
        });
        token.set(data.token);
        await start();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    }
  });

  const holder = $('#googleAuth');
  holder.hidden = false;
  google.accounts.id.renderButton(holder.querySelector('#googleButton'), {
    theme: 'filled_black', size: 'large', width: 340, text: 'continue_with', locale: 'pt-BR'
  });
}

/** Convite de servidor (?convite=) e aviso de e-mail não confirmado. */
async function handleLaunchParams() {
  $('#verifyBanner').hidden = state.me.emailVerified || !state.me.hasEmail || !appConfig.passwordResetEnabled;
  dropParam('cadastro');

  const code = params.get('convite');
  if (!code) return;
  dropParam('convite');

  const existing = state.guilds.find((g) => g.inviteCode === code);
  if (existing) return openGuild(existing.id);

  try {
    const { guild } = await api.post('/guilds/join', { code });
    state.guilds.push(guild);
    renderRail();
    openGuild(guild.id);
    toast(`Você entrou em "${guild.name}"!`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

export function logout() {
  token.clear();
  socket?.disconnect();
  location.reload();
}

/* ============================================================== boot ===== */

async function start() {
  const data = await api.get('/bootstrap');
  state.me = data.user;
  state.guilds = data.guilds;
  state.dms = data.dms;
  state.friends = data.friends;
  state.unread = data.unread;
  state.botCommands = data.bot.commands;
  state.botUser = data.bot.user;

  $('#auth').hidden = true;
  $('#app').hidden = false;

  connectSocket();
  renderMe();
  renderRail();
  openHome();
  handleLaunchParams();
}

function connectSocket() {
  socket = io(API_BASE || undefined, { auth: { token: token.get() } });
  voice = new VoiceClient(socket);
  voice.onUpdate(() => { renderStage(); renderVoicePanel(); syncAudio(); });

  socket.on('connect_error', (err) => {
    if (/autenticad|sess/i.test(err.message)) logout();
  });

  socket.on('message:new', (message) => {
    const list = state.messages.get(message.channelId);
    if (list) {
      list.push(message);
      if (message.channelId === state.activeChannelId) renderMessages();
    }
    if (message.channelId !== state.activeChannelId && message.author.id !== state.me.id) {
      state.unread[message.channelId] = (state.unread[message.channelId] || 0) + 1;
      renderRail();
      renderSidebar();
      const channel = channelById(message.channelId);
      if (channel?.type === 'dm') toast(`💬 ${message.author.username}: ${message.content.slice(0, 60)}`);
    } else if (message.channelId === state.activeChannelId) {
      socket.emit('channel:read', { channelId: message.channelId });
    }
  });

  socket.on('message:update', (message) => {
    const list = state.messages.get(message.channelId);
    if (!list) return;
    const index = list.findIndex((m) => m.id === message.id);
    if (index >= 0) list[index] = message;
    if (message.channelId === state.activeChannelId) renderMessages();
  });

  socket.on('message:delete', ({ id, channelId }) => {
    const list = state.messages.get(channelId);
    if (list) state.messages.set(channelId, list.filter((m) => m.id !== id));
    if (channelId === state.activeChannelId) renderMessages();
  });

  socket.on('typing', ({ channelId, user }) => {
    if (user.id === state.me.id) return;
    if (!state.typing.has(channelId)) state.typing.set(channelId, new Map());
    state.typing.get(channelId).set(user.id, { user, ts: Date.now() });
    renderTyping();
  });

  socket.on('presence', ({ userId, status }) => {
    for (const g of state.guilds) {
      const member = g.members.find((m) => m.id === userId);
      if (member) member.status = status;
    }
    for (const dm of state.dms) if (dm.recipient?.id === userId) dm.recipient.status = status;
    for (const f of state.friends.friends) if (f.id === userId) f.status = status;
    renderMembers();
    if (state.view === 'home') { renderSidebar(); renderHome(); }
  });

  socket.on('guild:members', ({ guildId, members }) => {
    const g = guild(guildId);
    if (g) g.members = members;
    renderMembers();
    renderSidebar();
  });

  socket.on('guild:channels', ({ guildId, channels }) => {
    const g = guild(guildId);
    if (g) g.channels = channels;
    renderSidebar();
    if (state.activeChannelId && !channelById(state.activeChannelId)) openHome();
  });

  socket.on('guild:settings', ({ guildId, settings }) => {
    const g = guild(guildId);
    if (g) g.settings = settings;
  });

  socket.on('guild:removed', ({ guildId }) => {
    state.guilds = state.guilds.filter((g) => g.id !== guildId);
    renderRail();
    if (state.activeGuildId === guildId) openHome();
  });

  socket.on('dm:new', ({ channel }) => {
    if (!state.dms.some((d) => d.id === channel.id)) state.dms.unshift(channel);
    if (state.view === 'home') renderSidebar();
  });

  socket.on('friends:update', (friends) => {
    state.friends = friends;
    if (state.view === 'home') { renderSidebar(); renderHome(); }
  });

  socket.on('voice:members', ({ channelId, members }) => {
    state.voiceMembers.set(channelId, members);
    renderSidebar();
    renderStage();
  });

  socket.on('music:state', ({ guildId, ...payload }) => {
    state.music.set(guildId, payload);
    syncMusic();
  });

  socket.on('call:incoming', ({ channelId, video, from }) => {
    state.pendingCall = { channelId, video, from };
    showRing();
  });

  socket.on('call:declined', ({ by }) => toast(`${by.username} recusou a chamada.`, 'err'));
  socket.on('call:cancelled', () => { state.pendingCall = null; $('#ringOverlay').hidden = true; });

  setInterval(renderTyping, 1500);
}

/* ============================================================ perfil ==== */

function renderMe() {
  const avatar = avatarNode(state.me, { status: false });
  avatar.dataset.status = state.me.status === 'offline' ? 'online' : state.me.status;
  $('#meAvatar').replaceWith(Object.assign(avatar, { id: 'meAvatar' }));
  $('#meName').textContent = state.me.username;
  $('#meTag').textContent = `#${state.me.tag}`;
}

/* ============================================================== rail ==== */

function renderRail() {
  const container = $('#railGuilds');
  container.replaceChildren();

  for (const g of state.guilds) {
    const unread = g.channels.reduce((sum, c) => sum + (state.unread[c.id] || 0), 0);
    const button = el('button', {
      class: `rail-item ${state.activeGuildId === g.id ? 'active' : ''}`,
      title: g.name,
      style: state.activeGuildId === g.id ? '' : `background:${g.iconColor}`,
      onclick: () => openGuild(g.id)
    }, el('span', {}, initials(g.name)), el('span', { class: 'rail-pill' }));

    if (unread) button.append(el('span', { class: 'rail-badge' }, unread > 99 ? '99+' : unread));
    container.append(button);
  }

  const dmUnread = state.dms.reduce((sum, d) => sum + (state.unread[d.id] || 0), 0);
  const home = $('#railHome');
  home.classList.toggle('active', state.view === 'home');
  home.querySelector('.rail-badge')?.remove();
  if (dmUnread) home.append(el('span', { class: 'rail-badge' }, dmUnread));
}

/* =========================================================== sidebar ==== */

function renderSidebar() {
  const body = $('#sidebarBody');
  body.replaceChildren();

  if (state.view === 'home') {
    $('#sidebarTitle').textContent = 'Mensagens diretas';
    $('#guildMenuChevron').hidden = true;

    body.append(el('button', {
      class: `channel ${state.activeChannelId === null ? 'active' : ''}`,
      onclick: openHome
    }, el('span', { class: 'glyph' }, '👥'), el('span', { class: 'name' }, 'Amigos')));

    body.append(el('div', { class: 'side-section' },
      el('div', { class: 'side-label' },
        el('span', {}, 'Mensagens diretas'),
        el('button', { title: 'Nova conversa', onclick: () => openModal(modals.addFriend()) }, '+'))));

    for (const dm of state.dms) {
      const unread = state.unread[dm.id] || 0;
      body.append(el('button', {
        class: `channel ${state.activeChannelId === dm.id ? 'active' : ''}`,
        onclick: () => openChannel(dm.id)
      },
        avatarNode(dm.recipient, { size: 24 }),
        el('span', { class: 'name' }, dm.recipient?.username || 'Desconhecido'),
        unread ? el('span', { class: 'badge' }, unread) : null));
    }

    if (!state.dms.length) {
      body.append(el('p', { style: 'padding:16px 8px;color:var(--text-mute);font-size:13px' },
        'Nenhuma conversa ainda. Adicione um amigo para começar.'));
    }
    renderRail();
    return;
  }

  const g = guild();
  if (!g) return;

  $('#sidebarTitle').textContent = g.name;
  $('#guildMenuChevron').hidden = false;

  const isAdmin = ['owner', 'admin'].includes(g.myRole);
  const textChannels = g.channels.filter((c) => c.type === 'text');
  const voiceChannels = g.channels.filter((c) => c.type === 'voice');

  const section = (label, list, type) => {
    body.append(el('div', { class: 'side-section' },
      el('div', { class: 'side-label' },
        el('span', {}, label),
        isAdmin ? el('button', {
          title: 'Criar canal',
          onclick: () => openModal(modals.createChannel(g.id, type))
        }, '+') : null)));

    for (const channel of list) {
      const unread = state.unread[channel.id] || 0;
      const row = el('button', {
        class: `channel ${state.activeChannelId === channel.id ? 'active' : ''}`,
        onclick: () => (channel.type === 'voice' ? joinVoice(channel) : openChannel(channel.id))
      },
        el('span', { class: 'glyph' }, channel.type === 'voice' ? '🔊' : '#'),
        el('span', { class: 'name' }, channel.name),
        unread ? el('span', { class: 'badge' }, unread) : null,
        isAdmin ? el('span', {
          class: 'del icon-btn', title: 'Excluir canal',
          style: 'width:22px;height:22px;font-size:12px',
          onclick: async (event) => {
            event.stopPropagation();
            if (!confirm(`Excluir o canal "${channel.name}"?`)) return;
            await api.del(`/channels/${channel.id}`);
          }
        }, '✕') : null);
      body.append(row);

      if (channel.type === 'voice') {
        const members = state.voiceMembers.get(channel.id) || [];
        if (members.length) {
          body.append(el('div', { class: 'voice-members' },
            members.map((m) => el('div', { class: `voice-member ${m.state?.speaking ? 'speaking' : ''}` },
              avatarNode(m.user, { size: 20, status: false }),
              el('span', {}, m.user.username),
              el('span', { class: 'flags' },
                m.state?.muted ? '🔇' : '',
                m.state?.screen ? '🖥️' : '',
                m.state?.video ? '📷' : '')))));
        }
      }
    }
  };

  section('Canais de texto', textChannels, 'text');
  section('Canais de voz', voiceChannels, 'voice');
  renderRail();
}

/* ========================================================== navegação === */

export function openHome() {
  state.view = 'home';
  state.activeGuildId = null;
  state.activeChannelId = null;
  document.getElementById('app').classList.remove('chat-open');
  renderSidebar();
  renderHome();
  renderRail();
}

export function openGuild(guildId) {
  const g = guild(guildId);
  if (!g) return;
  state.view = 'guild';
  state.activeGuildId = guildId;
  renderSidebar();
  const first = g.channels.find((c) => c.type === 'text');
  if (first) openChannel(first.id);
  else { state.activeChannelId = null; renderHome(); }
  renderRail();
}

export async function openChannel(channelId) {
  state.activeChannelId = channelId;
  state.replyTo = null;
  document.getElementById('app').classList.add('chat-open');
  $('#content').querySelector('.friend-tabs')?.remove();
  $('#content').querySelector('.friend-list')?.remove();

  const channel = channelById(channelId);
  const isDM = channel?.type === 'dm';

  $('#chatTitle').textContent = isDM ? `@ ${channel.recipient?.username ?? ''}` : `# ${channel?.name ?? ''}`;
  $('#chatTopic').textContent = channel?.topic || '';
  $('#composer').hidden = false;
  $('#btnCall').hidden = !isDM;
  $('#btnVideoCall').hidden = !isDM;
  $('#btnMembers').hidden = isDM;
  $('#btnBotPanel').hidden = isDM;
  $('#membersPane').hidden = isDM;
  $('#input').placeholder = isDM ? `Conversar com ${channel.recipient?.username}` : `Conversar em #${channel?.name}`;

  state.unread[channelId] = 0;
  socket.emit('channel:read', { channelId });
  renderRail();
  renderSidebar();
  renderMembers();

  if (!state.messages.has(channelId)) {
    const { messages } = await api.get(`/channels/${channelId}/messages`);
    state.messages.set(channelId, messages);
  }
  renderMessages();
  $('#input').focus();
}

/* ======================================================== tela inicial == */

function renderHome() {
  if (state.activeChannelId) return;
  const messages = $('#messages');
  const content = $('#content');
  $('#composer').hidden = true;
  $('#membersPane').hidden = true;
  $('#btnCall').hidden = true;
  $('#btnVideoCall').hidden = true;
  $('#btnMembers').hidden = true;
  $('#btnBotPanel').hidden = true;
  $('#chatTopic').textContent = '';

  if (state.view === 'guild') {
    $('#chatTitle').textContent = guild()?.name ?? '';
    messages.replaceChildren(el('div', { class: 'empty' },
      el('div', { class: 'big-icon' }, '💬'),
      el('h3', {}, 'Nenhum canal de texto'),
      el('p', {}, 'Crie um canal de texto na barra lateral para começar a conversar.')));
    return;
  }

  $('#chatTitle').textContent = 'Amigos';

  const tabs = el('div', { class: 'friend-tabs' },
    ['online', 'todos', 'pendentes', 'bloqueados'].map((tab) =>
      el('button', {
        class: `friend-tab ${state.friendTab === tab ? 'active' : ''}`,
        onclick: () => { state.friendTab = tab; renderHome(); }
      }, tab[0].toUpperCase() + tab.slice(1) +
        (tab === 'pendentes' && state.friends.incoming.length ? ` (${state.friends.incoming.length})` : ''))),
    el('button', { class: 'friend-tab cta', onclick: () => openModal(modals.addFriend()) }, 'Adicionar amigo'));

  const list = el('div', { class: 'friend-list' });

  const row = (user, actions, sub) => el('div', { class: 'friend-row' },
    avatarNode(user, { size: 36 }),
    el('div', { class: 'meta' },
      el('div', { class: 'nm' }, user.username, el('span', { style: 'color:var(--text-mute);font-weight:400' }, `#${user.tag}`)),
      el('div', { class: 'sub' }, sub ?? (user.customStatus || statusLabel(user.status)))),
    el('div', { class: 'acts' }, actions));

  if (state.friendTab === 'pendentes') {
    for (const req of state.friends.incoming) {
      list.append(row(req.user, [
        el('button', { class: 'btn btn-success', onclick: () => respondFriend(req.id, true) }, 'Aceitar'),
        el('button', { class: 'btn btn-ghost', onclick: () => respondFriend(req.id, false) }, 'Recusar')
      ], 'Quer ser seu amigo'));
    }
    for (const req of state.friends.outgoing) {
      list.append(row(req.user, [el('span', { style: 'color:var(--text-mute);font-size:13px' }, 'Aguardando…')], 'Pedido enviado'));
    }
    if (!state.friends.incoming.length && !state.friends.outgoing.length) {
      list.append(emptyBlock('📭', 'Nenhum pedido pendente'));
    }
  } else if (state.friendTab === 'bloqueados') {
    for (const user of state.friends.blocked) {
      list.append(row(user, [el('button', {
        class: 'btn btn-ghost',
        onclick: async () => { await api.del(`/friends/${user.id}/block`); refreshFriends(); }
      }, 'Desbloquear')], 'Bloqueado'));
    }
    if (!state.friends.blocked.length) list.append(emptyBlock('🚫', 'Ninguém bloqueado'));
  } else {
    const friends = state.friendTab === 'online'
      ? state.friends.friends.filter((f) => f.status !== 'offline')
      : state.friends.friends;

    for (const user of friends) {
      list.append(row(user, [
        el('button', { class: 'icon-btn', title: 'Mensagem', onclick: () => startDM(user.id) }, '💬'),
        el('button', { class: 'icon-btn', title: 'Ligar', onclick: () => startCall(user.id, false) }, '📞'),
        el('button', { class: 'icon-btn', title: 'Vídeo', onclick: () => startCall(user.id, true) }, '🎥'),
        el('button', {
          class: 'icon-btn', title: 'Remover amigo',
          onclick: async () => {
            if (!confirm(`Remover ${user.username} da sua lista?`)) return;
            await api.del(`/friends/${user.id}`);
            refreshFriends();
          }
        }, '✕')
      ]));
    }
    if (!friends.length) {
      list.append(emptyBlock('🫂', state.friendTab === 'online' ? 'Nenhum amigo online' : 'Sua lista está vazia',
        'Clique em "Adicionar amigo" e mande o nome#0000 de alguém.'));
    }
  }

  messages.replaceChildren();
  content.querySelector('.friend-tabs')?.remove();
  content.querySelector('.friend-list')?.remove();
  content.prepend(list);
  content.prepend(tabs);
}

const emptyBlock = (icon, title, sub) => el('div', { class: 'empty' },
  el('div', { class: 'big-icon' }, icon), el('h3', {}, title), sub ? el('p', {}, sub) : null);

const statusLabel = (status) => ({ online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', offline: 'Offline' }[status] || 'Offline');

async function refreshFriends() {
  state.friends = await api.get('/friends');
  renderHome();
  renderSidebar();
}

async function respondFriend(id, accept) {
  await api.post(`/friends/${id}/respond`, { accept });
  await refreshFriends();
  toast(accept ? 'Pedido aceito!' : 'Pedido recusado.', accept ? 'ok' : '');
}

export async function startDM(userId) {
  const { channel } = await api.post('/dms', { userId });
  if (!state.dms.some((d) => d.id === channel.id)) state.dms.unshift(channel);
  state.view = 'home';
  state.activeGuildId = null;
  renderSidebar();
  await openChannel(channel.id);
}

async function startCall(userId, video) {
  const { channel } = await api.post('/dms', { userId });
  if (!state.dms.some((d) => d.id === channel.id)) state.dms.unshift(channel);
  await openChannel(channel.id);
  await joinVoice(channel, { video, ring: true });
}

/* ========================================================== mensagens === */

function renderMessages() {
  const container = $('#messages');
  const list = state.messages.get(state.activeChannelId) || [];
  container.replaceChildren();

  const channel = channelById(state.activeChannelId);
  if (!list.length) {
    container.append(el('div', { class: 'empty' },
      el('div', { class: 'big-icon' }, channel?.type === 'dm' ? '👋' : '💬'),
      el('h3', {}, channel?.type === 'dm'
        ? `Início da conversa com ${channel.recipient?.username}`
        : `Bem-vindo a #${channel?.name ?? ''}`),
      el('p', {}, 'Mande a primeira mensagem. Dica: digite !ajuda para falar com o Nexy.')));
    return;
  }

  let lastAuthor = null;
  let lastTs = 0;
  let lastDay = null;

  for (const message of list) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      container.append(el('div', { class: 'divider' }, el('span', {}, formatDay(message.createdAt))));
      lastDay = day;
      lastAuthor = null;
    }
    const grouped = message.author.id === lastAuthor
      && message.createdAt - lastTs < 5 * 60_000
      && !message.replyTo && !message.embed;

    container.append(messageNode(message, grouped));
    lastAuthor = message.author.id;
    lastTs = message.createdAt;
  }

  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function messageNode(message, grouped) {
  const mine = message.author.id === state.me.id;
  const g = guild();
  const isMod = g && ['owner', 'admin', 'mod'].includes(g.myRole);

  const tools = el('div', { class: 'msg-tools' },
    el('button', { class: 'icon-btn', title: 'Reagir', onclick: () => reactPicker(message) }, '😊'),
    el('button', {
      class: 'icon-btn', title: 'Responder',
      onclick: () => setReply(message)
    }, '↩'),
    mine ? el('button', { class: 'icon-btn', title: 'Editar', onclick: () => editMessage(message) }, '✏️') : null,
    (mine || isMod) ? el('button', {
      class: 'icon-btn', title: 'Apagar',
      onclick: () => socket.emit('message:delete', { id: message.id })
    }, '🗑️') : null);

  const body = el('div', {});

  if (message.replyTo) {
    body.append(el('div', { class: 'msg-reply' },
      el('span', {}, '↩'),
      avatarNode(message.replyTo.author, { size: 16, status: false }),
      el('strong', { style: 'font-size:12px' }, message.replyTo.author?.username ?? '—'),
      el('span', { style: 'opacity:.8' }, (message.replyTo.content || '').slice(0, 90))));
  }

  if (!grouped) {
    body.append(el('div', { class: 'msg-head' },
      el('span', { class: `msg-author ${message.author.isBot ? 'bot-name' : ''}` }, message.author.username),
      message.author.isBot ? el('span', { class: 'bot-badge' }, 'BOT') : null,
      el('span', { class: 'msg-time' }, formatTime(message.createdAt))));
  }

  if (message.content) {
    body.append(el('div', {
      class: 'msg-body',
      html: renderMarkdown(message.content) + (message.editedAt ? '<span class="msg-edited">(editado)</span>' : '')
    }));
  }

  if (message.embed) body.append(embedNode(message.embed));

  if (message.reactions?.length) {
    body.append(el('div', { class: 'reactions' },
      message.reactions.map((r) => el('button', {
        class: `reaction ${r.users.includes(state.me.id) ? 'mine' : ''}`,
        onclick: () => socket.emit('message:react', { id: message.id, emoji: r.emoji })
      }, r.emoji, el('span', {}, r.count)))));
  }

  return el('div', { class: `msg ${grouped ? 'grouped' : ''}`, dataset: { id: message.id } },
    el('div', { class: 'msg-avatar' }, grouped ? '' : avatarNode(message.author, { status: false })),
    body,
    tools);
}

function embedNode(embed) {
  const node = el('div', { class: 'embed', style: `border-left-color:${embed.color || '#5865f2'}` });

  if (embed.avatarOf) {
    node.append(el('div', { class: 'embed-avatar' }, avatarNode(embed.avatarOf, { size: 72, status: false })));
  }
  if (embed.title) node.append(el('div', { class: 'embed-title' }, embed.title));
  if (embed.description) node.append(el('div', { class: 'embed-desc', html: renderMarkdown(embed.description) }));

  if (embed.fields?.length) {
    node.append(el('div', { class: 'embed-fields' },
      embed.fields.filter(Boolean).map((f) => el('div', { class: `embed-field ${f.inline ? 'inline' : ''}` },
        el('div', { class: 'embed-field-name' }, f.name),
        el('div', { class: 'embed-field-value', html: renderMarkdown(String(f.value ?? '—')) })))));
  }

  if (embed.music?.url) {
    node.append(el('div', { class: 'embed-music' },
      el('audio', { controls: true, src: embed.music.url, preload: 'none' })));
  }

  if (embed.footer) node.append(el('div', { class: 'embed-footer' }, embed.footer));
  return node;
}

function setReply(message) {
  state.replyTo = message;
  $('#replyBar').hidden = false;
  $('#replyText').textContent = `Respondendo a ${message.author.username}`;
  $('#input').focus();
}

function clearReply() {
  state.replyTo = null;
  $('#replyBar').hidden = true;
}

function editMessage(message) {
  const content = prompt('Editar mensagem:', message.content);
  if (content === null || content.trim() === message.content) return;
  socket.emit('message:edit', { id: message.id, content: content.trim() });
}

function reactPicker(message) {
  const emojis = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '👀', '💯', '🤝'];
  const picker = el('div', {
    class: 'msg-tools',
    style: 'display:flex;position:fixed;z-index:100;flex-wrap:wrap;max-width:220px'
  }, emojis.map((emoji) => el('button', {
    class: 'icon-btn',
    onclick: () => { socket.emit('message:react', { id: message.id, emoji }); picker.remove(); }
  }, emoji)));

  const anchor = document.querySelector(`.msg[data-id="${message.id}"]`)?.getBoundingClientRect();
  picker.style.left = `${Math.min((anchor?.right ?? 200) - 230, window.innerWidth - 240)}px`;
  picker.style.top = `${(anchor?.top ?? 100) - 6}px`;
  document.body.append(picker);
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 10);
}

function renderTyping() {
  const map = state.typing.get(state.activeChannelId);
  if (!map) return void ($('#typing').textContent = '');
  const active = [...map.values()].filter((t) => Date.now() - t.ts < 5000);
  map.clear();
  for (const t of active) map.set(t.user.id, t);

  const names = active.map((t) => t.user.username);
  $('#typing').textContent = names.length === 0 ? ''
    : names.length === 1 ? `${names[0]} está digitando…`
    : names.length <= 3 ? `${names.join(', ')} estão digitando…`
    : 'Várias pessoas estão digitando…';
}

/* =========================================================== membros ==== */

function renderMembers() {
  const pane = $('#membersList');
  const g = guild();
  if (!g || state.view !== 'guild' || !state.activeChannelId) return;

  pane.replaceChildren();
  const online = g.members.filter((m) => m.status !== 'offline');
  const offline = g.members.filter((m) => m.status === 'offline');

  const group = (label, list) => {
    if (!list.length) return;
    pane.append(el('div', { class: 'side-label' }, el('span', {}, `${label} — ${list.length}`)));
    for (const member of list) {
      pane.append(el('button', {
        class: `member-row ${member.status === 'offline' ? 'offline' : ''}`,
        onclick: () => openModal(modals.userCard(member, g))
      },
        avatarNode(member, { size: 32 }),
        el('div', { class: 'meta' },
          el('div', { class: 'nm' }, member.displayName, member.isBot ? el('span', { class: 'bot-badge', style: 'margin-left:6px' }, 'BOT') : null),
          el('div', { class: 'sub' }, member.customStatus || `Nível ${member.level} · ${member.coins} 🪙`)),
        member.role !== 'member' ? el('span', { class: `role-tag role-${member.role}` }, member.role) : null));
    }
  };

  group('Online', online);
  group('Offline', offline);
}

/* ============================================================== voz ===== */

export async function joinVoice(channel, { video = false, ring = false } = {}) {
  try {
    await voice.join(channel.id, { video });
    state.stageCollapsed = false;
    if (ring) socket.emit('call:start', { channelId: channel.id, video });
    renderVoicePanel();
    renderStage();
    toast(`Conectado em ${channel.type === 'dm' ? channel.recipient?.username : channel.name}`, 'ok');
  } catch (err) {
    toast(`Não foi possível conectar: ${err.message}`, 'err');
  }
}

function leaveVoice() {
  voice.leave();
  renderVoicePanel();
  renderStage();
}

function renderVoicePanel() {
  const panel = $('#voicePanel');
  panel.hidden = !voice?.connected;
  if (!voice?.connected) return;

  const channel = channelById(voice.channelId);
  const name = channel?.type === 'dm' ? `@${channel.recipient?.username}` : `# ${channel?.name ?? ''}`;
  $('#voiceChannelName').textContent = name;
  $('#voiceStatusText').textContent = `Voz conectada · ${voice.peers.size + 1}`;
  $('#btnCam').classList.toggle('active', voice.state.video);
  $('#btnScreen').classList.toggle('active', voice.state.screen);
  $('#btnMic').classList.toggle('off', voice.state.muted);
  $('#btnDeaf').classList.toggle('off', voice.state.deafened);
}

function renderStage() {
  const stage = $('#stage');
  if (!voice?.connected || state.stageCollapsed) {
    stage.hidden = true;
    return;
  }
  stage.hidden = false;

  const grid = $('#stageGrid');
  const tiles = voice.tiles(state.me);
  const seen = new Set();

  for (const tile of tiles) {
    for (const [kind, stream] of [['cam', tile.video], ['screen', tile.screen]]) {
      const key = `${tile.key}:${kind}`;
      if (!stream) continue;
      seen.add(key);
      let node = grid.querySelector(`[data-tile="${key}"]`);
      if (!node) {
        node = el('div', { class: 'tile', dataset: { tile: key } },
          el('video', { autoplay: true, playsInline: true, muted: tile.self }),
          el('div', { class: 'tile-name' }, `${tile.user?.username ?? ''}`),
          kind === 'screen' ? el('div', { class: 'tile-tag' }, '🖥️ tela') : null);
        grid.append(node);
      }
      const video = node.querySelector('video');
      if (video.srcObject !== stream) video.srcObject = stream;
      node.classList.toggle('speaking', !!tile.speaking && kind === 'cam');
    }

    // participante sem vídeo: mostra o avatar
    if (!tile.video && !tile.screen) {
      const key = `${tile.key}:avatar`;
      seen.add(key);
      let node = grid.querySelector(`[data-tile="${key}"]`);
      if (!node) {
        node = el('div', { class: 'tile', dataset: { tile: key } },
          el('div', { class: 'tile-avatar' }, avatarNode(tile.user, { size: 84, status: false })),
          el('div', { class: 'tile-name' }, tile.user?.username ?? ''));
        grid.append(node);
      }
      node.classList.toggle('speaking', !!tile.speaking);
      const flag = tile.state?.muted ? '🔇' : '';
      node.querySelector('.tile-name').textContent = `${flag} ${tile.user?.username ?? ''}`.trim();
    }
  }

  for (const node of [...grid.children]) {
    if (!seen.has(node.dataset.tile)) node.remove();
  }

  $('#stageMic').classList.toggle('active', !voice.state.muted);
  $('#stageMic').textContent = voice.state.muted ? '🔇 Mudo' : '🎙️ Falando';
  $('#stageCam').classList.toggle('active', voice.state.video);
  $('#stageScreen').classList.toggle('active', voice.state.screen);
}

/** Reproduz o áudio remoto fora da grade (funciona mesmo sem vídeo). */
function syncAudio() {
  const sink = $('#audioSink');
  const wanted = new Map();

  for (const peer of voice?.peers.values() || []) {
    for (const [streamId, stream] of peer.streams) {
      if (stream.getAudioTracks().length) wanted.set(streamId, stream);
    }
  }

  for (const [streamId, stream] of wanted) {
    let audio = sink.querySelector(`[data-stream="${streamId}"]`);
    if (!audio) {
      audio = el('audio', { autoplay: true, dataset: { stream: streamId } });
      sink.append(audio);
    }
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.muted = !!voice.state.deafened;
    audio.play?.().catch(() => { /* aguarda gesto do usuário */ });
  }

  for (const audio of [...sink.querySelectorAll('audio[data-stream]')]) {
    if (!wanted.has(audio.dataset.stream)) audio.remove();
  }
}

/* ============================================================= música === */

function syncMusic() {
  const music = state.music.get(state.activeGuildId);
  const sink = $('#audioSink');
  let player = sink.querySelector('#musicPlayer');

  if (!music?.current) {
    player?.remove();
    return;
  }
  if (!player) {
    player = el('audio', { id: 'musicPlayer', autoplay: true });
    sink.append(player);
  }
  if (player.dataset.url !== music.current.url) {
    player.dataset.url = music.current.url;
    player.src = music.current.url;
    const offset = Math.max(0, (Date.now() - music.startedAt) / 1000);
    player.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(player.duration) && offset < player.duration) player.currentTime = offset;
    }, { once: true });
  }
  if (music.paused) player.pause();
  else player.play?.().catch(() => toast('Clique em qualquer lugar para liberar o áudio da música.'));
}

/* ========================================================== chamadas ==== */

function showRing() {
  const call = state.pendingCall;
  if (!call) return;
  $('#ringAvatar').replaceWith(Object.assign(avatarNode(call.from, { size: 76, status: false }), { id: 'ringAvatar', className: 'avatar big' }));
  $('#ringName').textContent = call.from.username;
  $('#ringKind').textContent = call.video ? 'Chamada de vídeo' : 'Chamada de voz';
  $('#ringOverlay').hidden = false;
}

/* ============================================================= binds ==== */

function bindUI() {
  $('#railHome').addEventListener('click', openHome);
  $('#btnCreateGuild').addEventListener('click', () => openModal(modals.createGuild()));
  $('#btnJoinGuild').addEventListener('click', () => openModal(modals.joinGuild()));
  $('#btnBack').addEventListener('click', () => document.getElementById('app').classList.remove('chat-open'));

  $('#sidebarHeader').addEventListener('click', () => {
    if (state.view === 'guild') openModal(modals.guildMenu(guild()));
  });

  $('#btnUserSettings').addEventListener('click', () => openModal(modals.userSettings()));
  $('#btnSettings').addEventListener('click', () => openModal(modals.userSettings()));
  $('#btnMembers').addEventListener('click', () => { $('#membersPane').hidden = !$('#membersPane').hidden; });
  $('#btnBotPanel').addEventListener('click', () => openModal(modals.botPanel(guild())));

  $('#btnMic').addEventListener('click', () => {
    if (!voice?.connected) return toast('Entre em um canal de voz primeiro.');
    voice.toggleMute();
    renderVoicePanel();
  });
  $('#btnDeaf').addEventListener('click', () => {
    if (!voice?.connected) return toast('Entre em um canal de voz primeiro.');
    voice.toggleDeafen();
    syncAudio();
    renderVoicePanel();
  });
  $('#btnHangup').addEventListener('click', leaveVoice);
  $('#btnCam').addEventListener('click', async () => {
    try { await voice.setCamera(!voice.state.video); } catch { toast('Não consegui acessar a câmera.', 'err'); }
  });
  $('#btnScreen').addEventListener('click', async () => {
    try { await voice.setScreen(!voice.state.screen); } catch { toast('Compartilhamento cancelado.'); }
  });

  $('#stageMic').addEventListener('click', () => { voice.toggleMute(); renderStage(); renderVoicePanel(); });
  $('#stageCam').addEventListener('click', async () => {
    try { await voice.setCamera(!voice.state.video); } catch { toast('Não consegui acessar a câmera.', 'err'); }
  });
  $('#stageScreen').addEventListener('click', async () => {
    try { await voice.setScreen(!voice.state.screen); } catch { toast('Compartilhamento cancelado.'); }
  });
  $('#stageLeave').addEventListener('click', leaveVoice);
  $('#stageCollapse').addEventListener('click', () => { state.stageCollapsed = true; renderStage(); });

  $('#btnCall').addEventListener('click', () => {
    const channel = channelById(state.activeChannelId);
    if (channel) joinVoice(channel, { ring: true });
  });
  $('#btnVideoCall').addEventListener('click', () => {
    const channel = channelById(state.activeChannelId);
    if (channel) joinVoice(channel, { video: true, ring: true });
  });

  $('#ringAccept').addEventListener('click', async () => {
    const call = state.pendingCall;
    $('#ringOverlay').hidden = true;
    state.pendingCall = null;
    if (!call) return;
    await openChannel(call.channelId);
    await joinVoice(channelById(call.channelId), { video: call.video });
  });
  $('#ringDecline').addEventListener('click', () => {
    const call = state.pendingCall;
    $('#ringOverlay').hidden = true;
    state.pendingCall = null;
    if (call) socket.emit('call:decline', { channelId: call.channelId });
  });

  $('#verifyDismiss').addEventListener('click', () => { $('#verifyBanner').hidden = true; });
  $('#verifyResend').addEventListener('click', async () => {
    try {
      await api.post('/auth/resend-verification');
      toast('E-mail de confirmação reenviado. Olhe sua caixa de entrada.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#replyCancel').addEventListener('click', clearReply);
  $('#btnEmoji').addEventListener('click', () => {
    const input = $('#input');
    const emojis = ['😀', '😂', '🥲', '😎', '🤔', '👍', '🔥', '🎉', '❤️', '👀', '🤝', '🚀'];
    const picker = el('div', {
      class: 'msg-tools',
      style: 'display:flex;position:fixed;bottom:80px;right:40px;z-index:100;flex-wrap:wrap;max-width:220px'
    }, emojis.map((emoji) => el('button', {
      class: 'icon-btn',
      onclick: () => { input.value += emoji; picker.remove(); input.focus(); }
    }, emoji)));
    document.body.append(picker);
    setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 10);
  });

  const input = $('#input');
  const emitTyping = debounce(() => {
    if (state.activeChannelId) socket.emit('typing', { channelId: state.activeChannelId });
  }, 900);

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    emitTyping();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || !state.activeChannelId) return;

    socket.emit('message:send', {
      channelId: state.activeChannelId,
      content,
      replyTo: state.replyTo?.id || null
    }, (response) => {
      if (!response?.ok) toast(response?.error || 'Não foi possível enviar', 'err');
    });

    input.value = '';
    input.style.height = 'auto';
    clearReply();
  });

  $('#modalBackdrop').addEventListener('click', (event) => {
    if (event.target.id === 'modalBackdrop') closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

/* ============================================================== main ==== */

setupAuth();
bindUI();

if (token.get()) {
  start().catch(() => { token.clear(); $('#auth').hidden = false; });
} else {
  $('#auth').hidden = false;
}

// helpers usados pelos modais
export const refresh = {
  rail: renderRail,
  sidebar: renderSidebar,
  home: renderHome,
  members: renderMembers,
  friends: refreshFriends,
  me: renderMe
};
