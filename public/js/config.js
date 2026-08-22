/**
 * Origem da API. Vazio = mesma origem que serviu a página (uso local e
 * quando o backend também entrega o front). Em deploy separado (front na
 * Vercel, backend no Render) o build injeta a URL completa na meta tag.
 */
const meta = document.querySelector('meta[name="nexus-api"]')?.content?.trim() || '';

export const API_BASE = /^https?:\/\//.test(meta) ? meta.replace(/\/+$/, '') : '';
