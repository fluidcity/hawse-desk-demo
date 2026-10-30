'use strict';
// Closed perp candles from OKX swaps (public REST; OKX has no keyless historical WS). Used by perp momentum and by
// the strategy editor's backtests. History beyond 300 bars pages through /history-candles.
const { fetchJson } = require('../lib/net');
const { parseOkxCandles } = require('./candles');
const BAR = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1H': 3600e3, '4H': 14400e3, '1D': 86400e3 };

async function fetchOkxBars({ symbol, bar = '5m', limit = 300, market = 'swap', health, id }) {
  const inst = market === 'spot' ? `${symbol}-USDT` : `${symbol}-USDT-SWAP`;
  let out = parseOkxCandles(await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${bar}&limit=${Math.min(300, limit)}`, { health, id, timeoutMs: 10000 }));
  while (out.length < limit) {
    const before = out[0] && out[0].t; if (!before) break;
    const older = parseOkxCandles(await fetchJson(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${bar}&limit=100&after=${before}`, { health, id, timeoutMs: 10000 }));
    if (!older.length) break; out = [...older, ...out];
  }
  return out.slice(-limit);
}

class PerpBars {
  constructor({ health, symbols, bar = '5m', pollMs = 60000 }) {
    this.health = health; this.symbols = symbols; this.bar = bar; this.pollMs = pollMs; this.bars = {};
    health.register('candles.okx-swap', { label: `OKX swap candles (${bar})`, group: 'candles', note: 'closed bars for perp momentum', staleMs: pollMs * 3 });
  }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), this.pollMs); }
  stop() { clearInterval(this.timer); }
  async poll() { for (const s of this.symbols) { try { this.bars[s] = await fetchOkxBars({ symbol: s, bar: this.bar, limit: 200, health: this.health, id: 'candles.okx-swap' }); } catch {} } }
  closed(s) { const b = (this.bars[s] || []).filter((x) => x.closed); return b.length ? b : null; }
  snapshot() { return { bar: this.bar, symbols: Object.fromEntries(Object.entries(this.bars).map(([k, v]) => [k, v.length])) }; }
}
module.exports = { PerpBars, fetchOkxBars, BAR };
