'use strict';
// Polymarket RECORDER (H6). Public read endpoints only, no wallet, no keys, no order code:
//   gamma-api /markets?slug=…                     15-minute crypto up/down markets ({asset}-updown-15m-{windowStartUnix})
//   gamma-api /markets?active=true&closed=false&order=volume24hr   the top markets by 24h volume (slow book sampling)
//   clob      /book?token_id=…                    order book (ex = Polymarket's book timestamp, ms), written when the hash changes
//   data-api  /trades?market=conditionId         public prints (wallet field dropped), deduped
// Resolution of the up/down markets is Chainlink-based (not CF BRTI), so these are recorded as a comparison venue
// for the same 15-minute question, not as a substitute for Kalshi settlement.
const { publicGet, Bucket } = require('./public-get');

const parseArr = (x) => { if (Array.isArray(x)) return x; try { const a = JSON.parse(x || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
function normPolyBook(j, depth = 10) {
  const lv = (a, desc) => (a || []).map((x) => [+x.price, +x.size]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, depth);
  const bids = lv(j.bids, true), asks = lv(j.asks, false);
  return { ex: j.timestamp != null ? +j.timestamp : null, hash: j.hash || null, bids, asks, bb: bids.length ? bids[0][0] : null, ba: asks.length ? asks[0][0] : null };
}
const windowStart = (ms, w = 900) => Math.floor(ms / 1000 / w) * w;

class PolymarketRecorder {
  constructor({ store, health, cfg = {}, gap = () => {}, now = () => Date.now(), get = publicGet, log = (m) => console.log(m) }) {
    this.c = { gamma: 'https://gamma-api.polymarket.com', clob: 'https://clob.polymarket.com', data: 'https://data-api.polymarket.com', assets: ['btc', 'eth', 'sol', 'xrp'],
      bookMs: 2000, tradesMs: 5000, discoverMs: 30000, topN: 10, topMs: 60000, maxRps: 10, gapMs: 10000, depth: 10, ...cfg };
    Object.assign(this, { store, health, gap, now, get, log });
    this.markets = new Map(); this.top = []; this.bucket = new Bucket(this.c.maxRps, now); this.timers = []; this.errors = 0; this.polls = { book: 0, trades: 0, discover: 0, top: 0 }; this.running = false;
    health.register('rec.poly.book', { label: 'Recorder · Polymarket 15m up/down books', group: 'recorder', note: `public CLOB /book every ${this.c.bookMs / 1000}s (${this.c.assets.join(', ')})`, staleMs: 30000 });
    health.register('rec.poly.trades', { label: 'Recorder · Polymarket trades', group: 'recorder', note: 'public data-api /trades, deduped (wallet field dropped)', staleMs: 60000 });
    health.register('rec.poly.markets', { label: 'Recorder · Polymarket discovery + top markets', group: 'recorder', note: `public gamma-api; top ${this.c.topN} by 24h volume sampled every ${this.c.topMs / 1000}s`, staleMs: 180000 });
  }
  async call(id, url) { if (!this.bucket.take()) return null; try { return await this.get(url, { health: this.health, id }); } catch { this.errors++; return null; } }
  // One in-flight run per loop: a slow cycle is skipped (and later shows up as a measured gap), never stacked on itself.
  every(ms, f) { let busy = false; const run = async () => { if (busy) { this.skipped = (this.skipped || 0) + 1; return; } busy = true; try { await f(); } catch (e) { this.log('[recorder] loop error: ' + e.message); } finally { busy = false; } };
    const t = setInterval(run, ms); if (t.unref) t.unref(); this.timers.push(t); }
  start() {
    if (this.running) return; this.running = true; this.discover(); setTimeout(() => this.pollTop(), 5000).unref?.();
    this.every(this.c.bookMs, () => this.pollBooks()); this.every(this.c.tradesMs, () => this.pollTrades()); this.every(this.c.discoverMs, () => this.discover()); this.every(this.c.topMs, () => this.pollTop());
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; }
  restart() { this.stop(); this.start(); }
  watchSpec() { return [{ key: 'recorder polymarket books', ids: ['rec.poly.book'], intervalMs: this.c.bookMs * 5, restart: () => this.restart() }]; }
  track(m, asset) {
    if (this.markets.has(m.slug)) return;
    const toks = parseArr(m.clobTokenIds), outs = parseArr(m.outcomes);
    if (!toks.length) return;
    const st = { slug: m.slug, asset, cond: m.conditionId, end: Date.parse(m.endDate) || null, start: null, toks: toks.map((id, i) => ({ id: String(id), out: outs[i] || String(i), hash: null, lastOk: null })), seen: new Set(), seenQ: [], trades: 0, bookRows: 0, settled: false, lastTradeOk: null };
    const ws = /-(\d{9,})$/.exec(m.slug); if (ws) st.start = +ws[1] * 1000;
    this.markets.set(m.slug, st);
    this.store.write('poly.market', { t: 'market', slug: m.slug, asset, cond: m.conditionId, start: st.start, end: st.end, tokens: st.toks.map((x) => ({ id: x.id, out: x.out })), q: m.question || null, src: m.resolutionSource || null });
  }
  async discover() {
    this.polls.discover++; const now = this.now();
    for (const ws of [windowStart(now), windowStart(now) + 900]) for (const a of this.c.assets) {
      const slug = `${a}-updown-15m-${ws}`; if (this.markets.has(slug)) continue;
      const j = await this.call('rec.poly.markets', `${this.c.gamma}/markets?slug=${encodeURIComponent(slug)}`);
      const m = Array.isArray(j) ? j[0] : null; if (m) this.track(m, a);
    }
    // settlement (closed + outcomePrices) for finished windows
    for (const st of this.markets.values()) {
      if (st.settled || !st.end || now < st.end + 30000) continue;
      const j = await this.call('rec.poly.markets', `${this.c.gamma}/markets?slug=${encodeURIComponent(st.slug)}`); const m = Array.isArray(j) ? j[0] : null; if (!m) continue;
      if (m.closed) { st.settled = true; this.store.write('poly.market', { t: 'settle', slug: st.slug, asset: st.asset, prices: parseArr(m.outcomePrices).map(Number), outcomes: parseArr(m.outcomes), umaStatus: m.umaResolutionStatus || null }); }
      else if (now - st.end > 6 * 3600e3) { st.settled = true; this.store.write('poly.market', { t: 'settle_timeout', slug: st.slug }); }
    }
    for (const [k, st] of this.markets) if (st.settled && now - st.end > 3 * 3600e3) this.markets.delete(k);
  }
  live() { const now = this.now(); return [...this.markets.values()].filter((m) => !m.settled && m.end && now < m.end + 2000 && (!m.start || now >= m.start - 1000)); }
  async book(stream, tok, meta, hid) {
    const j = await this.call(hid, `${this.c.clob}/book?token_id=${encodeURIComponent(tok.id)}`); if (!j) return;
    const rx = this.now(); this.polls.book++;
    if (tok.lastOk != null && rx - tok.lastOk > this.c.gapMs && stream === 'poly.book') this.gap(stream, tok.id, tok.lastOk, rx);
    tok.lastOk = rx; const b = normPolyBook(j, this.c.depth); const key = b.hash || JSON.stringify([b.bids, b.asks]);
    if (key === tok.hash) return; tok.hash = key;
    this.store.write(stream, { t: 'book', tok: tok.id, out: tok.out, ...meta, ex: b.ex, hash: b.hash, bids: b.bids, asks: b.asks, bb: b.bb, ba: b.ba });
    return true;
  }
  async pollBooks() { await Promise.all(this.live().flatMap((m) => m.toks.map((t) => this.book('poly.book', t, { slug: m.slug, asset: m.asset }, 'rec.poly.book').then((w) => { if (w) m.bookRows++; })))); }
  async pollTrades() {
    for (const m of this.live()) {
      if (!m.cond) continue;
      const j = await this.call('rec.poly.trades', `${this.c.data}/trades?market=${encodeURIComponent(m.cond)}&limit=200`); if (!Array.isArray(j)) continue;
      this.polls.trades++; const rx = this.now();
      if (m.lastTradeOk != null && rx - m.lastTradeOk > this.c.gapMs * 2) this.gap('poly.trade', m.slug, m.lastTradeOk, rx);
      m.lastTradeOk = rx;
      const idOf = (t) => (t.transactionHash ? `${t.transactionHash}:${t.asset}:${t.size}:${t.price}` : `${t.timestamp}:${t.asset}:${t.size}:${t.price}:${t.side}`);
      // A full page with NO overlap with what we already hold means prints were missed between polls: say so.
      if (j.length >= 200 && m.trades > 0 && !j.some((t) => m.seen.has(idOf(t)))) this.gap('poly.trade', m.slug, rx, rx, 'trade-page-limit');
      for (const t of j.slice().reverse()) {
        const id = idOf(t);
        if (m.seen.has(id)) continue; m.seen.add(id); m.seenQ.push(id); if (m.seenQ.length > 5000) m.seen.delete(m.seenQ.shift());
        m.trades++;
        this.store.write('poly.trade', { t: 'trade', slug: m.slug, asset: m.asset, tok: t.asset != null ? String(t.asset) : null, out: t.outcome || null, ex: t.timestamp != null ? +t.timestamp * 1000 : null, px: +t.price, sz: +t.size, side: t.side || null, tx: t.transactionHash || null });
      }
    }
  }
  async pollTop() {
    this.polls.top++;
    const j = await this.call('rec.poly.markets', `${this.c.gamma}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${this.c.topN}`);
    if (Array.isArray(j)) this.top = j.map((m) => ({ slug: m.slug, toks: parseArr(m.clobTokenIds).map(String), outs: parseArr(m.outcomes), v: +m.volume24hr || 0, cache: this.top.find((x) => x.slug === m.slug)?.cache || {} })).filter((m) => m.toks.length);
    for (const m of this.top) for (let i = 0; i < m.toks.length && i < 2; i++) {
      const tok = m.cache[m.toks[i]] || (m.cache[m.toks[i]] = { id: m.toks[i], out: m.outs[i] || String(i), hash: null, lastOk: null });
      await this.book('poly.top', tok, { slug: m.slug, v24: m.v }, 'rec.poly.markets');
    }
  }
  view() { const now = this.now(); return { polls: this.polls, errors: this.errors, rateSkipped: this.bucket.skipped, live: this.live().map((m) => ({ slug: m.slug, asset: m.asset, secLeft: Math.round((m.end - now) / 1000), bookRows: m.bookRows, trades: m.trades })), top: this.top.length }; }
}
module.exports = { PolymarketRecorder, normPolyBook, windowStart };
