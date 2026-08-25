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

/* ============================================================== ícones == */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Traçados de um kit de ícones de linha, minimalista, no estilo Feather. */
const ICON_PATHS = {
  mic: [
    ['path', { d: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
    ['line', { x1: 12, y1: 19, x2: 12, y2: 23 }],
    ['line', { x1: 8, y1: 23, x2: 16, y2: 23 }]
  ],
  'mic-off': [
    ['path', { d: 'M12 1a3 3 0 0 0-3 3v6' }],
    ['path', { d: 'M15 9.34V4a3 3 0 0 0-5.94-.6' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-8.7 6.8' }],
    ['path', { d: 'M5 10v2a7 7 0 0 0 1.13 3.83' }],
    ['line', { x1: 12, y1: 19, x2: 12, y2: 23 }],
    ['line', { x1: 8, y1: 23, x2: 16, y2: 23 }],
    ['line', { x1: 1, y1: 1, x2: 23, y2: 23 }]
  ],
  headphones: [
    ['path', { d: 'M3 18v-6a9 9 0 0 1 18 0v6' }],
    ['path', { d: 'M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z' }],
    ['path', { d: 'M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z' }]
  ],
  phone: [
    ['path', { d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z' }]
  ],
  video: [
    ['path', { d: 'M23 7l-7 5 7 5V7z' }],
    ['rect', { x: 1, y: 5, width: 15, height: 14, rx: 2, ry: 2 }]
  ],
  monitor: [
    ['rect', { x: 2, y: 3, width: 20, height: 14, rx: 2, ry: 2 }],
    ['line', { x1: 8, y1: 21, x2: 16, y2: 21 }],
    ['line', { x1: 12, y1: 17, x2: 12, y2: 21 }]
  ],
  users: [
    ['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: 9, cy: 7, r: 4 }],
    ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }],
    ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }]
  ],
  compass: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['polygon', { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76' }]
  ],
  send: [
    ['line', { x1: 22, y1: 2, x2: 11, y2: 13 }],
    ['polygon', { points: '22 2 15 22 11 13 2 9 22 2' }]
  ],
  trash: [
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]
  ],
  edit: [
    ['path', { d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
    ['path', { d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' }]
  ],
  reply: [
    ['polyline', { points: '9 14 4 9 9 4' }],
    ['path', { d: 'M20 20v-7a4 4 0 0 0-4-4H4' }]
  ],
  plus: [
    ['line', { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]
  ],
  close: [
    ['line', { x1: 18, y1: 6, x2: 6, y2: 18 }],
    ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]
  ],
  'chevron-down': [
    ['polyline', { points: '6 9 12 15 18 9' }]
  ],
  'chevron-left': [
    ['polyline', { points: '15 18 9 12 15 6' }]
  ],
  sliders: [
    ['line', { x1: 4, y1: 21, x2: 4, y2: 14 }], ['line', { x1: 4, y1: 10, x2: 4, y2: 3 }],
    ['line', { x1: 12, y1: 21, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 8, x2: 12, y2: 3 }],
    ['line', { x1: 20, y1: 21, x2: 20, y2: 16 }], ['line', { x1: 20, y1: 12, x2: 20, y2: 3 }],
    ['line', { x1: 1, y1: 14, x2: 7, y2: 14 }],
    ['line', { x1: 9, y1: 8, x2: 15, y2: 8 }],
    ['line', { x1: 17, y1: 16, x2: 23, y2: 16 }]
  ],
  maximize: [
    ['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }],
    ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
    ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }],
    ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }]
  ],
  minimize: [
    ['path', { d: 'M8 3v3a2 2 0 0 1-2 2H3' }],
    ['path', { d: 'M21 8h-3a2 2 0 0 1-2-2V3' }],
    ['path', { d: 'M3 16h3a2 2 0 0 1 2 2v3' }],
    ['path', { d: 'M16 21v-3a2 2 0 0 1 2-2h3' }]
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 5 }],
    ['line', { x1: 12, y1: 1, x2: 12, y2: 3 }], ['line', { x1: 12, y1: 21, x2: 12, y2: 23 }],
    ['line', { x1: 4.22, y1: 4.22, x2: 5.64, y2: 5.64 }], ['line', { x1: 18.36, y1: 18.36, x2: 19.78, y2: 19.78 }],
    ['line', { x1: 1, y1: 12, x2: 3, y2: 12 }], ['line', { x1: 21, y1: 12, x2: 23, y2: 12 }],
    ['line', { x1: 4.22, y1: 19.78, x2: 5.64, y2: 18.36 }], ['line', { x1: 18.36, y1: 5.64, x2: 19.78, y2: 4.22 }]
  ],
  moon: [
    ['path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' }]
  ],
  mail: [
    ['path', { d: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z' }],
    ['polyline', { points: '22 6 12 13 2 6' }]
  ],
  'link-2': [
    ['path', { d: 'M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3' }],
    ['path', { d: 'M9 17H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3' }],
    ['line', { x1: 8, y1: 12, x2: 16, y2: 12 }]
  ],
  clipboard: [
    ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
    ['rect', { x: 8, y: 2, width: 8, height: 4, rx: 1, ry: 1 }]
  ],
  list: [
    ['line', { x1: 8, y1: 6, x2: 21, y2: 6 }],
    ['line', { x1: 8, y1: 12, x2: 21, y2: 12 }],
    ['line', { x1: 8, y1: 18, x2: 21, y2: 18 }],
    ['line', { x1: 3, y1: 6, x2: 3.01, y2: 6 }],
    ['line', { x1: 3, y1: 12, x2: 3.01, y2: 12 }],
    ['line', { x1: 3, y1: 18, x2: 3.01, y2: 18 }]
  ],
  bell: [
    ['path', { d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' }],
    ['path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }]
  ],
  'user-plus': [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: 8.5, cy: 7, r: 4 }],
    ['line', { x1: 20, y1: 8, x2: 20, y2: 14 }],
    ['line', { x1: 17, y1: 11, x2: 23, y2: 11 }]
  ],
  cpu: [
    ['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2, ry: 2 }],
    ['rect', { x: 9, y: 9, width: 6, height: 6 }],
    ['line', { x1: 9, y1: 1, x2: 9, y2: 4 }], ['line', { x1: 15, y1: 1, x2: 15, y2: 4 }],
    ['line', { x1: 9, y1: 20, x2: 9, y2: 23 }], ['line', { x1: 15, y1: 20, x2: 15, y2: 23 }],
    ['line', { x1: 20, y1: 9, x2: 23, y2: 9 }], ['line', { x1: 20, y1: 14, x2: 23, y2: 14 }],
    ['line', { x1: 1, y1: 9, x2: 4, y2: 9 }], ['line', { x1: 1, y1: 14, x2: 4, y2: 14 }]
  ],
  'log-out': [
    ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }],
    ['polyline', { points: '16 17 21 12 16 7' }],
    ['line', { x1: 21, y1: 12, x2: 9, y2: 12 }]
  ],
  'message-circle': [
    ['path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }]
  ],
  volume: [
    ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }]
  ],
  contrast: [
    ['circle', { cx: 12, cy: 12, r: 10 }],
    ['path', { d: 'M12 2a10 10 0 0 1 0 20z' }]
  ],
  camera: [
    ['path', { d: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z' }],
    ['circle', { cx: 12, cy: 13, r: 4 }]
  ],
  sidebar: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2, ry: 2 }],
    ['line', { x1: 9, y1: 3, x2: 9, y2: 21 }]
  ],
  play: [
    ['polygon', { points: '6 3 20 12 6 21 6 3', fill: 'currentColor', stroke: 'none' }]
  ]
};

/** Ícone SVG de traço (24×24), no lugar dos emojis usados como ícone de UI. */
export function icon(name, size = 18) {
  const shapes = ICON_PATHS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('icon', `icon-${name}`);
  if (!shapes) return svg;
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

export function avatarNode(user, { size = null, status = true } = {}) {
  const dimensions = size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px` : '';
  const node = el('span', {
    class: 'avatar',
    style: `background:${user?.avatarColor || '#5865f2'}${dimensions}`
  }, user?.avatarUrl ? '' : initials(user?.username));

  if (user?.avatarUrl) {
    node.append(el('img', { src: user.avatarUrl, alt: '', referrerPolicy: 'no-referrer' }));
  }
  if (status && user?.status) node.dataset.status = user.status;
  return node;
}

/**
 * Recorta uma imagem escolhida pelo usuário em um quadrado, redimensiona
 * para `size`×`size` e devolve um data URL JPEG comprimido — tudo no
 * navegador, sem subir nada pra lugar nenhum antes do usuário salvar.
 */
export function resizeImageToDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo não é uma imagem válida'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export const debounce = (fn, ms = 250) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};
