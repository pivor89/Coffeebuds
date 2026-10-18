// Image pipeline: magic-byte sniffing, sharp re-encode (EXIF/GPS stripped), storage in the DB (bytea / BLOB) so it
// survives Render's ephemeral disk at no extra cost. IDs are random 128-bit hex, so URLs are unguessable.
const crypto = require('crypto');
const sharp = require('sharp');
const db = require('./db');

const MAX_INPUT_BYTES = 6 * 1024 * 1024;
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)/.test(buf.toString('ascii', 8, 12))) return 'heic';
  return null;
}
class ImageError extends Error { constructor(m) { super(m); this.user = true; } }

// Returns { data, mime, width, height }; throws ImageError with a user-facing message.
async function processImage(buf, maxDim) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new ImageError('Choose a photo to upload.');
  if (buf.length > MAX_INPUT_BYTES) throw new ImageError('That photo is too large (max 6 MB).');
  const kind = sniff(buf);
  if (kind === 'heic') throw new ImageError('HEIC photos must be converted first — please try again from the app (it converts automatically).');
  if (!kind) throw new ImageError('Only JPEG, PNG or WebP photos are supported.');
  try {
    // sharp drops all metadata (EXIF incl. GPS, XMP, ICC) unless asked to keep it; rotate() bakes in the EXIF orientation first.
    const { data, info } = await sharp(buf, { failOn: 'error', limitInputPixels: 50e6, animated: false })
      .rotate().resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    return { data, mime: 'image/webp', width: info.width, height: info.height };
  } catch { throw new ImageError("We couldn't read that photo. Try a different one."); }
}

async function saveImage(ownerId, img, kind) {
  const id = crypto.randomBytes(16).toString('hex');
  await db.run('INSERT INTO images(id,owner_id,kind,mime,data,width,height) VALUES (?,?,?,?,?,?,?)', [id, ownerId, kind, img.mime, img.data, img.width, img.height]);
  return id;
}
const deleteImage = (id) => db.run('DELETE FROM images WHERE id=?', [id]);

module.exports = { sniff, processImage, saveImage, deleteImage, ImageError, MAX_INPUT_BYTES };
