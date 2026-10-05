import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { db } from './db.js';
import { formatUsd } from './pricing.js';
import { validateCaption, validateUsername, processImage, QcError } from './qc.js';
import {
  loadUser, requireUser, originCheck, setSession, clearSession,
  verifyGoogleCredential, upsertUser, anonymiseUser,
} from './auth.js';
import {
  GameError, getBoard, getTile, getRankings, assertTileClaimable, createPendingClaim, setProviderRef,
  confirmPayment, getClaimForUser, getClaimImagePath, createReport, removeClaimContent, adminOverview,
  getMyClaims, expireStalePending,
} from './game.js';
import { getProvider } from './payments/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://accounts.google.com'],
      'frame-src': ['https://accounts.google.com'],
      'connect-src': ["'self'", 'https://accounts.google.com'],
      'img-src': ["'self'", 'data:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
      'font-src': ['https://fonts.gstatic.com'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// Webhooks need the raw body for signature verification: register BEFORE express.json().
app.post('/webhooks/lemonsqueezy', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  try {
    const provider = getProvider();
    if (provider.name !== 'lemonsqueezy') return res.status(404).end();
    const evt = provider.parseWebhook(req.body, req.get('x-signature'));
    if (evt) {
      const r = confirmPayment({ claimId: evt.claimId, provider: 'lemonsqueezy', providerRef: evt.orderId, paidCents: evt.paidCents });
      console.log(`[webhook] claim=${evt.claimId} -> ${r.status}${r.note ? ' (' + r.note + ')' : ''}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] rejected:', err.message);
    res.status(400).json({ error: 'bad webhook' });
  }
});

app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(originCheck);
app.use(loadUser);
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

const strict = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 } });
const ipHash = (req) => crypto.createHash('sha256').update(String(req.ip) + config.sessionSecret).digest('hex').slice(0, 32);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Public read API ----------
app.get('/api/config', (_req, res) => {
  res.json({
    googleClientId: config.googleClientId,
    devLogin: config.devLogin,
    floorPriceCents: config.floorPriceCents,
    freezeHours: config.freezeHours,
    captionMax: config.captionMax,
    consentVersion: config.consentVersion,
  });
});
app.get('/api/board', (_req, res) => res.json({ tiles: getBoard() }));
app.get('/api/tiles/:id', (req, res) => res.json(getTile(Number(req.params.id))));
app.get('/api/rankings', (_req, res) => res.json(getRankings()));

app.get('/img/:id.webp', (req, res) => {
  const file = getClaimImagePath(Number(req.params.id));
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // images are immutable once paid
  res.type('image/webp').sendFile(file);
});

// ---------- Auth ----------
app.post('/api/auth/google', strict(10 * 60_000, 30), wrap(async (req, res) => {
  let profile;
  try { profile = await verifyGoogleCredential(String(req.body?.credential || '')); }
  catch { throw new GameError('Google sign-in failed.', 401); }
  setSession(res, upsertUser(profile));
  res.json({ ok: true });
}));

app.post('/api/auth/dev', strict(10 * 60_000, 30), (req, res) => {
  if (!config.devLogin) return res.status(404).end();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new GameError('Enter an email.', 422);
  setSession(res, upsertUser({ sub: 'dev-' + email, email }));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { username: req.user.username, email: req.user.email }, claims: getMyClaims(req.user.id) });
});

// Delete account: personal data removed, public history stays under an anonymised name.
app.delete('/api/me', requireUser, (req, res) => {
  anonymiseUser(req.user.id);
  clearSession(res);
  res.json({ ok: true });
});

// ---------- Seizing a tile ----------
app.post('/api/tiles/:id/claim', requireUser, strict(10 * 60_000, 15), upload.single('image'), wrap(async (req, res) => {
  const tileId = Number(req.params.id);
  if (!Number.isInteger(tileId) || tileId < 1 || tileId > config.tileCount) throw new GameError('Tile not found.', 404);

  const b = req.body || {};
  if (b.adult !== 'true') throw new GameError('You must confirm that you are 18 or older.', 422);
  if (b.consent !== 'true') throw new GameError('You must accept the payment terms to continue.', 422);
  if (!req.file) throw new GameError('Choose an image.', 422);

  const caption = validateCaption(b.caption);
  const desiredUsername = req.user.username ? null : validateUsername(b.username);

  assertTileClaimable(tileId);          // fail fast before image work
  const imageFile = await processImage(req.file.buffer); // QC happens before any payment

  let claim;
  try {
    claim = createPendingClaim({ user: req.user, tileId, caption, desiredUsername, imageFile, ipHash: ipHash(req) });
  } catch (err) {
    fs.rm(path.join(config.uploadDir, imageFile), { force: true }, () => {});
    throw err;
  }

  try {
    const provider = getProvider();
    const checkout = await provider.createCheckout(claim, req.user);
    setProviderRef(claim.id, provider.name, checkout.providerRef);
    res.json({ claimId: claim.id, priceCents: claim.price_cents, checkoutUrl: checkout.url });
  } catch (err) {
    console.error('[checkout]', err);
    db.prepare(`UPDATE claims SET status = 'failed', note = 'checkout creation failed' WHERE id = ?`).run(claim.id);
    throw new GameError('Could not start checkout. No payment was taken.', 502);
  }
}));

app.get('/api/claims/:id', requireUser, (req, res) => res.json(getClaimForUser(Number(req.params.id), req.user.id)));

// ---------- Reports ----------
app.post('/api/reports', strict(60 * 60_000, 20), (req, res) => {
  createReport({ claimId: Number(req.body?.claimId), userId: req.user?.id, reason: req.body?.reason });
  res.json({ ok: true });
});

// ---------- Mock checkout (development only) ----------
if (config.paymentProvider === 'mock' && !config.isProd) {
  const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock checkout</title>
  <link rel="stylesheet" href="/style.css"><body class="plain"><main class="doc">${body}</main>`;
  app.get('/mock-pay/:id', requireUser, (req, res) => {
    const c = getClaimForUser(Number(req.params.id), req.user.id);
    res.send(page(`<h1>Mock checkout</h1><p>Development only. No real money moves.</p>
      <p>Tile <strong>${c.tile}</strong>, amount <strong>${formatUsd(c.priceCents)}</strong>.</p>
      <form method="post" action="/mock-pay/${c.id}/complete"><button class="btn primary" type="submit">Pay ${formatUsd(c.priceCents)}</button></form>
      <p><a href="/">Cancel</a></p>`));
  });
  app.post('/mock-pay/:id/complete', requireUser, express.urlencoded({ extended: false }), (req, res) => {
    const c = getClaimForUser(Number(req.params.id), req.user.id);
    confirmPayment({ claimId: c.id, provider: 'mock', providerRef: `mock-${c.id}`, paidCents: c.priceCents });
    res.redirect(`/?claim=${c.id}`);
  });
}

// ---------- Admin ----------
function requireAdmin(req, res, next) {
  const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(config.adminToken);
  if (!config.adminToken || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.get('/api/admin/overview', requireAdmin, (_req, res) => res.json(adminOverview()));
app.post('/api/admin/claims/:id/remove', requireAdmin, (req, res) => {
  removeClaimContent(Number(req.params.id), req.body?.reason);
  res.json({ ok: true });
});

// ---------- Static ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(422).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image is larger than 5 MB.' : 'Upload failed.' });
  }
  if (err instanceof GameError || err instanceof QcError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

setInterval(() => { try { expireStalePending(); } catch (e) { console.error(e); } }, 10 * 60_000).unref();

export { app };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(config.port, () => {
    console.log(`Forty Thrones running at ${config.baseUrl} (payments: ${config.paymentProvider}${config.devLogin ? ', dev login ON' : ''}, freeze: ${config.freezeHours}h)`);
  });
}
