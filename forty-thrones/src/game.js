import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { nextPriceCents } from './pricing.js';
import { notifyThroneTaken } from './notify.js';

export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'GameError'; this.status = status; }
}

const imageUrl = (claimId) => `/img/${claimId}.webp`;

function tileRow(row, now) {
  const hasClaim = !!row.claim_id;
  const removed = hasClaim && !!row.removed_at;
  return {
    id: row.id,
    name: row.name,
    lastPriceCents: row.price_cents || 0,
    nextPriceCents: nextPriceCents(row.price_cents || 0, config.floorPriceCents),
    // Remaining lock time is deliberately NOT exposed. Only whether the tile can be seized right now.
    locked: hasClaim && row.frozen_until > now,
    claimId: row.claim_id || null,
    owner: hasClaim ? row.username : null,
    heldSince: hasClaim ? row.paid_at : null,
    removed,
    image: hasClaim && !removed ? imageUrl(row.claim_id) : null,
    caption: hasClaim && !removed ? row.caption : null,
  };
}

const TILE_SELECT = `
  SELECT t.id, t.name, c.id AS claim_id, c.price_cents, c.caption, c.paid_at, c.frozen_until, c.removed_at, u.username
  FROM tiles t
  LEFT JOIN claims c ON c.id = t.current_claim_id
  LEFT JOIN users u ON u.id = c.user_id`;

export function getBoard(now = Date.now()) {
  return db.prepare(TILE_SELECT + ' ORDER BY t.id').all().map((r) => tileRow(r, now));
}

export function getTile(tileId, now = Date.now()) {
  const row = db.prepare(TILE_SELECT + ' WHERE t.id = ?').get(tileId);
  if (!row) throw new GameError('Tile not found.', 404);
  const history = db.prepare(`
    SELECT c.id, u.username, c.price_cents, c.paid_at, c.ended_at, c.removed_at
    FROM claims c JOIN users u ON u.id = c.user_id
    WHERE c.tile_id = ? AND c.status = 'paid'
    ORDER BY c.paid_at DESC`).all(tileId).map((h) => ({
    owner: h.username,
    priceCents: h.price_cents,
    paidAt: h.paid_at,
    endedAt: h.ended_at,
    heldMs: (h.ended_at || now) - h.paid_at,
    holding: !h.ended_at,
    removed: !!h.removed_at,
  }));
  return { ...tileRow(row, now), history };
}

export function getRankings(now = Date.now()) {
  const limit = 20;
  const richest = db.prepare(`
    SELECT u.username, SUM(c.price_cents) AS total, COUNT(*) AS n
    FROM claims c JOIN users u ON u.id = c.user_id WHERE c.status = 'paid'
    GROUP BY c.user_id ORDER BY total DESC, MIN(c.paid_at) ASC LIMIT ?`).all(limit)
    .map((r) => ({ username: r.username, totalCents: r.total, claims: r.n }));

  const longest = db.prepare(`
    SELECT u.username, t.name AS tile, c.price_cents, COALESCE(c.ended_at, ?) - c.paid_at AS held, c.ended_at IS NULL AS holding
    FROM claims c JOIN users u ON u.id = c.user_id JOIN tiles t ON t.id = c.tile_id
    WHERE c.status = 'paid' ORDER BY held DESC LIMIT ?`).all(now, limit)
    .map((r) => ({ username: r.username, tile: r.tile, priceCents: r.price_cents, heldMs: r.held, holding: !!r.holding }));

  const mostClaims = db.prepare(`
    SELECT u.username, COUNT(*) AS n FROM claims c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'paid' GROUP BY c.user_id ORDER BY n DESC, MIN(c.paid_at) ASC LIMIT ?`).all(limit)
    .map((r) => ({ username: r.username, claims: r.n }));

  const mostTiles = db.prepare(`
    SELECT u.username, COUNT(*) AS n FROM tiles t JOIN claims c ON c.id = t.current_claim_id JOIN users u ON u.id = c.user_id
    GROUP BY c.user_id ORDER BY n DESC, MIN(c.paid_at) ASC LIMIT ?`).all(limit)
    .map((r) => ({ username: r.username, tiles: r.n }));

  const biggest = db.prepare(`
    SELECT u.username, t.name AS tile, c.price_cents FROM claims c JOIN users u ON u.id = c.user_id JOIN tiles t ON t.id = c.tile_id
    WHERE c.status = 'paid' ORDER BY c.price_cents DESC, c.paid_at ASC LIMIT ?`).all(limit)
    .map((r) => ({ username: r.username, tile: r.tile, priceCents: r.price_cents }));

  return { richest, longest, mostClaims, mostTiles, biggest };
}

export function usernameTaken(name) {
  return !!db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name);
}

/** Cheap pre-check used before spending effort on image processing. */
export function assertTileClaimable(tileId, now = Date.now()) {
  const row = db.prepare(TILE_SELECT + ' WHERE t.id = ?').get(tileId);
  if (!row) throw new GameError('Tile not found.', 404);
  if (row.claim_id && row.frozen_until > now) throw new GameError('This throne is locked right now. Try again later.', 409);
  return row;
}

export function createPendingClaim({ user, tileId, caption, desiredUsername, imageFile, ipHash }) {
  const now = Date.now();
  return db.transaction(() => {
    const tile = db.prepare(TILE_SELECT + ' WHERE t.id = ?').get(tileId);
    if (!tile) throw new GameError('Tile not found.', 404);
    if (tile.claim_id && tile.frozen_until > now) throw new GameError('This throne is locked right now. Try again later.', 409);

    if (!user.username) {
      if (!desiredUsername) throw new GameError('Choose a username. It is permanent.', 422);
      if (usernameTaken(desiredUsername)) throw new GameError('That username is taken.', 409);
    }

    const price = nextPriceCents(tile.price_cents || 0, config.floorPriceCents);

    if (config.maxSpendPerAccountCents > 0) {
      const spent = db.prepare(`SELECT COALESCE(SUM(price_cents),0) AS s FROM claims WHERE user_id = ? AND status = 'paid'`).get(user.id).s;
      if (spent + price > config.maxSpendPerAccountCents) throw new GameError('This purchase would exceed the spending limit for your account.', 403);
    }

    const r = db.prepare(`
      INSERT INTO claims (tile_id, user_id, desired_username, price_cents, caption, image_file, status, created_at, consent_at, consent_version, consent_ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(tileId, user.id, user.username ? null : desiredUsername, price, caption, imageFile, now, now, config.consentVersion, ipHash);
    return { id: Number(r.lastInsertRowid), tile_id: tileId, tile_name: tile.name, price_cents: price };
  })();
}

export function setProviderRef(claimId, provider, ref) {
  if (ref) db.prepare('UPDATE claims SET provider = ?, provider_ref = ? WHERE id = ?').run(provider, ref, claimId);
  else db.prepare('UPDATE claims SET provider = ? WHERE id = ?').run(provider, claimId);
}

/**
 * Called when the payment provider confirms payment. Idempotent.
 * Because the tile can change hands while a customer is checking out, we re-validate here.
 * If the tile is locked or the price is no longer high enough, the claim becomes `needs_refund`
 * and must be refunded from the provider dashboard (see README).
 */
export function confirmPayment({ claimId, provider, providerRef, paidCents }) {
  const now = Date.now();
  let notify = null;

  const result = db.transaction(() => {
    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
    if (!claim) return { status: 'unknown' };
    if (claim.status === 'paid' || claim.status === 'needs_refund') return { status: claim.status };

    const fail = (note) => {
      db.prepare(`UPDATE claims SET status = 'needs_refund', provider = ?, provider_ref = ?, paid_at = NULL, note = ? WHERE id = ?`)
        .run(provider, providerRef ?? null, note, claimId);
      return { status: 'needs_refund', note };
    };

    if (paidCents && paidCents < claim.price_cents) return fail(`underpaid: expected ${claim.price_cents}, got ${paidCents}`);

    const tile = db.prepare(TILE_SELECT + ' WHERE t.id = ?').get(claim.tile_id);
    if (tile.claim_id && tile.frozen_until > now) return fail('tile was locked by another purchase before this payment completed');
    const needed = nextPriceCents(tile.price_cents || 0, config.floorPriceCents);
    if (claim.price_cents < needed) return fail(`price outdated: needed ${needed}, paid ${claim.price_cents}`);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claim.user_id);
    if (!user.username) {
      try {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(claim.desired_username, user.id);
        user.username = claim.desired_username;
      } catch {
        return fail('username was taken before this payment completed');
      }
    }

    if (tile.claim_id) {
      db.prepare('UPDATE claims SET ended_at = ? WHERE id = ?').run(now, tile.claim_id);
      const old = db.prepare('SELECT u.email, u.username, u.deleted_at, c.user_id FROM claims c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(tile.claim_id);
      if (old && !old.deleted_at && old.user_id !== claim.user_id) notify = { email: old.email, username: old.username, tile: tile.name };
    }
    db.prepare(`UPDATE claims SET status = 'paid', paid_at = ?, frozen_until = ?, provider = ?, provider_ref = ? WHERE id = ?`)
      .run(now, now + config.freezeMs, provider, providerRef ?? null, claimId);
    db.prepare('UPDATE tiles SET current_claim_id = ? WHERE id = ?').run(claimId, claim.tile_id);
    return { status: 'paid' };
  })();

  if (notify) notifyThroneTaken(notify.email, notify.username, notify.tile);
  return result;
}

export function getClaimForUser(claimId, userId) {
  const c = db.prepare(`SELECT c.id, c.status, c.price_cents, c.note, t.name AS tile FROM claims c JOIN tiles t ON t.id = c.tile_id WHERE c.id = ? AND c.user_id = ?`).get(claimId, userId);
  if (!c) throw new GameError('Claim not found.', 404);
  return { id: c.id, status: c.status, priceCents: c.price_cents, tile: c.tile, note: c.status === 'needs_refund' ? c.note : null };
}

/** Pending claims that were never paid within an hour are marked failed and their image files deleted. */
export function expireStalePending() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const stale = db.prepare(`SELECT id, image_file FROM claims WHERE status = 'pending' AND created_at < ?`).all(cutoff);
  for (const c of stale) {
    db.prepare(`UPDATE claims SET status = 'failed' WHERE id = ?`).run(c.id);
    fs.rm(path.join(config.uploadDir, c.image_file), { force: true }, () => {});
  }
  return stale.length;
}

export function getClaimImagePath(claimId) {
  const c = db.prepare(`SELECT image_file, status, removed_at FROM claims WHERE id = ?`).get(claimId);
  if (!c || c.status !== 'paid' || c.removed_at) return null;
  return path.join(config.uploadDir, c.image_file);
}

export function removeClaimContent(claimId, reason) {
  const c = db.prepare('SELECT image_file FROM claims WHERE id = ?').get(claimId);
  if (!c) throw new GameError('Claim not found.', 404);
  db.transaction(() => {
    db.prepare('UPDATE claims SET removed_at = ?, removed_reason = ? WHERE id = ?').run(Date.now(), String(reason || '').slice(0, 300), claimId);
    db.prepare(`UPDATE reports SET status = 'actioned' WHERE claim_id = ? AND status = 'open'`).run(claimId);
  })();
  // Delete the image file; the payment record and name stay in the history. No refund.
  fs.rm(path.join(config.uploadDir, c.image_file), { force: true }, () => {});
}

export function createReport({ claimId, userId, reason }) {
  const claim = db.prepare(`SELECT id, tile_id FROM claims WHERE id = ? AND status = 'paid'`).get(claimId);
  if (!claim) throw new GameError('Nothing to report.', 404);
  const text = String(reason || '').trim().slice(0, 300);
  if (!text) throw new GameError('Tell us what is wrong with this content.', 422);
  db.prepare('INSERT INTO reports (claim_id, tile_id, reporter_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(claim.id, claim.tile_id, userId ?? null, text, Date.now());
}

export function adminOverview() {
  return {
    reports: db.prepare(`SELECT r.id, r.claim_id, r.tile_id, r.reason, r.created_at, r.status FROM reports r WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 200`).all(),
    needsRefund: db.prepare(`SELECT c.id, c.tile_id, c.price_cents, c.provider, c.provider_ref, c.note, u.email FROM claims c JOIN users u ON u.id = c.user_id WHERE c.status = 'needs_refund' ORDER BY c.id DESC`).all(),
  };
}

export function getMyClaims(userId) {
  return db.prepare(`SELECT c.id, t.name AS tile, c.price_cents, c.paid_at, c.ended_at FROM claims c JOIN tiles t ON t.id = c.tile_id WHERE c.user_id = ? AND c.status = 'paid' ORDER BY c.paid_at DESC`).all(userId)
    .map((c) => ({ id: c.id, tile: c.tile, priceCents: c.price_cents, paidAt: c.paid_at, holding: !c.ended_at }));
}
