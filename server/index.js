'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const express = require('express');

const api = require('./api');
const { attachRealtime } = require('./realtime');
const { DATA_DIR } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

// Atras do proxy do Render, o IP real vem em X-Forwarded-For. Sem isso o
// rate limiting enxergaria todo mundo como o mesmo endereco.
app.set('trust proxy', 1);

/**
 * O front pode ser servido de outro dominio (ex: Vercel) enquanto a API roda
 * aqui. ALLOWED_ORIGINS aceita uma lista separada por virgula; vazio libera
 * qualquer origem, o que e adequado para uso local.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);

const originAllowed = (origin) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use('/api', api);

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// SPA: qualquer rota desconhecida devolve o app
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/**
 * getUserMedia so funciona em contexto seguro. Em localhost o HTTP basta;
 * para acessar de outro dispositivo na rede, coloque cert.pem e key.pem
 * em data/ e o servidor sobe em HTTPS automaticamente.
 */
const certPath = path.join(DATA_DIR, 'cert.pem');
const keyPath = path.join(DATA_DIR, 'key.pem');
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);

const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);

attachRealtime(server, app, { originAllowed });

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log('');
  console.log('  ⬢  nexus67 rodando');
  console.log(`     local:  ${scheme}://localhost:${PORT}`);
  for (const addr of localAddresses()) console.log(`     rede:   ${scheme}://${addr}:${PORT}`);
  if (!useHttps) {
    console.log('');
    console.log('     obs: camera/microfone so funcionam em localhost sem HTTPS.');
    console.log('          para usar na rede local, gere data/cert.pem e data/key.pem.');
  }
  console.log('');
});
