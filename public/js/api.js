import { API_BASE } from './config.js';

const TOKEN_KEY = 'nexus.token';

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY)
};

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const jwt = token.get();
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let data = {};
  try { data = await res.json(); } catch { /* resposta vazia */ }

  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path, body) => request('DELETE', path, body)
};
