import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Minimal .env loader (no extra dependency). Real environment variables win.
function loadDotEnv() {
  const file = path.resolve('.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  isProd: env.NODE_ENV === 'production',
  port: int(env.PORT, 3000),
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET || '',
  dataDir: path.resolve(env.DATA_DIR || './data'),

  floorPriceCents: int(env.FLOOR_PRICE_CENTS, 100),
  freezeHours: Number(env.FREEZE_HOURS || 24),
  captionMax: int(env.CAPTION_MAX, 100),
  maxSpendPerAccountCents: int(env.MAX_SPEND_PER_ACCOUNT_CENTS, 0),
  consentVersion: env.CONSENT_VERSION || '2026-10-v1',
  tileCount: 40,

  googleClientId: env.GOOGLE_CLIENT_ID || '',
  paymentProvider: env.PAYMENT_PROVIDER || 'mock',
  lemon: {
    apiKey: env.LEMONSQUEEZY_API_KEY || '',
    storeId: env.LEMONSQUEEZY_STORE_ID || '',
    variantId: env.LEMONSQUEEZY_VARIANT_ID || '',
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
  },
  adminToken: env.ADMIN_TOKEN || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Forty Thrones <no-reply@localhost>',
  },
};

// Development convenience: random secret per process if none given (sessions reset on restart).
if (!config.sessionSecret) {
  if (config.isProd) throw new Error('SESSION_SECRET is required in production');
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
}
if (config.isProd) {
  if (config.paymentProvider === 'mock') throw new Error('PAYMENT_PROVIDER=mock is not allowed in production');
  if (!config.googleClientId) throw new Error('GOOGLE_CLIENT_ID is required in production');
}

config.devLogin = !config.isProd && !config.googleClientId;
config.freezeMs = Math.round(config.freezeHours * 3600 * 1000);
config.uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(config.uploadDir, { recursive: true });
