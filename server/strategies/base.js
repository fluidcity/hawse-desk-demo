'use strict';
// Strategy base: arm/disarm, sleeve accounting, skip-reason logging, risk gate access.
class Strategy {
  constructor(engine, { id, name, desc, allocPct, chains = [] }) {
    this.e = engine; this.id = id; this.name = name; this.desc = desc; this.allocPct = allocPct; this.chains = chains;
    this.armed = false; this.lastSkip = null; this.lastEval = 0; this.positions = []; this.notes = [];
    engine.ledger.book(id);
  }
  get alloc() { return this.e.cfg.paperStartEquity * this.allocPct; }
  sleeve(simulated = false) { const b = this.e.ledger.book(this.id)[simulated ? 'sim' : 'real']; return this.alloc + b.realized; }
  arm(on) {
    this.armed = !!on;
    this.e.tape.push({ kind: 'risk', strategy: this.id, msg: (on ? 'Armed ' : 'Disarmed ') + this.name });
  }
  skip(reason, detail) { this.lastSkip = { t: Date.now(), reason, detail }; this.e.tape.skip(this.id, reason, { detail }); }
  gate(simulated) { return this.e.canOpen(simulated); }
  log(msg, extra = {}) { return this.e.tape.push({ kind: 'info', strategy: this.id, msg, ...extra }); }
  fillLog(msg, pnl, simulated) { return this.e.tape.push({ kind: 'fill', strategy: this.id, msg, pnl, simulated }); }
  /** 'live' | 'mock' | 'mixed' | 'down' -- what data this strategy is running on right now. */
  dataMode() { return 'live'; }
  tick() {}
  view() { return {}; }
  snapshot() {
    return { id: this.id, name: this.name, desc: this.desc, armed: this.armed, dataMode: this.dataMode(), alloc: this.alloc, chains: this.chains,
      sleeve: this.sleeve(false), positions: this.positions.map((p) => this.posView(p)), lastSkip: this.lastSkip,
      skipCounts: this.e.tape.skipCounts(this.id), view: this.view() };
  }
  posView(p) { return p; }
}
module.exports = { Strategy };
