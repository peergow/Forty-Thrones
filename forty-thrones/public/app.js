// Forty Thrones frontend. No build step. User-supplied text is always inserted with textContent. innerHTML is used only for constant SVG icons.
const $ = (s) => document.querySelector(s);
const state = { cfg: null, me: null, tiles: [], rank: null, tab: 'richest' };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function dur(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${Math.max(m, 0)}m`;
}
const date = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  let json = {};
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

function toast(msg, ms = 4500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

const crownSvg = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'crown'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M3 18 4.5 7l4.5 5 3-7 3 7 4.5-5L21 18z" fill="currentColor"/>';
  return s;
};
const lockSvg = () => {
  const w = el('span', { class: 'lock', title: 'Locked right now' });
  w.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V8a3 3 0 0 0-6 0z" fill="currentColor"/></svg>';
  return w;
};

// 11x11 perimeter: 4 corners + 9 tiles per side = 40.
function position(i) {
  if (i <= 10) return [1, i + 1];
  if (i <= 20) return [i - 9, 11];
  if (i <= 30) return [11, 31 - i];
  return [41 - i, 1];
}

/* ---------------- Rendering ---------------- */
function renderAccount() {
  const a = $('#acct'); a.replaceChildren();
  if (state.me) {
    a.append(el('span', { class: 'who', text: state.me.username || state.me.email }));
    a.append(el('button', { class: 'btn', onclick: openAccount }, 'Account'));
  } else {
    a.append(el('button', { class: 'btn', onclick: () => openSignIn() }, 'Sign in'));
  }
}

function renderBoard() {
  const board = $('#board');
  board.querySelectorAll('.tile').forEach((n) => n.remove());
  for (const t of state.tiles) {
    const [r, c] = position(t.id - 1);
    const owned = !!t.claimId;
    const cls = ['tile', owned && !t.removed ? 'owned' : 'empty', t.removed ? 'removed' : ''].join(' ');
    const label = owned ? `${t.name}, held by ${t.owner}, last price ${usd(t.lastPriceCents)}` : `${t.name}, empty, ${usd(t.nextPriceCents)} to take`;
    const btn = el('button', { class: cls, style: `--r:${r};--c:${c}`, 'aria-label': label, onclick: () => openTile(t.id) },
      t.image ? el('img', { src: t.image, alt: '', loading: 'lazy', decoding: 'async' }) : (t.removed ? null : crownSvg()),
      el('span', { class: 'nm', text: t.name }),
      el('span', { class: 'pr', text: usd(owned ? t.lastPriceCents : t.nextPriceCents) }),
      t.locked ? lockSvg() : null);
    board.append(btn);
  }
}

const TABS = [
  ['richest', 'Richest', (r) => r.richest.map((x) => ({ n: x.username, v: usd(x.totalCents), s: `${x.claims} seizure${x.claims === 1 ? '' : 's'}` }))],
  ['longest', 'Longest held', (r) => r.longest.map((x) => ({ n: x.username, v: dur(x.heldMs), s: `${x.tile}${x.holding ? ', still holding' : ''}` }))],
  ['mostClaims', 'Most seizures', (r) => r.mostClaims.map((x) => ({ n: x.username, v: String(x.claims), s: '' }))],
  ['mostTiles', 'Most thrones now', (r) => r.mostTiles.map((x) => ({ n: x.username, v: String(x.tiles), s: '' }))],
  ['biggest', 'Biggest single price', (r) => r.biggest.map((x) => ({ n: x.username, v: usd(x.priceCents), s: x.tile }))],
];
function renderRankings() {
  const tabs = $('#rankTabs'); tabs.replaceChildren();
  for (const [key, label] of TABS) {
    tabs.append(el('button', { role: 'tab', 'aria-selected': String(state.tab === key), onclick: () => { state.tab = key; renderRankings(); } }, label));
  }
  const list = $('#rankList'); list.replaceChildren();
  const rows = state.rank ? TABS.find((t) => t[0] === state.tab)[2](state.rank) : [];
  if (!rows.length) list.append(el('li', { class: 'empty' }, 'No one is on this list yet. The first throne is open.'));
  for (const r of rows.slice(0, 10)) {
    list.append(el('li', {}, el('span', { class: 'nm' }, r.n, r.s ? el('span', { class: 'sub', text: r.s }) : null), el('span', { class: 'val', text: r.v })));
  }
}

async function refresh() {
  const [b, r] = await Promise.all([api('GET', '/api/board'), api('GET', '/api/rankings')]);
  state.tiles = b.tiles; state.rank = r;
  renderBoard(); renderRankings();
}
async function loadMe() {
  const m = await api('GET', '/api/me');
  state.me = m.user ? { ...m.user, claims: m.claims } : null;
  renderAccount();
}

/* ---------------- Dialog helpers ---------------- */
const dlg = () => $('#dlg');
function showDialog(...content) {
  const d = dlg();
  d.replaceChildren(el('div', { class: 'dlg' },
    el('button', { class: 'btn close', 'aria-label': 'Close', onclick: () => d.close() }, 'Close'),
    ...content));
  if (!d.open) d.showModal();
}
dlg().addEventListener('click', (e) => { if (e.target === dlg()) dlg().close(); });

/* ---------------- Tile detail ---------------- */
async function openTile(id) {
  let t;
  try { t = await api('GET', `/api/tiles/${id}`); } catch (e) { return toast(e.message); }
  const parts = [el('h2', { id: 'dlgTitle', text: t.name })];

  if (t.claimId && !t.removed) {
    parts.push(el('img', { class: 'hero', src: t.image, alt: `Image on ${t.name}` }));
    parts.push(el('p', { class: 'caption', text: t.caption }));
    parts.push(el('div', { class: 'facts' },
      el('span', {}, 'Held by ', el('b', { text: t.owner })),
      el('span', {}, 'Paid ', el('b', { text: usd(t.lastPriceCents) })),
      el('span', {}, 'Since ', el('b', { text: date(t.heldSince) }))));
  } else if (t.removed) {
    parts.push(el('p', {}, 'The image on this throne was removed by moderators. The owner and payment stay in the history below.'));
  } else {
    parts.push(el('p', {}, 'Nobody has taken this throne yet.'));
  }

  const actions = el('div', { class: 'row' });
  if (t.locked) {
    actions.append(el('button', { class: 'btn primary', disabled: true }, 'Locked right now'));
  } else {
    actions.append(el('button', { class: 'btn primary', onclick: () => startClaim(t) }, `Take it for ${usd(t.nextPriceCents)}`));
  }
  if (t.claimId && !t.removed) actions.append(el('button', { class: 'btn', onclick: () => openReport(t) }, 'Report'));
  parts.push(actions);

  if (t.history.length) {
    parts.push(el('h3', { text: 'History' }));
    parts.push(el('ul', { class: 'hist' }, t.history.map((h) => el('li', {},
      el('span', {}, h.owner, el('span', { class: 'sub', text: h.holding ? '  holding now' : `  held ${dur(h.heldMs)}` }), h.removed ? el('span', { class: 'sub', text: '  (image removed)' }) : null),
      el('span', { text: usd(h.priceCents) })))));
  }
  showDialog(...parts);
}

function openReport(t) {
  const err = el('p', { class: 'err' });
  const reason = el('textarea', { rows: '3', maxlength: '300', required: true, 'aria-label': 'What is wrong with this content?' });
  showDialog(
    el('h2', { text: `Report ${t.name}` }),
    el('p', {}, 'Tell us what is wrong with this image or caption. Moderators review every report.'),
    reason, err,
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/api/reports', { claimId: t.claimId, reason: reason.value }); dlg().close(); toast('Report sent. Thank you.'); }
        catch (e) { err.textContent = e.message; }
      } }, 'Send report'),
      el('button', { class: 'btn', onclick: () => openTile(t.id) }, 'Back')));
}

/* ---------------- Sign in ---------------- */
let googleReady = null;
function loadGoogle() {
  if (googleReady) return googleReady;
  googleReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load Google Sign-In.'));
    document.head.append(s);
  });
  return googleReady;
}

function openSignIn(after) {
  const err = el('p', { class: 'err' });
  const body = [el('h2', { text: 'Sign in' }), el('p', {}, 'Browsing the board never needs an account. Sign in when you want to take a throne.')];
  const done = async () => { await loadMe(); dlg().close(); if (after) after(); };

  if (state.cfg.googleClientId) {
    const holder = el('div');
    body.push(holder, err);
    showDialog(...body);
    loadGoogle().then(() => {
      // eslint-disable-next-line no-undef
      google.accounts.id.initialize({ client_id: state.cfg.googleClientId, callback: async ({ credential }) => {
        try { await api('POST', '/api/auth/google', { credential }); await done(); } catch (e) { err.textContent = e.message; }
      } });
      // eslint-disable-next-line no-undef
      google.accounts.id.renderButton(holder, { theme: 'filled_blue', size: 'large', text: 'signin_with' });
    }).catch((e) => { err.textContent = e.message; });
  } else if (state.cfg.devLogin) {
    const email = el('input', { type: 'email', required: true, placeholder: 'you@example.com', 'aria-label': 'Email' });
    body.push(el('p', { class: 'warn' }, 'Development mode: Google Sign-In is not configured, so any email works.'), email, err,
      el('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/api/auth/dev', { email: email.value }); await done(); } catch (e) { err.textContent = e.message; }
      } }, 'Continue'));
    showDialog(...body);
  } else {
    body.push(el('p', { class: 'err' }, 'Sign-in is not configured on this server.'));
    showDialog(...body);
  }
}

function openAccount() {
  const err = el('p', { class: 'err' });
  const claims = state.me.claims || [];
  showDialog(
    el('h2', { text: state.me.username || 'Your account' }),
    el('p', { class: 'facts' }, el('span', { text: state.me.email })),
    claims.length ? el('ul', { class: 'hist' }, claims.map((c) => el('li', {}, el('span', {}, c.tile, el('span', { class: 'sub', text: c.holding ? '  holding now' : '' })), el('span', { text: usd(c.priceCents) })))) : el('p', {}, 'You have not taken a throne yet.'),
    err,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: async () => { await api('POST', '/api/auth/logout'); state.me = null; renderAccount(); dlg().close(); } }, 'Sign out'),
      el('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete your account? Your email is erased and your name is replaced by an anonymous one in the public history. Payments are not refunded.')) return;
        try { await api('DELETE', '/api/me'); state.me = null; renderAccount(); dlg().close(); await refresh(); toast('Account deleted.'); } catch (e) { err.textContent = e.message; }
      } }, 'Delete account')));
}

/* ---------------- Claim flow ---------------- */
function startClaim(t) {
  if (!state.me) return openSignIn(() => startClaim(t));
  const needName = !state.me.username;
  const err = el('p', { class: 'err', role: 'alert' });
  const max = state.cfg.captionMax;

  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', required: true });
  const preview = el('img', { class: 'preview', alt: 'Preview', hidden: true });
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) { preview.hidden = true; return; }
    preview.src = URL.createObjectURL(f); preview.hidden = false;
  });
  const caption = el('textarea', { rows: '2', maxlength: String(max), required: true });
  const counter = el('span', { class: 'hint', text: `0 / ${max}` });
  caption.addEventListener('input', () => { counter.textContent = `${[...caption.value].length} / ${max}`; });
  const username = needName ? el('input', { type: 'text', required: true, minlength: '3', maxlength: '20', pattern: '[A-Za-z0-9_]{3,20}', autocomplete: 'off' }) : null;
  const adult = el('input', { type: 'checkbox', required: true });
  const consent = el('input', { type: 'checkbox', required: true });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, `Pay ${usd(t.nextPriceCents)}`);

  const form = el('form', { class: 'claim' },
    el('label', { class: 'f' }, 'Image', el('span', { class: 'hint', text: 'JPEG, PNG, WebP or GIF, up to 5 MB, at least 256 by 256 pixels. It is cropped to a square and cannot be changed after you pay.' }), file, preview),
    el('label', { class: 'f' }, el('span', {}, 'Caption ', counter), el('span', { class: 'hint', text: 'Shown when someone opens your throne. Links are not allowed.' }), caption),
    username ? el('label', { class: 'f' }, 'Username', el('span', { class: 'hint', text: 'Public, unique and permanent. You cannot change it later.' }), username) : null,
    el('div', { class: 'warn' },
      el('strong', {}, `Price: ${usd(t.nextPriceCents)}, plus tax where it applies.`),
      el('p', { class: 'hint', text: `After you pay, this throne is locked for ${state.cfg.freezeHours} hours. When the lock ends, anyone can take it by paying at least 10% more. If that happens you lose the throne and your payment is not returned. Your name and payment stay in the history.` })),
    el('label', { class: 'check' }, adult, 'I am 18 or older.'),
    el('label', { class: 'check' }, consent, el('span', {}, 'I understand that my payment is non-refundable, that someone else can take this throne after the lock ends, and that the money I pay will not come back. I accept the ', el('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'terms'), '.')),
    err,
    el('div', { class: 'row' }, submit, el('button', { class: 'btn', type: 'button', onclick: () => openTile(t.id) }, 'Back')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; submit.disabled = true; submit.textContent = 'Checking image…';
    const fd = new FormData();
    fd.set('image', file.files[0]); fd.set('caption', caption.value);
    if (username) fd.set('username', username.value);
    fd.set('adult', String(adult.checked)); fd.set('consent', String(consent.checked));
    try {
      const r = await api('POST', `/api/tiles/${t.id}/claim`, fd);
      submit.textContent = 'Opening checkout…';
      window.location.href = r.checkoutUrl;
    } catch (ex) {
      err.textContent = ex.message; submit.disabled = false; submit.textContent = `Pay ${usd(t.nextPriceCents)}`;
      await refresh();
    }
  });
  showDialog(el('h2', { text: `Take ${t.name}` }), form);
}

/* ---------------- Return from checkout ---------------- */
async function handleReturn() {
  const id = new URLSearchParams(location.search).get('claim');
  if (!id) return;
  history.replaceState({}, '', '/');
  if (!state.me) return;
  showDialog(el('h2', { text: 'Confirming your payment…' }), el('p', {}, 'This usually takes a few seconds.'));
  for (let i = 0; i < 20; i++) {
    let c;
    try { c = await api('GET', `/api/claims/${id}`); } catch { break; }
    if (c.status === 'paid') { dlg().close(); await loadMe(); await refresh(); toast(`${c.tile} is yours.`); return; }
    if (c.status === 'needs_refund') {
      showDialog(el('h2', { text: 'Someone was faster' }),
        el('p', {}, `Another purchase for ${c.tile} went through before yours completed, so your throne could not be placed. Your payment will be refunded.`));
      return;
    }
    if (c.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  showDialog(el('h2', { text: 'Still waiting' }), el('p', {}, 'We have not received confirmation of your payment yet. If you were charged, the throne will appear on the board once it arrives. You can close this window.'));
}

/* ---------------- Boot ---------------- */
(async function boot() {
  state.cfg = await api('GET', '/api/config');
  await Promise.all([loadMe(), refresh()]);
  await handleReturn();
  setInterval(() => { if (!dlg().open) refresh().catch(() => {}); }, 30000);
})();
