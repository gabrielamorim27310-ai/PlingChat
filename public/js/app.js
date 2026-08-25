import { api, token } from './api.js';
import { API_BASE } from './config.js';
import { $, $$, el, icon, avatarNode, renderMarkdown, formatTime, formatDay, dayKey, initials, debounce } from './util.js';
import { VoiceClient } from './voice.js';
import { openModal, closeModal, modals } from './modals.js';
import {
  playPling, startRingtone, stopRingtone, notifyOS, unlockAudio,
  osNotificationsEnabled, enableOsNotifications, isIOS, isMac, isStandaloneApp, convSoundKey
} from './notify.js';

// iOS só libera áudio depois de um toque de verdade na página -- este é o
// primeiro toque, então destrava os sons de notificação nele.
document.addEventListener('pointerdown', unlockAudio, { once: true });

// Registra o service worker cedo (não só quando a pessoa ativa push) --
// isso também é um dos requisitos pra Android/desktop oferecerem "instalar
// app" sozinho, e deixa o push pronto pra quando ela ativar depois.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Clicar numa notificação com a aba já aberta só foca a janela (o SW não
  // navega sozinho) -- ele manda essa mensagem pra gente abrir o canal certo.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'notification-click') return;
    const id = new URL(event.data.url, location.origin).searchParams.get('canal');
    if (id) openChannel(id);
  });
}

/* =============================================================== tema === */

const THEME_KEY = 'nexus.theme';

/** 'dark' (padrão de sempre), 'light' ou 'auto' (segue o sistema). */
export function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* modo privado, sem problema */ }
}

export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; }
}

applyTheme(getTheme());

/* ============================================================== estado === */

export const state = {
  me: null,
  guilds: [],
  dms: [],
  friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
  unread: {},
  mentioned: new Set(), // channelId -> tem mensagem nao lida que me cita
  botCommands: [],
  botUser: null,

  workspace: 'personal',  // 'personal' | id de um servidor-organização
  view: 'home',           // 'home' | 'guild'
  activeGuildId: null,
  activeChannelId: null,
  friendTab: 'online',

  messages: new Map(),    // channelId -> [message]
  typing: new Map(),      // channelId -> Map<userId, {user, ts}>
  voiceMembers: new Map(),// channelId -> [{user, state}]
  music: new Map(),       // guildId -> estado do player
  dmReadState: new Map(), // channelId (DM) -> timestamp do ultimo "lido" da outra pessoa

  replyTo: null,
  stageCollapsed: false,
  pendingCall: null
};

export let socket = null;
export let voice = null;

/** @meu-usuario dentro do texto me cita? Usado pra destacar e notificar diferente. */
export function mentionsMe(content) {
  if (!content || !state.me?.username) return false;
  const name = state.me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${name}\\b`, 'i').test(content);
}

/** Envolve @menções de gente de verdade da conversa num span pra destacar
 * na mensagem (html já escapado) -- a sua própria ganha um destaque extra,
 * igual o Discord faz. */
function highlightMentions(html) {
  const names = new Set(mentionCandidates().map((u) => u.username));
  if (state.me?.username) names.add(state.me.username);
  if (!names.size) return html;

  const alternatives = [...names]
    .sort((a, b) => b.length - a.length) // nomes mais longos primeiro, senão um prefixo casa antes da hora
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${alternatives.join('|')})\\b`, 'gi');

  return html.replace(re, (match, name) => {
    const isMe = state.me?.username && name.toLowerCase() === state.me.username.toLowerCase();
    return `<span class="mention${isMe ? ' me' : ''}">${match}</span>`;
  });
}

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

  // Chegou por um link de workspace de empresa (?org=guildId) -- o e-mail
  // do domínio certo substitui o convite pessoal (checado de verdade no
  // servidor; aqui é só pra não travar o formulário atrás de um convite
  // que a pessoa não tem motivo pra ter).
  const pendingOrgId = params.get('org');

  function applyMode() {
    const isLogin = authMode === 'login';
    $('#fieldUsername').hidden = isLogin;
    $('#fieldUsername').querySelector('input').required = !isLogin;

    const needsInvite = !isLogin && appConfig.signupMode === 'invite' && !pendingOrgId;
    $('#fieldInvite').hidden = !needsInvite;
    $('#fieldInvite').querySelector('input').required = needsInvite;

    $('#authTitle').textContent = isLogin ? 'Que bom te ver de novo!' : 'Criar uma conta';
    $('#authSub').textContent = isLogin
      ? 'Entre para conversar, chamar e jogar com a galera.'
      : pendingOrgId
        ? 'Cadastre-se com seu e-mail da empresa — sem precisar de convite.'
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
          ? { username: form.username.value, inviteCode: form.inviteCode?.value?.trim() || null, orgGuildId: pendingOrgId || null }
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
    } else if (pendingOrgId) {
      authMode = 'register'; // quem chega por link de empresa provavelmente ainda não tem conta
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

/** Converte a chave publica VAPID (base64url) pro formato que o PushManager espera. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Pede permissão de notificação e inscreve esse navegador pra push. Só deve
 * ser chamado a partir de um clique do usuário — navegadores bloqueiam (ou
 * pioram a UX de) pedidos de permissão disparados sozinhos.
 */
export async function setupPush() {
  if (!appConfig.vapidPublicKey) return toast('Notificações não estão configuradas no servidor.', 'err');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast('Seu navegador não suporta notificações push.', 'err');
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Permissão de notificação recusada.', 'err');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(appConfig.vapidPublicKey)
      });
    }
    await api.post('/push/subscribe', { subscription: sub.toJSON() });
    toast('Notificações ativadas!', 'ok');
  } catch (err) {
    toast('Não deu pra ativar: ' + err.message, 'err');
  }
}

const NOTIF_BANNER_DISMISS_KEY = 'nexus.notifBannerDismissed';

/** Sugere ativar notificações logo após o login -- melhora bastante a
 * experiência (nada de F5 pra ver se chegou mensagem) e a maioria nem sabe
 * que dá pra ativar. Some sozinho se já tiver ativado ou se a pessoa
 * dispensar (não fica insistindo a cada login). */
function setupNotifBanner() {
  const banner = $('#notifBanner');
  if (!banner) return;
  const text = $('#notifBannerText');
  const enableBtn = $('#notifBannerEnable');

  if (typeof Notification === 'undefined' || osNotificationsEnabled()
    || localStorage.getItem(NOTIF_BANNER_DISMISS_KEY) === 'on') {
    banner.hidden = true;
    return;
  }

  if (isIOS() && !isStandaloneApp()) {
    text.textContent = 'Prefira usar o PlingChat instalado (Compartilhar → Adicionar à Tela de Início) — é a única forma do iPhone avisar de mensagens novas fora do app.';
    enableBtn.hidden = true;
  } else {
    text.textContent = isMac()
      ? 'Ative as notificações do PlingChat para não perder mensagens e chamadas (no Mac, confira também os Ajustes do Sistema → Notificações).'
      : 'Ative as notificações do PlingChat para não perder mensagens e chamadas.';
    enableBtn.hidden = false;
  }
  banner.hidden = false;
}

/** Convite de servidor (?convite=) e aviso de e-mail não confirmado. */
async function handleLaunchParams() {
  $('#verifyBanner').hidden = state.me.emailVerified || !state.me.hasEmail || !appConfig.passwordResetEnabled;
  setupNotifBanner();
  dropParam('cadastro');

  const canal = params.get('canal');
  if (canal) {
    dropParam('canal');
    const channel = channelById(canal) || state.dms.find((d) => d.id === canal);
    if (channel?.guildId) openGuild(channel.guildId);
    if (channel) openChannel(canal);
  }

  const orgGuildId = params.get('org');
  if (orgGuildId) {
    dropParam('org');
    if (state.guilds.some((g) => g.id === orgGuildId)) {
      openGuild(orgGuildId);
    } else {
      try {
        const { guild } = await api.post(`/guilds/${orgGuildId}/join-by-domain`, {});
        state.guilds.push(guild);
        renderRail();
        openGuild(guild.id);
        toast(`Você entrou em "${guild.name}" pelo domínio verificado!`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  }

  // Volta do checkout da Stripe -- o webhook normalmente já processou até
  // aqui, mas pode atrasar um pouco; se o servidor ainda não aparece,
  // recarrega uma vez em vez de deixar a pessoa presa numa tela velha.
  const stripeStatus = params.get('stripe');
  if (stripeStatus) {
    dropParam('stripe');
    const stripeGuildId = params.get('guild');
    dropParam('guild');
    if (stripeStatus === 'success' && stripeGuildId) {
      if (state.guilds.some((g) => g.id === stripeGuildId)) {
        openGuild(stripeGuildId);
        toast('Pagamento confirmado! Bem-vindo(a).', 'ok');
      } else {
        toast('Pagamento recebido, finalizando sua entrada…', 'ok');
        setTimeout(() => location.reload(), 2500);
      }
    } else if (stripeStatus === 'cancel') {
      toast('Assinatura cancelada antes de terminar.');
    }
  }
  if (params.get('stripe_onboarded')) {
    dropParam('stripe_onboarded');
    toast('Cadastro na Stripe recebido! Pode levar alguns minutos até ficar liberado pra receber.', 'ok');
  }
  dropParam('stripe_refresh');

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
  for (const dm of data.dms) state.dmReadState.set(dm.id, dm.theirLastRead || 0);
  state.friends = data.friends;
  state.unread = data.unread;
  state.botCommands = data.bot.commands;
  state.botUser = data.bot.user;

  $('#loading').hidden = true;
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

    const isMine = message.author.id === state.me.id;
    const channel = channelById(message.channelId);
    const mentioned = !isMine && mentionsMe(message.content);

    // O som toca pra qualquer mensagem de outra pessoa, mesmo no canal que
    // você já está olhando (a notificação do sistema é que só aparece com a
    // aba sem foco -- isso já é resolvido dentro de notifyOS).
    if (!isMine) {
      playPling(convSoundKey(channel));
      if (channel?.type === 'dm' || mentioned) {
        const title = channel?.type === 'dm' ? message.author.username : `${message.author.username} em #${channel?.name ?? ''}`;
        notifyOS(title, message.content.slice(0, 140), {
          tag: message.channelId, url: `/?canal=${message.channelId}`, onClick: () => openChannel(message.channelId)
        });
      }
    }

    if (message.channelId !== state.activeChannelId && !isMine) {
      state.unread[message.channelId] = (state.unread[message.channelId] || 0) + 1;
      if (mentioned) state.mentioned.add(message.channelId);
      renderRail();
      renderSidebar();
      if (channel?.type === 'dm') toast(`💬 ${message.author.username}: ${message.content.slice(0, 60)}`);
      else if (mentioned) toast(`🔔 ${message.author.username} te citou em #${channel?.name ?? ''}`);
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

  socket.on('presence', ({ userId, status, user }) => {
    // "user" vem preenchido tanto num simples online/offline quanto quando o
    // perfil muda (nome, foto, cor, bio) -- reaproveita o mesmo evento pra
    // não precisar de F5 quando alguém troca a foto, por exemplo.
    const patchProfile = (obj) => {
      if (!user) return;
      Object.assign(obj, {
        username: user.username, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl,
        customStatus: user.customStatus, bio: user.bio
      });
      if ('displayName' in obj) obj.displayName = obj.nickname || user.username;
    };

    for (const g of state.guilds) {
      const member = g.members.find((m) => m.id === userId);
      if (member) { member.status = status; patchProfile(member); }
    }
    for (const dm of state.dms) {
      if (dm.recipient?.id === userId) { dm.recipient.status = status; patchProfile(dm.recipient); }
    }
    for (const f of state.friends.friends) if (f.id === userId) { f.status = status; patchProfile(f); }

    if (user && userId === state.me.id) {
      state.me = { ...state.me, ...user };
      renderMe();
    }

    // Só reflete no author das mensagens já carregadas (e só re-renderiza)
    // quando algo realmente mudou -- senão todo blink de online/offline de
    // quem já postou no canal ativo forçaria um re-render à toa.
    let touchedActiveChannel = false;
    if (user) {
      for (const [channelId, list] of state.messages) {
        for (const m of list) {
          if (m.author?.id !== userId) continue;
          const changed = m.author.username !== user.username || m.author.avatarUrl !== user.avatarUrl
            || m.author.avatarColor !== user.avatarColor;
          if (changed) {
            Object.assign(m.author, user);
            if (channelId === state.activeChannelId) touchedActiveChannel = true;
          }
        }
      }
    }
    if (touchedActiveChannel) renderMessages();

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

  socket.on('guild:info', ({ guildId, ...patch }) => {
    const g = guild(guildId);
    if (!g) return;
    Object.assign(g, patch);
    if (state.activeGuildId === guildId) applyGuildAccent(g.iconColor);
    renderRail();
    renderSidebar();
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

  // Confirmação de leitura -- só chega se a outra pessoa deixa a leitura
  // dela visível (recíproco, ver PATCH /me). Atualiza o "Visto" ao vivo.
  socket.on('dm:read', ({ channelId, userId, at }) => {
    if (userId === state.me.id) return;
    state.dmReadState.set(channelId, at);
    if (channelId === state.activeChannelId) renderMessages();
  });

  socket.on('voice:members', ({ channelId, members }) => {
    state.voiceMembers.set(channelId, members);
    renderSidebar();
    renderStage();
    renderCallWaitingBanner();
  });

  socket.on('music:state', ({ guildId, ...payload }) => {
    state.music.set(guildId, payload);
    syncMusic();
  });

  socket.on('call:incoming', ({ channelId, video, from }) => {
    state.pendingCall = { channelId, video, from };
    showRing();
    startRingtone();
    notifyOS(`${from.username} está ligando`, video ? 'Chamada de vídeo' : 'Chamada de voz', {
      tag: `call:${channelId}`, url: `/?canal=${channelId}`, onClick: () => openChannel(channelId)
    });
  });

  socket.on('call:declined', ({ by }) => toast(`${by.username} recusou a chamada.`, 'err'));
  socket.on('call:cancelled', () => { state.pendingCall = null; $('#ringOverlay').hidden = true; stopRingtone(); });

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

/** Organizações são servidores com domínio de e-mail verificado configurado. */
const isOrg = (g) => !!g.settings?.org_domain;
const visibleGuilds = () => state.workspace === 'personal'
  ? state.guilds.filter((g) => !isOrg(g))
  : state.guilds.filter((g) => g.id === state.workspace);

function renderWorkspaceSwitcher() {
  const orgs = state.guilds.filter(isOrg);
  const switcher = $('#wsSwitcher');
  switcher.hidden = !orgs.length;
  if (!orgs.length) return;

  // se o servidor-organização ativo sumiu (saiu, foi excluído), volta pro pessoal
  if (state.workspace !== 'personal' && !orgs.some((g) => g.id === state.workspace)) state.workspace = 'personal';

  const current = state.workspace === 'personal' ? null : guild(state.workspace);
  $('#wsAvatar').replaceChildren(current ? initials(current.name) : icon('users', 18));
  $('#wsAvatar').title = current ? current.name : 'Pessoal';

  const menu = $('#wsMenu');
  menu.replaceChildren();
  const row = (label, active, onclick, sub) => el('button', {
    class: `ws-row ${active ? 'active' : ''}`, onclick
  }, el('span', { class: 'ws-row-avatar' }, sub ? initials(label) : icon('users', 16)),
    el('div', {}, el('strong', {}, label), sub ? el('small', {}, sub) : null));

  menu.append(row('Pessoal', state.workspace === 'personal', () => switchWorkspace('personal')));
  for (const g of orgs) menu.append(row(g.name, state.workspace === g.id, () => switchWorkspace(g.id), 'Organização'));
}

function switchWorkspace(target) {
  state.workspace = target;
  $('#wsMenu').hidden = true;
  renderWorkspaceSwitcher();
  renderRail();
  const guilds = visibleGuilds();
  if (target !== 'personal' && guilds.length) openGuild(guilds[0].id);
  else openHome();
}

function renderRail() {
  const container = $('#railGuilds');
  container.replaceChildren();
  renderWorkspaceSwitcher();

  for (const g of visibleGuilds()) {
    const unread = g.channels.reduce((sum, c) => sum + (state.unread[c.id] || 0), 0);
    const mentioned = g.channels.some((c) => state.mentioned.has(c.id));
    const button = el('button', {
      class: `rail-item ${state.activeGuildId === g.id ? 'active' : ''}`,
      title: g.name,
      style: `background:${g.iconColor}`,
      onclick: () => openGuild(g.id)
    }, g.iconUrl ? el('img', { src: g.iconUrl, alt: '' }) : el('span', {}, initials(g.name)),
      el('span', { class: 'rail-pill', style: `--rail-pill-color:${g.iconColor}` }));

    if (unread) button.append(el('span', { class: `rail-badge ${mentioned ? 'mentioned' : ''}` }, unread > 99 ? '99+' : unread));
    container.append(button);
  }

  const dmUnread = state.dms.reduce((sum, d) => sum + (state.unread[d.id] || 0), 0);
  const dmMentioned = state.dms.some((d) => state.mentioned.has(d.id));
  const home = $('#railHome');
  home.classList.toggle('active', state.view === 'home');
  home.querySelector('.rail-badge')?.remove();
  if (dmUnread) home.append(el('span', { class: `rail-badge ${dmMentioned ? 'mentioned' : ''}` }, dmUnread));
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
    }, el('span', { class: 'glyph' }, icon('users', 15)), el('span', { class: 'name' }, 'Amigos')));

    body.append(el('div', { class: 'side-section' },
      el('div', { class: 'side-label' },
        el('span', {}, 'Mensagens diretas'),
        el('button', { title: 'Nova conversa', onclick: () => openModal(modals.addFriend()) }, '+'))));

    // O Nexy fica sempre fixo no topo -- é pra ser tão acessível quanto o
    // Meta AI dentro do WhatsApp, não uma conversa que pode afundar na
    // lista conforme chegam mensagens de outras pessoas.
    const sortedDms = [...state.dms].sort((a, b) =>
      (b.recipient?.id === state.botUser?.id) - (a.recipient?.id === state.botUser?.id));

    for (const dm of sortedDms) {
      const isNexy = dm.recipient?.id === state.botUser?.id;
      const unread = state.unread[dm.id] || 0;
      const voiceHere = state.voiceMembers.get(dm.id) || [];
      const waiting = voiceHere.length > 0 && !voiceHere.some((m) => m.user.id === state.me.id);
      body.append(el('button', {
        class: `channel ${state.activeChannelId === dm.id ? 'active' : ''} ${waiting ? 'has-call' : ''}`,
        title: waiting ? `${voiceHere[0].user.username} está te esperando na chamada` : '',
        onclick: () => openChannel(dm.id)
      },
        avatarNode(dm.recipient, { size: 24 }),
        el('span', { class: 'name' }, dm.recipient?.username || 'Desconhecido'),
        isNexy ? el('span', { class: 'ia-badge' }, 'IA') : null,
        waiting ? el('span', { class: 'call-badge' }, icon('phone', 11)) : null,
        unread ? el('span', { class: `badge ${state.mentioned.has(dm.id) ? 'mentioned' : ''}` }, unread) : null));
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
        el('span', { class: 'glyph' }, channel.type === 'voice' ? icon('volume', 15) : '#'),
        el('span', { class: 'name' }, channel.name),
        unread ? el('span', { class: `badge ${state.mentioned.has(channel.id) ? 'mentioned' : ''}` }, unread) : null,
        isAdmin ? el('span', {
          class: 'del icon-btn', title: 'Excluir canal',
          style: 'width:22px;height:22px;font-size:12px',
          onclick: async (event) => {
            event.stopPropagation();
            if (!confirm(`Excluir o canal "${channel.name}"?`)) return;
            await api.del(`/channels/${channel.id}`);
          }
        }, icon('close', 12)) : null);
      body.append(row);

      if (channel.type === 'voice') {
        const members = state.voiceMembers.get(channel.id) || [];
        if (members.length) {
          body.append(el('div', { class: 'voice-members' },
            members.map((m) => el('div', { class: `voice-member ${m.state?.speaking ? 'speaking' : ''}` },
              avatarNode(m.user, { size: 20, status: false }),
              el('span', {}, m.user.username),
              el('span', { class: 'flags' },
                m.state?.muted ? icon('mic-off', 12) : '',
                m.state?.screen ? icon('monitor', 12) : '',
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

// A cor do servidor aberto tinge alguns detalhes discretos da UI (o
// tracinho do canal ativo, por ex.) -- em Amigos/DM volta pro neutro.
function applyGuildAccent(color) {
  document.documentElement.style.setProperty('--guild-accent', color || 'var(--text)');
}

export function openHome() {
  state.view = 'home';
  state.activeGuildId = null;
  state.activeChannelId = null;
  document.getElementById('app').classList.remove('chat-open');
  applyGuildAccent(null);
  renderSidebar();
  renderHome();
  renderRail();
}

export function openGuild(guildId) {
  const g = guild(guildId);
  if (!g) return;
  state.view = 'guild';
  state.activeGuildId = guildId;
  applyGuildAccent(g.iconColor);
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
  $('#btnConvSound').hidden = false;
  $('#btnMembers').hidden = isDM;
  $('#btnBotPanel').hidden = isDM;
  // No celular o painel de membros não abre sozinho -- cobre a tela toda e
  // trava o clique em tudo (composer incluso). Só abre pelo botão mesmo.
  $('#membersPane').hidden = isDM || matchMedia('(max-width: 860px)').matches;
  // No celular o campo de digitar fica bem estreito (espremido entre os
  // botões de emoji e enviar) -- "Conversar com {nome}" quebra linha ali e a
  // segunda linha some fora da área visível. Nome/canal já aparece bem
  // grande no cabeçalho, então não precisa repetir no placeholder também.
  $('#input').placeholder = matchMedia('(max-width: 480px)').matches
    ? 'Mensagem'
    : isDM ? `Conversar com ${channel.recipient?.username}` : `Conversar em #${channel?.name}`;

  state.unread[channelId] = 0;
  state.mentioned.delete(channelId);
  socket.emit('channel:read', { channelId });
  renderRail();
  renderSidebar();
  renderMembers();
  renderCallWaitingBanner();
  closeMentionMenu();

  if (!state.messages.has(channelId)) {
    const { messages } = await api.get(`/channels/${channelId}/messages`);
    state.messages.set(channelId, messages);
  }
  renderMessages();
  $('#input').focus();
}

// Mostra um aviso fixo acima do composer quando a pessoa abre uma DM em que
// alguém já está esperando na chamada (e ela ainda não entrou), para que
// não dependa só do overlay "Chamando..." do lado de quem ligou.
// Alguem (que nao seja eu) ja esta na sala de voz desse canal, esperando?
// Usado tanto pelo aviso fixo quanto pelos botoes de ligar do cabeçalho --
// se a pessoa ja esta la esperando, não faz sentido "ligar" (tocar) de novo,
// é só entrar direto.
function channelHasWaitingCall(channelId) {
  const members = state.voiceMembers.get(channelId) || [];
  return members.find((m) => m.user.id !== state.me.id) || null;
}

function renderCallWaitingBanner() {
  const banner = $('#callWaitingBanner');
  if (!banner) return;

  const channel = channelById(state.activeChannelId);
  const isDM = channel?.type === 'dm';
  const already = voice?.connected && voice.channelId === state.activeChannelId;
  const waitingMember = isDM ? channelHasWaitingCall(state.activeChannelId) : null;

  if (!isDM || already || !waitingMember) {
    banner.hidden = true;
    return;
  }

  $('#callWaitingText').textContent = `${waitingMember.user.username} está te esperando na chamada`;
  banner.hidden = false;
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
  $('#btnConvSound').hidden = true;
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
        el('button', { class: 'icon-btn', title: 'Mensagem', onclick: () => startDM(user.id) }, icon('message-circle', 16)),
        el('button', { class: 'icon-btn', title: 'Ligar', onclick: () => startCall(user.id, false) }, icon('phone', 16)),
        el('button', { class: 'icon-btn', title: 'Vídeo', onclick: () => startCall(user.id, true) }, icon('video', 16)),
        el('button', {
          class: 'icon-btn', title: 'Remover amigo',
          onclick: async () => {
            if (!confirm(`Remover ${user.username} da sua lista?`)) return;
            await api.del(`/friends/${user.id}`);
            refreshFriends();
          }
        }, icon('close', 14))
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
    const isDM = channel?.type === 'dm';
    const g = !isDM ? guild() : null;

    const askBot = () => {
      const input = $('#input');
      input.value = '!ajuda';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    };

    const actions = isDM
      ? [
          el('button', { class: 'btn btn-ghost', onclick: () => startCall(channel.recipient.id, false) }, icon('phone', 15), ' Ligar'),
          el('button', { class: 'btn btn-ghost', onclick: () => startCall(channel.recipient.id, true) }, icon('video', 15), ' Vídeo')
        ]
      : [
          g ? el('button', { class: 'btn btn-ghost', onclick: () => openModal(modals.invite(g)) }, icon('user-plus', 15), ' Convidar pessoas') : null,
          el('button', { class: 'btn btn-ghost', onclick: askBot }, icon('cpu', 15), ' Ver comandos do bot')
        ];

    container.append(el('div', { class: 'empty' },
      el('div', { class: 'empty-badge' }, icon('message-circle', 32)),
      el('h3', {}, isDM
        ? `Início da conversa com ${channel.recipient?.username}`
        : `Bem-vindo a #${channel?.name ?? ''}`),
      el('p', {}, isDM
        ? 'Mande a primeira mensagem ou comece uma chamada.'
        : 'Mande a primeira mensagem. Dica: digite !ajuda para falar com o Nexy.'),
      el('div', { class: 'empty-actions' }, actions)));
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

  // Confirmação de leitura: "Visto" só embaixo da ÚLTIMA mensagem que eu
  // mandei numa DM, e só quando o timestamp de leitura da outra pessoa já
  // passou dela. Sempre 1 linha só (como whatsapp/imessage), não por msg.
  if (channel?.type === 'dm') {
    const myLast = [...list].reverse().find((m) => m.author.id === state.me.id);
    const theirRead = state.dmReadState.get(channel.id) || 0;
    if (myLast && theirRead >= myLast.createdAt) {
      container.append(el('div', { class: 'read-receipt' }, `Visto ${formatTime(theirRead)}`));
    }
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
    }, icon('reply', 16)),
    mine ? el('button', { class: 'icon-btn', title: 'Editar', onclick: () => editMessage(message) }, icon('edit', 16)) : null,
    (mine || isMod) ? el('button', {
      class: 'icon-btn', title: 'Apagar',
      onclick: () => socket.emit('message:delete', { id: message.id })
    }, icon('trash', 16)) : null);

  const body = el('div', {});

  if (message.replyTo) {
    body.append(el('div', { class: 'msg-reply' },
      icon('reply', 12),
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
    const mine2 = mentionsMe(message.content);
    body.append(el('div', {
      class: `msg-body ${mine2 ? 'has-mention' : ''}`,
      html: highlightMentions(renderMarkdown(message.content)) + (message.editedAt ? '<span class="msg-edited">(editado)</span>' : '')
    }));
  }

  if (message.embed) body.append(embedNode(message.embed, message));

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

async function respondGuildInvite(message, accept) {
  try {
    const { message: updated, guild } = await api.post(`/messages/${message.id}/guild-invite`, { accept });
    const list = state.messages.get(updated.channelId);
    const idx = list?.findIndex((m) => m.id === updated.id);
    if (list && idx > -1) list[idx] = updated;
    renderMessages();
    if (accept && guild) {
      state.guilds.push(guild);
      renderRail();
      toast(`Você entrou em "${guild.name}"!`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function embedNode(embed, message) {
  const node = el('div', { class: 'embed', style: `border-left-color:${embed.color || '#5865f2'}` });

  if (embed.guildInvite) {
    const { guildName, status } = embed.guildInvite;
    node.append(el('div', { class: 'invite-embed-status' },
      status === 'pending'
        ? el('div', { class: 'invite-embed-actions' },
            el('button', { class: 'btn btn-primary', onclick: () => respondGuildInvite(message, true) }, `Entrar em ${guildName}`),
            el('button', { class: 'btn btn-ghost', onclick: () => respondGuildInvite(message, false) }, 'Recusar'))
        : el('div', { class: `invite-embed-resolved ${status}` },
            status === 'accepted' ? `✓ Você entrou em ${guildName}` : '✕ Convite recusado')));
  }

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

const ROLE_LABEL = { owner: 'Dono', admin: 'Admin', mod: 'Moderador', member: 'Membro' };

function renderMembers() {
  const pane = $('#membersList');
  const g = guild();
  if (!g || state.view !== 'guild' || !state.activeChannelId) return;

  const query = ($('#membersSearch')?.value || '').trim().toLowerCase();
  const matches = (m) => !query || m.displayName.toLowerCase().includes(query) || m.username.toLowerCase().includes(query);

  pane.replaceChildren();
  $('#membersCount').textContent = `Membros — ${g.members.length}`;

  const online = g.members.filter((m) => m.status !== 'offline' && matches(m));
  const offline = g.members.filter((m) => m.status === 'offline' && matches(m));

  const row = (member) => el('button', {
    class: `member-row ${member.status === 'offline' ? 'offline' : ''}`,
    onclick: () => openModal(modals.userCard(member, g))
  },
    avatarNode(member, { size: 32 }),
    el('div', { class: 'meta' },
      el('div', { class: 'nm' }, member.displayName, member.isBot ? el('span', { class: 'bot-badge', style: 'margin-left:6px' }, 'BOT') : null),
      el('div', { class: 'sub' }, member.customStatus || `Nível ${member.level} · ${member.coins} 🪙`)),
    member.role !== 'member' ? el('span', { class: `role-tag role-${member.role}` }, ROLE_LABEL[member.role] || member.role) : null);

  const group = (label, list) => {
    if (!list.length) return;
    pane.append(el('div', { class: 'side-label' }, el('span', {}, `${label} — ${list.length}`)));
    for (const member of list) pane.append(row(member));
  };

  // Dentro de "online", donos e admins aparecem primeiro — o resto junto.
  const byRank = (list) => [...list].sort((a, b) => rankOf(b.role) - rankOf(a.role));
  const owners = byRank(online.filter((m) => m.role === 'owner' || m.role === 'admin'));
  const rest = online.filter((m) => m.role !== 'owner' && m.role !== 'admin');

  group('Administração', owners);
  group('Online', rest);
  group('Offline', offline);

  if (!online.length && !offline.length) {
    pane.append(el('p', { style: 'padding:16px 8px;color:var(--text-mute);font-size:13px' }, 'Ninguém encontrado.'));
  }
}

const rankOf = (role) => ({ owner: 3, admin: 2, mod: 1, member: 0 }[role] || 0);

/** Botãozinho de volume que abre um slider (0% a 200%) -- fica num canto
 * do tile de cada outra pessoa na chamada, nunca no seu próprio. */
function volumeControl(userId) {
  const pct = Math.round(getUserVolume(userId) * 100);
  const label = el('span', { class: 'tile-volume-label' }, `${pct}%`);
  const slider = el('input', { type: 'range', min: '0', max: '200', value: String(pct), class: 'tile-volume-slider' });
  const panel = el('div', { class: 'tile-volume-panel', hidden: true }, slider, label);
  const btn = el('button', {
    type: 'button', class: 'tile-volume-btn', title: 'Volume desta pessoa',
    onclick: (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; }
  }, icon('volume', 13));

  slider.addEventListener('input', () => {
    const value = Number(slider.value) / 100;
    label.textContent = `${slider.value}%`;
    setUserVolume(userId, value);
    applyUserVolume(userId, value);
  });
  slider.addEventListener('click', (e) => e.stopPropagation());

  return el('div', { class: 'tile-volume' }, btn, panel);
}

/* ============================================================== voz ===== */

export async function joinVoice(channel, { video = false, ring = false } = {}) {
  try {
    await voice.join(channel.id, { video });
    state.stageCollapsed = false;
    if (ring) socket.emit('call:start', { channelId: channel.id, video });
    renderVoicePanel();
    renderStage();
    renderCallWaitingBanner();
    toast(`Conectado em ${channel.type === 'dm' ? channel.recipient?.username : channel.name}`, 'ok');
  } catch (err) {
    toast(`Não foi possível conectar: ${err.message}`, 'err');
  }
}

function leaveVoice() {
  voice.leave();
  renderVoicePanel();
  renderStage();
  renderCallWaitingBanner();
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

  // DM 1:1 e ainda ninguem alem de voce na chamada -- mostra "Chamando..."
  // em vez do grid vazio, igual o Discord faz.
  const waitingChannel = channelById(voice.channelId);
  const waitingOverlay = $('#stageWaiting');
  if (waitingOverlay) {
    const waiting = waitingChannel?.type === 'dm' && tiles.length <= 1;
    waitingOverlay.hidden = !waiting;
    if (waiting) {
      const other = waitingChannel.recipient;
      $('#stageWaitingAvatar').replaceWith(Object.assign(
        avatarNode(other, { size: 96, status: false }), { id: 'stageWaitingAvatar', className: 'avatar big' }));
      $('#stageWaitingName').textContent = other?.username ?? '';
    }
  }

  for (const tile of tiles) {
    for (const [kind, stream] of [['cam', tile.video], ['screen', tile.screen]]) {
      const key = `${tile.key}:${kind}`;
      if (!stream) continue;
      seen.add(key);
      let node = grid.querySelector(`[data-tile="${key}"]`);
      if (!node) {
        node = el('div', { class: `tile${kind === 'screen' ? ' screen' : ''}`, dataset: { tile: key } },
          el('video', { autoplay: true, playsInline: true, muted: tile.self }),
          el('div', { class: 'tile-name' }, `${tile.user?.username ?? ''}`),
          kind === 'screen' ? el('div', { class: 'tile-tag' }, icon('monitor', 12), 'tela') : null,
          (!tile.self && kind === 'cam') ? volumeControl(tile.user?.id) : null);
        grid.append(node);
      }
      const video = node.querySelector('video');
      if (video.srcObject !== stream) video.srcObject = stream;
      if (!tile.self) applyAudioOutput(video);
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
          el('div', { class: 'tile-name' }, tile.user?.username ?? ''),
          !tile.self ? volumeControl(tile.user?.id) : null);
        grid.append(node);
      }
      node.classList.toggle('speaking', !!tile.speaking);
      const flag = tile.state?.muted ? '🔇' : '';
      node.querySelector('.tile-name').textContent = `${flag} ${tile.user?.username ?? ''}`.trim();
    }
  }

  for (const node of grid.querySelectorAll('[data-tile]')) {
    if (!seen.has(node.dataset.tile)) node.remove();
  }

  // Modo "spotlight" (Zoom/Meet): com alguem compartilhando tela, ela vira
  // grande na area principal e o resto encolhe numa faixa lateral.
  const screenTiles = [...grid.querySelectorAll('.tile.screen')];
  const otherTiles = [...grid.querySelectorAll('.tile:not(.screen)')];
  if (screenTiles.length) {
    grid.classList.add('spotlight');
    let main = grid.querySelector(':scope > .spotlight-main');
    if (!main) { main = el('div', { class: 'spotlight-main' }); grid.append(main); }
    let side = grid.querySelector(':scope > .spotlight-side');
    if (!side) { side = el('div', { class: 'spotlight-side' }); grid.append(side); }
    for (const node of screenTiles) main.append(node);
    for (const node of otherTiles) side.append(node);
  } else {
    grid.classList.remove('spotlight');
    for (const node of [...screenTiles, ...otherTiles]) grid.append(node);
    grid.querySelector(':scope > .spotlight-main')?.remove();
    grid.querySelector(':scope > .spotlight-side')?.remove();
  }

  $('#stageMic').classList.toggle('active', !voice.state.muted);
  $('#stageMic .pill-icon').replaceChildren(icon(voice.state.muted ? 'mic-off' : 'mic', 16));
  $('#stageMic .pill-label').textContent = voice.state.muted ? 'Mudo' : 'Falando';
  $('#stageCam').classList.toggle('active', voice.state.video);
  $('#stageScreen').classList.toggle('active', voice.state.screen);

  const anyScreenShared = tiles.some((t) => t.screen);
  $('#stageFullscreen').hidden = !anyScreenShared && !document.fullscreenElement;
}

/** Aplica a saída de áudio escolhida (Configurações → Voz e vídeo) num
 * elemento <audio>/<video> -- só existe suporte real no Chrome/Edge; nos
 * outros o navegador ignora e toca no dispositivo padrão do sistema mesmo. */
export function applyAudioOutput(mediaEl) {
  const sinkId = voice?.deviceIds?.audioOutput;
  if (!sinkId || typeof mediaEl.setSinkId !== 'function') return;
  mediaEl.setSinkId(sinkId).catch(() => { /* dispositivo pode ter sumido -- ignora */ });
}

/* -------------------------------------------- volume por pessoa na call -- */
// <audio>.volume sozinho não passa de 100% -- pra "aumentar o áudio de
// alguém" de verdade (acima do normal) precisa passar o som por um
// GainNode do Web Audio. Preferência fica salva por pessoa (não por
// chamada), então já volta aplicada da próxima vez que ela falar de novo.
const VOLUME_KEY_PREFIX = 'nexus.volume.';
export const getUserVolume = (userId) => {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY_PREFIX + userId));
    return Number.isFinite(v) ? v : 1;
  } catch { return 1; }
};
export const setUserVolume = (userId, value) => {
  try { localStorage.setItem(VOLUME_KEY_PREFIX + userId, String(value)); } catch { /* ignora */ }
};

let audioCtx = null;
let lastAppliedSinkId = '';
const gainNodes = new Map(); // streamId -> { gain: GainNode, userId }

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

/** Muda o ganho ao vivo, sem esperar o próximo syncAudio() -- é o que o
 * slider chama a cada arrasto. */
export function applyUserVolume(userId, value) {
  for (const node of gainNodes.values()) {
    if (node.userId === userId) node.gain.gain.value = value;
  }
}

/** Reproduz o áudio remoto fora da grade (funciona mesmo sem vídeo). */
function syncAudio() {
  const sink = $('#audioSink');
  const wanted = new Map(); // streamId -> { stream, userId }

  for (const peer of voice?.peers.values() || []) {
    for (const [streamId, stream] of peer.streams) {
      if (stream.getAudioTracks().length) wanted.set(streamId, { stream, userId: peer.user?.id });
    }
  }

  // Saída de áudio agora é escolhida no AudioContext (todo áudio remoto
  // passa por ele pro ganho funcionar) -- só reaplica quando o dispositivo
  // escolhido realmente muda, pra não dar uma piscada de áudio à toa.
  const ctx = wanted.size ? getAudioCtx() : audioCtx;
  const sinkId = voice?.deviceIds?.audioOutput || '';
  if (ctx && typeof ctx.setSinkId === 'function' && sinkId !== lastAppliedSinkId) {
    lastAppliedSinkId = sinkId;
    ctx.setSinkId(sinkId || '').catch(() => { /* dispositivo pode ter sumido -- ignora */ });
  }

  for (const [streamId, { stream, userId }] of wanted) {
    let audio = sink.querySelector(`[data-stream="${streamId}"]`);
    if (!audio) {
      audio = el('audio', { autoplay: true, dataset: { stream: streamId } });
      sink.append(audio);
    }
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.muted = !!voice.state.deafened;
    audio.play?.().catch(() => { /* aguarda gesto do usuário */ });

    if (!gainNodes.has(streamId)) {
      try {
        const source = ctx.createMediaElementSource(audio);
        const gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination);
        gainNodes.set(streamId, { gain, userId });
      } catch {
        // Se o navegador recusar (raro), o <audio> ainda toca no volume
        // normal por conta própria -- só o boost acima de 100% não funciona.
      }
    }
    const node = gainNodes.get(streamId);
    if (node) node.gain.gain.value = userId ? getUserVolume(userId) : 1;
  }

  for (const audio of [...sink.querySelectorAll('audio[data-stream]')]) {
    if (!wanted.has(audio.dataset.stream)) {
      gainNodes.get(audio.dataset.stream)?.gain.disconnect();
      gainNodes.delete(audio.dataset.stream);
      audio.remove();
    }
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

/** Substitui os emojis usados como ícone de UI por SVGs de traço. */
function mountStaticIcons() {
  const map = {
    btnAddGuild: ['plus', 20],
    guildMenuChevron: ['chevron-down', 16],
    btnScreen: ['monitor', 16],
    btnCam: ['video', 16],
    btnHangup: ['phone', 16],
    btnMic: ['mic', 16],
    btnDeaf: ['headphones', 16],
    btnSettings: ['sliders', 16],
    verifyDismiss: ['close', 14],
    btnBack: ['chevron-left', 18],
    btnCall: ['phone', 16],
    btnVideoCall: ['video', 16],
    btnConvSound: ['bell', 16],
    btnBotPanel: ['cpu', 16],
    btnMembers: ['users', 16],
    btnNavToggle: ['sidebar', 17],
    membersClose: ['close', 16],
    replyCancel: ['close', 14],
    membersInviteBtn: ['user-plus', 15]
  };
  for (const [id, [name, size]] of Object.entries(map)) {
    const node = document.getElementById(id);
    if (node) node.replaceChildren(icon(name, size));
  }
  $('#composer .send').replaceChildren(icon('send', 16));
  $('#stageCam .pill-icon').replaceChildren(icon('video', 16));
  $('#stageScreen .pill-icon').replaceChildren(icon('monitor', 16));
  $('#stageFullscreen .pill-icon').replaceChildren(icon('maximize', 16));
}

/**
 * Alça arrastável entre o palco de chamada e o chat: deixa a pessoa decidir
 * o quanto de espaço a chamada ocupa, em vez de uma altura fixa que tanto
 * pode sobrar (chat espremido) quanto faltar (vídeo pequeno).
 */
function bindStageResize() {
  const stage = $('#stage');
  const handle = $('#stageResize');
  if (!stage || !handle) return;

  const MIN = 220;
  const saved = Number(localStorage.getItem('nexus.stageHeight'));
  if (saved > 0) stage.style.setProperty('--stage-h', `${saved}px`);

  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (stage.classList.contains('is-fullscreen')) return;
    dragging = true;
    startY = e.clientY;
    startH = stage.getBoundingClientRect().height;
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const max = window.innerHeight * 0.88;
    const h = Math.min(max, Math.max(MIN, startH + (e.clientY - startY)));
    stage.style.setProperty('--stage-h', `${h}px`);
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem('nexus.stageHeight', String(Math.round(stage.getBoundingClientRect().height)));
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);

  handle.addEventListener('dblclick', () => {
    stage.style.removeProperty('--stage-h');
    localStorage.removeItem('nexus.stageHeight');
  });
}

/* ==================================================== menção (@) ==== */

/** Quem dá pra @mencionar na conversa aberta agora -- o outro lado numa
 * DM, ou todo mundo do servidor num canal de texto. */
function mentionCandidates() {
  const channel = channelById(state.activeChannelId);
  if (!channel) return [];
  if (channel.type === 'dm') return channel.recipient ? [channel.recipient] : [];
  return guild()?.members || [];
}

let mention = null; // { start, query, candidates, index } -- null quando o menu tá fechado

function closeMentionMenu() {
  mention = null;
  $('#mentionMenu').hidden = true;
}

function renderMentionMenu() {
  const menu = $('#mentionMenu');
  if (!mention || !mention.candidates.length) { menu.hidden = true; return; }
  // replaceChildren(...nodes) espera os nós como argumentos separados --
  // passar o array direto (sem espalhar) não lança erro, só vira o texto
  // literal "[object HTMLButtonElement]" na tela (já vi essa antes).
  menu.replaceChildren(...mention.candidates.map((user, i) => el('button', {
    type: 'button',
    class: `mention-option ${i === mention.index ? 'active' : ''}`,
    onmousedown: (e) => e.preventDefault(), // não perde o foco do textarea ao clicar
    onclick: () => insertMention(user)
  },
    avatarNode(user, { size: 22, status: false }),
    el('span', { class: 'name' }, user.displayName || user.username),
    el('span', { class: 'tag' }, `#${user.tag}`))));
  menu.hidden = false;
}

/** Olha o texto antes do cursor: tem um "@algo" sem espaço colado nele?
 * Se tiver, abre/atualiza o menu com quem bate com "algo"; senão fecha. */
function updateMentionMenu() {
  const input = $('#input');
  const upToCursor = input.value.slice(0, input.selectionStart);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(upToCursor);
  if (!match) return closeMentionMenu();

  const query = match[1].toLowerCase();
  const candidates = mentionCandidates()
    .filter((u) => u.username.toLowerCase().startsWith(query) || (u.displayName || '').toLowerCase().startsWith(query))
    .slice(0, 8);
  if (!candidates.length) return closeMentionMenu();

  mention = { start: upToCursor.length - match[1].length - 1, query, candidates, index: 0 };
  renderMentionMenu();
}

function insertMention(user) {
  const input = $('#input');
  const name = user.displayName || user.username;
  const before = input.value.slice(0, mention.start);
  const after = input.value.slice(mention.start + 1 + mention.query.length);
  input.value = `${before}@${name} ${after}`;
  const caret = before.length + name.length + 2;
  input.focus();
  input.setSelectionRange(caret, caret);
  closeMentionMenu();
}

function bindUI() {
  mountStaticIcons();
  $('#railHome').addEventListener('click', openHome);
  $('#wsTrigger').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('#wsMenu');
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      const r = $('#wsTrigger').getBoundingClientRect();
      menu.style.top = `${r.top}px`;
      menu.style.left = `${r.right + 8}px`;
    }
  });
  document.addEventListener('click', (event) => {
    if (!$('#wsMenu').hidden && !$('#wsSwitcher').contains(event.target)) $('#wsMenu').hidden = true;
  });
  $('#btnAddGuild').addEventListener('click', () => openModal(modals.addGuild()));
  $('#btnBack').addEventListener('click', () => document.getElementById('app').classList.remove('chat-open'));

  $('#stageFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      $('#stage').requestFullscreen?.().catch(() => toast('Não consegui abrir em tela cheia.', 'err'));
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const active = !!document.fullscreenElement;
    $('#stage').classList.toggle('is-fullscreen', active);
    $('#stageFullscreen .pill-label').textContent = active ? 'Sair da tela cheia' : 'Tela cheia';
    $('#stageFullscreen .pill-icon').replaceChildren(icon(active ? 'minimize' : 'maximize', 16));
  });

  bindStageResize();

  $('#sidebarHeader').addEventListener('click', () => {
    if (state.view === 'guild') openModal(modals.guildMenu(guild()));
  });

  $('#btnUserSettings').addEventListener('click', () => openModal(modals.userSettings()));
  $('#btnSettings').addEventListener('click', () => openModal(modals.userSettings()));
  $('#btnMembers').addEventListener('click', () => { $('#membersPane').hidden = !$('#membersPane').hidden; });
  $('#membersClose').addEventListener('click', () => { $('#membersPane').hidden = true; });
  $('#membersSearch').addEventListener('input', debounce(renderMembers, 120));
  $('#membersInviteBtn').addEventListener('click', () => { const g = guild(); if (g) openModal(modals.invite(g)); });

  const appEl = document.getElementById('app');
  if (localStorage.getItem('nexus.navCollapsed') === 'on') appEl.classList.add('nav-collapsed');
  $('#btnNavToggle').addEventListener('click', () => {
    const collapsed = appEl.classList.toggle('nav-collapsed');
    localStorage.setItem('nexus.navCollapsed', collapsed ? 'on' : 'off');
  });
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
  $('#voicePanel').addEventListener('click', (event) => {
    if (event.target.closest('.voice-actions')) return; // botões próprios já tratados acima
    state.stageCollapsed = !state.stageCollapsed;
    renderStage();
  });

  $('#btnCall').addEventListener('click', () => {
    const channel = channelById(state.activeChannelId);
    if (channel) joinVoice(channel, { ring: !channelHasWaitingCall(channel.id) });
  });
  $('#btnVideoCall').addEventListener('click', () => {
    const channel = channelById(state.activeChannelId);
    if (channel) joinVoice(channel, { video: true, ring: !channelHasWaitingCall(channel.id) });
  });
  $('#callWaitingJoin').addEventListener('click', () => {
    const channel = channelById(state.activeChannelId);
    if (channel) joinVoice(channel);
  });
  $('#btnConvSound').addEventListener('click', () => {
    const channel = channelById(state.activeChannelId);
    if (channel) openModal(modals.conversationSound(channel));
  });

  $('#ringAccept').addEventListener('click', async () => {
    const call = state.pendingCall;
    $('#ringOverlay').hidden = true;
    stopRingtone();
    state.pendingCall = null;
    if (!call) return;
    await openChannel(call.channelId);
    await joinVoice(channelById(call.channelId), { video: call.video });
  });
  $('#ringDecline').addEventListener('click', () => {
    const call = state.pendingCall;
    $('#ringOverlay').hidden = true;
    stopRingtone();
    state.pendingCall = null;
    if (call) socket.emit('call:decline', { channelId: call.channelId });
  });

  $('#verifyDismiss').addEventListener('click', () => { $('#verifyBanner').hidden = true; });

  $('#notifBannerDismiss').addEventListener('click', () => {
    localStorage.setItem(NOTIF_BANNER_DISMISS_KEY, 'on');
    $('#notifBanner').hidden = true;
  });
  $('#notifBannerEnable').addEventListener('click', async () => {
    const ok = await enableOsNotifications();
    toast(ok ? 'Notificações ativadas!' : 'Permissão recusada pelo navegador.', ok ? 'ok' : 'err');
    localStorage.setItem(NOTIF_BANNER_DISMISS_KEY, 'on');
    $('#notifBanner').hidden = true;
  });
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
    updateMentionMenu();
  });

  input.addEventListener('keydown', (event) => {
    if (mention) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        mention.index = (mention.index + 1) % mention.candidates.length;
        renderMentionMenu();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        mention.index = (mention.index - 1 + mention.candidates.length) % mention.candidates.length;
        renderMentionMenu();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertMention(mention.candidates[mention.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentionMenu();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  // Clicar fora fecha o menu de menção (o próprio botão já usa
  // onmousedown:preventDefault pra não disparar isso antes do clique valer).
  document.addEventListener('click', (event) => {
    if (mention && !$('#mentionMenu').contains(event.target) && event.target !== input) closeMentionMenu();
  });
  // Fecha qualquer slider de volume aberto ao clicar fora dele -- um só
  // listener pra todos os tiles (eles vêm e vão conforme gente entra/sai
  // da chamada, então cada um ter o próprio listener vazaria memória).
  document.addEventListener('click', (event) => {
    if (event.target.closest('.tile-volume')) return;
    for (const panel of $$('.tile-volume-panel')) panel.hidden = true;
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
    closeMentionMenu();
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
  start().catch(() => { token.clear(); $('#loading').hidden = true; $('#auth').hidden = false; });
} else {
  $('#loading').hidden = true;
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
