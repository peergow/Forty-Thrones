import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';
import { TILE_NAMES } from './names.js';

export const db = new Database(path.join(config.dataDir, 'forty-thrones.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS tiles (
  id INTEGER PRIMARY KEY,           -- 1..40
  name TEXT NOT NULL,
  current_claim_id INTEGER
);

-- status: pending | paid | failed | needs_refund
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tile_id INTEGER NOT NULL REFERENCES tiles(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  desired_username TEXT,
  price_cents INTEGER NOT NULL,
  caption TEXT NOT NULL,
  image_file TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT,
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  frozen_until INTEGER,
  ended_at INTEGER,                 -- when someone else seized the tile
  removed_at INTEGER,               -- admin removal: content hidden, history kept
  removed_reason TEXT,
  consent_at INTEGER NOT NULL,
  consent_version TEXT NOT NULL,
  consent_ip_hash TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_tile ON claims(tile_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_provider_ref ON claims(provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  tile_id INTEGER NOT NULL,
  reporter_user_id INTEGER,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
`);

const seed = db.prepare('INSERT OR IGNORE INTO tiles (id, name) VALUES (?, ?)');
db.transaction(() => {
  for (let i = 0; i < config.tileCount; i++) seed.run(i + 1, TILE_NAMES[i] || `Throne ${i + 1}`);
})();
