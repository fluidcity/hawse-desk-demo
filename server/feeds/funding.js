'use strict';
// Real public perpetual funding feeds (no API keys). Normalized per venue/symbol.
// Binance + Bybit may be geo-blocked from some networks (HTTP 451/403); that is
// reported as DOWN in the health panel -- it is never replaced with fake data.
const { fetchJson, sleep } = require('../lib/net');
const { hourlyRate } = require('../lib/fees');

const H = 3600e3;
const VENUES = ['binance', 'bybit', 'okx', 'hyperliquid'];
const LABEL = { binance: 'Binance USD-M', bybit: 'Bybit Linear', okx: 'OKX Swap', hyperliquid: 'Hyperliquid' };

function rec(venue, symbol, { rate, intervalH, nextFundingTime, mark, bid, ask }) {
  rate = +rate; mark = +mark;
  if (!isFinite(rate) || !(mark > 0)) return null;
  const b = +bid > 0 ? +bid : mark, a = +ask > 0 ? +ask : mark;
  return { venue, symbol, rate, intervalH, hourly: hourlyRate(rate, intervalH), nextFundingTime: +nextFundingTime || null,
    mark, bid: b, ask: a, halfSpreadBps: ((a - b) / 2 / ((a + b) / 2)) * 1e4, ts: Date.now() };
}

// ---- parsers (exported for tests) ----
function parseBinance(premium, book, info, symbols) {
  const iv = new Map((info || []).map((x) => [x.symbol, +x.fundingIntervalHours]));
  const bk = new Map((book || []).map((x) => [x.symbol, x]));
  const out = [];
  for (const s of symbols) {
    const p = (premium || []).find((x) => x.symbol === s + 'USDT'); if (!p) continue;
    const b = bk.get(s + 'USDT') || {};
    const r = rec('binance', s, { rate: p.lastFundingRate, intervalH: iv.get(s + 'USDT') || 8, nextFundingTime: p.nextFundingTime, mark: p.markPrice, bid: b.bidPrice, ask: b.askPrice });
    if (r) out.push(r);
  }
  return out;
}
function parseBybit(tickers, instruments, symbols) {
  const list = (tickers && tickers.result && tickers.result.list) || [];
  const iv = new Map(((instruments && instruments.result && instruments.result.list) || []).map((x) => [x.symbol, +x.fundingInterval / 60]));
  const out = [];
  for (const s of symbols) {
    const t = list.find((x) => x.symbol === s + 'USDT'); if (!t) continue;
    const intervalH = +t.fundingIntervalHour || iv.get(s + 'USDT') || 8;
    const r = rec('bybit', s, { rate: t.fundingRate, intervalH, nextFundingTime: t.nextFundingTime, mark: t.markPrice, bid: t.bid1Price, ask: t.ask1Price });
    if (r) out.push(r);
  }
  return out;
}
function parseOkx(fundingBySym, tickers, marks, symbols) {
  const tk = new Map(((tickers && tickers.data) || []).map((x) => [x.instId, x]));
  const mk = new Map(((marks && marks.data) || []).map((x) => [x.instId, x]));
  const out = [];
  for (const s of symbols) {
    const id = s + '-USDT-SWAP'; const f = fundingBySym[s]; if (!f) continue;
    const intervalH = f.nextFundingTime && f.fundingTime ? (+f.nextFundingTime - +f.fundingTime) / H : 8;
    const t = tk.get(id) || {}; const m = mk.get(id) || {};
    const r = rec('okx', s, { rate: f.fundingRate, intervalH: intervalH > 0 ? intervalH : 8, nextFundingTime: f.fundingTime, mark: m.markPx || t.last, bid: t.bidPx, ask: t.askPx });
    if (r) out.push(r);
  }
  return out;
}
function parseHyperliquid(meta, symbols, now = Date.now()) {
  if (!Array.isArray(meta) || meta.length < 2) return [];
  const [m, ctxs] = meta; const out = [];
  const next = Math.ceil((now + 1) / H) * H; // HL settles hourly on the hour
  for (const s of symbols) {
    const i = m.universe.findIndex((u) => u.name === s); if (i < 0) continue;
    const c = ctxs[i]; const ip = c.impactPxs || [];
    const r = rec('hyperliquid', s, { rate: c.funding, intervalH: 1, nextFundingTime: next, mark: c.markPx, bid: ip[0], ask: ip[1] });
    if (r) { r.dayNtlVlm = +c.dayNtlVlm; r.openInterestUsd = +c.openInterest * r.mark; out.push(r); }
  }
  return out;
}

class FundingFeed {
  constructor({ health, symbols, pollMs }) {
    this.health = health; this.symbols = symbols; this.pollMs = pollMs;
    this.data = new Map(); // key venue|symbol -> rec
    this.cache = { binanceInfo: null, bybitInst: null, cacheT: 0 };
    for (const v of VENUES) health.register('funding.' + v, { label: LABEL[v] + ' funding', group: 'Perp funding', kind: 'live', note: 'public REST, no key' });
  }
  get(venue, symbol) { return this.data.get(venue + '|' + symbol); }
  fresh(maxAgeMs = 3 * 60e3) { return [...this.data.values()].filter((r) => Date.now() - r.ts < maxAgeMs); }
  bySymbol(symbol, maxAgeMs) { return this.fresh(maxAgeMs).filter((r) => r.symbol === symbol); }
  put(list) { for (const r of list) this.data.set(r.venue + '|' + r.symbol, r); }
  async pollBinance() {
    const id = 'funding.binance', base = 'https://fapi.binance.com';
    const premium = await fetchJson(base + '/fapi/v1/premiumIndex', { health: this.health, id });
    const book = await fetchJson(base + '/fapi/v1/ticker/bookTicker', { health: this.health, id }).catch(() => []);
    if (!this.cache.binanceInfo || Date.now() - this.cache.cacheT > H) this.cache.binanceInfo = await fetchJson(base + '/fapi/v1/fundingInfo').catch(() => []);
    this.put(parseBinance(premium, book, this.cache.binanceInfo, this.symbols));
  }
  async pollBybit() {
    const id = 'funding.bybit', base = 'https://api.bybit.com';
    const t = await fetchJson(base + '/v5/market/tickers?category=linear', { health: this.health, id });
    if (!this.cache.bybitInst) this.cache.bybitInst = await fetchJson(base + '/v5/market/instruments-info?category=linear&limit=1000').catch(() => null);
    this.put(parseBybit(t, this.cache.bybitInst, this.symbols));
  }
  async pollOkx() {
    const id = 'funding.okx', base = 'https://www.okx.com';
    const tickers = await fetchJson(base + '/api/v5/market/tickers?instType=SWAP', { health: this.health, id });
    const marks = await fetchJson(base + '/api/v5/public/mark-price?instType=SWAP').catch(() => null);
    const f = {};
    for (const s of this.symbols) { // OKX has no batch funding endpoint; stay well under its rate limit
      try { const r = await fetchJson(`${base}/api/v5/public/funding-rate?instId=${s}-USDT-SWAP`); if (r.data && r.data[0]) f[s] = r.data[0]; } catch { /* symbol may not exist */ }
      await sleep(250);
    }
    this.put(parseOkx(f, tickers, marks, this.symbols));
  }
  async pollHyperliquid() {
    const meta = await fetchJson('https://api.hyperliquid.xyz/info', { method: 'POST', body: { type: 'metaAndAssetCtxs' }, health: this.health, id: 'funding.hyperliquid' });
    this.put(parseHyperliquid(meta, this.symbols));
  }
  async pollAll() {
    await Promise.allSettled([this.pollBinance(), this.pollBybit(), this.pollOkx(), this.pollHyperliquid()]);
  }
  start() { const run = () => this.pollAll().catch(() => {}); run(); this.timer = setInterval(run, this.pollMs); }
  stop() { clearInterval(this.timer); }
  snapshot() { return { venues: VENUES, labels: LABEL, symbols: this.symbols, rows: this.fresh(10 * 60e3) }; }
}

module.exports = { FundingFeed, VENUES, parseBinance, parseBybit, parseOkx, parseHyperliquid };
