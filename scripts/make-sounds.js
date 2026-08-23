#!/usr/bin/env node
'use strict';

/**
 * Gera os sons de notificação do PlingChat via síntese pura (sem baixar
 * amostra nenhuma) -- um "sino" simples (fundamental + quinta + oitava,
 * com decaimento exponencial) que dá o timbre de "pling" usado em toda a
 * identidade sonora do app.
 */

const fs = require('node:fs');
const path = require('node:path');

const SR = 44100;
const OUT = path.join(__dirname, '..', 'public', 'sounds');
fs.mkdirSync(OUT, { recursive: true });

function writeWav(filename, samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);   // PCM
  buffer.writeUInt16LE(1, 22);   // mono
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, filename), buffer);
  console.log('gerado:', filename, `(${(samples.length / SR).toFixed(2)}s)`);
}

/** Um "pling": fundamental + quinta + oitava, decaimento exponencial (timbre de sino). */
function bell(freq, durationSec, startGain = 0.5) {
  const n = Math.floor(SR * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const attack = Math.min(1, t / 0.004);
    const decay = Math.exp(-t * 5.5);
    const fundamental = Math.sin(2 * Math.PI * freq * t);
    const fifth = 0.45 * Math.sin(2 * Math.PI * freq * 1.5 * t);
    const octave = 0.25 * Math.sin(2 * Math.PI * freq * 2 * t);
    out[i] = startGain * attack * decay * (fundamental + fifth + octave);
  }
  return out;
}

function silence(durationSec) {
  return new Float32Array(Math.floor(SR * durationSec));
}

function mix(...layers) {
  const len = Math.max(...layers.map((l) => l.samples.length + l.offset));
  const out = new Float32Array(len);
  for (const { samples, offset } of layers) {
    for (let i = 0; i < samples.length; i++) out[offset + i] += samples[i];
  }
  return out;
}

function concat(...chunks) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// --- pling.wav: notificação de mensagem -- duas notas rápidas subindo ---
writeWav('pling.wav', mix(
  { samples: bell(1046.5, 0.5, 0.5), offset: 0 },                    // C6
  { samples: bell(1568, 0.45, 0.38), offset: Math.floor(SR * 0.05) } // G6, logo em seguida
));

// --- ring.wav: toque de chamada -- par de "plings" com pausa, dá pra tocar em loop ---
const pulse = bell(880, 0.28, 0.55); // A5
const pair = concat(pulse, silence(0.14), pulse);
writeWav('ring.wav', concat(pair, silence(0.9)));

console.log('ok');
