'use strict';
// Real public spot top-of-book (REST, no keys) for the funding strategy's cash-and-carry mode.
//   Binance GET /api/v3/ticker/bookTicker · OKX GET /api/v5/market/tickers?instType=SPOT · Bybit GET /v5/market/tickers?category=spot
// One request per venue per poll. Binance/Bybit can be geo-blocked (451/403): that venue shows DOWN and is never faked.
const { fetchJson } = require('../lib/net');

const SPOT_VENUES = Object.freeze(['binance', 'okx', 'bybit']);
const LABEL = { binance: 'Binance spot', okx: 'OKX spot', bybit: 'Bybit spot' };

function q(venue, symbol, bid, ask, now) {
  bid = +bid; ask = +ask; if (!(bid > 0 && ask > 0 && ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  return { venue, symbol, bid, ask, mid, halfSpreadBps: ((ask - bid) / 2 / mid) * 1e4, ts: now, transport: 'rest' };
}
function parseBinanceSpot(list, symbols, now = Date.now()) {
  const m = new Map((Array.isArray(list) ? list : []).map((x) => [x.symbol, x]));
  return symbols.map((s) => { const x = m.get(s + 'USDT'); return x && q('binance', s, x.bidPrice, x.askPrice, now); }).filter(Boolean);
}
function parseOkxSpot(resp, symbols, now = Date.now()) {
  const m = new Map(((resp && resp.data) || []).map((x) => [x.instId, x]));
  return symbols.map((s) => { const x = m.get(s + '-USDT'); return x && q('okx', s, x.bidPx, x.askPx, now); }).filter(Boolean);
}
function parseBybitSpot(resp, symbols, now = Date.now()) {
  const m = new Map(((resp && resp.result && resp.result.list) || []).map((x) => [x.symbol, x]));
  return symbols.map((s) => { const x = m.get(s + 'USDT'); return x && q('bybit', s, x.bid1Price, x.ask1Price, now); }).filter(Boolean);
}

class SpotFeed {
  constructor({ health, symbols, pollMs = 30000 }) {
    this.health = health; this.symbols = symbols; this.pollMs = pollMs; this.data = new Map();
    for (const v of SPOT_VENUES) health.register('spot.' + v, { label: LABEL[v] + ' book', group: 'Spot books', kind: 'live', note: 'public REST, no key · carry mode' });
  }
  syms() { return typeof this.symbols === 'function' ? this.symbols() : this.symbols; }
  put(rows) { for (const r of rows) this.data.set(r.venue + '|' + r.symbol, r); }
  get(venue, symbol, maxAgeMs = 90000) { const r = this.data.get(venue + '|' + symbol); return r && Date.now() - r.ts < maxAgeMs ? r : null; }
  async pollAll() {
    const s = this.syms(), h = this.health;
    await Promise.allSettled([
      fetchJson('https://api.binance.com/api/v3/ticker/bookTicker', { health: h, id: 'spot.binance' }).then((r) => this.put(parseBinanceSpot(r, s))),
      fetchJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT', { health: h, id: 'spot.okx' }).then((r) => this.put(parseOkxSpot(r, s))),
      fetchJson('https://api.bybit.com/v5/market/tickers?category=spot', { health: h, id: 'spot.bybit' }).then((r) => this.put(parseBybitSpot(r, s))),
    ]);
  }
  start() { const run = () => this.pollAll().catch(() => {}); run(); this.timer = setInterval(run, this.pollMs); }
  stop() { clearInterval(this.timer); }
  snapshot() { return { rows: [...this.data.values()].filter((r) => Date.now() - r.ts < 120000).map(({ venue, symbol, bid, ask }) => ({ venue, symbol, bid, ask })) }; }
}
module.exports = { SpotFeed, SPOT_VENUES, parseBinanceSpot, parseOkxSpot, parseBybitSpot };
