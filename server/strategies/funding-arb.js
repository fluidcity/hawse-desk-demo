'use strict';
// Strategy 1: cross-venue perp funding arbitrage on REAL public funding rates.
// Long the venue paying the lowest hourly funding, short the highest, equal notional.
// Honest modeling: hourly normalization of 1h/4h/8h intervals, discrete settlement at
// each venue's own funding time, taker fees on 4 fills, spread+impact slippage, basis buffer,
// mark-to-market of both legs (basis risk shows up in PnL), and exit costs inside unrealized.
const { Strategy } = require('./base');
const F = require('../lib/fees');

const H = 3600e3;
const DEPTH = { BTC: 5e6, ETH: 3e6, SOL: 1.5e6 }; // conservative top-of-book depth proxy (USD)

class FundingArb extends Strategy {
  constructor(engine) {
    super(engine, { id: 'funding', name: 'Funding Arb', desc: 'Cross-venue perp funding (Binance · Bybit · OKX · Hyperliquid)', allocPct: 0.3, chains: ['CEX', 'Hyperliquid'] });
    this.cfg = engine.cfg.funding; this.maxPositions = 2; this.maxHoldH = 72; this.best = [];
  }
  feed() { return this.e.feeds.funding; }
  dataMode() {
    const venues = new Set(this.feed().fresh().map((r) => r.venue));
    return venues.size >= 2 ? 'live' : 'down';
  }
  slip(r, notional) { return F.slippageBps({ halfSpreadBps: r.halfSpreadBps, notional, depthUsd: r.dayNtlVlm ? r.dayNtlVlm * 0.0005 : DEPTH[r.symbol] || 5e5 }); }
  evaluate(symbol, notional) {
    const rows = this.feed().bySymbol(symbol, 3 * 60e3);
    if (rows.length < 2) return { symbol, ok: false, reason: `${symbol}: need 2+ live venues (have ${rows.length})` };
    let best = null;
    for (const lo of rows) for (const hi of rows) {
      if (lo === hi) continue;
      const mid = (lo.mark + hi.mark) / 2;
      const basisBps = Math.abs(hi.mark - lo.mark) / mid * 1e4;
      const edge = F.fundingArbEdge({ shortHourly: hi.hourly, longHourly: lo.hourly, holdHours: this.cfg.holdHours, notional,
        shortFee: F.TAKER_FEES[hi.venue], longFee: F.TAKER_FEES[lo.venue], shortSlipBps: this.slip(hi, notional), longSlipBps: this.slip(lo, notional),
        basisBufferBps: basisBps * 0.5 + 2 });
      if (!best || edge.net > best.edge.net) best = { symbol, long: lo, short: hi, edge, basisBps, spreadApr: F.annualizedPct(hi.hourly - lo.hourly) };
    }
    best.ok = best.edge.netBps >= this.cfg.minNetBps;
    if (!best.ok) best.reason = `${symbol}: net ${best.edge.netBps.toFixed(1)}bps/${this.cfg.holdHours}h < ${this.cfg.minNetBps}bps after fees/slip/basis`;
    return best;
  }
  tick(now) {
    this.manage(now);
    if (now - this.lastEval < 15000) return; this.lastEval = now;
    const notional = Math.max(0, this.sleeve() * 0.45);
    this.best = this.cfg.symbols.map((s) => this.evaluate(s, notional || 1000)).filter(Boolean).sort((a, b) => (b.edge ? b.edge.netBps : -1e9) - (a.edge ? a.edge.netBps : -1e9));
    if (!this.armed) return;
    if (this.positions.length >= this.maxPositions) return this.skip('max concurrent pairs reached', `${this.maxPositions}`);
    const cand = this.best.find((b) => b.ok && !this.positions.some((p) => p.symbol === b.symbol));
    if (!cand) { const top = this.best[0]; return this.skip('no pair clears cost hurdle', top && top.reason ? top.reason : ''); }
    const g = this.gate(false); if (!g.ok) return this.skip('risk gate: ' + g.reason);
    this.open(cand, notional, now);
  }
  open(c, notional, now) {
    const b = this.e.broker;
    const qty = notional / ((c.long.mark + c.short.mark) / 2);
    const lf = b.fill({ strategy: this.id, venue: c.long.venue, symbol: c.symbol, side: 'buy', qty, price: c.long.mark, feeRate: F.TAKER_FEES[c.long.venue], slipBps: this.slip(c.long, notional) });
    const sf = b.fill({ strategy: this.id, venue: c.short.venue, symbol: c.symbol, side: 'sell', qty, price: c.short.mark, feeRate: F.TAKER_FEES[c.short.venue], slipBps: this.slip(c.short, notional) });
    this.e.ledger.charge(this.id, { amount: lf.fee + sf.fee, simulated: false });
    const leg = (f, r, side) => ({ venue: r.venue, side, qty, entry: f.price, rate: r.rate, intervalH: r.intervalH, nextFT: r.nextFundingTime, funding: 0, settlements: 0 });
    const p = { id: lf.id, symbol: c.symbol, openedAt: now, notional, legs: [leg(lf, c.long, 'long'), leg(sf, c.short, 'short')], entryFees: lf.fee + sf.fee, expected: c.edge, mtm: 0 };
    this.positions.push(p);
    this.fillLog(`OPEN ${c.symbol} long ${c.long.venue} / short ${c.short.venue} · $${notional.toFixed(0)}/leg · est ${c.edge.netBps.toFixed(1)}bps/${this.cfg.holdHours}h`, -p.entryFees, false);
  }
  manage(now) {
    let unreal = 0;
    for (const p of [...this.positions]) {
      let fresh = true, mtm = 0, exitCost = 0;
      for (const l of p.legs) {
        const r = this.feed().get(l.venue, p.symbol);
        if (!r || now - r.ts > 10 * 60e3) { fresh = false; continue; }
        // Discrete funding settlement at the venue's own schedule, using the last rate known before settlement.
        if (l.nextFT && now >= l.nextFT && now - p.openedAt > 0 && l.nextFT > p.openedAt) {
          const pay = F.fundingPayment({ side: l.side, notional: l.qty * r.mark, rate: l.rate });
          this.e.ledger.cashflow(this.id, { amount: pay, simulated: false });
          l.funding += pay; l.settlements++;
          this.e.tape.push({ kind: 'fill', strategy: this.id, msg: `FUNDING ${p.symbol} ${l.venue} ${l.side} @ ${(l.rate * 100).toFixed(4)}%`, pnl: pay, simulated: false });
          l.nextFT = r.nextFundingTime && r.nextFundingTime > now ? r.nextFundingTime : l.nextFT + l.intervalH * H;
        } else if (r.nextFundingTime && r.nextFundingTime > now) l.nextFT = l.nextFT && l.nextFT > now ? l.nextFT : r.nextFundingTime;
        l.rate = r.rate; l.mark = r.mark; l.hourly = r.hourly;
        mtm += l.side === 'long' ? (r.mark - l.entry) * l.qty : (l.entry - r.mark) * l.qty;
        exitCost += l.qty * r.mark * (F.TAKER_FEES[l.venue] + this.slip(r, p.notional) / 1e4);
      }
      p.mtm = mtm; p.exitCost = exitCost; p.funding = p.legs.reduce((a, l) => a + l.funding, 0);
      if (!fresh) { p.stale = true; unreal += mtm - exitCost; continue; }
      p.stale = false;
      const [L, S] = p.legs; const spreadH = S.hourly - L.hourly;
      const heldH = (now - p.openedAt) / H;
      let why = null;
      if (spreadH <= 0) why = 'funding spread flipped';
      else if (heldH >= this.maxHoldH) why = `max hold ${this.maxHoldH}h`;
      if (why) this.close(p, why); else unreal += mtm - exitCost;
    }
    this.e.ledger.setUnrealized(this.id, { real: unreal });
  }
  close(p, why) {
    let pricePnl = 0, fees = 0;
    for (const l of p.legs) {
      const r = this.feed().get(l.venue, p.symbol);
      const f = this.e.broker.fill({ strategy: this.id, venue: l.venue, symbol: p.symbol, side: l.side === 'long' ? 'sell' : 'buy', qty: l.qty, price: r.mark, feeRate: F.TAKER_FEES[l.venue], slipBps: this.slip(r, p.notional) });
      pricePnl += l.side === 'long' ? (f.price - l.entry) * l.qty : (l.entry - f.price) * l.qty; fees += f.fee;
    }
    const booked = pricePnl - fees;
    const total = booked + p.funding - p.entryFees;
    this.e.ledger.close(this.id, { pnl: booked, total, fees: fees + p.entryFees, simulated: false, meta: { symbol: p.symbol, why } });
    this.positions = this.positions.filter((x) => x !== p);
    this.fillLog(`CLOSE ${p.symbol} (${why}) · funding ${p.funding.toFixed(2)} · basis ${pricePnl.toFixed(2)} · fees ${(fees + p.entryFees).toFixed(2)}`, total, false);
  }
  posView(p) {
    return { symbol: p.symbol, openedAt: p.openedAt, notional: p.notional, legs: p.legs.map(({ venue, side, entry, mark, rate, nextFT, funding }) => ({ venue, side, entry, mark, rate, nextFT, funding })),
      funding: p.funding, mtm: p.mtm, exitCost: p.exitCost, entryFees: p.entryFees, stale: p.stale };
  }
  view() {
    return { best: this.best.slice(0, 8).map((b) => ({ symbol: b.symbol, ok: !!b.ok, reason: b.reason || null,
      long: b.long && b.long.venue, short: b.short && b.short.venue, netBps: b.edge ? b.edge.netBps : null, spreadApr: b.spreadApr ?? null, basisBps: b.basisBps ?? null,
      gross: b.edge ? b.edge.grossFunding : null, costs: b.edge ? b.edge.fees + b.edge.slippage + b.edge.basisBuffer : null })), holdHours: this.cfg.holdHours, minNetBps: this.cfg.minNetBps };
  }
}
module.exports = { FundingArb };
