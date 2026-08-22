export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'title' && key !== 'type') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');

/** Markdown reduzido: negrito, itálico, riscado, código, títulos e links. */
export function renderMarkdown(text) {
  let out = escapeHtml(text);

  out = out.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  out = out.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  out = out.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/__(.+?)__/g, '<u>$1</u>');
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

const DAY_MS = 86_400_000;

export function formatTime(ts) {
  const date = new Date(ts);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(Date.now() - DAY_MS).toDateString() === date.toDateString();
  const hhmm = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Hoje às ${hhmm}`;
  if (yesterday) return `Ontem às ${hhmm}`;
  return `${date.toLocaleDateString('pt-BR')} ${hhmm}`;
}

export const dayKey = (ts) => new Date(ts).toDateString();

export function formatDay(ts) {
  const date = new Date(ts);
  if (dayKey(Date.now()) === dayKey(ts)) return 'Hoje';
  if (dayKey(Date.now() - DAY_MS) === dayKey(ts)) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

export function avatarNode(user, { size = null, status = true } = {}) {
  const node = el('span', {
    class: 'avatar',
    style: `background:${user?.avatarColor || '#5865f2'}${size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px` : ''}`
  }, initials(user?.username));
  if (status && user?.status) node.dataset.status = user.status;
  return node;
}

export const debounce = (fn, ms = 250) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};
