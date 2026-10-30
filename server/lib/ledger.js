'use strict';
// Paper ledger with strict separation of real-data PnL and simulated-feed PnL.
// "real" = every price/signal input came from a live public or authenticated feed.
// "sim"  = at least one input was mocked/simulated. These books are never merged.

class Ledger {
  constructor({ startEquity }) {
    this.startEquity = startEquity;
    this.books = new Map();
    this.curve = [];
    this.closed = [];
  }
  book(id) {
    if (!this.books.has(id)) this.books.set(id, { id, real: blank(), sim: blank(), unrealReal: 0, unrealSim: 0 });
    return this.books.get(id);
  }
  /** Record a completed (closed) paper trade. pnl is NET of fees and slippage. */
  close(id, { pnl, total, fees = 0, slippage = 0, simulated, meta = {} }) {
    // pnl: amount booked now. total: full trade outcome incl. earlier charges/cashflows (for win/loss stats).
    if (total === undefined) total = pnl;
    if (typeof simulated !== 'boolean') throw new TypeError('Ledger.close: simulated flag is required');
    if (!isFinite(pnl)) throw new RangeError('Ledger.close: pnl must be finite');
    const b = this.book(id)[simulated ? 'sim' : 'real'];
    b.realized += pnl; b.fees += fees; b.slippage += slippage; b.trades += 1;
    if (total > 0) b.wins += 1; else b.losses += 1;
    const rec = { t: Date.now(), strategy: id, pnl: total, booked: pnl, fees, slippage, simulated, ...meta };
    this.closed.unshift(rec); if (this.closed.length > 500) this.closed.pop();
    return rec;
  }
  /** Fees paid on an opening fill are charged immediately so equity is never flattered. */
  charge(id, { amount, simulated, kind = 'fee' }) {
    const b = this.book(id)[simulated ? 'sim' : 'real'];
    b.realized -= amount; if (kind === 'fee') b.fees += amount; else b.slippage += amount;
  }
  /** Funding or other cashflows on open positions. */
  cashflow(id, { amount, simulated }) { const b = this.book(id)[simulated ? 'sim' : 'real']; b.realized += amount; b.funding += amount; }
  setUnrealized(id, { real = 0, sim = 0 }) { const b = this.book(id); b.unrealReal = real; b.unrealSim = sim; }
  totals() {
    let real = 0, sim = 0, realU = 0, simU = 0;
    for (const b of this.books.values()) { real += b.real.realized; sim += b.sim.realized; realU += b.unrealReal; simU += b.unrealSim; }
    return { realEquity: this.startEquity + real + realU, realPnl: real + realU, simPnl: sim + simU, realRealized: real, simRealized: sim };
  }
  sample(now = Date.now()) {
    const t = this.totals();
    this.curve.push({ t: now, real: t.realEquity, sim: this.startEquity + t.simPnl });
    if (this.curve.length > 2000) this.curve.splice(0, this.curve.length - 2000);
  }
  attribution() {
    return [...this.books.values()].map((b) => ({ id: b.id, real: b.real.realized + b.unrealReal, sim: b.sim.realized + b.unrealSim,
      realStats: b.real, simStats: b.sim, unrealReal: b.unrealReal, unrealSim: b.unrealSim }));
  }
}
const blank = () => ({ realized: 0, fees: 0, slippage: 0, funding: 0, trades: 0, wins: 0, losses: 0 });
module.exports = { Ledger };
