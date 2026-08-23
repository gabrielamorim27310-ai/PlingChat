'use strict';

const crypto = require('node:crypto');
const { all, get, run } = require('./db');
const store = require('./store');

/**
 * Envio de e-mail pela API HTTP do Resend — sem SDK, só fetch.
 *
 * Sem RESEND_API_KEY o módulo fica inerte: nada quebra, e as rotas que
 * dependem dele avisam que a recuperação de senha não está configurada.
 */

const API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'PlingChat <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

const isEnabled = () => !!API_KEY;

const TTL = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000
};

async function send({ to, subject, html }) {
  if (!isEnabled()) throw new Error('O envio de e-mail não está configurado neste servidor');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, html })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Falha ao enviar e-mail (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------- tokens --- */

async function createToken(userId, kind) {
  // Invalida tokens anteriores do mesmo tipo: só o último vale.
  await run('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?', userId, kind);

  const token = crypto.randomBytes(32).toString('base64url');
  await run('INSERT INTO email_tokens (token, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
    token, userId, kind, Date.now() + TTL[kind]);
  return token;
}

async function consumeToken(token, kind) {
  const row = await get('SELECT * FROM email_tokens WHERE token = ? AND kind = ?', String(token || ''), kind);
  if (!row) throw new Error('Link inválido');
  if (row.used_at) throw new Error('Este link já foi usado');
  if (row.expires_at < Date.now()) throw new Error('Este link expirou. Peça outro.');

  await run('UPDATE email_tokens SET used_at = ? WHERE token = ?', Date.now(), token);
  return row.user_id;
}

/* ------------------------------------------------------------ modelos --- */

const layout = (title, body, cta) => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b0d12;padding:32px;color:#e6e9f0">
  <div style="max-width:520px;margin:0 auto;background:#161a23;border:1px solid #262c3a;border-radius:14px;padding:32px">
    <div style="color:#7b86ff;font-weight:700;font-size:18px;margin-bottom:20px">⬢ PlingChat</div>
    <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
    <p style="color:#9aa3b5;font-size:14px;line-height:1.6;margin:0 0 24px">${body}</p>
    ${cta ? `<a href="${cta.url}" style="display:inline-block;background:#5865f2;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px">${cta.label}</a>
    <p style="color:#6b7488;font-size:12px;margin:22px 0 0;word-break:break-all">Se o botão não funcionar, copie este endereço:<br>${cta.url}</p>` : ''}
  </div>
</div>`;

async function sendVerification(user) {
  if (!isEnabled() || !user.email) return false;
  const token = await createToken(user.id, 'verify');
  await send({
    to: user.email,
    subject: 'Confirme seu e-mail no PlingChat',
    html: layout(
      `Olá, ${user.username}!`,
      'Confirme seu endereço de e-mail para garantir que você consegue recuperar sua conta depois. O link vale por 24 horas.',
      { url: `${APP_URL}/?verificar=${token}`, label: 'Confirmar e-mail' }
    )
  });
  return true;
}

async function sendPasswordReset(user) {
  if (!isEnabled() || !user.email) return false;
  const token = await createToken(user.id, 'reset');
  await send({
    to: user.email,
    subject: 'Redefinir sua senha do PlingChat',
    html: layout(
      `Olá, ${user.username}`,
      'Recebemos um pedido para redefinir sua senha. O link vale por 1 hora. Se não foi você, pode ignorar este e-mail — sua senha continua a mesma.',
      { url: `${APP_URL}/?redefinir=${token}`, label: 'Criar nova senha' }
    )
  });
  return true;
}

const markVerified = (userId) => run('UPDATE users SET email_verified = 1 WHERE id = ?', userId);

module.exports = {
  isEnabled, send, createToken, consumeToken,
  sendVerification, sendPasswordReset, markVerified, APP_URL
};
