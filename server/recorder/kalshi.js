'use strict';
// Kalshi RECORDER (H6, miro's kalshi-15m-study.md §7A + payout-sweep §7 H2). PUBLIC market data only:
//   GET /markets?series_ticker=…&status=open       discovery (strike = floor_strike, open/close times)
//   GET /markets/{ticker}/orderbook?depth=N        top-N YES and NO bids (YES ask = 1 - best NO bid, with its size)
//   GET /markets/trades?ticker=…&min_ts=…          every public print, deduped by trade_id
//   GET /markets/{ticker}                          official settlement result (status finalized/settled, result yes/no)
//   GET /series/{series}                           fee terms (fee_type, fee_multiplier), re-checked hourly
// miro's spec asks for the authenticated WebSocket (orderbook_delta). That route needs request signing with an API
// key, and this job forbids order/auth-signing code, so books come from REST polling (default every 1 s per live
// 15m market). The REST book has no exchange timestamp: rows carry rx (local receive time) and ex: null. Trades carry ex
// (Kalshi created_time) and rx.
// Rows: market, book (written only when the book changed; polls are counted), trade, settle, series, gap.
const { publicGet, Bucket } = require('./public-get');

const num = (x) => (x == null || x === '' ? null : +x);
/** Normalize a Kalshi orderbook response (orderbook_fp dollars or legacy cents) to sorted best-first levels. Pure. */
function normBook(j, depth = 10) {
  const ob = (j && (j.orderbook_fp || j.orderbook)) || {};
  const conv = (arr, cents) => (arr || []).map(([p, s]) => [cents ? +p / 100 : +p, +s]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0]).slice(0, depth);
  const cents = !j.orderbook_fp && !!j.orderbook;
  const yes = conv(ob.yes_dollars || ob.yes, cents), no = conv(ob.no_dollars || ob.no, cents);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return { yes, no, yb: yes.length ? yes[0][0] : null, ybs: yes.length ? yes[0][1] : null, ya: no.length ? r4(1 - no[0][0]) : null, yas: no.length ? no[0][1] : null,
    // YES ask ladder (best first) = complement of the NO bid ladder: what a YES taker walks.
    askLadder: no.map(([p, s]) => [r4(1 - p), s]) };
}
function normTrade(t) {
  return { t: 'trade', id: t.trade_id, tk: t.ticker, ex: Date.parse(t.created_time) || null, yp: num(t.yes_price_dollars != null ? t.yes_price_dollars : t.yes_price != null ? t.yes_price / 100 : null),
    np: num(t.no_price_dollars != null ? t.no_price_dollars : t.no_price != null ? t.no_price / 100 : null), c: num(t.count_fp != null ? t.count_fp : t.count), side: t.taker_side || null, block: !!t.is_block_trade };
}

class KalshiRecorder {
  constructor({ store, health, cfg = {}, gap = () => {}, now = () => Date.now(), get = publicGet, log = (m) => console.log(m) }) {
    this.c = { base: 'https://api.elections.kalshi.com/trade-api/v2', series: ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M'], extraSeries: ['KXNFLGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXBTCD'],
      extraTop: 12, bookMs: 1000, tradesMs: 2000, discoverMs: 20000, extraDiscoverMs: 300000, extraBookMs: 30000, settleMs: 20000, seriesMs: 3600e3, depth: 10, maxRps: 10, gapMs: 5000, ...cfg };
    Object.assign(this, { store, health, gap, now, get, log });
    this.markets = new Map(); // ticker -> state
    this.bucket = new Bucket(this.c.maxRps, now); this.listeners = { book: [], settle: [], market: [], series: [] };
    this.polls = { book: 0, trades: 0, discover: 0, settle: 0, extra: 0 }; this.errors = 0; this.series = {}; this.timers = []; this.rr = 0; this.running = false;
    const H = (id, label, note, staleMs) => health.register(id, { label, group: 'recorder', note, staleMs });
    H('rec.kalshi.book', 'Recorder · Kalshi 15m order books', `public REST /orderbook every ${this.c.bookMs / 1000}s per live market (${this.c.series.join(', ')})`, 15000);
    H('rec.kalshi.trades', 'Recorder · Kalshi 15m trades', `public /markets/trades every ${this.c.tradesMs / 1000}s, deduped by trade_id`, 30000);
    H('rec.kalshi.markets', 'Recorder · Kalshi market discovery + settlement', 'public /markets (strike, open/close) and /markets/{t} (official result)', 120000);
    H('rec.kalshi.extra', 'Recorder · Kalshi sports/other series', `${this.c.extraSeries.join(', ')} · top ${this.c.extraTop} by 24h volume · book every ${this.c.extraBookMs / 1000}s`, 300000);
  }
  url(p, q) { return this.c.base + p + (q ? '?' + new URLSearchParams(q).toString() : ''); }
  async call(id, p, q) { if (this.coolUntil && this.now() < this.coolUntil) { this.coolSkipped = (this.coolSkipped || 0) + 1; return null; } if (!this.bucket.take()) return null; try { return await this.get(this.url(p, q), { health: this.health, id }); } catch (e) { this.noteErr(id, e); return null; } }
  noteErr(id, e) { this.errors++; const k = e && e.status ? 'HTTP ' + e.status : (e && /timeout|abort/i.test(e.message) ? 'timeout' : 'network'); (this.errKinds = this.errKinds || {})[k] = (this.errKinds[k] || 0) + 1; this.lastError = { at: this.now(), id, kind: k }; if (e && e.status === 429) this.coolUntil = this.now() + (this.c.coolMs || 2000); } // 429 → whole client pauses briefly (missed polls surface as gap rows)
  on(kind, f) { this.listeners[kind].push(f); }
  emit(kind, x) { for (const f of this.listeners[kind]) { try { f(x); } catch (e) { this.log('[recorder] listener error: ' + e.message); } } }
  // One in-flight run per loop: a slow cycle is skipped (and later shows up as a measured gap), never stacked on itself.
  every(ms, f) { let busy = false; const run = async () => { if (busy) { this.skipped = (this.skipped || 0) + 1; return; } busy = true; try { await f(); } catch (e) { this.log('[recorder] loop error: ' + e.message); } finally { busy = false; } };
    const t = setInterval(run, ms); if (t.unref) t.unref(); this.timers.push(t); }
  start() {
    if (this.running) return; this.running = true;
    this.discover(); this.checkSeries(); setTimeout(() => this.discoverExtra(), 3000).unref?.();
    this.every(this.c.bookMs, () => this.pollBooks()); this.every(this.c.tradesMs, () => this.pollTrades()); this.every(this.c.discoverMs, () => this.discover());
    this.every(this.c.extraDiscoverMs, () => this.discoverExtra()); this.every(Math.max(1000, Math.floor(this.c.extraBookMs / Math.max(1, this.c.extraTop))), () => this.pollExtraBook());
    this.every(this.c.settleMs, () => this.pollSettle()); this.every(this.c.seriesMs, () => this.checkSeries());
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; }
  restart() { this.stop(); this.start(); }
  watchSpec() { return [{ key: 'recorder kalshi books', ids: ['rec.kalshi.book'], intervalMs: this.c.bookMs * 5, restart: () => this.restart() }]; }
  /** Track a market (also used by the paper test to make sure a filled market's settlement is fetched after a restart). */
  track(m, kind = 'crypto', series = null) {
    const tk = m.ticker; if (this.markets.has(tk)) return this.markets.get(tk);
    const st = { tk, series: series || m.series_ticker || tk.split('-')[0], kind, open: Date.parse(m.open_time) || null, close: Date.parse(m.close_time) || null, strike: num(m.floor_strike),
      strikeType: m.strike_type || null, pls: m.price_level_structure || null, ranges: m.price_ranges || null, lastBookKey: null, lastBookOk: null, lastTradeOk: null, lastTradeEx: null, seen: new Set(), seenQ: [],
      settled: !!(m.result && (m.status === 'finalized' || m.status === 'settled')), settleTries: 0, books: 0, bookRows: 0, trades: 0, last: null, firstBookAt: null };
    this.markets.set(tk, st);
    if (m.open_time) {
      this.store.write('kalshi.market', { t: 'market', tk, s: st.series, kind, ev: m.event_ticker || null, open: st.open, close: st.close, exp: Date.parse(m.expected_expiration_time) || null, strike: st.strike,
        strikeType: st.strikeType, pls: st.pls, ranges: m.price_ranges || null, title: m.title || null, sub: m.yes_sub_title || null, rules: kind === 'crypto' ? (m.rules_primary || null) : null });
      this.emit('market', st);
    }
    return st;
  }
  async discover() {
    this.polls.discover++;
    for (const s of this.c.series) {
      const j = await this.call('rec.kalshi.markets', '/markets', { series_ticker: s, status: 'open', limit: 20 }); if (!j) continue;
      for (const m of j.markets || []) this.track(m, 'crypto', s);
    }
  }
  live(kind) { const now = this.now(); return [...this.markets.values()].filter((m) => m.kind === kind && !m.settled && m.close && now < m.close + 2000 && (!m.open || now >= m.open - 1000)); }
  async pollBooks() {
    await Promise.all(this.live('crypto').map((m) => this.book(m, 'rec.kalshi.book', 'kalshi.book')));
  }
  async book(m, hid, stream) {
    const t0 = this.now(); const j = await this.call(hid, `/markets/${m.tk}/orderbook`, { depth: this.c.depth }); if (!j) return;
    const rx = this.now(); this.polls.book++; m.books++;
    if (m.lastBookOk != null && rx - m.lastBookOk > (m.kind === 'crypto' ? this.c.gapMs : this.c.extraBookMs * 3)) this.gap(stream, m.tk, m.lastBookOk, rx);
    m.lastBookOk = rx; if (m.firstBookAt == null) m.firstBookAt = rx;
    const b = normBook(j, this.c.depth); const key = JSON.stringify([b.yes, b.no]);
    const secLeft = m.close ? Math.round((m.close - rx) / 1000) : null;
    m.last = { rx, sent: t0, ya: b.ya, yas: b.yas, yb: b.yb, ybs: b.ybs, secLeft };
    if (key !== m.lastBookKey) { m.lastBookKey = key; m.bookRows++; this.store.write(stream, { t: 'book', tk: m.tk, s: m.series, ex: null, sent: t0, secLeft, yes: b.yes, no: b.no, ya: b.ya, yas: b.yas, yb: b.yb, ybs: b.ybs }); }
    if (m.kind === 'crypto') this.emit('book', { tk: m.tk, series: m.series, rx, sent: t0, close: m.close, open: m.open, strike: m.strike, secLeft, ...b });
  }
  async pollTrades() {
    for (const m of this.live('crypto')) {
      const q = { ticker: m.tk, limit: 1000 }; if (m.lastTradeEx) q.min_ts = Math.floor(m.lastTradeEx / 1000) - 5; // API max (1001 → HTTP 400); 200 forced 2-3 pages per BTC poll and drew HTTP 429s
      let j = await this.call('rec.kalshi.trades', '/markets/trades', q); if (!j) continue;
      const rx = this.now(); this.polls.trades++;
      if (m.lastTradeOk != null && rx - m.lastTradeOk > this.c.gapMs * 2) this.gap('kalshi.trade', m.tk, m.lastTradeOk, rx);
      m.lastTradeOk = rx;
      let pages = 0; const all = [...(j.trades || [])];
      while (j && j.cursor && (j.trades || []).length >= 1000 && pages < 4) { pages++; j = await this.call('rec.kalshi.trades', '/markets/trades', { ...q, cursor: j.cursor }); if (j) all.push(...(j.trades || [])); }
      if (pages >= 4 && j && j.cursor && m.lastTradeEx) this.gap('kalshi.trade', m.tk, rx, rx, 'trade-page-limit'); // (first poll = history backfill, capped at 5,000 prints; not a gap)
      for (const t of all.reverse()) {
        if (!t.trade_id || m.seen.has(t.trade_id)) continue;
        m.seen.add(t.trade_id); m.seenQ.push(t.trade_id); if (m.seenQ.length > 5000) m.seen.delete(m.seenQ.shift());
        const r = normTrade(t); m.trades++; if (r.ex && (!m.lastTradeEx || r.ex > m.lastTradeEx)) m.lastTradeEx = r.ex;
        this.store.write('kalshi.trade', { ...r, s: m.series });
      }
    }
  }
  async discoverExtra() {
    this.polls.extra++; const cands = [];
    for (const s of this.c.extraSeries) {
      const j = await this.call('rec.kalshi.extra', '/markets', { series_ticker: s, status: 'open', limit: 200 }); if (!j) continue;
      for (const m of j.markets || []) cands.push({ m, s, v: num(m.volume_24h_fp) || 0 });
    }
    if (!cands.length) return;
    const top = cands.sort((a, b) => b.v - a.v).slice(0, this.c.extraTop);
    const keep = new Set(top.map((x) => x.m.ticker));
    for (const [tk, st] of this.markets) if (st.kind === 'extra' && !keep.has(tk) && !st.settled && st.close && this.now() < st.close) st.kind = 'extra-dropped';
    for (const { m, s } of top) { const st = this.track(m, 'extra', s); if (st.kind === 'extra-dropped') st.kind = 'extra'; }
  }
  async pollExtraBook() {
    const xs = this.live('extra'); if (!xs.length) return;
    const m = xs[this.rr++ % xs.length]; await this.book(m, 'rec.kalshi.extra', 'kalshi.extra');
  }
  async pollSettle() {
    const now = this.now();
    for (const m of this.markets.values()) {
      if (m.settled || !m.close || now < m.close + 5000 || m.kind === 'extra-dropped') continue;
      if (m.settleTries > 1100) { m.settled = true; this.store.write('kalshi.market', { t: 'settle_timeout', tk: m.tk, s: m.series }); continue; } // ~6 h
      m.settleTries++;
      const j = await this.call('rec.kalshi.markets', `/markets/${m.tk}`); if (!j || !j.market) continue;
      this.polls.settle++; const x = j.market;
      if (x.result && (x.status === 'finalized' || x.status === 'settled' || x.status === 'determined')) {
        m.settled = true; m.result = x.result;
        const row = { t: 'settle', tk: m.tk, s: m.series, result: x.result, status: x.status, value: num(x.expiration_value), strike: num(x.floor_strike), settledAt: Date.parse(x.settlement_ts) || null, close: m.close };
        this.store.write('kalshi.market', row); this.emit('settle', row);
      }
    }
    for (const [tk, m] of this.markets) if (m.settled && m.close && now - m.close > 3 * 3600e3) this.markets.delete(tk);
  }
  async checkSeries() {
    for (const s of this.c.series) {
      const j = await this.call('rec.kalshi.markets', `/series/${s}`); if (!j || !j.series) continue;
      const x = j.series; const v = { fee_type: x.fee_type || null, fee_multiplier: x.fee_multiplier != null ? +x.fee_multiplier : null, at: this.now() };
      const prev = this.series[s]; this.series[s] = v;
      if (!prev || prev.fee_type !== v.fee_type || prev.fee_multiplier !== v.fee_multiplier) this.store.write('kalshi.market', { t: 'series', s, ...v });
      this.emit('series', { s, ...v });
    }
  }
  view() {
    const now = this.now();
    return { polls: this.polls, errors: this.errors, errKinds: this.errKinds || {}, lastError: this.lastError || null, loopSkips: this.skipped || 0, coolSkipped: this.coolSkipped || 0, rateSkipped: this.bucket.skipped, maxRps: this.c.maxRps, series: this.series,
      live: this.live('crypto').map((m) => ({ tk: m.tk, s: m.series, secLeft: m.close ? Math.round((m.close - now) / 1000) : null, strike: m.strike, books: m.books, bookRows: m.bookRows, trades: m.trades,
        ya: m.last && m.last.ya, yas: m.last && m.last.yas, yb: m.last && m.last.yb, bookAgeMs: m.lastBookOk ? now - m.lastBookOk : null })),
      extra: this.live('extra').length, tracked: this.markets.size, pendingSettle: [...this.markets.values()].filter((m) => !m.settled && m.close && now > m.close).length };
  }
}
module.exports = { KalshiRecorder, normBook, normTrade };
