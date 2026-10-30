'use strict';
// H7: optional Kalshi WebSocket market-data recorder. OFF by default (KALSHI_WS=true turns it on) and it only runs when a
// Kalshi key is configured. RECORD ONLY.
//   * Subscribes to the public market-data channels 'orderbook_delta' (a snapshot, then every delta) and 'trade'.
//     Optionally (KALSHI_WS_CF_INDEX=true) it also takes 'cfbenchmarks_value', the CF Benchmarks RTI values (BRTI,
//     ETHUSD_RTI...) that Kalshi relays with their trailing 60 s average, i.e. the settlement index itself.
//     ALLOWED_CHANNELS below is the complete list. Private channels (fill, market_positions, user orders...) are refused
//     in code and by test/kalshi-ws.test.js.
//   * Sends no trading commands: the only commands are subscribe and update_subscription (add_markets,
//     delete_markets, get_snapshot).
//   * The handshake headers come from an injected function (server/kalshi-auth/ws-sign.js, the repo's single signing
//     helper). This file never sees the key, and it attaches the headers only to the Kalshi WS URL.
//   * The REST poller (kalshi.js) keeps running. This adds full-resolution books and exchange timestamps on top. The
//     frozen H2 paper test still reads the REST books, so the frozen rule's inputs do not change.
// Rows: 'kalshi.ws.book' {t:'snap'|'delta'}, 'kalshi.ws.trade', 'kalshi.ws.cf'; gaps (seq jumps, socket down) go to 'gaps'.
const { WsClient } = require('../lib/ws');
const { isKalshiWsUrl } = require('../kalshi-auth/ws-sign');

const ALLOWED_CHANNELS = ['orderbook_delta', 'trade', 'cfbenchmarks_value'];
const ALLOWED_CMDS = ['subscribe', 'update_subscription'];
const ALLOWED_ACTIONS = ['add_markets', 'delete_markets', 'get_snapshot'];
const num = (x) => (x == null || x === '' ? null : +x);
const levels = (a) => (Array.isArray(a) ? a.map((l) => [num(l[0]), num(l[1])]).filter((l) => Number.isFinite(l[0]) && Number.isFinite(l[1])) : []);

/** Validate an outgoing frame against the allowlists. Throws on anything else (pure; exported for tests). */
function checkOutgoing(f) {
  if (!f || !ALLOWED_CMDS.includes(f.cmd)) throw new Error('kalshi-ws: command not allowed: ' + (f && f.cmd));
  const p = f.params || {};
  if (f.cmd === 'subscribe') { const ch = p.channels || []; if (!ch.length || ch.some((c) => !ALLOWED_CHANNELS.includes(c))) throw new Error('kalshi-ws: channel not allowed: ' + ch.join(',')); }
  if (f.cmd === 'update_subscription' && !ALLOWED_ACTIONS.includes(p.action)) throw new Error('kalshi-ws: action not allowed: ' + p.action);
  return f;
}

class KalshiWsRecorder {
  constructor({ store, health, cfg = {}, auth = null, kalshi = null, gap = () => {}, now = () => Date.now(), WebSocketImpl, log = (m) => console.log(m) }) {
    this.c = { url: 'wss://api.elections.kalshi.com/trade-api/ws/v2', cfIndex: false, indexIds: ['BRTI', 'ETHUSD_RTI', 'SOLUSD_RTI', 'XRPUSD_RTI'], syncMs: 5000, kinds: ['crypto'], ...cfg };
    Object.assign(this, { store, health, auth, kalshi, gap, now, log, WebSocketImpl });
    this.n = { snap: 0, delta: 0, trade: 0, cf: 0, seqGaps: 0, errors: 0, sent: 0 }; this.errCodes = {}; this.sids = {}; this.seq = {}; this.subscribed = new Set(); this.pending = new Set();
    this.msgId = 0; this.timers = []; this.running = false; this.lastCf = {}; this.downSince = null;
    this.problem = !auth ? 'no Kalshi key configured (set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH or _PEM; see docs/kalshi-api-key.md)' : !isKalshiWsUrl(this.c.url) ? 'KALSHI_WS_URL is not a Kalshi WebSocket URL' : null;
    health.register('rec.kalshi.ws', { label: 'Recorder · Kalshi WebSocket (orderbook_delta + trade' + (this.c.cfIndex ? ' + CF index' : '') + ')', group: 'recorder',
      note: this.problem || 'authenticated read-only market-data socket; read-only key; the REST poller keeps running alongside', staleMs: 60000 });
    if (this.problem) health.fail('rec.kalshi.ws', this.problem);
  }
  send(cl, f) { checkOutgoing(f); this.n.sent++; cl.send(f); }
  next() { return ++this.msgId; }
  wanted() { if (!this.kalshi) return []; return [...new Set(this.c.kinds.flatMap((k) => this.kalshi.live(k).map((m) => m.tk)))]; }
  start() {
    if (this.running || this.problem) return; this.running = true;
    this.client = new WsClient({ url: this.c.url, health: this.health, id: 'rec.kalshi.ws', label: 'recorder kalshi ws', WebSocketImpl: this.WebSocketImpl, log: this.log, idleMs: 90000, headers: this.auth,
      onOpen: (cl) => this.onOpen(cl), onMessage: (s) => this.onFrame(JSON.parse(s)) });
    this.client.start();
    const t = setInterval(() => this.sync(), this.c.syncMs); if (t.unref) t.unref(); this.timers.push(t);
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; if (this.client) this.client.stop(); this.client = null; }
  restart() { if (this.client) this.client.restart('watchdog'); }
  watchSpec() { return this.problem ? [] : [{ key: 'recorder kalshi ws', ids: ['rec.kalshi.ws'], intervalMs: 60000, restart: () => this.restart() }]; }
  onOpen(cl) {
    const t = this.now(); if (this.downSince != null) this.gap('kalshi.ws', 'socket', this.downSince, t, null); this.downSince = null;
    this.sids = {}; this.seq = {}; this.subscribed = new Set(); this.pending = new Set();
    const tks = this.wanted();
    if (tks.length) { this.send(cl, { id: this.next(), cmd: 'subscribe', params: { channels: ['orderbook_delta'], market_tickers: tks } }); this.send(cl, { id: this.next(), cmd: 'subscribe', params: { channels: ['trade'], market_tickers: tks } }); for (const x of tks) this.pending.add(x); }
    if (this.c.cfIndex) this.send(cl, { id: this.next(), cmd: 'subscribe', params: { channels: ['cfbenchmarks_value'], index_ids: this.c.indexIds } });
  }
  /** Every syncMs: add newly listed markets (each new 15-minute window), drop closed ones. */
  sync() {
    const cl = this.client; if (!cl || !cl.open) { if (this.downSince == null && this.running) this.downSince = this.now(); return; }
    const want = new Set(this.wanted()); const have = new Set([...this.subscribed, ...this.pending]);
    const add = [...want].filter((x) => !have.has(x)); const del = [...this.subscribed].filter((x) => !want.has(x));
    if (add.length) {
      for (const ch of ['orderbook_delta', 'trade']) {
        if (this.sids[ch] != null) this.send(cl, { id: this.next(), cmd: 'update_subscription', params: { sid: this.sids[ch], action: 'add_markets', market_tickers: add } });
        else this.send(cl, { id: this.next(), cmd: 'subscribe', params: { channels: [ch], market_tickers: add } });
      }
      for (const x of add) this.pending.add(x);
    }
    if (del.length) { for (const ch of ['orderbook_delta', 'trade']) if (this.sids[ch] != null) this.send(cl, { id: this.next(), cmd: 'update_subscription', params: { sid: this.sids[ch], action: 'delete_markets', market_tickers: del } }); for (const x of del) this.subscribed.delete(x); }
  }
  /** Parse one frame (pure apart from writes). Returns the exchange timestamp when the frame has one. */
  onFrame(j) {
    const m = j.msg || {}; const rx = this.now();
    if (j.type === 'subscribed') { this.sids[m.channel] = m.sid; if (m.channel === 'orderbook_delta') { for (const x of this.pending) this.subscribed.add(x); this.pending.clear(); } return null; }
    if (j.type === 'error') { this.n.errors++; const k = String(m.code); this.errCodes[k] = (this.errCodes[k] || 0) + 1; this.store.write('kalshi.ws.book', { t: 'ws_error', code: m.code, msg: String(m.msg || '').slice(0, 120) }); if (m.code === 9) this.health.fail('rec.kalshi.ws', 'Kalshi says authentication required (code 9): check the key'); return null; }
    if (j.sid != null && j.seq != null && j.type !== 'subscribed' && j.type !== 'ok') {
      const prev = this.seq[j.sid];
      if (prev != null && j.seq !== prev + 1 && j.type !== 'orderbook_snapshot') { this.n.seqGaps++; this.gap('kalshi.ws', 'sid' + j.sid, rx, rx, 'ws-seq-gap'); this.resnap(); }
      this.seq[j.sid] = j.seq;
    }
    const ex = num(j.sending_ts_ms);
    if (j.type === 'orderbook_snapshot') { this.n.snap++; this.subscribed.add(m.market_ticker); this.store.write('kalshi.ws.book', { t: 'snap', tk: m.market_ticker, clock: m.clock, seq: j.seq, ex, yes: levels(m.yes_dollars_fp), no: levels(m.no_dollars_fp) }); return ex; }
    if (j.type === 'orderbook_delta') { this.n.delta++; const e = num(m.ts_ms) || ex; this.store.write('kalshi.ws.book', { t: 'delta', tk: m.market_ticker, clock: m.clock, seq: j.seq, ex: e, side: m.side, p: num(m.price_dollars), d: num(m.delta_fp) }); return e; }
    if (j.type === 'trade') { this.n.trade++; const e = num(m.ts_ms) || ex; this.store.write('kalshi.ws.trade', { t: 'trade', tk: m.market_ticker, id: m.trade_id, ex: e, yp: num(m.yes_price_dollars), np: num(m.no_price_dollars), n: num(m.count_fp), side: m.taker_side, block: !!m.is_block_trade }); return e; }
    if (j.type === 'cfbenchmarks_value') {
      this.n.cf++; let v = null, src = null; try { const d = JSON.parse(m.data); v = num(d.value); src = num(d.time); } catch { /* raw frame kept below */ }
      const a60 = m.avg_60s_data ? num(m.avg_60s_data.value) : null; const q = m.last_60s_windowed_average_15min;
      const row = { t: 'cf', id: m.index_id, v, src, kalshiRx: num(m.received_at), ex, avg60: a60, q15: q ? { v: num(q.value), n: q.window_size, from: q.window_start_ts_ms, to: q.window_end_ts_exclusive } : null };
      this.store.write('kalshi.ws.cf', row); this.lastCf[m.index_id] = { v, avg60: a60, at: rx }; for (const f of this.cfListeners || []) { try { f(row, rx); } catch { /* display-only consumer */ } } return src || ex;
    }
    return null;
  }
  resnap() { const cl = this.client; const sid = this.sids.orderbook_delta; const tks = [...this.subscribed]; if (cl && cl.open && sid != null && tks.length) this.send(cl, { id: this.next(), cmd: 'update_subscription', params: { sid, action: 'get_snapshot', market_tickers: tks } }); }
  view() { return { enabled: true, problem: this.problem, cfIndex: !!this.c.cfIndex, socket: this.client ? this.client.view() : null, counts: this.n, errCodes: this.errCodes, markets: this.subscribed.size, cf: this.lastCf }; }
}
module.exports = { KalshiWsRecorder, checkOutgoing, ALLOWED_CHANNELS, ALLOWED_CMDS, ALLOWED_ACTIONS };
