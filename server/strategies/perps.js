'use strict';
// Crypto-perp paper strategies (the futures stand-in next to the simulated CME module).
//  - PerpMomentum: Donchian breakout with EMA trend filter on closed OKX swap bars; executes on the freshest real perp
//    quote (WS when fresh). Costs: taker fee both sides, spread+impact slippage, discrete funding settlements.
//  - PerpBasis: cash-and-carry. Buy spot (ask) + short perp (bid) on real books when the basis plus expected funding
//    clears all four taker fees and slippage; exit on convergence or time. Long-spot/short-perp only (no spot shorting).
const { Strategy } = require('./base');
const X = require('../lib/explain');
const F = require('../lib/fees');
const { openPos, managePos } = require('./directional');

const H = 3600e3;
const ema = (xs, n) => { const k = 2 / (n + 1); const out = []; let e = xs[0]; for (const x of xs) { e = x * k + e * (1 - k); out.push(e); } return out; };
const atr = (bars, n = 14) => ema(bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l)), n);

/** Pure (tested): breakout signal on closed bars. Costs are a fraction (round-trip fee+slip). */
// Signal defaults, read by momentumSignal AND by explain() (cfg.perps.momentum overrides them) so text cannot drift.
const MOMENTUM_DEFAULTS = Object.freeze({ lookback: 20, fast: 20, slow: 50, slAtr: 1.5, tpAtr: 3, minAtrPct: 0.1, maxAtrPct: 2.5, costFrac: 0.0012, minEdgeX: 3 });
const BASIS_SPOT_VENUES = Object.freeze(['okx', 'binance', 'bybit']);
const QUOTE_FRESH_MS = 15000;
function momentumSignal(bars, opts = {}) {
  const { lookback, fast, slow, slAtr, tpAtr, minAtrPct, maxAtrPct, costFrac, minEdgeX } = { ...MOMENTUM_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  if (!bars || bars.length < Math.max(slow, lookback) + 5) return { side: null, reason: 'not enough closed bars' };
  const c = bars.map((b) => b.c), ef = ema(c, fast), es = ema(c, slow), a = atr(bars), i = bars.length - 1, px = c[i];
  const prior = bars.slice(i - lookback, i), hi = Math.max(...prior.map((b) => b.h)), lo = Math.min(...prior.map((b) => b.l));
  const atrPct = (a[i] / px) * 100, sl = (slAtr * a[i]) / px, tp = (tpAtr * a[i]) / px;
  const base = { px, atrPct, sl, tp, hi, lo, barT: bars[i].t };
  if (atrPct < minAtrPct) return { ...base, side: null, reason: `volatility too low (ATR ${atrPct.toFixed(2)}%)` };
  if (atrPct > maxAtrPct) return { ...base, side: null, reason: `volatility too high (ATR ${atrPct.toFixed(2)}%)` };
  let side = null;
  if (px > hi && ef[i] > es[i]) side = 'long'; else if (px < lo && ef[i] < es[i]) side = 'short';
  if (!side) return { ...base, side: null, reason: px > hi || px < lo ? 'breakout against EMA trend' : `inside ${lookback}-bar range` };
  if (tp < minEdgeX * costFrac) return { ...base, side: null, reason: `target ${(tp * 100).toFixed(2)}% < ${minEdgeX}× round-trip cost ${(costFrac * 100).toFixed(2)}%` };
  return { ...base, side, reason: `${side} breakout ${lookback}-bar ${side === 'long' ? 'high' : 'low'}` };
}

/** Settle discrete funding for an open perp leg. Returns payment (+ received). */
function settleFunding(s, p, row, now) {
  if (!row) return 0;
  if (!p.nextFT) p.nextFT = row.nextFundingTime && row.nextFundingTime > p.openedAt ? row.nextFundingTime : null;
  if (!p.nextFT || now < p.nextFT) return 0;
  const pay = F.fundingPayment({ side: p.perpSide || p.side, notional: p.qty * row.mark, rate: row.rate });
  s.e.ledger.cashflow(s.id, { amount: pay, simulated: false }); p.funding = (p.funding || 0) + pay;
  s.e.tape.push({ kind: 'fill', strategy: s.id, msg: `FUNDING ${p.symbol} ${row.venue} ${p.perpSide || p.side} @ ${(row.rate * 100).toFixed(4)}%`, pnl: pay, simulated: false });
  p.nextFT = row.nextFundingTime && row.nextFundingTime > now ? row.nextFundingTime : p.nextFT + (row.intervalH || 8) * H;
  return pay;
}

class PerpMomentum extends Strategy {
  constructor(engine, bars) {
    super(engine, { id: 'perpmom', name: 'Perp Momentum', desc: 'Donchian breakout + EMA trend on BTC/ETH/SOL perps · executes on freshest WS quote · fees, slippage & funding modeled', allocPct: 0.13, chains: ['BTC', 'ETH', 'SOL'] });
    this.bars = bars; this.c = engine.cfg.perps; this.signals = {}; this.lastBar = {};
  }
  dataMode() { const any = this.c.symbols.some((s) => this.bars.closed(s)); return any && this.c.symbols.some((s) => this.e.quote(s, QUOTE_FRESH_MS)) ? 'live' : 'down'; }
  tick(now) {
    for (const p of this.positions) settleFunding(this, p, this.e.feeds.funding.get(p.venue, p.symbol), now);
    managePos(this, (s) => { const p = this.positions.find((x) => x.symbol === s); const r = p && this.e.feeds.funding.get(p.venue, s); return r && now - r.ts < 30000 ? r.mark : null; }, now,
      { onClose: (p, rec) => { if (p.funding) this.e.tape.push({ kind: 'info', strategy: this.id, msg: `${p.symbol} funding over hold ${p.funding >= 0 ? '+' : ''}${p.funding.toFixed(2)}` }); void rec; } });
    if (now - this.lastEval < 10000) return; this.lastEval = now;
    for (const sym of this.c.symbols) {
      const bars = this.bars.closed(sym); const q = this.e.quote(sym, QUOTE_FRESH_MS);
      if (!bars) { if (this.armed) this.skip('no closed bars', sym); continue; }
      if (!q) { if (this.armed) this.skip('no fresh perp quote', sym); continue; }
      const feeRate = F.TAKER_FEES[q.venue] || 0.0005;
      const notional0 = this.sleeve(false) * this.c.momentum.sizePct;
      const slipBps = F.slippageBps({ halfSpreadBps: q.halfSpreadBps, notional: notional0, depthUsd: q.dayNtlVlm ? q.dayNtlVlm * 0.0002 : 2e6 });
      const costFrac = 2 * feeRate + 2 * slipBps / 1e4;
      const sig = momentumSignal(bars, { ...this.c.momentum, costFrac });
      this.signals[sym] = { ...sig, venue: q.venue, transport: q.transport, costPct: costFrac * 100 };
      const last = bars[bars.length - 1].t; if (!this.armed || this.lastBar[sym] === last) continue; this.lastBar[sym] = last;
      if (!sig.side) { this.skip(sig.reason, sym); continue; }
      if (this.positions.some((p) => p.symbol === sym)) { this.skip('already positioned', sym); continue; }
      const g = this.gate(false); if (!g.ok) { this.skip('risk gate: ' + g.reason, sym); continue; }
      const row = this.e.feeds.funding.get(q.venue, sym);
      const holdFunding = row ? F.fundingPayment({ side: sig.side, notional: 1, rate: row.hourly * this.c.momentum.maxHoldH }) : 0;
      if (sig.tp + holdFunding - costFrac <= 0) { this.skip('funding over hold erases edge', `${sym} ${(holdFunding * 100).toFixed(3)}%`); continue; }
      const riskUsd = this.sleeve(false) * this.c.momentum.riskPct; const notional = Math.min(notional0, riskUsd / sig.sl);
      openPos(this, { symbol: sym, side: sig.side, notional, quote: q, feeRate, slipBps, tp: sig.tp, sl: sig.sl, maxHoldMs: this.c.momentum.maxHoldH * H, simulated: false,
        reason: `${sig.reason} · ATR ${sig.atrPct.toFixed(2)}% · cost ${(costFrac * 100).toFixed(3)}% · via ${q.transport || 'rest'}`, now, extra: { perp: true, funding: 0 } });
    }
  }
  view() { return { signals: this.signals, bar: this.bars.bar }; }
  explain() {
    const m = { ...MOMENTUM_DEFAULTS, ...this.c.momentum };
    return X.explanation(`A trend-following breakout system on crypto perpetual futures. When a closed ${m.bar} candle breaks out of its recent
      ${m.lookback}-bar range in the direction of the moving-average trend, it enters with an ATR-based stop and target, risks a fixed small
      share of the sleeve, and skips trades whose target is too small to beat costs or where funding would eat the edge.`, {
      Markets: [`Perps: ${X.list(this.c.symbols)}`, `Closed ${m.bar} candles; executes on the freshest perp quote (WebSocket when fresh, < ${QUOTE_FRESH_MS / 1000} s old)`],
      Signal: [`Long: close above the prior ${m.lookback}-bar high and EMA${m.fast} above EMA${m.slow}; short is the mirror image`,
        `Volatility filter: ATR between ${X.pct(m.minAtrPct)} and ${X.pct(m.maxAtrPct)} of price`, `Target must be ≥ ${m.minEdgeX}× the round-trip cost (2 taker fees + 2× slippage)`,
        `Expected funding over ${X.hours(m.maxHoldH)} must not erase the edge`],
      Entry: ['Evaluated once per new closed bar per coin; one position per coin',
        `Size: risk ${X.pct(m.riskPct * 100, 1)} of the sleeve to the stop, capped at ${X.pct(m.sizePct * 100, 0)} of the sleeve notional`],
      Exit: [`Stop ${m.slAtr}× ATR, target ${m.tpAtr}× ATR from entry`, `Time stop after ${X.hours(m.maxHoldH)}`, 'Funding is settled on the venue schedule while held'],
      Risk: X.deskRisk(this), Data: [X.feesLine()] });
  }
}

/** Pure (tested): evaluate a cash-and-carry entry from real books. */
function basisEdge({ spot, perp, spotFee = F.TAKER_FEES.spot, perpFee = 0.0005, slipBps = 1, hourlyFunding = 0, holdH = 24, convergeTo = 0 }) {
  const basisBps = (perp.bid / spot.ask - 1) * 1e4;
  const costsBps = 2 * (spotFee + perpFee) * 1e4 + 4 * slipBps;
  const fundingBps = hourlyFunding * holdH * 1e4; // short perp receives positive funding
  const netBps = basisBps - convergeTo + fundingBps - costsBps;
  return { basisBps, costsBps, fundingBps, netBps };
}

class PerpBasis extends Strategy {
  constructor(engine) {
    super(engine, { id: 'basis', name: 'Perp Basis (cash & carry)', desc: 'Long spot + short perp when basis + expected funding clears 4 taker fees & slippage · exits on convergence', allocPct: 0.1, chains: ['BTC', 'ETH', 'SOL'] });
    this.c = engine.cfg.perps.basis; this.symbols = engine.cfg.perps.symbols; this.table = [];
  }
  dataMode() { return this.e.spotQuote('BTC') ? 'live' : 'down'; }
  tick(now) {
    let ur = 0;
    for (const p of [...this.positions]) {
      const sp = this.e.spotQuote(p.symbol, p.spotVenue), pr = this.e.feeds.funding.get(p.venue, p.symbol);
      if (!sp || !pr || now - pr.ts > 30000) { p.stale = true; continue; } p.stale = false;
      settleFunding(this, p, pr, now);
      const spotExit = F.applySlippage(sp.bid, 'sell', p.slipBps), perpExit = F.applySlippage(pr.ask, 'buy', p.slipBps);
      const exitFees = F.fee(spotExit * p.qty, F.TAKER_FEES.spot) + F.fee(perpExit * p.qty, p.perpFee);
      p.upnl = (spotExit - p.spotEntry) * p.qty + (p.perpEntry - perpExit) * p.qty - exitFees;
      p.basisNowBps = (pr.ask / sp.bid - 1) * 1e4;
      let why = null;
      if (p.basisNowBps <= this.c.exitBps) why = 'basis converged'; else if (now - p.openedAt >= this.c.maxHoldH * H) why = 'time stop';
      if (why) {
        this.positions.splice(this.positions.indexOf(p), 1);
        const rec = this.e.ledger.close(this.id, { pnl: p.upnl, total: p.upnl - p.entryFees + (p.funding || 0), fees: p.entryFees + exitFees, simulated: false, meta: { symbol: p.symbol, why } });
        this.fillLog(`CLOSE basis ${p.symbol} spot ${p.spotVenue} / perp ${p.venue} (${why}) · net ${rec.pnl >= 0 ? '+' : ''}${rec.pnl.toFixed(2)} after fees · funding ${(p.funding || 0).toFixed(2)}`, p.upnl, false);
      } else ur += p.upnl;
    }
    this.e.ledger.setUnrealized(this.id, { real: ur, sim: 0 });
    if (now - this.lastEval < 5000) return; this.lastEval = now;
    const rows = [];
    for (const sym of this.symbols) for (const sv of BASIS_SPOT_VENUES) {
      const spot = this.e.spotQuote(sym, sv); if (!spot) continue;
      for (const pr of this.e.feeds.funding.bySymbol(sym, QUOTE_FRESH_MS)) {
        const perpFee = F.TAKER_FEES[pr.venue] || 0.0005, notional = this.sleeve(false) * this.c.sizePct;
        const slipBps = F.slippageBps({ halfSpreadBps: 0, notional, depthUsd: 2e6 });
        const e = basisEdge({ spot, perp: pr, perpFee, slipBps, hourlyFunding: pr.hourly, holdH: this.c.holdH, convergeTo: this.c.exitBps });
        rows.push({ symbol: sym, spotVenue: sv, perpVenue: pr.venue, ...e, slipBps, perpFee, spot, perp: pr, notional, transport: pr.transport });
      }
    }
    rows.sort((a, b) => b.netBps - a.netBps); this.table = rows;
    if (!this.armed) return;
    const best = rows[0];
    if (!best) return this.skip('no fresh spot+perp books', 'needs WS spot + perp');
    if (best.netBps < this.c.minNetBps) return this.skip(`best net ${best.netBps.toFixed(1)}bp < ${this.c.minNetBps}bp`, `${best.symbol} ${best.spotVenue}/${best.perpVenue} basis ${best.basisBps.toFixed(1)}bp − costs ${best.costsBps.toFixed(1)}bp + funding ${best.fundingBps.toFixed(1)}bp`);
    if (this.positions.length >= this.c.maxPositions) return this.skip('max basis positions open');
    if (this.positions.some((p) => p.symbol === best.symbol)) return this.skip('already carrying ' + best.symbol);
    const g = this.gate(false); if (!g.ok) return this.skip('risk gate: ' + g.reason);
    const spotEntry = F.applySlippage(best.spot.ask, 'buy', best.slipBps), perpEntry = F.applySlippage(best.perp.bid, 'sell', best.slipBps), qty = best.notional / spotEntry;
    const entryFees = F.fee(spotEntry * qty, F.TAKER_FEES.spot) + F.fee(perpEntry * qty, best.perpFee);
    this.e.ledger.charge(this.id, { amount: entryFees, simulated: false });
    this.positions.push({ id: 'b' + now, symbol: best.symbol, side: 'carry', perpSide: 'short', qty, spotVenue: best.spotVenue, venue: best.perpVenue, spotEntry, perpEntry, entryFees, perpFee: best.perpFee, slipBps: best.slipBps, openedAt: now, notional: best.notional, funding: 0,
      legs: [{ side: 'long', venue: best.spotVenue + ' spot' }, { side: 'short', venue: best.perpVenue + ' perp' }] });
    this.fillLog(`OPEN basis ${best.symbol}: buy spot ${best.spotVenue} @ ${spotEntry.toFixed(4)} / short perp ${best.perpVenue} @ ${perpEntry.toFixed(4)} · basis ${best.basisBps.toFixed(1)}bp · exp net ${best.netBps.toFixed(1)}bp`, -entryFees, false);
  }
  view() { return { table: this.table.slice(0, 12).map(({ symbol, spotVenue, perpVenue, basisBps, costsBps, fundingBps, netBps, transport }) => ({ symbol, spotVenue, perpVenue, basisBps, costsBps, fundingBps, netBps, transport })) }; }
  explain() {
    const c = this.c;
    return X.explanation(`A cash-and-carry trade: buy the coin on a spot exchange and short the same amount of its perpetual future, so price moves
      cancel. It earns the premium of the perp over spot (the basis) as the two converge, plus funding paid to shorts, and only opens when that
      beats four taker fees and slippage.`, {
      Markets: [`Coins: ${X.list(this.symbols)}`, `Spot books: ${X.list(BASIS_SPOT_VENUES)}; perps: every venue with a fresh quote (< ${QUOTE_FRESH_MS / 1000} s)`],
      Signal: [`Net = basis (perp bid vs spot ask) − exit level ${X.num(c.exitBps)} bp + expected funding over ${X.hours(c.holdH)} − 4 taker fees − slippage`],
      Entry: [`Open the best spot/perp pair when net ≥ ${X.num(c.minNetBps)} bp`, 'Long spot + short perp only (never the reverse)',
        `Size: ${X.pct(c.sizePct * 100, 0)} of the sleeve; one carry per coin, at most ${c.maxPositions} open`],
      Exit: [`Close both legs when the basis converges to ≤ ${X.num(c.exitBps)} bp`, `Time stop after ${X.hours(c.maxHoldH)}`],
      Risk: X.deskRisk(this), Data: [X.feesLine()] });
  }
}
module.exports = { PerpMomentum, PerpBasis, momentumSignal, basisEdge, settleFunding, MOMENTUM_DEFAULTS };
