import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { containsLink, validateCaption, validateUsername, processImage, QcError } from '../src/qc.js';

test('links are detected, plain text passes', () => {
  for (const t of ['visit example.com', 'https://a.b', 'www . x', 'foo(dot)com', 'Ｗｗｗ．evil．com']) assert.equal(containsLink(t), true, t);
  for (const t of ['hello world', 'I was here first.', 'e.g. this', 'Rule 1. Win']) assert.equal(containsLink(t), false, t);
});
test('caption length and links rejected', () => {
  assert.throws(() => validateCaption('x'.repeat(101)), QcError);
  assert.throws(() => validateCaption('see example.com'), QcError);
  assert.equal(validateCaption('  hi   there '), 'hi there');
});
test('username rules', () => {
  assert.equal(validateUsername('Queen_01'), 'Queen_01');
  assert.throws(() => validateUsername('a b'), QcError);
  assert.throws(() => validateUsername('ab'), QcError);
  assert.throws(() => validateUsername('anon-1234'), QcError);
});
test('image QC rejects junk and tiny images, accepts valid ones', async () => {
  await assert.rejects(processImage(Buffer.from('not an image')), QcError);
  const tiny = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#f00' } }).png().toBuffer();
  await assert.rejects(processImage(tiny), QcError);
  const ok = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
  const file = await processImage(ok);
  assert.match(file, /^[0-9a-f]{32}\.webp$/);
});
