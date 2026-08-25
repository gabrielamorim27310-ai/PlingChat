'use strict';

/**
 * Sons e notificações do sistema para mensagem/chamada. Tudo fica
 * silenciosamente desligado se o navegador não suportar ou a permissão não
 * tiver sido concedida — nunca quebra o resto do app.
 */

const SOUND_KEY = 'nexus.soundsEnabled';
const OS_KEY = 'nexus.osNotifications';
const CONV_SOUND_PREFIX = 'nexus.convSound.';

/** Sons alternativos pra notificação -- dá pra escolher um diferente por
 * amigo ou servidor (ver conversationSettings() em modals.js), pra dar de
 * ouvido só quem tá chamando sem nem olhar a tela. */
export const SOUND_OPTIONS = [
  { value: 'default', label: 'Pling (padrão)', file: '/sounds/pling.wav' },
  { value: 'marimba', label: 'Marimba', file: '/sounds/notif-marimba.wav' },
  { value: 'bell', label: 'Sino', file: '/sounds/notif-bell.wav' },
  { value: 'pop', label: 'Pop', file: '/sounds/notif-pop.wav' },
  { value: 'arpeggio', label: 'Arpejo', file: '/sounds/notif-arpeggio.wav' }
];

const ring = new Audio('/sounds/ring.wav');
ring.loop = true;

const soundCache = new Map();
function soundAudio(value) {
  const opt = SOUND_OPTIONS.find((o) => o.value === value) || SOUND_OPTIONS[0];
  if (!soundCache.has(opt.value)) soundCache.set(opt.value, new Audio(opt.file));
  return soundCache.get(opt.value);
}
const pling = soundAudio('default');

/** Chave da conversa (DM ou servidor) pra som personalizado -- `null` cai
 * sempre no padrão. */
export const convSoundKey = (channel) =>
  !channel ? null : channel.type === 'dm' ? `dm:${channel.id}` : channel.guildId ? `guild:${channel.guildId}` : null;

export function getConversationSound(key) {
  if (!key) return 'default';
  try { return localStorage.getItem(CONV_SOUND_PREFIX + key) || 'default'; } catch { return 'default'; }
}
export function setConversationSound(key, value) {
  if (!key) return;
  try {
    if (!value || value === 'default') localStorage.removeItem(CONV_SOUND_PREFIX + key);
    else localStorage.setItem(CONV_SOUND_PREFIX + key, value);
  } catch { /* ignora */ }
}

/* -------------------------------------------------------- plataforma --- */

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
// iPadOS reporta plataforma "MacIntel" igual um Mac de verdade desde o
// iOS 13 -- toque com mais de 1 ponto é o jeito de diferenciar (Mac normal
// não tem tela sensível ao toque).
export const isMac = () => /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1;
export const isStandaloneApp = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const soundsEnabled = () => localStorage.getItem(SOUND_KEY) !== 'off';
export const setSoundsEnabled = (on) => localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');

/**
 * iOS (e Android em menor grau) só deixa tocar áudio depois de um toque de
 * verdade -- chamar .play() de dentro de um evento de socket não conta.
 * "Destrava" os dois sons tocando e pausando na hora, dentro do mesmo toque.
 * Chamado uma vez só, no primeiro toque na página inteira.
 */
let audioUnlocked = false;
export function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  // Destrava todo som que a pessoa possa vir a ouvir, não só o padrão --
  // senão o primeiro "pling" com som personalizado de um amigo ficaria
  // mudo no iOS (cada elemento de áudio precisa do próprio toque).
  for (const a of [...SOUND_OPTIONS.map((o) => soundAudio(o.value)), ring]) {
    const p = a.play();
    if (p?.catch) p.catch(() => {});
    a.pause();
    a.currentTime = 0;
  }
}

/** Toca o "pling" de mensagem nova -- `convKey` (ver convSoundKey) escolhe
 * o som personalizado daquela conversa, se a pessoa tiver trocado.
 * Silencioso se o navegador ainda bloquear autoplay. */
export function playPling(convKey) {
  if (!soundsEnabled()) return;
  const audio = soundAudio(getConversationSound(convKey));
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

export function startRingtone() {
  if (!soundsEnabled()) return;
  ring.currentTime = 0;
  ring.play().catch(() => {});
}

export function stopRingtone() {
  ring.pause();
  ring.currentTime = 0;
}

/* --------------------------------------------------- notificações do SO --- */

const supportsNotification = () => typeof Notification !== 'undefined';

export const osNotificationsEnabled = () =>
  supportsNotification() && Notification.permission === 'granted' && localStorage.getItem(OS_KEY) !== 'off';

/** Pede permissão -- só deve ser chamado a partir de um clique do usuário. */
export async function enableOsNotifications() {
  if (!supportsNotification()) return false;
  const perm = await Notification.requestPermission();
  const ok = perm === 'granted';
  localStorage.setItem(OS_KEY, ok ? 'on' : 'off');
  return ok;
}

export function disableOsNotifications() {
  localStorage.setItem(OS_KEY, 'off');
}

/**
 * Mostra uma notificação do sistema -- só quando a aba não está em foco.
 * Prefere passar pelo service worker (ServiceWorkerRegistration.
 * showNotification): é a única forma que funciona num PWA instalado no
 * iPhone -- o construtor direto `new Notification()` não é confiável lá.
 * Cai pro construtor direto só se não tiver service worker mesmo.
 */
export async function notifyOS(title, body, { tag, url, onClick } = {}) {
  if (!osNotificationsEnabled() || document.hasFocus()) return;
  const iconHref = document.querySelector('link[rel="icon"]')?.href;

  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready.catch(() => null) : null;
  if (reg?.showNotification) {
    reg.showNotification(title, { body, tag, icon: iconHref, data: { url } }).catch(() => {});
    return;
  }

  try {
    const n = new Notification(title, { body, tag, icon: iconHref });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
  } catch {
    // navegador pode recusar silenciosamente (ex: aba nao segura) -- ignora
  }
}
