'use strict';

/**
 * Sons e notificações do sistema para mensagem/chamada. Tudo fica
 * silenciosamente desligado se o navegador não suportar ou a permissão não
 * tiver sido concedida — nunca quebra o resto do app.
 */

const SOUND_KEY = 'nexus.soundsEnabled';
const OS_KEY = 'nexus.osNotifications';

const pling = new Audio('/sounds/pling.wav');
const ring = new Audio('/sounds/ring.wav');
ring.loop = true;

export const soundsEnabled = () => localStorage.getItem(SOUND_KEY) !== 'off';
export const setSoundsEnabled = (on) => localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');

/** Toca o "pling" de mensagem nova. Silencioso se o navegador ainda bloquear autoplay. */
export function playPling() {
  if (!soundsEnabled()) return;
  pling.currentTime = 0;
  pling.play().catch(() => {});
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

/** Mostra uma notificação do sistema -- só quando a aba não está em foco. */
export function notifyOS(title, body, { tag, onClick } = {}) {
  if (!osNotificationsEnabled() || document.hasFocus()) return;
  try {
    const iconHref = document.querySelector('link[rel="icon"]')?.href;
    const n = new Notification(title, { body, tag, icon: iconHref });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
  } catch {
    // navegador pode recusar silenciosamente (ex: aba nao segura) -- ignora
  }
}
