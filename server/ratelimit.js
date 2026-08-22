'use strict';

/**
 * Limitador de taxa em memória, por janela deslizante.
 *
 * Não depende de nada externo e é suficiente para uma instância única —
 * que é o modelo desta aplicação. Se um dia houver várias instâncias, este
 * módulo precisa migrar para um armazenamento compartilhado (Redis).
 */

const buckets = new Map(); // chave -> number[] (timestamps)

/** Remove chaves que já expiraram, para a memória não crescer sem limite. */
function sweep() {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => t > now);
    if (alive.length) buckets.set(key, alive);
    else buckets.delete(key);
  }
}
setInterval(sweep, 60_000).unref?.();

/**
 * Registra uma tentativa e diz se ela estourou o limite.
 * Cada timestamp guardado já é o instante em que ele expira.
 */
function hit(key, { windowMs, max }) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => t > now);

  if (hits.length >= max) {
    const retryAfter = Math.ceil((Math.min(...hits) - now) / 1000);
    buckets.set(key, hits);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  hits.push(now + windowMs);
  buckets.set(key, hits);
  return { allowed: true, remaining: max - hits.length };
}

/** Zera o contador — usado quando a tentativa deu certo (ex: login válido). */
const reset = (key) => buckets.delete(key);

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket?.remoteAddress
  || 'desconhecido';

/**
 * Middleware Express.
 *
 * @param {string} name      identificador do balde (aparece na chave)
 * @param {number} windowMs  tamanho da janela
 * @param {number} max       tentativas permitidas na janela
 * @param {Function} [by]    deriva parte extra da chave a partir do req
 * @param {string} [message] mensagem devolvida ao estourar
 */
function limit({ name, windowMs, max, by = null, message = null }) {
  return (req, res, next) => {
    const extra = by ? String(by(req) ?? '') : '';
    const key = `${name}:${clientIp(req)}:${extra}`;
    const result = hit(key, { windowMs, max });

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(429).json({
        error: message || `Muitas tentativas. Tente de novo em ${humanize(result.retryAfter)}.`,
        retryAfter: result.retryAfter
      });
    }

    // Deixa a rota zerar o contador quando a operação for legítima.
    req.rateLimitKey = key;
    next();
  };
}

function humanize(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minuto${minutes > 1 ? 's' : ''}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hora${hours > 1 ? 's' : ''}`;
}

/** Versão para sockets, onde não existe req/res. */
function allow(key, { windowMs, max }) {
  return hit(key, { windowMs, max }).allowed;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Perfis usados pelas rotas sensíveis. */
const presets = {
  login: { name: 'login', windowMs: 15 * MINUTE, max: 8, message: 'Muitas tentativas de login. Espere alguns minutos antes de tentar de novo.' },
  register: { name: 'register', windowMs: HOUR, max: 5, message: 'Muitas contas criadas a partir deste endereço. Tente mais tarde.' },
  forgot: { name: 'forgot', windowMs: HOUR, max: 4, message: 'Muitos pedidos de recuperação. Verifique seu e-mail ou tente mais tarde.' },
  reset: { name: 'reset', windowMs: HOUR, max: 8 },
  google: { name: 'google', windowMs: 15 * MINUTE, max: 15 },
  friend: { name: 'friend', windowMs: HOUR, max: 30, message: 'Muitos pedidos de amizade seguidos. Vá com calma.' },
  guild: { name: 'guild', windowMs: HOUR, max: 8, message: 'Você criou servidores demais em pouco tempo.' },
  invite: { name: 'invite', windowMs: HOUR, max: 20 },
  dm: { name: 'dm', windowMs: HOUR, max: 60 }
};

module.exports = { limit, allow, reset, presets, clientIp };
