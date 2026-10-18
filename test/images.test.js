const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { sniff, processImage } = require('../src/images');

test('sniff detects real types by magic bytes, not by name/claimed type', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer(), jpg = await sharp(png).jpeg().toBuffer();
  assert.strictEqual(sniff(png), 'png'); assert.strictEqual(sniff(webp), 'webp'); assert.strictEqual(sniff(jpg), 'jpeg');
  assert.strictEqual(sniff(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0')), 'heic');
  assert.strictEqual(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.strictEqual(sniff(Buffer.from('GIF89a........')), null);
});
test('processImage resizes, re-encodes to WebP and strips EXIF/GPS', async () => {
  const src = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#c8894b' } }).jpeg()
    .withExif({ IFD0: { Copyright: 'MARKER-123' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '27/1 57/1 0/1' } }).toBuffer();
  assert.ok((await sharp(src).metadata()).exif);
  const out = await processImage(src, 512);
  assert.strictEqual(out.mime, 'image/webp'); assert.strictEqual(out.width, 512);
  const m = await sharp(out.data).metadata();
  assert.strictEqual(m.format, 'webp'); assert.ok(!m.exif); assert.ok(!out.data.includes('MARKER-123'));
});
test('processImage rejects non-images, HEIC and oversize input with friendly errors', async () => {
  await assert.rejects(processImage(Buffer.from('hello world, not an image'), 512), /JPEG, PNG or WebP/);
  await assert.rejects(processImage(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0'), 512), /HEIC/);
  await assert.rejects(processImage(Buffer.alloc(7 * 1024 * 1024), 512), /too large/);
});
