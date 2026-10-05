import sharp from 'sharp';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.js';

export class QcError extends Error {
  constructor(message) { super(message); this.name = 'QcError'; this.status = 422; }
}

const TLDS = 'com|net|org|io|co|id|me|ly|gg|xyz|app|dev|info|biz|link|site|online|store|shop|tv|ai|to|us|uk|de|ru|cn|jp|fr|sg|my|in|br|club|top|live|page|cc|ws|vip|fun|win|click|zip|mov';
const LINK_PATTERNS = [
  /https?:\/\//i,
  /\bwww\s*\./i,
  /\bhxxps?\b/i,
  /\bt\.me\//i,
  new RegExp('\\b[a-z0-9-]{2,}\\s*(?:\\.|\\(dot\\)|\\[dot\\])\\s*(?:' + TLDS + ')\\b', 'i'),
];

/** Strips invisible/format characters, normalises look-alike characters. */
function normalise(text) {
  return text.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '');
}

export function containsLink(text) {
  const t = normalise(text);
  return LINK_PATTERNS.some((r) => r.test(t));
}

export function validateCaption(raw) {
  const caption = normalise(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  if (!caption) throw new QcError('Write a caption.');
  if ([...caption].length > config.captionMax) throw new QcError(`Caption can be at most ${config.captionMax} characters.`);
  if (containsLink(caption)) throw new QcError('Links are not allowed in captions.');
  return caption;
}

export function validateUsername(raw) {
  const u = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new QcError('Username must be 3 to 20 characters: letters, numbers, underscore.');
  if (/^anon[-_]/i.test(u)) throw new QcError('That username is reserved.');
  return u;
}

/**
 * Automatic image QC. Runs BEFORE payment. Throws QcError when the file is rejected.
 * The image is decoded and re-encoded, which removes metadata and anything that is not pixels.
 *
 * Hook: moderateImage() is where a real moderation service (NSFW / text-in-image / QR detection)
 * should be plugged in. By default it accepts everything that is a valid image.
 */
export async function processImage(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: 64_000_000 }).metadata();
  } catch {
    throw new QcError('This file is not a valid image. Use JPEG, PNG, WebP or GIF.');
  }
  if (!['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) {
    throw new QcError('Unsupported format. Use JPEG, PNG, WebP or GIF.');
  }
  if (!meta.width || !meta.height || meta.width < 256 || meta.height < 256) {
    throw new QcError('Image is too small. Minimum size is 256 x 256 pixels.');
  }
  const ratio = meta.width / meta.height;
  if (ratio > 3 || ratio < 1 / 3) throw new QcError('Image proportions are too extreme. Use something closer to a square.');

  const out = await sharp(buffer, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize(800, 800, { fit: 'cover', position: 'attention' })
    .webp({ quality: 85 })
    .toBuffer();

  await moderateImage(out);

  const name = crypto.randomBytes(16).toString('hex') + '.webp';
  await fs.writeFile(path.join(config.uploadDir, name), out);
  return name;
}

// eslint-disable-next-line no-unused-vars
async function moderateImage(_webpBuffer) {
  // Plug an external moderation API here. Throw new QcError('...') to reject.
  return;
}
