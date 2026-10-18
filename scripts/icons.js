// Generates CoffeeBuds app icons from SVG (no AI). Run: node scripts/icons.js
const sharp = require('sharp'); const fs = require('fs'); const path = require('path');
const out = path.join(__dirname, '..', 'public', 'icons');
// cup drawn in a 512 box; `s` scales the motif around the centre (maskable needs safe zone)
const cup = (s) => `<g transform="translate(256 256) scale(${s}) translate(-256 -256)">
  <path d="M206 128c-18 22 18 38 0 62M256 116c-20 26 20 44 0 72M306 128c-18 22 18 38 0 62" fill="none" stroke="#C69563" stroke-width="14" stroke-linecap="round"/>
  <path d="M332 262h18a46 46 0 0 1 0 92h-26" fill="none" stroke="#FBF7F0" stroke-width="22" stroke-linecap="round"/>
  <path d="M136 232h208v74a92 92 0 0 1-92 92h-24a92 92 0 0 1-92-92z" fill="#FBF7F0"/>
  <path d="M150 250h180v20H150z" fill="#C69563" opacity=".9"/>
  <rect x="104" y="414" width="272" height="20" rx="10" fill="#C69563"/>
</g>`;
const bg = (r) => `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3A2F27"/><stop offset="1" stop-color="#2E2620"/></linearGradient></defs><rect width="512" height="512" rx="${r}" fill="url(#g)"/>`;
const svg = (r, s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${bg(r)}${cup(s)}</svg>`;
(async () => {
  const any = svg(112, 1), full = svg(0, 1), mask = svg(0, 0.78);
  fs.writeFileSync(path.join(out, 'icon.svg'), any);
  const r = (s, size, file) => sharp(Buffer.from(s), { density: 384 }).resize(size, size).png().toFile(path.join(out, file));
  await r(any, 192, 'icon-192.png'); await r(any, 512, 'icon-512.png');
  await r(mask, 512, 'icon-maskable-512.png'); await r(full, 180, 'apple-touch-icon.png');
  await r(any, 32, 'favicon-32.png');
  console.log('icons written');
})();
