'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const store = require('./store');
const invites = require('./invites');
const { DATA_DIR } = require('./db');

/** Segredo persistido em disco para os tokens sobreviverem a um restart. */
function loadSecret() {
  if (process.env.NEXUS_SECRET) return process.env.NEXUS_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const SECRET = loadSecret();
const TOKEN_TTL = '30d';

const signToken = (userId) => jwt.sign({ sub: userId }, SECRET, { expiresIn: TOKEN_TTL });

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET).sub;
  } catch {
    return null;
  }
}

async function register({ username, email, password, inviteCode }) {
  username = String(username || '').trim();
  email = String(email || '').trim().toLowerCase();

  if (!/^[\w .\-À-ÿ]{2,32}$/u.test(username)) throw new Error('Nome de usuario invalido (2 a 32 caracteres)');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-mail invalido');
  if (String(password || '').length < 6) throw new Error('A senha precisa de pelo menos 6 caracteres');
  if (store.getUserByEmail(email)) throw new Error('Ja existe uma conta com este e-mail');

  // Valida o convite antes de criar qualquer coisa.
  invites.assertUsable(inviteCode);

  const passwordHash = await bcrypt.hash(password, 10);
  const user = store.createUser({ username, email, passwordHash });

  if (!invites.isOpen()) {
    const code = invites.consume(inviteCode, user.id);
    // O convite ja vem com amizade: quem convidou e quem chegou nao precisam
    // se pedir amizade depois, ja se conhecem.
    if (code?.created_by) store.autoFriend(code.created_by, user.id);
  }

  return { user: store.publicUser(user), token: signToken(user.id) };
}

/** Troca a senha de um usuario, usada pela recuperacao por e-mail. */
async function setPassword(userId, password) {
  if (String(password || '').length < 6) throw new Error('A senha precisa de pelo menos 6 caracteres');
  const hash = await bcrypt.hash(password, 10);
  require('./db').run('UPDATE users SET password_hash = ? WHERE id = ?', hash, userId);
  return store.getUser(userId);
}

async function login({ email, password }) {
  const user = store.getUserByEmail(String(email || '').trim().toLowerCase());
  if (!user || !user.password_hash) throw new Error('E-mail ou senha incorretos');
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw new Error('E-mail ou senha incorretos');
  return { user: store.publicUser(user), token: signToken(user.id) };
}

/** Middleware Express: exige um Bearer token valido. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token && verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Nao autenticado' });
  const user = store.getUser(userId);
  if (!user) return res.status(401).json({ error: 'Sessao invalida' });
  req.user = user;
  next();
}

module.exports = { register, login, setPassword, signToken, verifyToken, requireAuth };
