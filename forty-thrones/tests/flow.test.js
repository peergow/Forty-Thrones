// End-to-end test of the game rules through the HTTP API, using the mock payment provider and an isolated data dir.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.GOOGLE_CLIENT_ID = '';
process.env.FREEZE_HOURS = '24';
process.env.BASE_URL = 'http://localhost:0';
process.env.ADMIN_TOKEN = 'adm';

const { app } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { confirmPayment } = await import('../src/game.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });

const png = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#4455cc' } }).png().toBuffer();

class Client {
  cookie = '';
  async req(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { cookie: this.cookie, ...headers }, body });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }
  json(method, url, obj) { return this.req(method, url, JSON.stringify(obj), { 'content-type': 'application/json' }); }
  async login(email) { return this.json('POST', '/api/auth/dev', { email }); }
  async claim(tile, { caption = 'hello', username, consent = 'true', adult = 'true' } = {}) {
    const f = new FormData();
    f.set('caption', caption); f.set('consent', consent); f.set('adult', adult);
    if (username) f.set('username', username);
    f.set('image', new Blob([png], { type: 'image/png' }), 'a.png');
    return this.req('POST', `/api/tiles/${tile}/claim`, f);
  }
  pay(claimId, priceCents) { return confirmPayment({ claimId, provider: 'mock', providerRef: `mock-${claimId}`, paidCents: priceCents }); }
}

test('board starts with 40 empty tiles at the floor price', async () => {
  const c = new Client();
  const { json } = await c.req('GET', '/api/board');
  assert.equal(json.tiles.length, 40);
  assert.ok(json.tiles.every((t) => t.owner === null && t.nextPriceCents === 100 && !t.locked));
});

test('must be signed in, accept terms and be 18+', async () => {
  const anon = new Client();
  assert.equal((await anon.claim(1, { username: 'abc' })).status, 401);
  const a = new Client(); await a.login('a@x.com');
  assert.equal((await a.claim(1, { username: 'alice', consent: 'false' })).status, 422);
  assert.equal((await a.claim(1, { username: 'alice', adult: 'false' })).status, 422);
});

test('links in captions and bad images are rejected before any claim exists', async () => {
  const a = new Client(); await a.login('a@x.com');
  assert.equal((await a.claim(1, { username: 'alice', caption: 'visit foo.com' })).status, 422);
  const before = db.prepare('SELECT COUNT(*) n FROM claims').get().n;
  const f = new FormData(); f.set('caption', 'x'); f.set('consent', 'true'); f.set('adult', 'true'); f.set('username', 'alice');
  f.set('image', new Blob([Buffer.from('nope')], { type: 'image/png' }), 'a.png');
  assert.equal((await a.req('POST', '/api/tiles/1/claim', f)).status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims').get().n, before);
});

let aliceClaim, bobClaim;
test('first purchase, lock, then +10% seizure after the lock ends', async () => {
  const a = new Client(); await a.login('a@x.com');
  const r = await a.claim(1, { username: 'alice', caption: 'first!' });
  assert.equal(r.status, 200);
  assert.equal(r.json.priceCents, 100);
  assert.match(r.json.checkoutUrl, /mock-pay/);
  aliceClaim = r.json.claimId;
  assert.equal(a.pay(aliceClaim, 100).status, 'paid');

  let t = (await a.req('GET', '/api/tiles/1')).json;
  assert.equal(t.owner, 'alice'); assert.equal(t.locked, true); assert.equal(t.nextPriceCents, 110);
  assert.equal(t.lockedUntil, undefined, 'remaining lock time must not be exposed');

  const b = new Client(); await b.login('b@x.com');
  assert.equal((await b.claim(1, { username: 'bob' })).status, 409, 'locked tile cannot be seized');

  db.prepare('UPDATE claims SET frozen_until = ? WHERE id = ?').run(Date.now() - 1, aliceClaim); // simulate lock expiry
  const r2 = await b.claim(1, { username: 'bob', caption: 'mine now' });
  assert.equal(r2.status, 200); assert.equal(r2.json.priceCents, 110);
  bobClaim = r2.json.claimId;
  assert.equal(b.pay(bobClaim, 110).status, 'paid');

  t = (await a.req('GET', '/api/tiles/1')).json;
  assert.equal(t.owner, 'bob');
  assert.equal(t.history.length, 2, 'previous owner stays in history');
  assert.deepEqual(t.history.map((h) => [h.owner, h.priceCents]), [['bob', 110], ['alice', 100]]);
});

test('payment is idempotent and a stale payment goes to the refund queue', async () => {
  assert.equal(confirmPayment({ claimId: bobClaim, provider: 'mock', providerRef: 'x', paidCents: 110 }).status, 'paid');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM claims WHERE status = ?').get('paid').n, 2);

  // Two people check out for tile 2 at the same time. Second payment arrives after the first took the tile.
  const c = new Client(); await c.login('c@x.com'); const d = new Client(); await d.login('d@x.com');
  const rc = await c.claim(2, { username: 'carol' }); const rd = await d.claim(2, { username: 'dave' });
  assert.equal(c.pay(rc.json.claimId, 100).status, 'paid');
  const late = d.pay(rd.json.claimId, 100);
  assert.equal(late.status, 'needs_refund');
  assert.equal((await d.req('GET', `/api/claims/${rd.json.claimId}`)).json.status, 'needs_refund');
  const t2 = (await c.req('GET', '/api/tiles/2')).json; assert.equal(t2.owner, 'carol');
  const adm = await c.req('GET', '/api/admin/overview', null, { authorization: 'Bearer adm' });
  assert.equal(adm.json.needsRefund.length, 1);
});

test('rankings reflect total paid, longest holding and more', async () => {
  const { json } = await new Client().req('GET', '/api/rankings');
  assert.equal(json.richest[0].username, 'bob');
  assert.equal(json.richest[0].totalCents, 110);
  assert.ok(json.longest.length >= 3);
  assert.ok(json.biggest[0].priceCents === 110);
  assert.ok(json.mostTiles.length >= 1);
});

test('admin can remove content but history and payment stay', async () => {
  const c = new Client();
  assert.equal((await c.json('POST', `/api/admin/claims/${bobClaim}/remove`, { reason: 'x' })).status, 401);
  assert.equal((await c.req('POST', `/api/admin/claims/${bobClaim}/remove`, JSON.stringify({ reason: 'abuse' }), { 'content-type': 'application/json', authorization: 'Bearer adm' })).status, 200);
  const t = (await c.req('GET', '/api/tiles/1')).json;
  assert.equal(t.removed, true); assert.equal(t.image, null); assert.equal(t.caption, null);
  assert.equal(t.history[0].priceCents, 110);
  assert.equal((await c.req('GET', `/img/${bobClaim}.webp`)).status, 404);
});

test('deleting an account anonymises it but keeps public history', async () => {
  const c = new Client(); await c.login('c@x.com');
  assert.equal((await c.req('DELETE', '/api/me')).status, 200);
  const t = (await c.req('GET', '/api/tiles/2')).json;
  assert.match(t.owner, /^anon-/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE email = 'c@x.com'`).get().n, 0);
});

test('reports can be filed', async () => {
  const c = new Client();
  assert.equal((await c.json('POST', '/api/reports', { claimId: aliceClaim, reason: 'bad' })).status, 200);
});
