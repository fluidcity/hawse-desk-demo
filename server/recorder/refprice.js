'use strict';
// Multi-exchange 1-second reference prices (H6, miro's §7A "1 s multi-venue BRTI-like median").
// Free public WebSockets, no keys: Coinbase (ticker), Kraken v2 (trade), Bitstamp (live_trades), Gemini (v1 marketdata
// trades, one socket per asset), Crypto.com (trade) and, since H7, Bullish (unauthenticated anonymousTrades). That is 6 of
// the 7 CF Benchmarks BRTI constituents (list v13.7, 2026-08-24). LMAX Digital has no free public feed (account + API key),
// so it is not wired; see docs/reference-price-sources.md. Each second, per asset, one 'ref' row is written with every venue's last price, its exchange
// timestamp and its age, plus the median of the venues fresher than freshMs.
// This is a BRTI-LIKE MEDIAN OF LAST TRADES. It is NOT the CF Benchmarks index (that uses order-book mid-price
// weighting) and it is NOT Kalshi's settlement source. It is recorded for research only.
const { WsClient } = require('../lib/ws');

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
/** Pure per-venue frame parsers: return [{asset, px, ex}] (possibly empty). */
const parse = {
  coinbase(j) { if (j.type !== 'ticker' || !j.product_id) return []; const a = j.product_id.split('-')[0]; return [{ asset: a, px: +j.price, ex: Date.parse(j.time) || null, bid: +j.best_bid || null, ask: +j.best_ask || null }]; },
  kraken(j) { if (j.channel !== 'trade' || !Array.isArray(j.data)) return []; return j.data.map((d) => ({ asset: String(d.symbol || '').split('/')[0].replace(/^XBT$/, 'BTC'), px: +d.price, ex: Date.parse(d.timestamp) || null })); },
  bitstamp(j) { if (j.event !== 'trade' || !j.data) return []; const m = /^live_trades_([a-z]+)usd$/.exec(j.channel || ''); if (!m) return []; return [{ asset: m[1].toUpperCase(), px: +j.data.price, ex: j.data.microtimestamp ? Math.round(+j.data.microtimestamp / 1000) : (+j.data.timestamp * 1000 || null) }]; },
  gemini(j, asset) { if (j.type !== 'update' || !Array.isArray(j.events)) return []; return j.events.filter((e) => e.type === 'trade').map((e) => ({ asset, px: +e.price, ex: j.timestampms || null })); },
  // Bullish: the 'snapshot' frame replays the last 100 trades (can be weeks old on thin pairs), so only live 'update' batches count.
  bullish(j) { if (j.type !== 'update' || j.dataType !== 'V1TAAnonymousTradeUpdate' || !j.data || !Array.isArray(j.data.trades)) return []; return j.data.trades.map((d) => ({ asset: String(d.symbol || '').replace(/USD$/, ''), px: +d.price, ex: +d.createdAtTimestamp || null, sym: d.symbol })).filter((r) => /^[A-Z]+USD$/.test(r.sym || '')).sort((a, b) => (a.ex || 0) - (b.ex || 0)).map(({ sym, ...r }) => r); },
  cryptocom(j) { const r = j.result; if (!r || !Array.isArray(r.data) || !/^trade\./.test(r.subscription || r.channel || '')) return []; const a = String(r.instrument_name || '').split('_')[0]; return r.data.map((d) => ({ asset: a, px: +d.p, ex: +d.t || null })); },
};
function median(xs) { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return +(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2).toPrecision(12); }

class RefPriceRecorder {
  constructor({ store, health, cfg = {}, now = () => Date.now(), WebSocketImpl, log = (m) => console.log(m) }) {
    this.c = { assets: ASSETS, venues: ['coinbase', 'kraken', 'bitstamp', 'gemini', 'cryptocom', 'bullish'], freshMs: 10000, everyMs: 1000, ...cfg };
    Object.assign(this, { store, health, now, log, WebSocketImpl });
    this.last = {}; for (const a of this.c.assets) this.last[a] = {}; this.rows = 0; this.timers = []; this.clients = []; this.ticks = {}; this.running = false; this.latest = {};
    for (const v of this.c.venues) { this.ticks[v] = 0; health.register('rec.ref.' + v, { label: `Recorder · ref price · ${v}`, group: 'recorder', note: 'free public WebSocket, last trade/ticker → 1 s BRTI-like median (not the CF index)', staleMs: 90000 }); }
    health.register('rec.ref', { label: 'Recorder · 1 s reference median', group: 'recorder', note: `median of fresh (≤${this.c.freshMs / 1000}s) venue prices per asset; research only, not Kalshi's settlement source`, staleMs: 10000 });
  }
  take(venue, rows) { for (const r of rows) { if (!r.asset || !this.last[r.asset] || !(r.px > 0)) continue; this.last[r.asset][venue] = { px: r.px, ex: r.ex, rx: this.now() }; this.ticks[venue]++; } return rows.length && rows[0].ex ? rows[0].ex : null; }
  mk(venue, url, onOpen, parseFn, extra = {}) {
    const c = new WsClient({ url, health: this.health, id: 'rec.ref.' + venue, label: 'recorder ' + venue, WebSocketImpl: this.WebSocketImpl, log: this.log, onOpen, idleMs: 120000,
      onMessage: (s, cl) => { const j = JSON.parse(s); if (extra.onFrame && extra.onFrame(j, cl)) return null; return this.take(venue, parseFn(j)); }, ...extra.ws });
    this.clients.push({ venue, c }); return c;
  }
  start() {
    if (this.running) return; this.running = true; const A = this.c.assets, V = new Set(this.c.venues);
    if (V.has('coinbase')) this.mk('coinbase', 'wss://ws-feed.exchange.coinbase.com', (cl) => cl.send({ type: 'subscribe', product_ids: A.map((a) => a + '-USD'), channels: ['ticker', 'heartbeat'] }), parse.coinbase);
    if (V.has('kraken')) this.mk('kraken', 'wss://ws.kraken.com/v2', (cl) => cl.send({ method: 'subscribe', params: { channel: 'trade', symbol: A.map((a) => a + '/USD') } }), parse.kraken, { ws: { pingMs: 30000, ping: { method: 'ping' } } });
    if (V.has('bitstamp')) this.mk('bitstamp', 'wss://ws.bitstamp.net', (cl) => { for (const a of A) cl.send({ event: 'bts:subscribe', data: { channel: `live_trades_${a.toLowerCase()}usd` } }); }, parse.bitstamp, { ws: { pingMs: 30000, ping: { event: 'bts:heartbeat' } } });
    if (V.has('gemini')) for (const a of A) this.mk('gemini', `wss://api.gemini.com/v1/marketdata/${a}USD?trades=true&bids=false&offers=false&heartbeat=true`, null, (j) => parse.gemini(j, a));
    if (V.has('cryptocom')) this.mk('cryptocom', 'wss://stream.crypto.com/exchange/v1/market', (cl) => { setTimeout(() => cl.send({ id: 1, method: 'subscribe', params: { channels: A.map((a) => `trade.${a}_USD`) } }), 1000).unref?.(); }, parse.cryptocom,
      { onFrame: (j, cl) => { if (j.method === 'public/heartbeat') { cl.send({ id: j.id, method: 'public/respond-heartbeat' }); return true; } return false; } });
    if (V.has('bullish')) this.mk('bullish', 'wss://api.exchange.bullish.com/trading-api/v1/market-data/trades', (cl) => { for (const a of A) cl.send({ jsonrpc: '2.0', type: 'command', method: 'subscribe', params: { topic: 'anonymousTrades', symbol: a + 'USD' }, id: 'sub-' + a }); }, parse.bullish,
      { ws: { pingMs: 30000, ping: { jsonrpc: '2.0', type: 'command', method: 'keepalivePing', params: {}, id: 'ka' } } });
    for (const { c } of this.clients) c.start();
    const t = setInterval(() => this.tick(), this.c.everyMs); if (t.unref) t.unref(); this.timers.push(t);
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; for (const { c } of this.clients) c.stop(); this.clients = []; }
  restart() { for (const { c } of this.clients) c.restart('watchdog'); }
  watchSpec() { return this.c.venues.map((v) => ({ key: 'recorder ref ' + v, ids: ['rec.ref.' + v], intervalMs: 30000, restart: () => { for (const x of this.clients) if (x.venue === v) x.c.restart('watchdog'); } })); }
  /** Build (and write) the 1 s row per asset. Pure apart from the write; exported for tests via snapshotRow. */
  snapshotRow(asset, now = this.now()) {
    const vs = this.last[asset] || {}; const venues = {}; const fresh = [];
    for (const [v, x] of Object.entries(vs)) { const age = now - x.rx; venues[v] = { px: x.px, ex: x.ex, age }; if (age <= this.c.freshMs) fresh.push(x.px); }
    return { t: 'ref', asset, med: median(fresh), n: fresh.length, venues };
  }
  tick() {
    const now = this.now(); let any = false;
    for (const a of this.c.assets) { const r = this.snapshotRow(a, now); if (!Object.keys(r.venues).length) continue; this.store.write('ref', r); this.rows++; this.latest[a] = { med: r.med, n: r.n }; if (r.n) any = true; }
    if (any) this.health.ok('rec.ref', null); else this.health.fail('rec.ref', 'no fresh venue prices');
  }
  view() { return { rows: this.rows, latest: this.latest, venues: this.clients.reduce((o, { venue, c }) => { const v = c.view(); const p = o[venue] || { open: 0, sockets: 0, msgs: 0, reconnects: 0 }; p.sockets++; if (v.open) p.open++; p.msgs += v.msgs; p.reconnects += v.reconnects; p.ticks = this.ticks[venue]; o[venue] = p; return o; }, {}) }; }
}
module.exports = { RefPriceRecorder, parse, median, ASSETS };
