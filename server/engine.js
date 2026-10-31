'use strict';
const path = require('path');
const { Watchdog } = require('./lib/watchdog');
// HAWSE paper engine: wires feeds -> strategies -> paper broker -> ledger -> risk gates.
const { Health } = require('./lib/health');
const { Ledger } = require('./lib/ledger');
const { pnlBoard } = require('./lib/pnl-board');
const { RiskGate } = require('./lib/risk');
const { PaperBroker, LiveBroker } = require('./lib/broker');
const { Tape } = require('./lib/tape');
const { FundingFeed } = require('./feeds/funding');
const { SpotFeed } = require('./feeds/spot');
const { FundingArb } = require('./strategies/funding-arb');
const { MarketStream } = require('./feeds/market-ws');
const { Providers } = require('./providers');
const { loadArmed, saveArmed, quarantine } = require('./lib/armed-state');

class Engine {
  constructor(cfg, { modules = {} } = {}) {
    if (cfg.tradingMode !== 'paper') throw new Error('Refusing to start: TRADING_MODE must be "paper" (live trading is not implemented).');
    this.cfg = cfg; this.started = Date.now();
    this.health = new Health(); this.tape = new Tape(); this.broker = new PaperBroker(); this.live = new LiveBroker();
    this.ledger = new Ledger({ startEquity: cfg.paperStartEquity });
    this.gates = { real: new RiskGate({ startEquity: cfg.paperStartEquity, ...cfg.risk }), sim: new RiskGate({ startEquity: cfg.paperStartEquity, ...cfg.risk }) };
    const fc = cfg.funding;
    this.feeds = { funding: new FundingFeed({ health: this.health, symbols: fc.symbols, pollMs: fc.pollMs, usePredicted: fc.usePredicted !== false, hlTopOi: fc.hlTopOi || 0, obsMs: (fc.obsSec || 900) * 1000 }) };
    if (fc.carry && fc.carry.enabled) this.feeds.spot = new SpotFeed({ health: this.health, symbols: () => this.feeds.funding.symbols, pollMs: fc.carry.spotPollMs });
    if (cfg.ws && cfg.ws.enabled) this.feeds.ws = new MarketStream({ health: this.health, funding: this.feeds.funding, symbols: cfg.funding.symbols, spotSymbols: cfg.ws.spotSymbols });
    this.strategies = [new FundingArb(this)];
    for (const [name, mod] of Object.entries(modules)) mod(this, name);
    this.providers = new Providers(this, { env: cfg.env || process.env });
  }
  addFeed(name, feed) { this.feeds[name] = feed; return feed; }
  addStrategy(s) { this.strategies.push(s); return s; }
  strategy(id) { return this.strategies.find((s) => s.id === id); }
  /** Plain-English "what it does" + rules for every strategy, generated from the same constants/cfg the logic reads (served once via /api/explain, not per tick). */
  explainAll() {
    return this.strategies.map((s) => { let x; try { x = s.explain(); } catch (e) { x = { what: s.desc || s.name, rules: [], error: 'explainer failed: ' + e.message }; } return { id: s.id, name: s.name, ...x }; });
  }
  /** Freshest real perp quote for a symbol (Hyperliquid preferred, then OKX/Binance/Bybit). null if none fresh. */
  quote(symbol, maxAgeMs = 3 * 60e3) {
    const rows = this.feeds.funding.bySymbol(symbol, maxAgeMs); if (!rows.length) return null;
    const order = ['hyperliquid', 'okx', 'binance', 'bybit'];
    return rows.sort((a, b) => order.indexOf(a.venue) - order.indexOf(b.venue))[0];
  }
  /** Freshest real spot top-of-book: WS first, then (if restMaxAgeMs > 0) the REST spot feed. Preference OKX > Binance > Bybit unless a venue is given. */
  spotQuote(symbol, venue, maxAgeMs = 10000, restMaxAgeMs = 0) {
    const ws = this.feeds.ws, rest = this.feeds.spot;
    for (const v of venue ? [venue] : ['okx', 'binance', 'bybit']) {
      const q = (ws && ws.spotQuote(v, symbol, maxAgeMs)) || (restMaxAgeMs > 0 && rest && rest.get(v, symbol, restMaxAgeMs)); if (q) return q;
    }
    return null;
  }
  /** Cross-strategy exclusivity: true if another carry-style strategy (funding arb, perp basis) already holds `symbol`. */
  symbolHeld(symbol, exceptId, ids = ['funding', 'basis']) {
    return this.strategies.some((s) => s.id !== exceptId && ids.includes(s.id) && (s.positions || []).some((p) => p.symbol === symbol));
  }
  price(symbol) { const q = this.quote(symbol); return q ? q.mark : null; }
  canOpen(simulated) { return this.gates[simulated ? 'sim' : 'real'].canOpen(); }
  start() {
    for (const f of Object.values(this.feeds)) f.start && f.start();
    this.tape.push({ kind: 'info', msg: 'Desk online · PAPER mode · live order path disabled' });
    this.restoreArmed();
    this.loop = setInterval(() => this.tick(), 2000);
    this.sampler = setInterval(() => this.ledger.sample(), 5000);
    this.ledger.sample();
    this.watchdog = new Watchdog({ health: this.health, log: this.log || ((m) => console.log(m)), ...(this.cfg.watchdog || {}) }).watchAll(this.feeds);
    if (!this.cfg.watchdog || this.cfg.watchdog.enabled !== false) this.watchdog.start();
  }
  stop() { clearInterval(this.loop); clearInterval(this.sampler); this.watchdog && this.watchdog.stop(); for (const f of Object.values(this.feeds)) f.stop && f.stop(); }
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
  arm(id, on) { const s = this.strategy(id); if (!s) throw new Error('unknown strategy'); s.arm(on); return { persisted: this.persistArmed() }; }
  // ---- armed state on disk (cfg.armedState.file, default data/state/armed.json) ----
  // Active only after start() has loaded the file, so an engine that was never started (tests, tools) never writes it.
  // Restore goes through each strategy's own arm(): no extra arming path, no order path. Halt/breaker state is not persisted.
  restoreArmed() {
    const file = this.cfg.armedState && this.cfg.armedState.file; if (!file) { this.armedStore = null; return null; }
    const r = loadArmed(file); this.armedStore = { file, other: {} };
    const rel = path.relative(process.cwd(), file) || file;
    if (r.status === 'missing') { this.tape.push({ kind: 'info', msg: `Restored armed state: no saved state (${rel} missing) · all strategies disarmed` }); return r; }
    if (r.status === 'corrupt') {
      const kept = quarantine(file);
      this.tape.push({ kind: 'risk', msg: `Restored armed state: saved state unusable (${r.error}) · all strategies disarmed${kept ? ' · kept as ' + path.basename(kept) : ''}` }); return r;
    }
    const armed = [], failed = [];
    for (const [id, on] of Object.entries(r.armed)) {
      const s = this.strategy(id);
      if (!s) { this.armedStore.other[id] = on; continue; } // strategy not loaded this run (toggle off): keep its saved value
      if (!on) continue;
      try { s.arm(true); armed.push(s.id); } catch (e) { failed.push(id); this.tape.push({ kind: 'error', strategy: id, msg: 'restore arm failed: ' + e.message }); }
    }
    const off = this.strategies.filter((s) => !s.armed).length, other = Object.keys(this.armedStore.other).length;
    this.tape.push({ kind: 'risk', msg: `Restored armed state: ${armed.length ? 'armed ' + armed.join(', ') : 'nothing armed'} · ${off} disarmed${other ? ` · ${other} saved id(s) not loaded` : ''}${failed.length ? ' · failed ' + failed.join(', ') : ''} (paper)` });
    return { ...r, restored: armed, failed };
  }
  persistArmed() {
    if (!this.armedStore) return false;
    const m = { ...this.armedStore.other }; for (const s of this.strategies) m[s.id] = !!s.armed;
    try { saveArmed(this.armedStore.file, m); return true; } catch (e) { this.tape.push({ kind: 'error', msg: 'armed state not saved: ' + (e.code || e.message) }); return false; }
  }
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
      pnlBoard: pnlBoard(this.ledger, this.strategies, { now: Date.now(), since: this.started || Date.now() }), // display only
      strategies: this.strategies.map((s) => s.snapshot()),
      funding: this.feeds.funding.snapshot(),
      feeds: Object.fromEntries(Object.entries(this.feeds).filter(([k]) => k !== 'funding').map(([k, f]) => [k, f.snapshot ? f.snapshot() : null])),
      prices, health: this.health.list(), providers: this.providers.list(), tape: this.tape.rows.slice(0, 150),
      // Stale = a source that has delivered before but not within its staleMs. Shown as a top-bar badge + STALE tags.
      stale: this.health.list().filter((h) => h.status === 'stale').map((h) => ({ id: h.id, label: h.label, ageMs: h.ageMs, staleMs: h.staleMs, mock: h.kind === 'mock' })),
      watchdog: this.watchdog ? this.watchdog.view() : null, monoUptimeMs: Math.round(process.uptime() * 1000),
    };
  }
}
module.exports = { Engine };
