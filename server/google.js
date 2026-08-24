'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const store = require('./store');
const { signToken } = require('./auth');
const { run } = require('./db');
const invites = require('./invites');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const isEnabled = () => !!CLIENT_ID;

/** Cache das chaves públicas do Google (elas rodam a cada poucas horas). */
let cache = { keys: null, expiresAt: 0 };

async function googleKeys() {
  if (cache.keys && Date.now() < cache.expiresAt) return cache.keys;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error('Não foi possível validar o login do Google');

  const { keys } = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1];
  cache = {
    keys,
    expiresAt: Date.now() + (Number(maxAge) || 3600) * 1000
  };
  return keys;
}

/** Valida o ID token emitido pelo Google Identity Services. */
async function verifyIdToken(credential) {
  if (!isEnabled()) throw new Error('Login com Google não está configurado neste servidor');
  if (!credential) throw new Error('Credencial ausente');

  const header = JSON.parse(
    Buffer.from(String(credential).split('.')[0] || '', 'base64url').toString('utf8') || '{}'
  );

  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Chave de assinatura desconhecida');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });

  const payload = jwt.verify(credential, publicKey, {
    algorithms: ['RS256'],
    audience: CLIENT_ID,
    issuer: ISSUERS
  });

  if (payload.email && payload.email_verified === false) {
    throw new Error('Este e-mail do Google ainda não foi verificado');
  }
  return payload;
}

/** Nome de usuário livre a partir do nome vindo do Google. */
function usernameFrom(payload) {
  const raw = String(payload.given_name || payload.name || payload.email?.split('@')[0] || 'usuario');
  const clean = raw.trim().replace(/[^\w .\-À-ÿ]/gu, '').slice(0, 32);
  return clean.length >= 2 ? clean : 'usuario';
}

/**
 * Entra ou registra usando a conta do Google.
 * Se já existir uma conta com o mesmo e-mail, as contas são vinculadas.
 */
async function loginWithGoogle(credential, inviteCode = null) {
  const payload = await verifyIdToken(credential);

  let user = await store.getUserByGoogleSub(payload.sub);

  if (!user && payload.email) {
    user = await store.getUserByEmail(payload.email);
    if (user) await run('UPDATE users SET google_sub = ? WHERE id = ?', payload.sub, user.id);
  }

  if (!user) {
    // Conta nova pelo Google tambem precisa de convite quando o cadastro
    // esta fechado.
    await invites.assertUsable(inviteCode);

    // Nome tem que ser unico -- sem tela de cadastro pra pedir outro nome
    // nesse fluxo, entao so acrescenta um numero ate achar um livre.
    let username = usernameFrom(payload);
    if (await store.usernameTaken(username)) {
      let n = 2;
      while (await store.usernameTaken(`${username}${n}`)) n++;
      username = `${username}${n}`;
    }

    user = await store.createUser({
      username,
      email: payload.email ? String(payload.email).toLowerCase() : null,
      passwordHash: null
    });
    await run('UPDATE users SET google_sub = ? WHERE id = ?', payload.sub, user.id);

    if (!(await invites.isOpen())) {
      const code = await invites.consume(inviteCode, user.id);
      // Mesma regra do cadastro por e-mail: o convite ja vem com amizade.
      if (code?.created_by) await store.autoFriend(code.created_by, user.id);
    }

    // Foto de perfil inicial, só na criação da conta — em logins seguintes
    // isso sobrescreveria uma foto que a pessoa tenha trocado depois.
    if (payload.picture) await run('UPDATE users SET avatar_url = ? WHERE id = ?', payload.picture, user.id);
  }

  // O Google ja confirmou o endereco: nao precisamos verificar de novo.
  if (payload.email_verified) await run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);

  user = await store.getUser(user.id);
  return { user: store.publicUser(user), token: signToken(user.id) };
}

module.exports = { loginWithGoogle, verifyIdToken, isEnabled, CLIENT_ID };
