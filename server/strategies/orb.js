'use strict';
// Strategy 5: Opening-range breakout on CME micros (MES, MNQ).
// OR = first ORB_MINUTES 1-minute bars after 09:30 ET. After it forms, a 1-minute CLOSE outside the range
// enters (long above / short below), one trade per symbol per session. Stop = opposite side of the range;
// target = ORB_TARGET_R × risk; flat by 15:55 ET. Stop and target are checked on bar high/low; if both touch
// in one bar the STOP is assumed (conservative). Costs: fee per side per contract + 1 tick slippage each side.
// Data from the SIMULATED fallback books to the SIM book only.
const { Strategy } = require('./base');
const F = require('../lib/fees');

/** Pure: opening range from session bars ({m,h,l}). */
function openingRange(bars, minutes) {
  const or = bars.filter((b) => b.m >= 0 && b.m < minutes);
  if (or.length < minutes || !bars.some((b) => b.m >= minutes)) return null;
  return { high: Math.max(...or.map((b) => b.h)), low: Math.min(...or.map((b) => b.l)) };
}
/** Pure: breakout signal on the latest closed bar after the OR. */
function breakout(bar, or) { if (!or || !bar) return null; if (bar.c > or.high) return 'long'; if (bar.c < or.low) return 'short'; return null; }

class OpeningRangeBreakout extends Strategy {
  constructor(engine, feed) {
    super(engine, { id: 'orb', name: 'ORB · MES/MNQ', desc: 'Opening-range breakout on CME micros via Tradovate demo API (simulated fallback, labeled)', allocPct: 0.15, chains: ['CME', 'Tradovate demo'] });
    this.feed = feed; this.c = engine.cfg.orb; this.done = {}; this.state = {};
  }
  dataMode() { return this.feed.mode === 'live' ? 'live' : this.feed.mode === 'pending' ? 'pending' : 'sim'; }
  tick(now) {
    const sim = this.feed.mode !== 'live';
    let ur = 0, us = 0;
    for (const root of this.feed.roots) {
      const d = this.feed.data[root], sp = this.feed.spec(root), bars = d.bars, last = bars[bars.length - 1];
      const key = root + ':' + d.sessionId; const or = openingRange(bars, this.c.minutes);
      const pos = this.positions.find((p) => p.symbol === root);
      if (pos) {
        if (pos.session !== d.sessionId) { this.closePos(pos, pos.mark || pos.entry, 'session ended'); continue; }
        if (last && last.t !== pos.lastBarT) {
          pos.lastBarT = last.t; pos.mark = last.c;
          const hitStop = pos.side === 'long' ? last.l <= pos.stop : last.h >= pos.stop, hitTgt = pos.side === 'long' ? last.h >= pos.target : last.l <= pos.target;
          if (hitStop) { this.closePos(pos, pos.stop, 'stop'); continue; }
          if (hitTgt) { this.closePos(pos, pos.target, 'target'); continue; }
          if (last.m >= this.c.flatMinute) { this.closePos(pos, last.c, 'flat 15:55 ET'); continue; }
        }
        const r = F.futuresRoundTrip({ side: pos.side, entry: pos.entry, exit: pos.mark, contracts: pos.qty, pointValue: sp.pointValue, tickSize: sp.tickSize, slipTicks: 1, feePerSide: this.c.feePerSide });
        pos.upnl = r.net + this.c.feePerSide * pos.qty; // entry fee already charged
        if (pos.simulated) us += pos.upnl; else ur += pos.upnl;
        this.state[root] = `${pos.side.toUpperCase()} ${pos.qty} @ ${pos.entry.toFixed(2)} · stop ${pos.stop.toFixed(2)} · tgt ${pos.target.toFixed(2)}`;
        continue;
      }
      if (!last) { this.state[root] = 'no bars'; continue; }
      if (!or) { this.state[root] = `forming OR (${Math.min(bars.length, this.c.minutes)}/${this.c.minutes})`; continue; }
      if (this.done[key]) { this.state[root] = 'done for session'; continue; }
      if (last.m >= this.c.lastEntryMinute) { this.state[root] = 'past entry window'; continue; }
      const side = breakout(last, or);
      if (!side) { this.state[root] = 'inside range'; continue; }
      if (last.t === this.lastSeen?.[root]) continue; (this.lastSeen ||= {})[root] = last.t;
      const width = or.high - or.low, wPct = width / last.c * 100;
      this.state[root] = `breakout ${side}`;
      if (!this.armed) continue;
      if (wPct < this.c.minWidthPct || wPct > this.c.maxWidthPct) { this.done[key] = true; this.skip(`${root}: OR width ${wPct.toFixed(2)}% outside ${this.c.minWidthPct}–${this.c.maxWidthPct}%`); continue; }
      const entry = last.c, stop = side === 'long' ? or.low : or.high, risk = Math.abs(entry - stop);
      const riskUsd = (risk + 2 * sp.tickSize) * sp.pointValue + 2 * this.c.feePerSide;
      const qty = Math.floor(this.sleeve(sim) * this.c.maxRiskPct / 100 / riskUsd);
      if (qty < 1) { this.done[key] = true; this.skip(`${root}: 1 contract risks $${riskUsd.toFixed(0)} > ${this.c.maxRiskPct}% of sleeve`); continue; }
      const g = this.gate(sim); if (!g.ok) { this.skip('risk gate: ' + g.reason); continue; }
      this.done[key] = true;
      const target = side === 'long' ? entry + this.c.targetR * risk : entry - this.c.targetR * risk;
      const fee = this.c.feePerSide * qty; this.e.ledger.charge(this.id, { amount: fee, simulated: sim });
      const p = { id: `${root}-${now}`, symbol: root, contract: this.feed.contracts[this.feed.roots.indexOf(root)], side, qty, entry, stop, target, mark: entry, session: d.sessionId, lastBarT: last.t, simulated: sim, upnl: -2 * sp.tickSize * sp.pointValue * qty - fee };
      this.positions.push(p);
      this.fillLog(`OPEN ${side.toUpperCase()} ${qty} ${p.contract} @ ${entry.toFixed(2)} · OR ${or.low.toFixed(2)}–${or.high.toFixed(2)} · stop ${stop.toFixed(2)} tgt ${target.toFixed(2)}${sim ? ' (SIMULATED data → sim book)' : ''}`, -fee, sim);
    }
    this.e.ledger.setUnrealized(this.id, { real: ur, sim: us });
  }
  closePos(p, exit, why) {
    const sp = this.feed.spec(p.symbol);
    const r = F.futuresRoundTrip({ side: p.side, entry: p.entry, exit, contracts: p.qty, pointValue: sp.pointValue, tickSize: sp.tickSize, slipTicks: 1, feePerSide: this.c.feePerSide });
    const booked = r.net + this.c.feePerSide * p.qty; // entry fee was charged at open
    this.positions.splice(this.positions.indexOf(p), 1);
    const rec = this.e.ledger.close(this.id, { pnl: booked, total: r.net, fees: r.fees, slippage: r.slippage, simulated: p.simulated, meta: { symbol: p.contract, side: p.side, why } });
    this.fillLog(`CLOSE ${p.side.toUpperCase()} ${p.qty} ${p.contract} @ ${exit.toFixed(2)} (${why}) · net ${rec.pnl >= 0 ? '+' : ''}${rec.pnl.toFixed(2)} after fees+slippage`, booked, p.simulated);
  }
  view() {
    return { session: this.feed.session(), feePerSide: this.c.feePerSide, symbols: this.feed.roots.map((root) => {
      const d = this.feed.data[root], or = openingRange(d.bars, this.c.minutes);
      return { symbol: this.feed.contracts[this.feed.roots.indexOf(root)] || root, last: d.last, orLow: or && or.low, orHigh: or && or.high, state: this.state[root] || '—', bars: d.bars.slice(-120).map(({ o, h, l, c }) => ({ o, h, l, c })) };
    }) };
  }
  posView(p) { return { ...p, entry: p.entry }; }
}
module.exports = { OpeningRangeBreakout, openingRange, breakout };
