'use strict';

/**
 * Cloudflare Turnstile — CAPTCHA sem rastreamento.
 *
 * Sem TURNSTILE_SECRET_KEY o módulo fica inerte e a verificação sempre
 * passa, para o app continuar utilizável em desenvolvimento.
 */

const SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const isEnabled = () => !!(SITE_KEY && SECRET_KEY);

/**
 * Valida o token vindo do widget. Lança se o desafio não for aceito.
 * @param {string} token   valor de cf-turnstile-response
 * @param {string} [ip]    IP do cliente, opcional mas recomendado
 */
async function verify(token, ip = null) {
  if (!isEnabled()) return true;
  if (!token) throw new Error('Confirme que você não é um robô antes de continuar');

  const body = new URLSearchParams({ secret: SECRET_KEY, response: token });
  if (ip) body.set('remoteip', ip);

  let data;
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    data = await res.json();
  } catch {
    // Se a Cloudflare estiver fora do ar, não travamos o cadastro.
    console.warn('turnstile: verificação indisponível, seguindo sem o desafio');
    return true;
  }

  if (!data.success) {
    const codes = (data['error-codes'] || []).join(', ');
    if (codes.includes('timeout-or-duplicate')) {
      throw new Error('O desafio expirou. Tente enviar novamente.');
    }
    throw new Error('Não conseguimos validar o desafio. Recarregue a página e tente de novo.');
  }
  return true;
}

module.exports = { isEnabled, verify, SITE_KEY };
