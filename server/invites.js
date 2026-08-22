'use strict';

const { all, get, run } = require('./db');

/**
 * Registro por convite.
 *
 * SIGNUP_MODE controla o comportamento:
 *   invite (padrão) — só cria conta quem apresentar um código válido
 *   open            — qualquer pessoa se cadastra
 *
 * A primeira conta do banco é sempre liberada, senão não haveria como
 * gerar o primeiro convite.
 */

const MODE = (process.env.SIGNUP_MODE || 'invite').toLowerCase() === 'open' ? 'open' : 'invite';

const MAX_ACTIVE_PER_USER = Number(process.env.MAX_INVITES_PER_USER) || 5;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const userCount = () => get('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0').n;

/** O cadastro está aberto agora? (primeira conta sempre pode). */
const isOpen = () => MODE === 'open' || userCount() === 0;

function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 10; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      if (i === 4) code += '-';
    }
    if (!get('SELECT 1 FROM signup_codes WHERE code = ?', code)) return code;
  }
}

const normalize = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

function findCode(code) {
  return get('SELECT * FROM signup_codes WHERE code = ?', normalize(code));
}

/** Valida sem consumir. Lança com mensagem pronta para o usuário. */
function assertUsable(code) {
  if (isOpen()) return null;

  const row = findCode(code);
  if (!row) throw new Error('Código de convite inválido. Peça um a quem já usa o PlingChat.');
  if (row.revoked) throw new Error('Este convite foi revogado.');
  if (row.uses >= row.max_uses) throw new Error('Este convite já foi usado.');
  return row;
}

/** Marca o convite como consumido por um usuário. Devolve o convite (pra saber quem convidou). */
function consume(code, userId) {
  const row = findCode(code);
  if (!row) return null;
  run('UPDATE signup_codes SET uses = uses + 1 WHERE code = ?', row.code);
  run('INSERT OR IGNORE INTO signup_code_uses (code, user_id, used_at) VALUES (?, ?, ?)',
    row.code, userId, Date.now());
  return row;
}

function createCode(userId, { note = null, maxUses = 1 } = {}) {
  const active = get(
    'SELECT COUNT(*) AS n FROM signup_codes WHERE created_by = ? AND revoked = 0 AND uses < max_uses',
    userId
  ).n;
  if (active >= MAX_ACTIVE_PER_USER) {
    throw new Error(`Você já tem ${MAX_ACTIVE_PER_USER} convites ativos. Revogue um antes de criar outro.`);
  }

  const code = generateCode();
  run(
    'INSERT INTO signup_codes (code, created_by, note, max_uses, uses, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    code, userId, note, Math.min(Math.max(Number(maxUses) || 1, 1), 10), Date.now()
  );
  return findCode(code);
}

function revokeCode(code, userId) {
  const row = findCode(code);
  if (!row || row.created_by !== userId) throw new Error('Convite não encontrado');
  run('UPDATE signup_codes SET revoked = 1 WHERE code = ?', row.code);
}

const listCodes = (userId) =>
  all('SELECT * FROM signup_codes WHERE created_by = ? ORDER BY created_at DESC', userId)
    .map((row) => ({
      code: row.code,
      note: row.note,
      uses: row.uses,
      maxUses: row.max_uses,
      revoked: !!row.revoked,
      createdAt: row.created_at,
      active: !row.revoked && row.uses < row.max_uses
    }));

module.exports = {
  MODE, MAX_ACTIVE_PER_USER,
  isOpen, assertUsable, consume, createCode, revokeCode, listCodes, normalize
};
