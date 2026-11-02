'use strict';
// Sports-betting strategies (PAPER ONLY; alerts only; real-money placement is a disabled stub, see betting/live.js).
//  bet_ev     line shopping: a book's price vs the no-vig consensus of the OTHER books → +EV → fractional-Kelly stake.
//  bet_spread a book hanging a better NUMBER than the consensus spread; edge per point is an explicit ASSUMPTION.
//  bet_arb    cross-book arbitrage at quoted prices (paper-booked as one grouped position); middles are ALERTS ONLY.
// Every bet on the mock feed is tagged simulated and lands in the SIM book, never blended with real-data results.
// Module boundary: the host's Strategy base class is INJECTED (defineStrategies(Strategy)), so this file imports nothing
// from the rest of HAWSE. Uses host.cfg.betting, host ledger via BetBook, and the Strategy base API (arm/gate/log/view).
const S = require('./scanner');
const M = require('./math');
const A = require('./anchor');
const { explainStrategy, STRAT_RULES: R } = require('./explain');

function defineStrategies(Strategy) {

class BetStrategy extends Strategy {
  constructor(engine, feed, book, meta) { super(engine, meta); this.feed = feed; this.bk = book; this.c = engine.cfg.betting; this.opps = []; this.taken = new Set(); }
  dataMode() { return this.feed.mode === 'live' ? 'live' : this.feed.mode === 'mock' ? 'mock' : 'down'; }
  get simulated() { return this.feed.simulated; }
  caps() { return { maxStakePct: this.c.maxStakePct, maxEventPct: this.c.maxEventPct, maxOpenPct: this.c.maxOpenPct }; }
  /** Time-to-start gate in minutes (the MOCK feed's accelerated schedule uses its own small value). */
  minLeadMin() { return this.feed.simulated ? this.c.mockMinMinutesToStart : this.c.minMinutesToStart; }
  events() { return this.feed.upcoming(this.minLeadMin() * 60e3); }
  evName(ev) { return `${ev.away} @ ${ev.home}`; }
  /** Size + cap-check + gate + book one single bet. Returns true when booked. */
  takeSingle(ev, o, kind) {
    const k = `${ev.id}|${S.selKey(o.market, o.name, o.point)}`; if (this.taken.has(k)) return false;
    const sim = !!ev.simulated, bankroll = this.sleeve(sim);
    const kl = M.kelly(o.fairProb, o.dec, { fraction: this.c.kellyFraction, maxPct: this.c.maxStakePct / 100 });
    const stake = Math.floor(bankroll * kl.stakePct * 100) / 100;
    if (stake < this.c.minStakeUsd) { this.skip('Kelly stake below minimum', `${o.label} @${o.book} ${o.dec}: ${(kl.full * 100).toFixed(2)}% full Kelly → $${stake.toFixed(2)} < $${this.c.minStakeUsd}`); return false; }
    const cap = this.bk.check(this.id, { bankroll, simulated: sim, eventId: ev.id, stakes: [stake], ...this.caps() }); if (!cap.ok) { this.skip('exposure cap', cap.reason); return false; }
    const g = this.gate(sim); if (!g.ok) { this.skip('risk gate: ' + g.reason); return false; }
    this.taken.add(k);
    const meta = o.anchor ? { anchor: o.anchor, pFair: o.fairProb, dTaken: o.dec, priceAgeSec: o.priceAgeSec ?? null, anchorAgeSec: o.anchorAgeSec ?? null, holdPct: o.holdPct ?? null } : {};
    this.bk.place(this.id, ev, [{ ...o, stake }], { kind, meta });
    this.log(`${sim ? '[SIM] ' : ''}PAPER BET ${this.evName(ev)} · ${o.label} @ ${o.book} ${o.dec.toFixed(2)} · fair ${(1 / o.fairProb).toFixed(2)}${o.anchor ? ` (${o.anchor === 'consensus' ? 'consensus' : o.anchor + ' no-vig'})` : ''} · EV ${o.evPct.toFixed(1)}% · ${(this.c.kellyFraction)}× Kelly → $${stake.toFixed(2)}`, { simulated: sim });
    return true;
  }
  tick(now) {
    if (now - this.lastEval < R.scanMs) return; this.lastEval = now;
    this.bk.settle(now);
    if (this.feed.mode === 'pending') { this.opps = []; return this.armed && this.skip('odds feed connecting'); }
    this.opps = this.scan(now);
    if (!this.armed) return;
    if (!this.events().length) return this.skip('no upcoming events', `need > ${this.minLeadMin()} min to start`);
    this.act(now);
  }
  explain() { return explainStrategy(this); }
  view() { return { feed: this.feed.snapshot(), opps: this.opps.slice(0, 10), bets: this.bk.view(this.id), params: this.params(), liveBetting: 'disabled stub · alerts only' }; }
}

class BetEV extends BetStrategy {
  constructor(engine, feed, book) { super(engine, feed, book, { id: 'bet_ev', name: 'Sports +EV vs Pinnacle', desc: 'Soft-book price vs Pinnacle no-vig fair (falls back to the consensus of other books) · named gates · fractional Kelly · CLV scoreboard', allocPct: 0.06, chains: ['Sportsbooks'] }); this.gates = {}; }
  anchorBook() { return this.feed.simulated ? A.MOCK_ANCHOR : this.c.anchorBook; }
  gateCfg() { const c = this.c; return { anchor: this.anchorBook(), method: c.anchorMethod, minEdgePct: c.minEdgePct, minEdgeSpreadsPct: c.minEdgeSpreadsPct, minEdgeLongshotPct: c.minEdgeLongshotPct, longshotDec: c.longshotDec,
    maxPriceAgeSec: c.maxPriceAgeSec, maxAgeGapSec: c.maxAgeGapSec, maxHoldPct: c.maxHoldPct, minMinutes: this.minLeadMin(), maxHours: c.maxHoursToStart, maxDecimalOdds: c.maxOddsDec }; }
  params() { const c = this.c; return { anchor: c.anchor === 'pinnacle' ? this.anchorBook() : 'consensus', minEdgePct: c.minEdgePct, minEdgeSpreadsPct: c.minEdgeSpreadsPct, minEdgeLongshotPct: c.minEdgeLongshotPct, longshotDec: c.longshotDec,
    maxPriceAgeSec: c.maxPriceAgeSec, maxAgeGapSec: c.maxAgeGapSec, maxHoldPct: c.maxHoldPct, minMinutesToStart: this.minLeadMin(), maxHoursToStart: c.maxHoursToStart, minBooks: c.minBooks, kellyFraction: c.kellyFraction, maxDecimalOdds: c.maxOddsDec, method: c.anchor === 'pinnacle' ? c.anchorMethod : c.fairMethod }; }
  consensus(ev) {
    return S.evOpportunities(ev, { minEdgePct: 0, minBooks: this.c.minBooks, maxDecimalOdds: this.c.maxOddsDec, method: this.c.fairMethod })
      .map((o) => ({ ...o, anchor: 'consensus', needPct: this.c.minEdgePct, ok: o.evPct >= this.c.minEdgePct, reason: o.evPct >= this.c.minEdgePct ? undefined : `EV ${o.evPct.toFixed(2)}% < ${this.c.minEdgePct}%` }));
  }
  scan(now = Date.now()) {
    const gates = {}, add = (r) => { const k = r.replace(/[\d.]+/g, '#'); gates[k] = (gates[k] || 0) + 1; };
    const out = this.events().flatMap((ev) => {
      let os;
      if (this.c.anchor === 'pinnacle') {
        const r = A.anchoredOpportunities(ev, this.gateCfg(), now);
        for (const s of r.skips) add(s.reason);
        os = r.skips.some((s) => s.reason === 'no anchor book') ? this.consensus(ev).map((o) => ({ ...o, fallback: true })) : r.cands; // fallback ONLY when the anchor has no prices at all
        if (r.skips.length && !os.length) return [];
      } else os = this.consensus(ev);
      for (const o of os) if (!o.ok && o.reason) add(o.reason);
      return os.map((o) => ({ ...o, event: this.evName(ev), commence: ev.commence, simulated: !!ev.simulated }));
    });
    this.gates = gates;
    return out.sort((a, b) => (b.ok - a.ok) || b.evPct - a.evPct);
  }
  act() {
    const hits = this.opps.filter((o) => o.ok);
    if (!hits.length) { const g = Object.entries(this.gates).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ×${n}`).join('; '); const t = this.opps[0];
      return this.skip('no price passed the gates', (t ? `best ${t.label} @${t.book} EV ${t.evPct.toFixed(2)}%` : 'no comparable markets') + (g ? ` · gates: ${g}` : '')); }
    let n = 0; for (const o of hits) { if (n >= R.evMaxPerScan) break; const ev = this.feed.events.get(o.eventId); if (ev && this.takeSingle(ev, o, 'ev')) n++; }
  }
  view() { return { ...super.view(), gates: this.gates, scoreboard: this.bk.scoreboard(this.id) }; }
}

class BetSpread extends BetStrategy {
  constructor(engine, feed, book) { super(engine, feed, book, { id: 'bet_spread', name: 'Sports spread signal', desc: 'Off-consensus spread numbers (stale/soft lines) · edge per point is an ASSUMPTION · fractional Kelly', allocPct: 0.03, chains: ['Sportsbooks'] }); }
  params() { return { minPointEdge: this.c.minPointEdge, pointValuePct: this.c.pointValuePct, minEdgePct: this.c.minEdgePct, assumption: `${this.c.pointValuePct}% win-prob per point (assumed, not estimated)` }; }
  scan() {
    return this.events().flatMap((ev) => S.spreadSignals(ev, { minPointEdge: this.c.minPointEdge, pointValuePct: this.c.pointValuePct, minEdgePct: -100, minBooks: this.c.minBooks, method: this.c.fairMethod }).map((o) => ({ ...o, event: this.evName(ev), commence: ev.commence, simulated: !!ev.simulated })))
      .sort((a, b) => b.evPct - a.evPct);
  }
  act() {
    const hits = this.opps.filter((o) => o.evPct >= this.c.minEdgePct);
    if (!hits.length) return this.skip('no off-consensus spread with edge', this.opps[0] ? `best ${this.opps[0].label} ${this.opps[0].pointEdge}pt, EV ${this.opps[0].evPct.toFixed(2)}%` : `no line ≥ ${this.c.minPointEdge}pt off consensus`);
    let n = 0; for (const o of hits) { if (n >= R.spreadMaxPerScan) break; const ev = this.feed.events.get(o.eventId); if (ev && this.takeSingle(ev, o, 'spread')) n++; }
  }
}

class BetArb extends BetStrategy {
  constructor(engine, feed, book) { super(engine, feed, book, { id: 'bet_arb', name: 'Sports arb + middle scanner', desc: 'Cross-book arbitrage at quoted prices (paper) · middles are ALERTS ONLY', allocPct: 0.03, chains: ['Sportsbooks'] }); this.middles = []; this.alerted = new Map(); }
  params() { return { minMarginPct: this.c.minArbPct, arbStakePct: this.c.arbStakePct, middleMaxCostPct: this.c.middleMaxCostPct }; }
  scan() {
    const evs = this.events();
    this.middles = evs.flatMap((ev) => S.middleOpportunities(ev, { maxCostPct: this.c.middleMaxCostPct }).map((m) => ({ ...m, event: this.evName(ev), simulated: !!ev.simulated }))).slice(0, 10);
    return evs.flatMap((ev) => S.arbOpportunities(ev, { minMarginPct: -2 }).map((a) => ({ ...a, event: this.evName(ev), commence: ev.commence, simulated: !!ev.simulated }))).sort((a, b) => b.marginPct - a.marginPct);
  }
  act(now) {
    for (const m of this.middles) { // alerts only: never staked, deduped for R.middleDedupMin
      const k = m.eventId + m.legs.map((l) => l.book + l.name + l.point).join();
      if (!this.alerted.has(k) || now - this.alerted.get(k) > R.middleDedupMin * 60e3) { this.alerted.set(k, now); this.e.tape.push({ kind: 'info', strategy: this.id, simulated: m.simulated, msg: `${m.simulated ? '[SIM] ' : ''}ALERT middle ${m.event} · ${m.legs.map((l) => `${l.label} @${l.book} ${l.dec}`).join(' + ')} · width ${m.width} · ${m.ifOneWins >= 0 ? 'NO-LOSE (cross-line arb) ' : ''}if one wins ${m.ifOneWins.toFixed(2)}% · both ${m.ifBothWin.toFixed(1)}% (alert only, not placed)` }); }
    }
    const hits = this.opps.filter((a) => a.marginPct >= this.c.minArbPct);
    if (!hits.length) return this.skip('no arb at quoted prices', this.opps[0] ? `best ${this.opps[0].event} ${this.opps[0].market} Σimplied ${this.opps[0].sumImplied.toFixed(4)} (margin ${this.opps[0].marginPct.toFixed(2)}% < ${this.c.minArbPct}%)` : 'no overlapping markets');
    for (const a of hits.slice(0, R.arbMaxPerScan)) {
      const ev = this.feed.events.get(a.eventId); if (!ev) continue;
      const k = `${ev.id}|arb|${a.market}|${a.line}`; if (this.taken.has(k)) continue;
      const sim = !!ev.simulated, bankroll = this.sleeve(sim), total = Math.floor(bankroll * this.c.arbStakePct) / 100;
      const stakes = a.legs.map((l) => +(l.weight * total).toFixed(2));
      const cap = this.bk.check(this.id, { bankroll, simulated: sim, eventId: ev.id, stakes, ...this.caps(), maxStakePct: this.c.arbStakePct, maxEventPct: Math.max(this.c.maxEventPct, this.c.arbStakePct) }); if (!cap.ok) { this.skip('exposure cap', cap.reason); continue; }
      const g = this.gate(sim); if (!g.ok) { this.skip('risk gate: ' + g.reason); continue; }
      this.taken.add(k);
      const group = 'A' + now.toString(36) + Math.floor(Math.random() * 1e4);
      this.bk.place(this.id, ev, a.legs.map((l, i) => ({ ...l, market: a.market, stake: stakes[i] })), { kind: 'arb', group });
      this.log(`${sim ? '[SIM] ' : ''}PAPER ARB ${a.event} ${a.market}${a.line !== '' ? ' ' + a.line : ''} · ${a.legs.map((l, i) => `${l.label} @${l.book} ${l.dec} $${stakes[i]}`).join(' / ')} · locked ${a.marginPct.toFixed(2)}% at quoted prices (real books may limit/void/move first)`, { simulated: sim });
    }
  }
  view() { return { ...super.view(), middles: this.middles }; }
}

return { BetEV, BetSpread, BetArb };
}
module.exports = defineStrategies;
