// Forty Thrones: in-browser SIMULATION backend. No server, no real money, no real accounts.
// State lives in localStorage. It answers the same "API" routes as the real server, so app.js is almost unchanged.
(function () {
  'use strict';
  const KEY = 'ft-sim-v1';
  const HOUR = 3600e3, FLOOR = 100, FREEZE_H = 24, CAP = 100, TILE_COUNT = 40;
  const NAMES = ['The First Seat', 'Ember Gate', 'Lantern Row', 'North Wind', 'Quiet Harbor', 'Copper Hill', 'Moss Court', 'Tidewater', 'Saffron Steps', 'Ivory Keep', 'Dusk Terrace', 'Cinder Lane', 'Willow Hall', 'Brass Bell', 'Orchard Rise', 'Granite Walk', 'Silver Fen', "Crow's Nest", 'Amber Gallery', 'Thistle Yard', 'The Long Table', 'Garnet Plaza', 'Marble Mews', 'Heron Pond', 'Larkspur Gate', 'Foundry Row', 'Pine Crown', 'Opal Quay', 'Windmill Square', 'Rook Tower', 'Saltmarsh', 'Velvet Court', 'Juniper Way', 'Obsidian Step', 'Meadow Throne', 'Compass Point', 'Sable Arch', 'Glass Bridge', 'Rosewood Hall', 'The Last Seat'];
  const SEED_USERS = ['Mira', 'Kestrel', 'Odo', 'Juno_K', 'bellwether', 'NoodleKing', 'Tamsin', 'quartz_fox', 'Halvard', 'Pip_and_Pop'];
  const CAPTIONS = ['First one here.', 'Brought snacks.', 'This is my chair now.', 'Long live the cat.', 'Sorry, not sorry.', 'Hello from the north.', 'Come and get it.', 'Rent is due in 24 hours.', 'Made by a very tired designer.', 'Nothing to see here.', 'My nan says hi.', 'Vote for pancakes.', 'Reserved for a legend.', 'Small throne, big dreams.'];

  // ---- storage (falls back to memory if localStorage is blocked) ----
  const mem = {};
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
  };

  // ---- helpers ----
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const nextPrice = (last) => (last ? Math.max(FLOOR, Math.floor((last * 11 + 9) / 10)) : FLOOR);
  class SimError extends Error {}
  const fail = (m) => { throw new SimError(m); };

  function art(seed) {
    const r = rng(seed), h = Math.floor(r() * 360), h2 = (h + 40 + Math.floor(r() * 120)) % 360;
    let s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},70%,55%)'/><stop offset='1' stop-color='hsl(${h2},75%,32%)'/></linearGradient></defs><rect width='400' height='400' fill='url(#g)'/>`;
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(r() * 400), y = Math.floor(r() * 400), sz = 50 + Math.floor(r() * 130), op = (0.15 + r() * 0.25).toFixed(2);
      s += r() < 0.5 ? `<circle cx='${x}' cy='${y}' r='${sz / 2}' fill='white' fill-opacity='${op}'/>` : `<rect x='${x - sz / 2}' y='${y - sz / 2}' width='${sz}' height='${sz}' rx='${Math.floor(r() * 24)}' fill='white' fill-opacity='${op}' transform='rotate(${Math.floor(r() * 90)} ${x} ${y})'/>`;
    }
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(s + '</svg>');
  }

  // ---- same rules as the real server (src/qc.js) ----
  const TLDS = 'com|net|org|io|co|id|me|ly|gg|xyz|app|dev|info|biz|link|site|online|store|shop|tv|ai|to|us|uk|de|ru|cn|jp|fr|sg|my|in|br|club|top|live|page|cc|ws|vip|fun|win|click|zip|mov';
  const LINKS = [/https?:\/\//i, /\bwww\s*\./i, /\bhxxps?\b/i, /\bt\.me\//i, new RegExp('\\b[a-z0-9-]{2,}\\s*(?:\\.|\\(dot\\)|\\[dot\\])\\s*(?:' + TLDS + ')\\b', 'i')];
  const norm = (t) => t.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '');
  const hasLink = (t) => LINKS.some((r) => r.test(norm(t)));
  function validateCaption(raw) {
    const c = norm(String(raw ?? '')).replace(/\s+/g, ' ').trim();
    if (!c) fail('Write a caption.');
    if ([...c].length > CAP) fail(`Caption can be at most ${CAP} characters.`);
    if (hasLink(c)) fail('Links are not allowed in captions.');
    return c;
  }
  function validateUsername(raw) {
    const u = String(raw ?? '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) fail('Username must be 3 to 20 characters: letters, numbers, underscore.');
    if (/^anon[-_]/i.test(u)) fail('That username is reserved.');
    return u;
  }
  async function processImageBrowser(file) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) fail('Unsupported format. Use JPEG, PNG, WebP or GIF.');
    if (file.size > 5 * 1024 * 1024) fail('Image is larger than 5 MB.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new SimError('This file is not a valid image.')); i.src = url; });
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w < 256 || h < 256) fail('Image is too small. Minimum size is 256 x 256 pixels.');
      if (w / h > 3 || w / h < 1 / 3) fail('Image proportions are too extreme. Use something closer to a square.');
      const S = 320, cv = document.createElement('canvas'); cv.width = cv.height = S;
      const sc = Math.max(S / w, S / h), dw = w * sc, dh = h * sc;
      cv.getContext('2d').drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
      return cv.toDataURL('image/jpeg', 0.8);
    } finally { URL.revokeObjectURL(url); }
  }

  // ---- state ----
  let state; const pending = new Map();
  function seed() {
    const now = Date.now(), r = rng(40);
    const st = { offset: 0, nextClaimId: 1, nextUserId: 1, users: [], claims: [], meId: null };
    SEED_USERS.forEach((n) => st.users.push({ id: st.nextUserId++, email: n.toLowerCase() + '@demo.invalid', username: n, deleted: false }));
    for (const tileId of [1, 2, 3, 5, 6, 8, 11, 13, 14, 16, 19, 21, 22, 25, 28, 31, 33, 36, 38, 40]) {
      const n = 1 + Math.floor(r() * r() * 11), finalAgo = r() < 0.35 ? 1 + r() * 20 : 26 + r() * 140, gap = 26 + r() * 50;
      let price = 0, prevUser = 0; const chain = [];
      for (let k = 0; k < n; k++) {
        price = nextPrice(price);
        let u; do { u = st.users[Math.floor(r() * st.users.length)].id; } while (u === prevUser);
        prevUser = u;
        chain.push({ id: st.nextClaimId++, tileId, userId: u, price, caption: CAPTIONS[Math.floor(r() * CAPTIONS.length)], image: null, status: 'paid', paidAt: Math.round(now - (finalAgo + (n - 1 - k) * gap) * HOUR), removed: false });
      }
      chain.forEach((c, i) => { c.frozenUntil = c.paidAt + FREEZE_H * HOUR; c.endedAt = i < n - 1 ? chain[i + 1].paidAt : null; });
      chain[n - 1].image = art(tileId * 7919 + chain[n - 1].id);
      st.claims.push(...chain);
    }
    return st;
  }
  function load() { try { const s = JSON.parse(store.get(KEY)); if (s && s.claims && s.users) return s; } catch { /* fresh */ } return seed(); }
  function save() { try { store.set(KEY, JSON.stringify(state)); } catch (e) { console.warn('Could not save simulation state', e); } }
  state = load();

  const now = () => Date.now() + state.offset;
  const user = (id) => state.users.find((u) => u.id === id);
  const me = () => (state.meId ? user(state.meId) : null);
  const current = (tileId) => state.claims.find((c) => c.tileId === tileId && c.status === 'paid' && !c.endedAt);
  const taken = (name) => state.users.some((u) => u.username && u.username.toLowerCase() === name.toLowerCase());
  const requireMe = () => me() || fail('Sign in first.');

  function tileView(id) {
    const c = current(id), n = now();
    return {
      id, name: NAMES[id - 1], lastPriceCents: c ? c.price : 0, nextPriceCents: nextPrice(c ? c.price : 0),
      locked: !!c && c.frozenUntil > n, claimId: c ? c.id : null, owner: c ? user(c.userId).username : null,
      heldSince: c ? c.paidAt : null, removed: false, image: c ? c.image : null, caption: c ? c.caption : null,
    };
  }
  function tileDetail(id) {
    if (!(id >= 1 && id <= TILE_COUNT)) fail('Tile not found.');
    const n = now();
    const history = state.claims.filter((c) => c.tileId === id && c.status === 'paid').sort((a, b) => b.paidAt - a.paidAt)
      .map((c) => ({ owner: user(c.userId).username, priceCents: c.price, paidAt: c.paidAt, endedAt: c.endedAt, heldMs: (c.endedAt || n) - c.paidAt, holding: !c.endedAt, removed: false }));
    return { ...tileView(id), history };
  }
  function rankings() {
    const n = now(), paid = state.claims.filter((c) => c.status === 'paid'), L = 20;
    const byUser = new Map();
    for (const c of paid) { const e = byUser.get(c.userId) || { total: 0, n: 0, first: c.paidAt }; e.total += c.price; e.n++; e.first = Math.min(e.first, c.paidAt); byUser.set(c.userId, e); }
    const name = (id) => user(id).username;
    const ent = [...byUser.entries()];
    const heldNow = new Map(); for (const c of paid) if (!c.endedAt) heldNow.set(c.userId, (heldNow.get(c.userId) || 0) + 1);
    return {
      richest: ent.sort((a, b) => b[1].total - a[1].total || a[1].first - b[1].first).slice(0, L).map(([id, e]) => ({ username: name(id), totalCents: e.total, claims: e.n })),
      longest: paid.map((c) => ({ c, held: (c.endedAt || n) - c.paidAt })).sort((a, b) => b.held - a.held).slice(0, L).map(({ c, held }) => ({ username: name(c.userId), tile: NAMES[c.tileId - 1], priceCents: c.price, heldMs: held, holding: !c.endedAt })),
      mostClaims: ent.sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).slice(0, L).map(([id, e]) => ({ username: name(id), claims: e.n })),
      mostTiles: [...heldNow.entries()].sort((a, b) => b[1] - a[1]).slice(0, L).map(([id, k]) => ({ username: name(id), tiles: k })),
      biggest: [...paid].sort((a, b) => b.price - a.price || a.paidAt - b.paidAt).slice(0, L).map((c) => ({ username: name(c.userId), tile: NAMES[c.tileId - 1], priceCents: c.price })),
    };
  }

  function apply({ id, tileId, userId, price, caption, image, desiredUsername }) {
    const n = now(), cur = current(tileId), u = user(userId);
    if (cur && cur.frozenUntil > n) return { status: 'needs_refund', note: 'locked' };
    if (price < nextPrice(cur ? cur.price : 0)) return { status: 'needs_refund', note: 'price outdated' };
    if (!u.username) { if (taken(desiredUsername)) return { status: 'needs_refund', note: 'username taken' }; u.username = desiredUsername; }
    let notifiedUser = null;
    if (cur) { cur.endedAt = n; cur.image = null; notifiedUser = cur.userId; }
    state.claims.push({ id, tileId, userId, price, caption, image, status: 'paid', paidAt: n, frozenUntil: n + FREEZE_H * HOUR, endedAt: null, removed: false });
    save();
    return { status: 'paid', tile: NAMES[tileId - 1], notifiedUser };
  }

  async function claim(tileId, fd) {
    const u = requireMe();
    if (!(tileId >= 1 && tileId <= TILE_COUNT)) fail('Tile not found.');
    if (fd.get('adult') !== 'true') fail('You must confirm that you are 18 or older.');
    if (fd.get('consent') !== 'true') fail('You must accept the payment terms to continue.');
    const file = fd.get('image'); if (!file || !file.size) fail('Choose an image.');
    const caption = validateCaption(fd.get('caption'));
    let desired = null;
    if (!u.username) { desired = validateUsername(fd.get('username')); if (taken(desired)) fail('That username is taken.'); }
    const cur = current(tileId);
    if (cur && cur.frozenUntil > now()) fail('This throne is locked right now. Try again later.');
    const image = await api._processImage(file);               // QC happens before any payment
    const id = state.nextClaimId++;
    const price = nextPrice(cur ? cur.price : 0);
    pending.set(id, { id, tileId, userId: u.id, price, caption, image, desiredUsername: desired });
    return { claimId: id, priceCents: price, checkoutUrl: null };
  }

  // ---- router ----
  async function api(method, url, body) {
    let m;
    if (method === 'GET' && url === '/api/config') return { googleClientId: '', devLogin: true, floorPriceCents: FLOOR, freezeHours: FREEZE_H, captionMax: CAP, consentVersion: 'demo' };
    if (method === 'GET' && url === '/api/board') return { tiles: Array.from({ length: TILE_COUNT }, (_, i) => tileView(i + 1)) };
    if (method === 'GET' && (m = url.match(/^\/api\/tiles\/(\d+)$/))) return tileDetail(Number(m[1]));
    if (method === 'GET' && url === '/api/rankings') return rankings();
    if (method === 'GET' && url === '/api/me') {
      const u = me(); if (!u) return { user: null };
      return { user: { username: u.username, email: u.email }, claims: state.claims.filter((c) => c.userId === u.id && c.status === 'paid').sort((a, b) => b.paidAt - a.paidAt).map((c) => ({ id: c.id, tile: NAMES[c.tileId - 1], priceCents: c.price, paidAt: c.paidAt, holding: !c.endedAt })) };
    }
    if (method === 'POST' && url === '/api/auth/dev') {
      const email = String(body?.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail('Enter an email.');
      let u = state.users.find((x) => x.email === email && !x.deleted);
      if (!u) { u = { id: state.nextUserId++, email, username: null, deleted: false }; state.users.push(u); }
      state.meId = u.id; save(); return { ok: true };
    }
    if (method === 'POST' && url === '/api/auth/logout') { state.meId = null; save(); return { ok: true }; }
    if (method === 'DELETE' && url === '/api/me') {
      const u = requireMe(); const tag = 'anon-' + Math.random().toString(16).slice(2, 10);
      u.username = tag; u.email = `deleted-${u.id}@invalid`; u.deleted = true; state.meId = null; save(); return { ok: true };
    }
    if (method === 'POST' && (m = url.match(/^\/api\/tiles\/(\d+)\/claim$/))) return claim(Number(m[1]), body);
    if (method === 'POST' && url === '/api/reports') {
      if (!String(body?.reason || '').trim()) fail('Tell us what is wrong with this content.');
      return { ok: true };
    }
    fail('Not found.');
  }
  api._processImage = processImageBrowser;

  // ---- simulation controls ----
  const sim = {
    api,
    confirm(claimId) {
      const p = pending.get(claimId); if (!p) fail('This checkout has expired.');
      pending.delete(claimId);
      return apply(p);
    },
    cancel(claimId) { pending.delete(claimId); },
    skip(hours = FREEZE_H) { state.offset += hours * HOUR; save(); },
    rival() {
      const n = now();
      const open = []; for (let id = 1; id <= TILE_COUNT; id++) { const c = current(id); if (!c || c.frozenUntil <= n) open.push(id); }
      if (!open.length) return { ok: false, message: 'Every throne is locked right now. Skip 24 hours first.' };
      const tileId = open[Math.floor(Math.random() * open.length)], cur = current(tileId);
      const pool = state.users.filter((u) => !u.deleted && u.username && u.id !== state.meId && (!cur || u.id !== cur.userId) && SEED_USERS.includes(u.username));
      const rival = pool[Math.floor(Math.random() * pool.length)];
      const id = state.nextClaimId++, price = nextPrice(cur ? cur.price : 0);
      const res = apply({ id, tileId, userId: rival.id, price, caption: CAPTIONS[Math.floor(Math.random() * CAPTIONS.length)], image: art(Math.floor(Math.random() * 1e9)) });
      return { ok: true, tile: res.tile, rival: rival.username, priceCents: price, notifiedMe: res.notifiedUser === state.meId && !!state.meId };
    },
    reset() { store.del(KEY); pending.clear(); state = seed(); save(); },
  };
  globalThis.Sim = sim;
})();
