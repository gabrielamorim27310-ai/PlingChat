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

// Convite de conta comum: fixo em 5 usos, sem escolha -- não é mais uma
// opção que a pessoa configura, é regra fixa igual o limite de ativos.
const MAX_USES_PER_CODE = 5;

// "Ilimitado" pro dono -- não existe um "sem limite" de verdade numa coluna
// INTEGER, então usa um número grande o bastante pra nunca bater na prática.
const UNLIMITED_USES = 1_000_000;

// Dono do PlingChat: sem limite nenhum na hora de gerar convite -- nem de
// quantos convites ativos, nem de quantos usos cada um tem. Contas comuns
// ficam presas nos dois limites fixos acima (5 convites ativos, 5 usos
// cada) -- não dá mais pra escolher, é regra fixa igual pro dono também.
const OWNER_USER_ID = process.env.OWNER_USER_ID || 'mt5936c4001oj1l'; // Gabriel#5686

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const userCount = async () => (await get('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0')).n;

/** O cadastro está aberto agora? (primeira conta sempre pode). */
const isOpen = async () => MODE === 'open' || (await userCount()) === 0;

async function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 10; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      if (i === 4) code += '-';
    }
    if (!(await get('SELECT 1 FROM signup_codes WHERE code = ?', code))) return code;
  }
}

const normalize = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');

function findCode(code) {
  return get('SELECT * FROM signup_codes WHERE code = ?', normalize(code));
}

/** Valida sem consumir. Lança com mensagem pronta para o usuário. */
async function assertUsable(code) {
  if (await isOpen()) return null;

  const row = await findCode(code);
  if (!row) throw new Error('Código de convite inválido. Peça um a quem já usa o PlingChat.');
  if (row.revoked) throw new Error('Este convite foi revogado.');
  if (row.uses >= row.max_uses) throw new Error('Este convite já foi usado.');
  return row;
}

/** Marca o convite como consumido por um usuário. Devolve o convite (pra saber quem convidou). */
async function consume(code, userId) {
  const row = await findCode(code);
  if (!row) return null;
  await run('UPDATE signup_codes SET uses = uses + 1 WHERE code = ?', row.code);
  await run(
    `INSERT INTO signup_code_uses (code, user_id, used_at) VALUES (?, ?, ?)
     ON CONFLICT (code, user_id) DO NOTHING`,
    row.code, userId, Date.now());
  return row;
}

async function createCode(userId, { note = null } = {}) {
  const isOwner = userId === OWNER_USER_ID;

  if (!isOwner) {
    const active = (await get(
      'SELECT COUNT(*) AS n FROM signup_codes WHERE created_by = ? AND revoked = 0 AND uses < max_uses',
      userId
    )).n;
    if (active >= MAX_ACTIVE_PER_USER) {
      throw new Error(`Você já tem ${MAX_ACTIVE_PER_USER} convites ativos. Revogue um antes de criar outro.`);
    }
  }

  const code = await generateCode();
  await run(
    'INSERT INTO signup_codes (code, created_by, note, max_uses, uses, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    code, userId, note, isOwner ? UNLIMITED_USES : MAX_USES_PER_CODE, Date.now()
  );
  return findCode(code);
}

async function revokeCode(code, userId) {
  const row = await findCode(code);
  if (!row || row.created_by !== userId) throw new Error('Convite não encontrado');
  await run('UPDATE signup_codes SET revoked = 1 WHERE code = ?', row.code);
}

const listCodes = async (userId) =>
  (await all('SELECT * FROM signup_codes WHERE created_by = ? ORDER BY created_at DESC', userId))
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
  MODE, MAX_ACTIVE_PER_USER, MAX_USES_PER_CODE, OWNER_USER_ID,
  isOpen, assertUsable, consume, createCode, revokeCode, listCodes, normalize
};
