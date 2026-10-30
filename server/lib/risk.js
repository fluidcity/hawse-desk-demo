'use strict';
// Portfolio risk gate. Pure state machine (time injected), covered by test/risk.test.js.
//  - Daily loss halt: equity <= dayStart * (1 - dailyLossPct) -> no new risk until the next UTC day.
//  - Drawdown breaker: equity <= peak * (1 - maxDrawdownPct) -> latched until manual reset.
//  - Manual halt: operator kill switch.

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

class RiskGate {
  constructor({ startEquity, dailyLossPct = 3, maxDrawdownPct = 10, now = Date.now() }) {
    if (!(startEquity > 0)) throw new RangeError('startEquity must be > 0');
    this.dailyLossPct = dailyLossPct;
    this.maxDrawdownPct = maxDrawdownPct;
    this.peak = startEquity;
    this.equity = startEquity;
    this.day = dayKey(now);
    this.dayStart = startEquity;
    this.dailyHalt = false;
    this.breaker = false;
    this.manual = false;
    this.events = [];
  }
  setLimits({ dailyLossPct, maxDrawdownPct }) {
    if (dailyLossPct !== undefined) { if (!(dailyLossPct > 0 && dailyLossPct <= 100)) throw new RangeError('dailyLossPct'); this.dailyLossPct = dailyLossPct; }
    if (maxDrawdownPct !== undefined) { if (!(maxDrawdownPct > 0 && maxDrawdownPct <= 100)) throw new RangeError('maxDrawdownPct'); this.maxDrawdownPct = maxDrawdownPct; }
  }
  update(equity, now = Date.now()) {
    const d = dayKey(now);
    if (d !== this.day) {
      this.day = d; this.dayStart = equity;
      if (this.dailyHalt) { this.dailyHalt = false; this.events.push({ t: now, type: 'daily_reset' }); }
    }
    this.equity = equity;
    if (equity > this.peak) this.peak = equity;
    const dayLoss = (this.dayStart - equity) / this.dayStart * 100;
    if (!this.dailyHalt && dayLoss >= this.dailyLossPct) { this.dailyHalt = true; this.events.push({ t: now, type: 'daily_halt', dayLoss }); }
    const dd = this.drawdownPct();
    if (!this.breaker && dd >= this.maxDrawdownPct) { this.breaker = true; this.events.push({ t: now, type: 'breaker', dd }); }
    return this.status();
  }
  drawdownPct() { return this.peak > 0 ? Math.max(0, (this.peak - this.equity) / this.peak * 100) : 0; }
  dayPnl() { return this.equity - this.dayStart; }
  halt() { this.manual = true; }
  resume() { this.manual = false; }
  /** Manual reset of the latched drawdown breaker: re-bases the peak at current equity. */
  resetBreaker() { this.breaker = false; this.peak = this.equity; }
  canOpen() {
    if (this.manual) return { ok: false, reason: 'manual halt' };
    if (this.breaker) return { ok: false, reason: `drawdown breaker (${this.drawdownPct().toFixed(2)}% >= ${this.maxDrawdownPct}%)` };
    if (this.dailyHalt) return { ok: false, reason: `daily loss halt (limit ${this.dailyLossPct}%)` };
    return { ok: true, reason: null };
  }
  status() {
    const c = this.canOpen();
    return { ok: c.ok, reason: c.reason, equity: this.equity, peak: this.peak, dayStart: this.dayStart, dayPnl: this.dayPnl(),
      drawdownPct: this.drawdownPct(), dailyLossPct: this.dailyLossPct, maxDrawdownPct: this.maxDrawdownPct,
      dailyHalt: this.dailyHalt, breaker: this.breaker, manual: this.manual };
  }
}

module.exports = { RiskGate, dayKey };
