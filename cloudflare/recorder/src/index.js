// HAWSE always-on recorder on Cloudflare (H7 Stage L). Record-only: public market-data GETs, no order/auth/portfolio code.
// One Durable Object ("main") wakes on an alarm every POLL_MS (1 s grid; cron is 1-minute granularity, too coarse).
//   Kalshi (public REST, no key):  /markets?series_ticker=…&status=open (discovery), /markets/{t}/orderbook (books every tick),
//                                   /markets/trades?ticker=…&min_ts=… (every 2nd tick, deduped by trade_id), /markets/{t} (official result)
//   Polymarket (public, no wallet): gamma /markets?slug=… (15m up/down discovery), clob /book?token_id=… (every 2nd tick, written
//                                   when the book hash changes), data-api /trades?market=… (every 5th tick, deduped)
//   Extra Kalshi series (sports/daily, same list as the box): top EXTRA_TOP markets, one book per 3rd tick, round-robin.
// Rows match the box recorder's shapes plus src:'cf' and a stream name `s`. Every FLUSH_MS the buffer is gzipped into ONE
// chunk row in the object's own SQLite storage (R2 is optional: if a BUCKET binding exists the chunk is mirrored there).
// Retention: chunks older than RETAIN_DAYS or beyond MAX_BYTES (oldest first) are deleted at each flush.
// HTTP (Worker): GET /health (public: ok/stale only), GET /status and GET /pull/list, /pull/chunk (READ token),
// POST /start, /stop, /restart (ADMIN token). Tokens are compared by SHA-256 against READ_TOKEN_SHA256 / ADMIN_TOKEN_SHA256; the
// Worker never holds a token itself.

const KALSHI_PATH = /^\/trade-api\/v2\/markets(\/trades|\/[A-Z0-9._-]+(\/orderbook)?)?$/;
const POLY_HOSTS = { 'gamma-api.polymarket.com': /^\/markets$/, 'clob.polymarket.com': /^\/book$/, 'data-api.polymarket.com': /^\/trades$/ };

/** The ONLY way this code reaches the network: HTTPS GET to a public market-data path on Kalshi or Polymarket, no auth headers. */
export function publicUrl(base, path, query) {
  const u = new URL(base.replace(/\/$/, '') + path);
  const okKalshi = /(^|\.)kalshi\.com$/.test(u.hostname) && KALSHI_PATH.test(u.pathname);
  const okPoly = POLY_HOSTS[u.hostname] && POLY_HOSTS[u.hostname].test(u.pathname);
  if (u.protocol !== 'https:' || !(okKalshi || okPoly) || u.pathname.includes('..')) throw new Error('refused: not a public market-data path');
  for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
  return u.toString();
}
export function getPublic(base, path, query, fetchImpl = fetch) {
  return fetchImpl(publicUrl(base, path, query), { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'hawse-recorder (record-only research)' } });
}

/** Same normalization as the box recorder: best-first [price, qty] levels; YES ask = 1 - best NO bid. */
export function normBook(j) {
  const ob = (j && (j.orderbook_fp || j.orderbook)) || {};
  const cents = !j.orderbook_fp && !!j.orderbook;
  const lv = (a) => (Array.isArray(a) ? a : []).map(([p, q]) => [cents ? +p / 100 : +p, +q]).filter(([p, q]) => p > 0 && q >= 0).sort((a, b) => b[0] - a[0]);
  const yes = lv(ob.yes_dollars || ob.yes), no = lv(ob.no_dollars || ob.no);
  return { yes, no, yb: yes[0] ? yes[0][0] : null, ybs: yes[0] ? yes[0][1] : null, ya: no[0] ? +(1 - no[0][0]).toFixed(4) : null, yas: no[0] ? no[0][1] : null };
}
const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
export function normTrade(t) {
  return { id: t.trade_id, tk: t.ticker, ex: Date.parse(t.created_time) || null, yp: num(t.yes_price_dollars != null ? t.yes_price_dollars : t.yes_price != null ? t.yes_price / 100 : null),
    np: num(t.no_price_dollars != null ? t.no_price_dollars : t.no_price != null ? t.no_price / 100 : null), c: num(t.count_fp != null ? t.count_fp : t.count), side: t.taker_side || null, block: !!t.is_block_trade };
}
export function normPolyBook(j, depth = 10) {
  const lv = (a, desc) => (a || []).map((x) => [+x.price, +x.size]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, depth);
  const bids = lv(j.bids, true), asks = lv(j.asks, false);
  return { ex: j.timestamp != null ? +j.timestamp : null, hash: j.hash || null, bids, asks, bb: bids.length ? bids[0][0] : null, ba: asks.length ? asks[0][0] : null };
}
const parseArr = (x) => { if (Array.isArray(x)) return x; try { const a = JSON.parse(x || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export async function gzipLines(rows) {
  const body = new Blob([rows.map((r) => JSON.stringify(r)).join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}
export async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
/** Constant-time compare of sha256(presented bearer) with the configured hex digest. Missing digest = always refuse. */
export async function tokenOk(req, hexDigest) {
  const m = /^Bearer (\S{16,})$/.exec(req.headers.get('authorization') || ''); if (!m || !hexDigest || !/^[0-9a-f]{64}$/.test(hexDigest)) return false;
  const h = await sha256hex(m[1]); let d = 0; for (let i = 0; i < 64; i++) d |= h.charCodeAt(i) ^ hexDigest.charCodeAt(i); return d === 0;
}

const pos = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const list = (v, d) => String(v == null ? d : v).split(',').map((s) => s.trim()).filter(Boolean);
const DAY = 86400e3;
export const CODE_VERSION = '3'; // shown in /status so a redeploy can be confirmed as running (a busy DO can keep old code until evicted)

/** Chunk store on the Durable Object's SQLite (ctx.storage.sql). Pure SQL, so tests run it against node:sqlite. */
export class ChunkStore {
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, t0 INTEGER, t1 INTEGER, rows INTEGER, bytes INTEGER, streams TEXT, data BLOB)');
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  }
  add({ t0, t1, rows, streams, data }) { this.sql.exec('INSERT INTO chunks (t0, t1, rows, bytes, streams, data) VALUES (?, ?, ?, ?, ?, ?)', t0, t1, rows, data.byteLength, JSON.stringify(streams), data); return this.last(); }
  last() { const r = this.sql.exec('SELECT MAX(id) AS id FROM chunks').toArray()[0]; return r ? r.id : null; }
  totals() { const r = this.sql.exec('SELECT COUNT(*) AS chunks, COALESCE(SUM(rows),0) AS rows, COALESCE(SUM(bytes),0) AS bytes, MIN(t0) AS oldest, MAX(t1) AS newest, MAX(id) AS lastId FROM chunks').toArray()[0]; return { chunks: +r.chunks, rows: +r.rows, bytes: +r.bytes, oldest: r.oldest, newest: r.newest, lastId: r.lastId }; }
  list(after = 0, limit = 200) { return this.sql.exec('SELECT id, t0, t1, rows, bytes, streams FROM chunks WHERE id > ? ORDER BY id LIMIT ?', after, Math.min(1000, limit)).toArray().map((r) => ({ ...r, streams: JSON.parse(r.streams || '{}') })); }
  get(id) { const r = this.sql.exec('SELECT data FROM chunks WHERE id = ?', id).toArray()[0]; return r ? new Uint8Array(r.data) : null; }
  /** Delete by age, then oldest-first until under maxBytes. Returns the number of chunks deleted. */
  prune(now, retainDays, maxBytes) {
    let n = this.sql.exec('SELECT COUNT(*) AS n FROM chunks WHERE t1 < ?', now - retainDays * DAY).toArray()[0].n;
    if (n) this.sql.exec('DELETE FROM chunks WHERE t1 < ?', now - retainDays * DAY);
    let { bytes } = this.totals();
    while (bytes > maxBytes) { const o = this.sql.exec('SELECT id, bytes FROM chunks ORDER BY id LIMIT 1').toArray()[0]; if (!o) break; this.sql.exec('DELETE FROM chunks WHERE id = ?', o.id); bytes -= o.bytes; n++; }
    return n;
  }
  getMeta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
}

export class Recorder {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx; this.env = env; this.http = deps.fetch || ((...a) => fetch(...a)); this.now = deps.now || (() => Date.now());
    this.c = { kalshi: env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2', series: list(env.SERIES, 'KXBTC15M,KXETH15M,KXSOL15M,KXXRP15M'), extraSeries: list(env.EXTRA_SERIES, ''),
      extraTop: pos(env.EXTRA_TOP, 12), polyAssets: list(env.POLY_ASSETS, 'btc,eth,sol,xrp'), pollMs: pos(env.POLL_MS, 1000), discoverMs: pos(env.DISCOVER_MS, 60000), extraDiscoverMs: pos(env.EXTRA_DISCOVER_MS, 300000),
      flushMs: pos(env.FLUSH_MS, 60000), depth: pos(env.DEPTH, 10), retainDays: pos(env.RETAIN_DAYS, 14), maxBytes: pos(env.MAX_BYTES, 2 * 2 ** 30), gapMs: pos(env.GAP_MS, 5000), tradePages: pos(env.TRADE_PAGES, 3), maxBufRows: pos(env.MAX_BUF_ROWS, 40000), staleMs: pos(env.STALE_MS, 180000) };
    this.store = new ChunkStore(deps.sql || ctx.storage.sql);
    this.buf = []; this.tick = 0; this.k = new Map(); this.p = new Map(); this.extra = []; this.rr = 0; this.lastDisc = { k: 0, p: 0, x: 0 }; this.lastFlush = this.now(); this.cool = {};
    this.startedAt = this.now();
    // Counters survive restarts via the meta table (saved at each flush); in-memory market state does not, which is written as a gap.
    const saved = this.store.getMeta('n') || {};
    this.n = { alarms: 0, req: {}, s429: {}, errors: {}, rows: {}, gaps: 0, flushes: 0, pruned: 0, restarts: 0, lastWriteAt: null, ...saved };
    this.n.restarts++; this.recentGaps = this.store.getMeta('recentGaps') || [];
    this.row('gap', { t: 'gap', reason: 'do-start', from: saved.lastAlarmAt || null, to: this.now() });
  }
  row(s, r) { this.buf.push({ s, src: 'cf', rx: this.now(), ...r }); this.n.rows[s] = (this.n.rows[s] || 0) + 1; }
  gap(stream, key, from, to, reason = 'poll-gap') { this.n.gaps++; const g = { t: 'gap', stream, key, from, to, ms: to - from, reason }; this.row('gap', g); this.recentGaps.push(g); if (this.recentGaps.length > 20) this.recentGaps.shift(); }
  async running() { return (await this.ctx.storage.get('running')) === true; }
  /** GET a public URL; returns parsed JSON or null. Counts requests, 429s and errors per host. A 429 cools that host for 2 s. */
  async get(base, path, query) {
    const host = new URL(base).hostname, now = this.now(); if (this.cool[host] && now < this.cool[host]) return null;
    this.n.req[host] = (this.n.req[host] || 0) + 1;
    try {
      const r = await getPublic(base, path, query, this.http);
      if (r.status === 429) { this.n.s429[host] = (this.n.s429[host] || 0) + 1; this.cool[host] = this.now() + 2000; this.row('gap', { t: 'http-429', host, path }); return null; }
      if (!r.ok) { const k = host + ' HTTP ' + r.status; this.n.errors[k] = (this.n.errors[k] || 0) + 1; return null; }
      return await r.json();
    } catch (e) { const k = host + ' ' + (/timeout|abort/i.test(String(e && e.message)) ? 'timeout' : 'network'); this.n.errors[k] = (this.n.errors[k] || 0) + 1; return null; }
  }
  async discoverKalshi() {
    this.lastDisc.k = this.now();
    for (const s of this.c.series) {
      const j = await this.get(this.c.kalshi, '/markets', { series_ticker: s, status: 'open', limit: 20 }); if (!j) continue;
      for (const m of j.markets || []) {
        if (this.k.has(m.ticker)) continue;
        const st = { tk: m.ticker, series: s, open: Date.parse(m.open_time) || null, close: Date.parse(m.close_time) || null, strike: num(m.floor_strike), lastBook: null, lastBookOk: null, lastTradeOk: null, lastTradeEx: null, seen: new Set(), books: 0, bookRows: 0, trades: 0, settled: false, settleTries: 0 };
        this.k.set(m.ticker, st);
        this.row('kalshi.market', { t: 'market', tk: st.tk, series: s, ev: m.event_ticker || null, open: st.open, close: st.close, strike: st.strike, strikeType: m.strike_type || null });
      }
    }
  }
  liveK() { const now = this.now(); return [...this.k.values()].filter((m) => !m.settled && (!m.open || now >= m.open - 1000) && (!m.close || now < m.close + 2000)); }
  async kalshiBooks() {
    await Promise.all(this.liveK().map(async (m) => {
      const t0 = this.now(); const j = await this.get(this.c.kalshi, `/markets/${m.tk}/orderbook`, { depth: this.c.depth }); if (!j) return;
      const rx = this.now(); m.books++; if (m.lastBookOk != null && rx - m.lastBookOk > this.c.gapMs) this.gap('kalshi.book', m.tk, m.lastBookOk, rx); m.lastBookOk = rx;
      const b = normBook(j), key = JSON.stringify([b.yes, b.no]); if (key === m.lastBook) return; m.lastBook = key; m.bookRows++;
      this.row('kalshi.book', { t: 'book', tk: m.tk, series: m.series, strike: m.strike, close: m.close, secLeft: m.close ? Math.round((m.close - rx) / 1000) : null, lat: rx - t0, ...b });
    }));
  }
  async kalshiTrades() {
    for (const m of this.liveK()) {
      // Newest first, 1000 per page. A full page that has no trade we already saw means older ones may be missing: follow the
      // cursor (up to TRADE_PAGES pages). Still full after that = a 'trade-page-limit' gap row (also on a market's first poll: the opening seconds of a BTC 15m market can exceed 1000 trades).
      const q = { ticker: m.tk, limit: 1000 }; if (m.lastTradeEx) q.min_ts = Math.floor(m.lastTradeEx / 1000) - 2;
      let j = await this.get(this.c.kalshi, '/markets/trades', q); if (!j) continue;
      const rx = this.now(); if (m.lastTradeOk != null && rx - m.lastTradeOk > this.c.gapMs * 2) this.gap('kalshi.trade', m.tk, m.lastTradeOk, rx); m.lastTradeOk = rx;
      let ts = j.trades || [];
      for (let pg = 1; j && j.cursor && (j.trades || []).length >= 1000 && !(j.trades || []).some((t) => m.seen.has(t.trade_id)) && pg < this.c.tradePages; pg++) {
        j = await this.get(this.c.kalshi, '/markets/trades', { ...q, cursor: j.cursor }); if (j) ts = ts.concat(j.trades || []);
      }
      if ((j && (j.trades || []).length >= 1000) && !ts.some((t) => m.seen.has(t.trade_id))) this.row('gap', { t: 'gap', stream: 'kalshi.trade', key: m.tk, reason: 'trade-page-limit' });
      for (const t of ts.slice().reverse()) { if (!t.trade_id || m.seen.has(t.trade_id)) continue; m.seen.add(t.trade_id); const r = normTrade(t); m.trades++; if (r.ex && (!m.lastTradeEx || r.ex > m.lastTradeEx)) m.lastTradeEx = r.ex; this.row('kalshi.trade', { t: 'trade', ...r }); }
      if (m.seen.size > 5000) m.seen = new Set([...m.seen].slice(-2500));
    }
  }
  async kalshiSettle() {
    const now = this.now(), due = [...this.k.values()].find((m) => !m.settled && m.close && now > m.close + 20000);
    if (!due) return; due.settleTries++;
    const j = await this.get(this.c.kalshi, `/markets/${due.tk}`), m = j && j.market;
    if (m && m.result && (m.status === 'finalized' || m.status === 'settled')) { due.settled = true; this.row('kalshi.market', { t: 'settle', tk: due.tk, series: due.series, result: m.result, status: m.status, settledAt: Date.parse(m.settlement_ts || m.close_time) || null, value: num(m.expiration_value) }); }
    else if (now - due.close > 2 * 3600e3) { due.settled = true; this.row('kalshi.market', { t: 'settle_timeout', tk: due.tk }); }
    for (const [tk, x] of this.k) if (x.settled && now - x.close > 3600e3) this.k.delete(tk);
  }
  async discoverPoly() {
    this.lastDisc.p = this.now(); const ws0 = Math.floor(this.now() / 900e3) * 900;
    for (const ws of [ws0, ws0 + 900]) for (const a of this.c.polyAssets) {
      const slug = `${a}-updown-15m-${ws}`; if (this.p.has(slug)) continue;
      const j = await this.get('https://gamma-api.polymarket.com', '/markets', { slug }); const m = Array.isArray(j) ? j[0] : null; if (!m) continue;
      const toks = parseArr(m.clobTokenIds).map(String), outs = parseArr(m.outcomes);
      const st = { slug, asset: a, cond: m.conditionId || null, start: ws * 1000, end: Date.parse(m.endDate) || (ws + 900) * 1000, toks: toks.map((id, i) => ({ id, out: outs[i] || String(i), hash: null, lastOk: null })), seen: new Set(), bookRows: 0, trades: 0, lastTradeOk: null };
      this.p.set(slug, st); this.row('poly.market', { t: 'market', slug, asset: a, cond: st.cond, start: st.start, end: st.end, tokens: st.toks.map((x) => ({ id: x.id, out: x.out })) });
    }
    const now = this.now(); for (const [k, m] of this.p) if (now > m.end + 600e3) this.p.delete(k);
  }
  liveP() { const now = this.now(); return [...this.p.values()].filter((m) => now >= m.start - 1000 && now < m.end + 2000); }
  async polyBooks() {
    await Promise.all(this.liveP().flatMap((m) => m.toks.map(async (tok) => {
      const j = await this.get('https://clob.polymarket.com', '/book', { token_id: tok.id }); if (!j) return;
      const rx = this.now(); if (tok.lastOk != null && rx - tok.lastOk > this.c.gapMs * 2) this.gap('poly.book', tok.id, tok.lastOk, rx); tok.lastOk = rx;
      const b = normPolyBook(j, this.c.depth), key = b.hash || JSON.stringify([b.bids, b.asks]); if (key === tok.hash) return; tok.hash = key; m.bookRows++;
      this.row('poly.book', { t: 'book', tok: tok.id, out: tok.out, slug: m.slug, asset: m.asset, ...b });
    })));
  }
  async polyTrades() {
    for (const m of this.liveP()) {
      if (!m.cond) continue; const j = await this.get('https://data-api.polymarket.com', '/trades', { market: m.cond, limit: 200 }); if (!Array.isArray(j)) continue;
      const rx = this.now(); if (m.lastTradeOk != null && rx - m.lastTradeOk > 15000) this.gap('poly.trade', m.slug, m.lastTradeOk, rx); m.lastTradeOk = rx;
      const idOf = (t) => (t.transactionHash ? `${t.transactionHash}:${t.asset}:${t.size}:${t.price}` : `${t.timestamp}:${t.asset}:${t.size}:${t.price}:${t.side}`);
      if (j.length >= 200 && m.trades > 0 && !j.some((t) => m.seen.has(idOf(t)))) this.row('gap', { t: 'gap', stream: 'poly.trade', key: m.slug, reason: 'trade-page-limit' });
      for (const t of j.slice().reverse()) { const id = idOf(t); if (m.seen.has(id)) continue; m.seen.add(id); m.trades++;
        this.row('poly.trade', { t: 'trade', slug: m.slug, asset: m.asset, tok: t.asset != null ? String(t.asset) : null, out: t.outcome || null, ex: t.timestamp != null ? +t.timestamp * 1000 : null, px: +t.price, sz: +t.size, side: t.side || null, tx: t.transactionHash || null }); }
    }
  }
  async discoverExtra() {
    this.lastDisc.x = this.now(); const all = [];
    for (const s of this.c.extraSeries) { const j = await this.get(this.c.kalshi, '/markets', { series_ticker: s, status: 'open', limit: 200 }); if (j) for (const m of j.markets || []) all.push({ tk: m.ticker, series: s, v: +(m.volume_24h_fp ?? m.volume_24h ?? 0) || 0 }); }
    if (all.length) this.extra = all.sort((a, b) => b.v - a.v).slice(0, this.c.extraTop);
  }
  async extraBook() {
    if (!this.extra.length) return; const m = this.extra[this.rr++ % this.extra.length];
    const j = await this.get(this.c.kalshi, `/markets/${m.tk}/orderbook`, { depth: this.c.depth }); if (!j) return;
    this.row('kalshi.extra', { t: 'book', tk: m.tk, series: m.series, ...normBook(j) });
  }
  /** One alarm tick. The schedule spreads requests so each second stays at roughly 4-10 GETs. */
  async poll() {
    const i = this.tick++, now = this.now();
    const roll = [...this.k.values()].some((m) => m.close && now >= m.close && now < m.close + 8000); // a 15m window just rolled over
    if (now - this.lastDisc.k >= this.c.discoverMs || ((roll || !this.liveK().length) && now - this.lastDisc.k >= 2000)) await this.discoverKalshi();
    await this.kalshiBooks();
    if (i % 2 === 0) await this.kalshiTrades();
    if (this.c.polyAssets.length) { if (now - this.lastDisc.p >= this.c.discoverMs / 2) await this.discoverPoly(); if (i % 2 === 1) await this.polyBooks(); if (i % 5 === 2) await this.polyTrades(); }
    if (this.c.extraSeries.length) { if (now - this.lastDisc.x >= this.c.extraDiscoverMs) await this.discoverExtra(); if (i % 3 === 1) await this.extraBook(); }
    if (i % 10 === 5) await this.kalshiSettle();
  }
  async flush(force = false) {
    const now = this.now(); if (!this.buf.length || (!force && now - this.lastFlush < this.c.flushMs && this.buf.length < this.c.maxBufRows)) return null; // early flush keeps a chunk well under the 2 MB row limit
    const rows = this.buf; this.buf = []; this.lastFlush = now; const streams = {};
    for (const r of rows) streams[r.s] = (streams[r.s] || 0) + 1;
    const data = await gzipLines(rows); const t0 = rows[0].rx, t1 = rows[rows.length - 1].rx;
    const id = this.store.add({ t0, t1, rows: rows.length, streams, data });
    if (this.env.BUCKET) { try { const d = new Date(t0).toISOString(); await this.env.BUCKET.put(`rec/${d.slice(0, 10)}/${String(id).padStart(9, '0')}-cf.jsonl.gz`, data, { httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' } }); } catch { this.n.errors.r2 = (this.n.errors.r2 || 0) + 1; } }
    this.n.pruned += this.store.prune(now, this.c.retainDays, this.c.maxBytes);
    this.n.flushes++; this.n.lastWriteAt = now; this.n.lastAlarmAt = now;
    this.store.setMeta('n', this.n); this.store.setMeta('recentGaps', this.recentGaps);
    return id;
  }
  status() {
    const now = this.now(), T = this.store.totals(), age = this.n.lastWriteAt ? now - this.n.lastWriteAt : null;
    const rate = {}; for (const [h, r] of Object.entries(this.n.req)) rate[h] = { req: r, s429: this.n.s429[h] || 0, share429: r ? +((this.n.s429[h] || 0) / r).toFixed(5) : 0 };
    return { ok: age != null && age < this.c.staleMs, stale: age == null || age >= this.c.staleMs, now, startedAt: this.startedAt, lastWriteAt: this.n.lastWriteAt, lastWriteAgeS: age == null ? null : Math.round(age / 1000),
      version: CODE_VERSION, stored: T, buffered: this.buf.length, alarms: this.n.alarms, flushes: this.n.flushes, pruned: this.n.pruned, restarts: this.n.restarts, rowsByStream: this.n.rows, http: rate, errors: this.n.errors, gaps: this.n.gaps, recentGaps: this.recentGaps.slice(-10),
      kalshi: this.liveK().map((m) => ({ tk: m.tk, secLeft: m.close ? Math.round((m.close - now) / 1000) : null, books: m.books, bookRows: m.bookRows, trades: m.trades })),
      poly: this.liveP().map((m) => ({ slug: m.slug, bookRows: m.bookRows, trades: m.trades })), extra: this.extra.length,
      cfg: { series: this.c.series, extraSeries: this.c.extraSeries, polyAssets: this.c.polyAssets, pollMs: this.c.pollMs, flushMs: this.c.flushMs, retainDays: this.c.retainDays, maxBytes: this.c.maxBytes, staleMs: this.c.staleMs } };
  }
  async fetch(req) { // reached only through the Worker below, after it checked the token for the route
    const u = new URL(req.url), p = u.pathname;
    if (p === '/start') { await this.ctx.storage.put('running', true); await this.ctx.storage.setAlarm(this.now() + 100); return Response.json({ ok: true, running: true }); }
    if (p === '/restart') { // after a redeploy a busy DO keeps the old code; flush, then abort so the next alarm builds a fresh instance
      await this.flush(true); setTimeout(() => this.ctx.abort?.('restart after deploy'), 50); return Response.json({ ok: true, restarting: true, version: CODE_VERSION }); }
    if (p === '/stop') { await this.ctx.storage.put('running', false); await this.ctx.storage.deleteAlarm(); await this.flush(true); return Response.json({ ok: true, running: false }); }
    if (p === '/health') { const s = this.status(); return Response.json({ ok: s.ok, stale: s.stale, running: await this.running(), lastWriteAgeS: s.lastWriteAgeS }); }
    if (p === '/status') return Response.json({ running: await this.running(), ...this.status() });
    if (p === '/pull/list') return Response.json({ chunks: this.store.list(+u.searchParams.get('after') || 0, +u.searchParams.get('limit') || 200), totals: this.store.totals() });
    if (p === '/pull/chunk') { const d = this.store.get(+u.searchParams.get('id')); return d ? new Response(d, { headers: { 'content-type': 'application/gzip' } }) : new Response('gone', { status: 404 }); }
    return new Response('not found', { status: 404 });
  }
  async alarm() {
    if (!(await this.running())) return;
    // Schedule the next wake first, so a thrown poll does not stop the loop (alarms are at-least-once; rows carry rx).
    const next = Math.ceil((this.now() + 1) / this.c.pollMs) * this.c.pollMs; await this.ctx.storage.setAlarm(next);
    this.n.alarms++; this.n.lastAlarmAt = this.now();
    try { await this.poll(); } catch { this.n.errors.poll = (this.n.errors.poll || 0) + 1; }
    await this.flush();
  }
}

const ROUTES = { '/health': ['GET', null], '/status': ['GET', 'READ_TOKEN_SHA256'], '/pull/list': ['GET', 'READ_TOKEN_SHA256'], '/pull/chunk': ['GET', 'READ_TOKEN_SHA256'], '/start': ['POST', 'ADMIN_TOKEN_SHA256'], '/stop': ['POST', 'ADMIN_TOKEN_SHA256'], '/restart': ['POST', 'ADMIN_TOKEN_SHA256'] };
export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname, r = ROUTES[p];
    if (!r) return new Response('not found', { status: 404 });
    if (req.method !== r[0]) return new Response('method not allowed', { status: 405 });
    if (r[1] && !(await tokenOk(req, env[r[1]]))) return new Response('unauthorized', { status: 401 });
    const stub = env.RECORDER.get(env.RECORDER.idFromName('main'), { locationHint: 'enam' }); // US East, near Kalshi
    return stub.fetch(new Request(new URL(p + new URL(req.url).search, 'https://do.internal'), { method: req.method })); // the token is NOT forwarded
  },
};
