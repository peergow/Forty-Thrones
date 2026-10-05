import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { db } from './db.js';

const COOKIE = 'ft_session';
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

export function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, config.sessionSecret, { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 30 * 24 * 3600 * 1000, path: '/',
  });
}
export function clearSession(res) { res.clearCookie(COOKIE, { path: '/' }); }

/** Attaches req.user (or null). */
export function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const { uid } = jwt.verify(token, config.sessionSecret);
      const u = db.prepare('SELECT id, email, username, created_at FROM users WHERE id = ? AND deleted_at IS NULL').get(uid);
      if (u) req.user = u;
    } catch { /* invalid or expired token: treat as logged out */ }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  next();
}

export async function verifyGoogleCredential(credential) {
  if (!googleClient) throw new Error('Google Sign-In is not configured');
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email || !p.email_verified) throw new Error('Unverified Google account');
  return { sub: p.sub, email: p.email.toLowerCase() };
}

export function upsertUser({ sub, email }) {
  const existing = db.prepare('SELECT id FROM users WHERE google_sub = ? AND deleted_at IS NULL').get(sub);
  if (existing) return existing.id;
  const r = db.prepare('INSERT INTO users (google_sub, email, created_at) VALUES (?, ?, ?)').run(sub, email, Date.now());
  return Number(r.lastInsertRowid);
}

/** Deleting an account anonymises it. Public history stays, with an anonymised username. */
export function anonymiseUser(userId) {
  const tag = 'anon-' + crypto.randomBytes(4).toString('hex');
  db.prepare(`UPDATE users SET google_sub = ?, email = ?, username = ?, deleted_at = ? WHERE id = ?`)
    .run(`deleted-${userId}-${tag}`, `deleted-${userId}-${tag}@invalid`, tag, Date.now(), userId);
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite=Lax). */
export function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next(); // server-to-server, verified by signature
  const origin = req.get('origin');
  if (origin && origin !== new URL(config.baseUrl).origin) return res.status(403).json({ error: 'Bad origin.' });
  next();
}
