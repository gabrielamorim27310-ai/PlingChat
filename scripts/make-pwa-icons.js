#!/usr/bin/env node
'use strict';

/**
 * Gera os ícones PNG do PWA a partir do mesmo SVG da marca usado no favicon
 * -- renderiza num navegador headless (Playwright) e tira screenshot no
 * tamanho certo, sem precisar de nenhuma lib de imagem.
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const LOGO_PATH = 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.8-.4L4 21l1.4-4.1A8.2 8.2 0 0 1 3.6 11.5C3.6 6.9 7.6 3.2 12.5 3.2S21 6.9 21 11.5Z';

// rx em unidades do viewBox 0-24 (mesma proporção do favicon: 6.7/24 ≈ 28%)
const html = (size, rx) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9b4dff"/><stop offset="1" stop-color="#d94fc0"/>
  </linearGradient></defs>
  <rect width="24" height="24" rx="${rx}" fill="url(#g)"/>
  <path d="${LOGO_PATH}" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
</body></html>`;

async function render(size, rx, outFile) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(html(size, rx));
  const el = await page.$('svg');
  await el.screenshot({ path: path.join(OUT, outFile), omitBackground: true });
  await browser.close();
  console.log('gerado:', outFile, `${size}x${size}`);
}

(async () => {
  await render(192, 6.7, 'icon-192.png');
  await render(512, 6.7, 'icon-512.png');
  // apple-touch-icon: iOS já arredonda a própria borda, então manda sem
  // arredondar (rx=0) pra não sobrar cantos quadrados atrás do arredondado dele
  await render(180, 0, 'apple-touch-icon.png');
  console.log('ok');
})();
