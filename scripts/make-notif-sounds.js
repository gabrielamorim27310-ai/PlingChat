#!/usr/bin/env node
'use strict';

/**
 * Variações do "pling" pra quem quiser um som diferente pra um amigo ou
 * servidor específico (Configurações → som da conversa). Mesma técnica de
 * síntese pura do make-sounds.js -- sem baixar amostra nenhuma.
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
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
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

function bell(freq, durationSec, startGain = 0.5, decayRate = 5.5, overtones = true) {
  const n = Math.floor(SR * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const attack = Math.min(1, t / 0.004);
    const decay = Math.exp(-t * decayRate);
    const fundamental = Math.sin(2 * Math.PI * freq * t);
    const fifth = overtones ? 0.45 * Math.sin(2 * Math.PI * freq * 1.5 * t) : 0;
    const octave = overtones ? 0.25 * Math.sin(2 * Math.PI * freq * 2 * t) : 0;
    out[i] = startGain * attack * decay * (fundamental + fifth + octave);
  }
  return out;
}

const silence = (durationSec) => new Float32Array(Math.floor(SR * durationSec));

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

// --- Marimba: par de notas mais graves e quentes, decaimento mais lento ---
writeWav('notif-marimba.wav', mix(
  { samples: bell(698.5, 0.55, 0.55, 4.2), offset: 0 },                   // F5
  { samples: bell(880, 0.5, 0.42, 4.2), offset: Math.floor(SR * 0.07) }   // A5
));

// --- Sino: um tom só, mais longo e ressonante ---
writeWav('notif-bell.wav', bell(1318.5, 0.9, 0.5, 2.6)); // E6

// --- Pop: blip curtinho e seco, sem overtons -- quase um "toc" ---
writeWav('notif-pop.wav', mix(
  { samples: bell(1760, 0.09, 0.5, 22, false), offset: 0 },
  { samples: bell(2093, 0.07, 0.32, 26, false), offset: Math.floor(SR * 0.045) }
));

// --- Arpejo: três notas subindo rapidinho ---
writeWav('notif-arpeggio.wav', mix(
  { samples: bell(1046.5, 0.35, 0.42), offset: 0 },
  { samples: bell(1318.5, 0.35, 0.42), offset: Math.floor(SR * 0.06) },
  { samples: bell(1568, 0.4, 0.42), offset: Math.floor(SR * 0.12) }
));

console.log('ok');
