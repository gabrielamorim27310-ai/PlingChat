#!/usr/bin/env node
'use strict';

/**
 * Build do frontend estático (usado pela Vercel).
 *
 * Copia `public/` para `dist/` e injeta a URL do backend na meta tag
 * `nexus-api`, lida de NEXUS_API_URL. Sem essa variável o front continua
 * apontando para a própria origem, que é o comportamento local.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist');

const apiUrl = (process.env.NEXUS_API_URL || '').trim().replace(/\/+$/, '');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });

const indexPath = path.join(OUT, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8').replace(
  /<meta name="nexus-api" content="[^"]*">/,
  `<meta name="nexus-api" content="${apiUrl}">`
);
fs.writeFileSync(indexPath, html);

console.log(`dist/ gerado ${apiUrl ? `apontando para ${apiUrl}` : 'usando a mesma origem'}`);

if (!apiUrl) {
  console.warn('aviso: NEXUS_API_URL não definida — em deploy separado o front não achará a API.');
}
