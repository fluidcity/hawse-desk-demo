'use strict';
// Real 15m spot candles + spot top-of-book. OKX primary, Coinbase Exchange fallback, Binance (data-api.binance.vision) last.
// Only CLOSED bars are exposed to strategies.
const { fetchJson } = require('../lib/net');
const BAR_MS = 15 * 60e3;

const parseOkxCandles = (j) => (j.data || []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: r[8] === '1' })).reverse();
const parseCoinbaseCandles = (rows, now = Date.now()) => rows.map((r) => ({ t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5], closed: r[0] * 1000 + BAR_MS <= now })).reverse();
const parseBinanceKlines = (rows, now = Date.now()) => rows.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: +r[6] < now }));

class CandleFeed {
  constructor({ health, symbols, pollMs = 60000 }) {
    this.health = health; this.symbols = symbols; this.pollMs = pollMs; this.bars = {}; this.src = {}; this.tob = {};
    health.register('candles.okx', { label: 'OKX spot candles 15m', group: 'candles', note: 'public REST' });
    health.register('candles.coinbase', { label: 'Coinbase candles 15m (fallback)', group: 'candles', note: 'used only if OKX fails' });
    health.register('candles.binance', { label: 'Binance data-api candles (fallback)', group: 'candles', note: 'used only if OKX + Coinbase fail' });
    health.register('spot.okx', { label: 'OKX spot top-of-book', group: 'candles', note: 'public REST' });
  }
  start() { this.poll(); this.pollTob(); this.t1 = setInterval(() => this.poll(), this.pollMs); this.t2 = setInterval(() => this.pollTob(), 10000); }
  stop() { clearInterval(this.t1); clearInterval(this.t2); }
  restart() { this.stop(); this.start(); }
  watchSpec() { return { key: 'candles (REST poll)', ids: ['candles.okx', 'candles.coinbase', 'candles.binance'], intervalMs: this.pollMs, restart: () => this.restart() }; }
  async poll() {
    for (const s of this.symbols) {
      let bars = null, src = null;
      try { bars = parseOkxCandles(await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${s}-USDT&bar=15m&limit=200`, { health: this.health, id: 'candles.okx' })); src = 'OKX'; } catch {}
      if (!bars || bars.length < 60) try { bars = parseCoinbaseCandles(await fetchJson(`https://api.exchange.coinbase.com/products/${s}-USD/candles?granularity=900`, { health: this.health, id: 'candles.coinbase' })); src = 'Coinbase'; } catch {}
      if (!bars || bars.length < 60) try { bars = parseBinanceKlines(await fetchJson(`https://data-api.binance.vision/api/v3/klines?symbol=${s}USDT&interval=15m&limit=200`, { health: this.health, id: 'candles.binance' })); src = 'Binance'; } catch {}
      if (bars && bars.length >= 60) { this.bars[s] = { bars: bars.filter((b) => b.closed), ts: Date.now() }; this.src[s] = src; }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  async pollTob() {
    try {
      const j = await fetchJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT', { health: this.health, id: 'spot.okx' });
      const want = new Set(this.symbols.map((s) => s + '-USDT'));
      for (const r of j.data || []) if (want.has(r.instId)) { const bid = +r.bidPx, ask = +r.askPx, mid = (bid + ask) / 2; this.tob[r.instId.split('-')[0]] = { mark: +r.last, bid, ask, halfSpreadBps: (ask - bid) / 2 / mid * 1e4, venue: 'okx-spot', ts: Date.now(), vol24Usd: +r.volCcy24h }; }
    } catch {}
  }
  closed(symbol, maxAgeMs = 45 * 60e3) { const b = this.bars[symbol]; return b && Date.now() - b.ts < maxAgeMs ? b.bars : null; }
  quote(symbol, maxAgeMs = 60e3) { const q = this.tob[symbol]; return q && Date.now() - q.ts < maxAgeMs ? q : null; }
  snapshot() { return { sources: this.src, symbols: this.symbols }; }
}
module.exports = { CandleFeed, parseOkxCandles, parseCoinbaseCandles, parseBinanceKlines, BAR_MS };
