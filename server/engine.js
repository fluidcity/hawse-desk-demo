'use strict';
// HAWSE paper engine: wires feeds -> strategies -> paper broker -> ledger -> risk gates.
const { Health } = require('./lib/health');
const { Ledger } = require('./lib/ledger');
const { RiskGate } = require('./lib/risk');
const { PaperBroker, LiveBroker } = require('./lib/broker');
const { Tape } = require('./lib/tape');
const { FundingFeed } = require('./feeds/funding');
const { FundingArb } = require('./strategies/funding-arb');

class Engine {
  constructor(cfg, { modules = {} } = {}) {
    if (cfg.tradingMode !== 'paper') throw new Error('Refusing to start: TRADING_MODE must be "paper" (live trading is not implemented).');
    this.cfg = cfg; this.started = Date.now();
    this.health = new Health(); this.tape = new Tape(); this.broker = new PaperBroker(); this.live = new LiveBroker();
    this.ledger = new Ledger({ startEquity: cfg.paperStartEquity });
    this.gates = { real: new RiskGate({ startEquity: cfg.paperStartEquity, ...cfg.risk }), sim: new RiskGate({ startEquity: cfg.paperStartEquity, ...cfg.risk }) };
    this.feeds = { funding: new FundingFeed({ health: this.health, symbols: cfg.funding.symbols, pollMs: cfg.funding.pollMs }) };
    this.strategies = [new FundingArb(this)];
    for (const [name, mod] of Object.entries(modules)) mod(this, name);
  }
  addFeed(name, feed) { this.feeds[name] = feed; return feed; }
  addStrategy(s) { this.strategies.push(s); return s; }
  strategy(id) { return this.strategies.find((s) => s.id === id); }
  canOpen(simulated) { return this.gates[simulated ? 'sim' : 'real'].canOpen(); }
  start() {
    for (const f of Object.values(this.feeds)) f.start && f.start();
    this.tape.push({ kind: 'info', msg: 'Desk online · PAPER mode · live order path disabled' });
    this.loop = setInterval(() => this.tick(), 2000);
    this.sampler = setInterval(() => this.ledger.sample(), 5000);
    this.ledger.sample();
  }
  stop() { clearInterval(this.loop); clearInterval(this.sampler); for (const f of Object.values(this.feeds)) f.stop && f.stop(); }
  tick(now = Date.now()) {
    for (const s of this.strategies) {
      try { s.tick(now); } catch (e) { this.tape.push({ kind: 'error', strategy: s.id, msg: 'tick error: ' + e.message }); }
    }
    const t = this.ledger.totals();
    for (const [k, g] of Object.entries(this.gates)) {
      const before = g.canOpen().ok;
      g.update(k === 'real' ? t.realEquity : this.cfg.paperStartEquity + t.simPnl, now);
      const after = g.canOpen();
      if (before && !after.ok) this.tape.push({ kind: 'risk', msg: `RISK GATE (${k}) tripped: ${after.reason}` });
    }
  }
  // ---- operator actions ----
  arm(id, on) { const s = this.strategy(id); if (!s) throw new Error('unknown strategy'); s.arm(on); }
  halt() { for (const g of Object.values(this.gates)) g.halt(); this.tape.push({ kind: 'risk', msg: 'Operator HALT: no new risk' }); }
  resume() { for (const g of Object.values(this.gates)) { g.resume(); } this.tape.push({ kind: 'risk', msg: 'Operator resume' }); }
  resetBreaker() { for (const g of Object.values(this.gates)) g.resetBreaker(); this.tape.push({ kind: 'risk', msg: 'Drawdown breaker reset (peak re-based)' }); }
  setRisk(p) { for (const g of Object.values(this.gates)) g.setLimits(p); this.tape.push({ kind: 'risk', msg: `Risk limits: daily ${this.gates.real.dailyLossPct}% · DD ${this.gates.real.maxDrawdownPct}%` }); }
  placeLiveOrder() { return this.live.placeOrder(); } // always throws
  snapshot(flags) {
    const t = this.ledger.totals();
    const prices = {};
    for (const r of this.feeds.funding.fresh()) if (!prices[r.symbol] || r.venue === 'hyperliquid') prices[r.symbol] = { px: r.mark, venue: r.venue, ts: r.ts };
    return {
      now: Date.now(), uptimeMs: Date.now() - this.started, flags,
      totals: { ...t, start: this.cfg.paperStartEquity },
      risk: { real: this.gates.real.status(), sim: this.gates.sim.status() },
      curve: this.ledger.curve.slice(-720), attribution: this.ledger.attribution(), closed: this.ledger.closed.slice(0, 50),
      strategies: this.strategies.map((s) => s.snapshot()),
      funding: this.feeds.funding.snapshot(),
      feeds: Object.fromEntries(Object.entries(this.feeds).filter(([k]) => k !== 'funding').map(([k, f]) => [k, f.snapshot ? f.snapshot() : null])),
      prices, health: this.health.list(), tape: this.tape.rows.slice(0, 150),
    };
  }
}
module.exports = { Engine };
