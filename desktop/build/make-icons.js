'use strict';

/**
 * Gera os ícones do app a partir de build/icon.svg — roda uma vez, os
 * arquivos gerados ficam versionados (nao precisa rodar de novo a menos
 * que troque o logo).
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const png2icons = require('png2icons');

const SVG = path.join(__dirname, 'icon.svg');
const OUT = __dirname;

async function main() {
  const svg = fs.readFileSync(SVG);

  // PNG 512x512 (Linux/base) e um conjunto de tamanhos pro .ico do Windows.
  const png512 = await sharp(svg).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(OUT, 'icon.png'), png512);

  const png256Path = path.join(OUT, '_icon256.png');
  fs.writeFileSync(png256Path, await sharp(svg).resize(256, 256).png().toBuffer());

  const ico = await pngToIco([png256Path]);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  fs.unlinkSync(png256Path);

  const icns = png2icons.createICNS(png512, png2icons.BILINEAR, 0);
  if (icns) fs.writeFileSync(path.join(OUT, 'icon.icns'), icns);

  console.log('Ícones gerados: icon.png, icon.ico' + (icns ? ', icon.icns' : ' (icns falhou, so png/ico)'));
}

main().catch((err) => { console.error(err); process.exit(1); });
