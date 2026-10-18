// Generates CoffeeBuds app icons from the gold "CB" monogram source. Run: node scripts/icons.js
// Source: assets/icon-source.jpg (16:9, monogram centred on an espresso-to-caramel gradient).
const sharp = require('sharp'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'assets', 'icon-source.jpg');
const out = path.join(root, 'public', 'icons');
// Monogram bbox, as fractions of source width/height: x 0.322-0.684, y 0.183-0.781.
const FX = 0.503, FY = 0.482, FW = 0.361; // centre x, centre y, monogram width (of image width)
// Square crop of side `side` centred on the monogram; any area outside the source is
// filled by repeating the edge pixels, which continues the smooth gradient (full-bleed).
async function square(k) { // k = square side as a multiple of the monogram width
  const meta = await sharp(src).metadata();
  const side = Math.round(k * FW * meta.width), CX = FX * meta.width, CY = FY * meta.height;
  const left = Math.round(CX - side / 2), top = Math.round(CY - side / 2);
  const pad = { left: Math.max(0, -left), top: Math.max(0, -top),
    right: Math.max(0, left + side - meta.width), bottom: Math.max(0, top + side - meta.height) };
  const ext = await sharp(src).extend({ ...pad, extendWith: 'copy' }).toBuffer();
  return sharp(ext).extract({ left: left + pad.left, top: top + pad.top, width: side, height: side }).png().toBuffer();
}
// Minimal .ico containing PNG images (valid in all modern browsers).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => { const o = 6 + 16 * i;
    head[o] = size % 256; head[o + 1] = size % 256; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(buf.length, o + 8); head.writeUInt32LE(off, o + 12); off += buf.length; });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}
(async () => {
  const any = await square(1.6);   // monogram ~62% of width: comfortable padding
  const mask = await square(2.05);  // monogram corners well inside the 80% safe-zone circle
  const r = (b, size, file) => sharp(b).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(path.join(out, file));
  await r(any, 192, 'icon-192.png'); await r(any, 512, 'icon-512.png');
  await r(mask, 512, 'icon-maskable-512.png'); await r(any, 180, 'apple-touch-icon.png');
  await r(any, 32, 'favicon-32.png');
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map(async (size) => ({ size, buf: await sharp(any).resize(size, size).png().toBuffer() })));
  fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), ico(pngs));
  const svg = path.join(out, 'icon.svg'); if (fs.existsSync(svg)) fs.unlinkSync(svg);
  console.log('icons written');
})();
