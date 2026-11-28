import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '..');
const publicDir = path.join(webDir, 'public');
const iconsDir = path.join(publicDir, 'icons');

const require = createRequire(import.meta.url);
const sharpPath = require.resolve('sharp', {
  paths: [webDir, path.resolve(webDir, '../workspace-runner'), path.resolve(webDir, '../..')],
});
const sharp = require(sharpPath);

function buildSvg({ rx = 112, insetScale = 1 } = {}) {
  const tx = (512 * (1 - insetScale)) / 2;
  const ty = (512 * (1 - insetScale)) / 2;
  const groupOpen = insetScale === 1 ? '' : `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${insetScale})">`;
  const groupClose = insetScale === 1 ? '' : '</g>';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <defs>
    <radialGradient id="bg-glow" cx="66%" cy="34%" r="65%">
      <stop offset="0%" stop-color="#332A22" />
      <stop offset="55%" stop-color="#1C1917" />
      <stop offset="100%" stop-color="#141210" />
    </radialGradient>
    <linearGradient id="comet-tail-main" x1="336" y1="176" x2="108" y2="404" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FDE68A" stop-opacity="0.95" />
      <stop offset="35%" stop-color="#F59E0B" stop-opacity="0.82" />
      <stop offset="75%" stop-color="#D97706" stop-opacity="0.32" />
      <stop offset="100%" stop-color="#B45309" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="comet-tail-sub" x1="312" y1="158" x2="136" y2="338" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FCD34D" stop-opacity="0.65" />
      <stop offset="60%" stop-color="#D97706" stop-opacity="0.22" />
      <stop offset="100%" stop-color="#B45309" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="star-fill" x1="256" y1="96" x2="392" y2="256" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FEF3C7" />
      <stop offset="48%" stop-color="#FBBF24" />
      <stop offset="100%" stop-color="#D97706" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${rx}" fill="url(#bg-glow)" />
  ${groupOpen}
  <path d="M316 158 C246 196 184 246 132 316 C182 272 246 226 326 184 Z" fill="url(#comet-tail-sub)" />
  <path d="M326 172 C244 228 170 302 100 398 C188 330 264 264 342 192 Z" fill="url(#comet-tail-main)" />
  <path d="M336 92 C343 145 367 169 420 176 C367 183 343 207 336 260 C329 207 305 183 252 176 C305 169 329 145 336 92 Z" fill="url(#star-fill)" />
  <circle cx="336" cy="176" r="18" fill="#FFFBEB" fill-opacity="0.92" />
  <path d="M196 154 C198.5 169 205 175.5 220 178 C205 180.5 198.5 187 196 202 C193.5 187 187 180.5 172 178 C187 175.5 193.5 169 196 154 Z" fill="#FDE68A" fill-opacity="0.8" />
  ${groupClose}
</svg>`;
}

/**
 * Pack PNG buffers into a standard multi-size .ico file (Vista+ PNG-in-ICO format).
 */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;

  for (const { size, buffer } of entries) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // width
    dir.writeUInt8(size >= 256 ? 0 : size, 1); // height
    dir.writeUInt8(0, 2); // color palette
    dir.writeUInt8(0, 3); // reserved
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(buffer.length, 8); // bytes in resource
    dir.writeUInt32LE(offset, 12); // image offset
    dirEntries.push(dir);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.buffer)]);
}

async function renderPng(svg, size) {
  return sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

await fs.mkdir(iconsDir, { recursive: true });

const standardSvg = buildSvg({ rx: 112, insetScale: 1 });
const appleSvg = buildSvg({ rx: 0, insetScale: 0.92 });
const maskableSvg = buildSvg({ rx: 0, insetScale: 0.72 });

const [icon192, icon512, maskable512, apple180, ico16, ico32, ico48] = await Promise.all([
  renderPng(standardSvg, 192),
  renderPng(standardSvg, 512),
  renderPng(maskableSvg, 512),
  renderPng(appleSvg, 180),
  renderPng(standardSvg, 16),
  renderPng(standardSvg, 32),
  renderPng(standardSvg, 48),
]);

await Promise.all([
  fs.writeFile(path.join(iconsDir, 'icon-192.png'), icon192),
  fs.writeFile(path.join(iconsDir, 'icon-512.png'), icon512),
  fs.writeFile(path.join(iconsDir, 'icon-maskable-512.png'), maskable512),
  fs.writeFile(path.join(publicDir, 'apple-touch-icon.png'), apple180),
  fs.writeFile(path.join(publicDir, 'favicon.ico'), buildIco([
    { size: 16, buffer: ico16 },
    { size: 32, buffer: ico32 },
    { size: 48, buffer: ico48 },
  ])),
]);

console.log('Generated Halley PWA icons:', {
  'icons/icon-192.png': icon192.length,
  'icons/icon-512.png': icon512.length,
  'icons/icon-maskable-512.png': maskable512.length,
  'apple-touch-icon.png': apple180.length,
  'favicon.ico': ico16.length + ico32.length + ico48.length,
});
