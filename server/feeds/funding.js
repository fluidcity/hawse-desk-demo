'use strict';
// Real public perpetual funding feeds (no API keys). Normalized per venue/symbol.
// Binance + Bybit may be geo-blocked from some networks (HTTP 451/403); that is
// reported as DOWN in the health panel -- it is never replaced with fake data.
const { fetchJson, sleep } = require('../lib/net');
const { hourlyRate } = require('../lib/fees');

const H = 3600e3;
const VENUES = ['binance', 'bybit', 'okx', 'hyperliquid'];
// Binance USD-M REST (fapi.binance.com, also dapi) answers 451 and Bybit REST (api.bybit.com and api.bytick.com) answers a
// CloudFront 403 from some hosts (this box: US). No documented public REST alternative serves perp funding there, so the
// row says BLOCKED (HTTP xxx) and is re-probed every 30 min; the same venues' public WebSockets (fstream.binance.com,
// stream.bybit.com) are not blocked and already feed rates/marks into this store (transport 'ws').
const BLOCK_REPROBE_MS = 30 * 60e3;
const BLOCKED_ALT = { binance: 'rates/marks via ws.binance (public WS)', bybit: 'rates/marks via ws.bybit (public WS)' };
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
// Hyperliquid `predictedFundings`: [[asset, [[venueKey, {fundingRate, nextFundingTime, fundingIntervalHours} | null], ...]], ...]
// One call returns the NEXT predicted rate for HL, Binance and Bybit (OKX's funding-rate endpoint is itself the current-period forecast).
const PRED_VENUE = { HlPerp: 'hyperliquid', BinPerp: 'binance', BybitPerp: 'bybit' };
function parsePredicted(resp, symbols, now = Date.now()) {
  const out = []; if (!Array.isArray(resp)) return out;
  const want = new Set(symbols);
  for (const row of resp) {
    if (!Array.isArray(row) || !want.has(row[0]) || !Array.isArray(row[1])) continue;
    for (const [vk, d] of row[1]) {
      const venue = PRED_VENUE[vk]; if (!venue || !d) continue;
      const rate = +d.fundingRate, intervalH = +d.fundingIntervalHours || (venue === 'hyperliquid' ? 1 : 8);
      if (!isFinite(rate)) continue;
      out.push({ venue, symbol: row[0], rate, intervalH, hourly: hourlyRate(rate, intervalH), nextFundingTime: +d.nextFundingTime || null, ts: now });
    }
  }
  return out;
}
/** Top-N Hyperliquid perps by open interest (USD), from a metaAndAssetCtxs response. Delisted assets are skipped. */
function topByOi(meta, n) {
  if (!(n > 0) || !Array.isArray(meta) || meta.length < 2) return [];
  const [m, ctxs] = meta;
  return m.universe.map((u, i) => ({ name: u.name, delisted: u.isDelisted, oi: +(ctxs[i] || {}).openInterest * +(ctxs[i] || {}).markPx }))
    .filter((x) => !x.delisted && x.oi > 0 && /^[A-Z0-9]+$/.test(x.name)).sort((a, b) => b.oi - a.oi).slice(0, n).map((x) => x.name);
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
  constructor({ health, symbols, pollMs, usePredicted = true, hlTopOi = 0, obsMs = 15 * 60e3, histLen = 6 }) {
    this.health = health; this.baseSymbols = [...symbols]; this.symbols = [...symbols]; this.pollMs = pollMs;
    this.usePredicted = usePredicted; this.hlTopOi = hlTopOi; this.obsMs = obsMs; this.histLen = histLen;
    this.data = new Map(); // key venue|symbol -> rec
    this.pred = new Map(); // key venue|symbol -> predicted next-funding row (HL predictedFundings)
    this.hist = new Map(); // key venue|symbol -> last `histLen` observations [{ts, hourly}], one per obsMs at most
    this.cache = { binanceInfo: null, bybitInst: null, cacheT: 0 };
    for (const v of VENUES) health.register('funding.' + v, { label: LABEL[v] + ' funding', group: 'Perp funding', kind: 'live', note: 'public REST, no key' });
    if (usePredicted) health.register('funding.predicted', { label: 'Hyperliquid predictedFundings', group: 'Perp funding', kind: 'live', note: 'next-rate forecast for HL · Binance · Bybit, public, no key' });
    for (const v of ['binance', 'bybit']) if (health.setBlockedAlt) health.setBlockedAlt('funding.' + v, BLOCKED_ALT[v]);
  }
  get(venue, symbol) { return this.data.get(venue + '|' + symbol); }
  predicted(venue, symbol, maxAgeMs = 10 * 60e3) { const r = this.pred.get(venue + '|' + symbol); return r && Date.now() - r.ts < maxAgeMs ? r : null; }
  /** Rolling observation history (persistence filter input). An observation is a sample of the venue's current rate, at most one per obsMs. */
  history(venue, symbol) { return this.hist.get(venue + '|' + symbol) || []; }
  observe(r, now = r.ts || Date.now()) {
    const k = r.venue + '|' + r.symbol, h = this.hist.get(k) || [];
    if (h.length && now - h[h.length - 1].ts < this.obsMs) return false;
    h.push({ ts: now, hourly: r.hourly }); while (h.length > this.histLen) h.shift(); this.hist.set(k, h); return true;
  }
  fresh(maxAgeMs = 3 * 60e3) { return [...this.data.values()].filter((r) => Date.now() - r.ts < maxAgeMs); }
  bySymbol(symbol, maxAgeMs) { return this.fresh(maxAgeMs).filter((r) => r.symbol === symbol); }
  /** REST rows never overwrite a fresher websocket row (WS rows carry transport:'ws'). */
  put(list) {
    for (const r of list) {
      const k = r.venue + '|' + r.symbol, cur = this.data.get(k);
      if (cur && cur.transport === 'ws' && Date.now() - cur.ts < 15000) { cur.restRate = r.rate; cur.intervalH = r.intervalH || cur.intervalH; continue; }
      this.data.set(k, { transport: 'rest', ...r });
      this.observe(r);
    }
  }
  async pollBinance() {
    const id = 'funding.binance', base = 'https://fapi.binance.com';
    if (this.health.isBlocked && this.health.isBlocked(id, BLOCK_REPROBE_MS)) return;
    const premium = await fetchJson(base + '/fapi/v1/premiumIndex', { health: this.health, id });
    const book = await fetchJson(base + '/fapi/v1/ticker/bookTicker', { health: this.health, id }).catch(() => []);
    if (!this.cache.binanceInfo || Date.now() - this.cache.cacheT > H) this.cache.binanceInfo = await fetchJson(base + '/fapi/v1/fundingInfo').catch(() => []);
    this.put(parseBinance(premium, book, this.cache.binanceInfo, this.symbols));
  }
  async pollBybit() {
    const id = 'funding.bybit', base = 'https://api.bybit.com';
    if (this.health.isBlocked && this.health.isBlocked(id, BLOCK_REPROBE_MS)) return;
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
    if (this.hlTopOi > 0) { const top = topByOi(meta, this.hlTopOi); if (top.length) this.symbols = [...new Set([...this.baseSymbols, ...top])]; }
    this.put(parseHyperliquid(meta, this.symbols));
  }
  /** ONE POST /info {type:'predictedFundings'} per poll (public, no key). */
  async pollPredicted() {
    if (!this.usePredicted) return;
    const resp = await fetchJson('https://api.hyperliquid.xyz/info', { method: 'POST', body: { type: 'predictedFundings' }, health: this.health, id: 'funding.predicted' });
    for (const r of parsePredicted(resp, this.symbols)) this.pred.set(r.venue + '|' + r.symbol, r);
  }
  async pollAll() {
    await Promise.allSettled([this.pollBinance(), this.pollBybit(), this.pollOkx(), this.pollHyperliquid().then(() => this.pollPredicted())]);
  }
  start() { const run = () => this.pollAll().catch(() => {}); run(); this.timer = setInterval(run, this.pollMs); }
  stop() { clearInterval(this.timer); }
  restart() { this.stop(); this.start(); }
  watchSpec() { return { key: 'funding (REST poll)', ids: [...VENUES.map((v) => 'funding.' + v), ...(this.usePredicted ? ['funding.predicted'] : [])], intervalMs: this.pollMs, restart: () => this.restart() }; }
  snapshot() { return { venues: VENUES, labels: LABEL, symbols: this.symbols, rows: this.fresh(10 * 60e3), predicted: [...this.pred.values()].filter((r) => Date.now() - r.ts < 10 * 60e3).map(({ venue, symbol, hourly, nextFundingTime }) => ({ venue, symbol, hourly, nextFundingTime })) }; }
}

module.exports = { rec, FundingFeed, VENUES, parseBinance, parseBybit, parseOkx, parseHyperliquid, parsePredicted, topByOi, PRED_VENUE };
