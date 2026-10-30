'use strict';
// Real-time perp + spot top-of-book and funding over public exchange WebSockets (no keys):
//   Binance USD-M (bookTicker + markPrice@1s incl. funding), Bybit linear (tickers incl. funding),
//   OKX (SWAP tickers + funding-rate + mark-price, SPOT tickers), Hyperliquid (bbo + activeAssetCtx incl. funding),
//   spot books: Binance (data-stream.binance.vision), Bybit spot (orderbook.1), OKX spot tickers.
// Perp rows are merged into the FundingFeed store (transport:'ws'), so every strategy that asks engine.quote()
// gets the WS price when it is fresh and the REST-polled price otherwise. Each socket has its own health row.
const { WsClient } = require('../lib/ws');
const { rec } = require('./funding');

const H = 3600e3;
class MarketStream {
  constructor({ health, funding, symbols, spotSymbols }) {
    this.health = health; this.funding = funding; this.symbols = symbols; this.spotSymbols = spotSymbols || symbols;
    this.raw = {}; this.spot = {}; this.clients = [];
    const reg = (id, label) => health.register(id, { label, group: 'websocket', transport: 'ws', staleMs: 15000, note: 'public websocket · latency = exchange event time → box' });
    reg('ws.binance', 'Binance USD-M perps WS'); reg('ws.bybit', 'Bybit linear perps WS'); reg('ws.okx', 'OKX swap + spot WS'); reg('ws.hyperliquid', 'Hyperliquid WS');
    reg('ws.binance-spot', 'Binance spot book WS'); reg('ws.bybit-spot', 'Bybit spot book WS');
  }
  start() {
    const S = this.symbols, lc = (s) => s.toLowerCase() + 'usdt';
    // Binance routes USD-M streams by path: /public (book tickers) and /market (mark price + funding).
    const bin = (txt) => { const { data: d } = JSON.parse(txt); if (!d || !d.s) return null; const sym = d.s.replace(/USDT$/, '');
      if (d.e === 'markPriceUpdate') this.merge('binance', sym, { mark: +d.p, rate: +d.r, nextFundingTime: d.T }); else this.merge('binance', sym, { bid: +d.b, ask: +d.a }); return d.E || d.T; };
    this.clients.push(new WsClient({ url: `wss://fstream.binance.com/public/stream?streams=${S.map((s) => lc(s) + '@bookTicker').join('/')}`, health: this.health, id: 'ws.binance', onMessage: bin }));
    this.clients.push(new WsClient({ url: `wss://fstream.binance.com/market/stream?streams=${S.map((s) => lc(s) + '@markPrice@1s').join('/')}`, health: this.health, id: 'ws.binance', onMessage: bin }));
    this.clients.push(new WsClient({ url: 'wss://stream.bybit.com/v5/public/linear', health: this.health, id: 'ws.bybit', pingMs: 20000, ping: { op: 'ping' },
      onOpen: (c) => c.send({ op: 'subscribe', args: S.map((s) => `tickers.${s}USDT`) }),
      onMessage: (txt) => { const m = JSON.parse(txt); if (!m.topic || !m.data) return null; const d = m.data, sym = d.symbol.replace(/USDT$/, '');
        this.merge('bybit', sym, { bid: d.bid1Price && +d.bid1Price, ask: d.ask1Price && +d.ask1Price, mark: d.markPrice && +d.markPrice, rate: d.fundingRate !== undefined ? +d.fundingRate : undefined,
          nextFundingTime: d.nextFundingTime && +d.nextFundingTime, intervalH: d.fundingIntervalHour && +d.fundingIntervalHour }); return m.ts; } }));
    this.clients.push(new WsClient({ url: 'wss://ws.okx.com/ws/v5/public', health: this.health, id: 'ws.okx', pingMs: 20000, ping: 'ping',
      onOpen: (c) => c.send({ op: 'subscribe', args: [...S.flatMap((s) => ['tickers', 'funding-rate', 'mark-price'].map((channel) => ({ channel, instId: `${s}-USDT-SWAP` }))), ...this.spotSymbols.map((s) => ({ channel: 'tickers', instId: `${s}-USDT` }))] }),
      onMessage: (txt) => { if (txt === 'pong') return null; const m = JSON.parse(txt); if (!m.data || !m.arg) return null; const d = m.data[0], id = m.arg.instId, sym = id.split('-')[0];
        if (!id.endsWith('-SWAP')) { this.putSpot('okx', sym, +d.bidPx, +d.askPx, +d.ts); return +d.ts; }
        if (m.arg.channel === 'tickers') this.merge('okx', sym, { bid: +d.bidPx, ask: +d.askPx });
        else if (m.arg.channel === 'mark-price') this.merge('okx', sym, { mark: +d.markPx });
        else if (m.arg.channel === 'funding-rate') this.merge('okx', sym, { rate: +d.fundingRate, nextFundingTime: +d.fundingTime, intervalH: d.nextFundingTime && d.fundingTime ? (+d.nextFundingTime - +d.fundingTime) / H : undefined });
        return +d.ts; } }));
    this.clients.push(new WsClient({ url: 'wss://api.hyperliquid.xyz/ws', health: this.health, id: 'ws.hyperliquid', pingMs: 30000, ping: { method: 'ping' },
      onOpen: (c) => S.forEach((coin) => { c.send({ method: 'subscribe', subscription: { type: 'bbo', coin } }); c.send({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin } }); }),
      onMessage: (txt) => { const m = JSON.parse(txt);
        if (m.channel === 'bbo' && m.data && m.data.bbo) { const [b, a] = m.data.bbo; this.merge('hyperliquid', m.data.coin, { bid: b && +b.px, ask: a && +a.px }); return m.data.time; }
        if (m.channel === 'activeAssetCtx' && m.data) { const c = m.data.ctx; this.merge('hyperliquid', m.data.coin, { mark: +c.markPx, rate: +c.funding, intervalH: 1, nextFundingTime: Math.ceil((Date.now() + 1) / H) * H, dayNtlVlm: +c.dayNtlVlm }); }
        return null; } }));
    this.clients.push(new WsClient({ url: `wss://data-stream.binance.vision/stream?streams=${this.spotSymbols.map((s) => lc(s) + '@bookTicker').join('/')}`, health: this.health, id: 'ws.binance-spot',
      onMessage: (txt) => { const { data: d } = JSON.parse(txt); if (!d || !d.s) return null; this.putSpot('binance', d.s.replace(/USDT$/, ''), +d.b, +d.a, Date.now()); return null; } }));
    this.clients.push(new WsClient({ url: 'wss://stream.bybit.com/v5/public/spot', health: this.health, id: 'ws.bybit-spot', pingMs: 20000, ping: { op: 'ping' },
      onOpen: (c) => c.send({ op: 'subscribe', args: this.spotSymbols.map((s) => `orderbook.1.${s}USDT`) }),
      onMessage: (txt) => { const m = JSON.parse(txt); if (!m.topic || !m.data) return null; const d = m.data, sym = d.s.replace(/USDT$/, ''), k = 'bybit|' + sym, cur = this.spot[k] || {};
        const b = d.b && d.b[0] ? +d.b[0][0] : cur.bid, a = d.a && d.a[0] ? +d.a[0][0] : cur.ask; if (b && a) this.putSpot('bybit', sym, b, a, m.ts); return m.ts; } }));
    this.clients.forEach((c) => c.start());
  }
  stop() { this.clients.forEach((c) => c.stop()); }
  /** Merge a partial WS update; publish to the funding store once bid/ask/mark/rate are all known. */
  merge(venue, symbol, patch) {
    const k = venue + '|' + symbol, r = (this.raw[k] ||= { intervalH: venue === 'hyperliquid' ? 1 : 8 });
    for (const [key, v] of Object.entries(patch)) if (v !== undefined && v !== null && !Number.isNaN(v)) r[key] = v;
    r.ts = Date.now();
    if (!r.mark && r.bid && r.ask) r.mark = (r.bid + r.ask) / 2;
    if (r.rate === undefined) { const prev = this.funding.get(venue, symbol); if (prev) { r.rate = prev.rate; r.intervalH = prev.intervalH; } }
    if (r.rate === undefined || !r.mark) return;
    const row = rec(venue, symbol, r); if (!row) return;
    row.transport = 'ws'; if (r.dayNtlVlm) row.dayNtlVlm = r.dayNtlVlm;
    this.funding.data.set(k, row);
  }
  putSpot(venue, symbol, bid, ask, exTs) { if (!(bid > 0 && ask > 0)) return; this.spot[venue + '|' + symbol] = { venue, symbol, bid, ask, mid: (bid + ask) / 2, halfSpreadBps: ((ask - bid) / 2 / ((ask + bid) / 2)) * 1e4, ts: Date.now(), exTs }; }
  spotQuote(venue, symbol, maxAgeMs = 10000) { const q = this.spot[venue + '|' + symbol]; return q && Date.now() - q.ts < maxAgeMs ? q : null; }
  snapshot() { return { sockets: this.clients.map((c) => ({ id: c.id, open: c.open, msgs: c.msgs })), spot: Object.values(this.spot).filter((q) => Date.now() - q.ts < 15000).map(({ venue, symbol, bid, ask }) => ({ venue, symbol, bid, ask })) }; }
}
module.exports = { MarketStream };
