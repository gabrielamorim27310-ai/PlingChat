'use strict';

/**
 * Notificacoes push (Web Push / VAPID). Sem as chaves o modulo fica inerte
 * e o front simplesmente nao oferece o botao de ativar notificacoes.
 *
 * As chaves VAPID sao geradas uma vez (webpush.generateVAPIDKeys()) e nao
 * dependem de nenhuma conta externa — sao só um par de chaves ECDSA que o
 * proprio servidor usa pra assinar os pushes.
 */

const webpush = require('web-push');
const store = require('./store');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:nao-responda@PlingChat.app';

const isEnabled = () => !!(PUBLIC_KEY && PRIVATE_KEY);

if (isEnabled()) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

/**
 * Manda um push pra todos os dispositivos inscritos de um usuario.
 * Silencioso: notificacao push e "melhor esforco", nunca deve derrubar
 * o fluxo principal de entrega de mensagem.
 */
async function notify(userId, { title, body, tag = null, url = '/' }) {
  if (!isEnabled()) return;
  const subs = await store.listSubscriptions(userId);
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, tag, url });

  await Promise.all(subs.map(async (sub) => {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(target, payload);
    } catch (err) {
      // 404/410 = inscricao morta (usuario desinstalou, limpou dados, etc.) — remove.
      if (err.statusCode === 404 || err.statusCode === 410) await store.removeSubscription(sub.endpoint);
      else console.warn('push: falha ao enviar', err.statusCode || err.message);
    }
  }));
}

module.exports = { isEnabled, notify, PUBLIC_KEY };
