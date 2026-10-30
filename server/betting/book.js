'use strict';
// Paper bet ledger shared by the betting strategies.
//  - Exposure caps (per bet / per event / total open) are enforced against each strategy's own sleeve bankroll.
//  - Bets are graded from final scores (real: The Odds API /scores; mock: the synthetic outcome) and booked into the
//    desk Ledger, so they flow into the unified equity curve and per-strategy attribution. Vig is inside the price,
//    so fees are 0; no slippage is modelled, but see the README: paper ignores limits, restrictions and line moves.
//  - Arb legs share a group id and are booked with ONE ledger entry once every leg is graded.
//  - CLV: at commence the last pre-game snapshot is the (approximate) closing line; CLV = taken price vs no-vig close.
const S = require('./scanner');
const M = require('./math');
const CLV = require('./clv');

let seq = 0;
class BetBook {
  constructor(engine, feed, cfg) { this.e = engine; this.feed = feed; this.c = cfg; this.bets = []; }
  open(strategy) { return this.bets.filter((b) => b.status === 'open' && (!strategy || b.strategy === strategy)); }
  exposure(strategy, simulated, eventId) {
    const o = this.open(strategy).filter((b) => b.simulated === simulated);
    return { total: o.reduce((a, b) => a + b.stake, 0), event: o.filter((b) => b.event === eventId).reduce((a, b) => a + b.stake, 0) };
  }
  /** Check caps for a proposed set of stakes on one event. Returns {ok, reason}. */
  check(strategy, { bankroll, simulated, eventId, stakes, maxStakePct, maxEventPct, maxOpenPct }) {
    if (!(bankroll > 0)) return { ok: false, reason: 'no bankroll in sleeve' };
    const sum = stakes.reduce((a, b) => a + b, 0), x = this.exposure(strategy, simulated, eventId);
    const big = Math.max(...stakes);
    if (big > bankroll * maxStakePct / 100 + 1e-9) return { ok: false, reason: `per-bet cap ${maxStakePct}% (stake $${big.toFixed(2)} > $${(bankroll * maxStakePct / 100).toFixed(2)})` };
    if (x.event + sum > bankroll * maxEventPct / 100 + 1e-9) return { ok: false, reason: `per-event cap ${maxEventPct}% reached` };
    if (x.total + sum > bankroll * maxOpenPct / 100 + 1e-9) return { ok: false, reason: `total open-exposure cap ${maxOpenPct}% reached` };
    return { ok: true };
  }
  place(strategy, ev, legs, { kind, group = null, meta = {} } = {}) {
    const out = [];
    for (const l of legs) {
      const b = { id: 'B' + (++seq), t: this.e.now ? this.e.now() : Date.now(), strategy, kind, group, event: ev.id, eventLabel: `${ev.away} @ ${ev.home}`, home: ev.home, away: ev.away, sport: ev.sport, commence: ev.commence,
        market: l.market, name: l.name, point: l.point ?? null, label: l.label, book: l.book, dec: l.dec, stake: +l.stake.toFixed(2), fairProb: l.fairProb ?? null, evPct: l.evPct ?? null,
        simulated: !!ev.simulated, status: 'open', pnl: null, close: null, paper: true, ...meta };
      this.bets.unshift(b); out.push(b);
    }
    if (this.bets.length > 1000) this.bets = this.bets.filter((b, i) => i < 1000 || b.status === 'open');
    return out;
  }
  /** Capture closing lines and grade finished games. Called from the strategies' ticks; idempotent. */
  settle(now = Date.now()) {
    const booked = [];
    for (const b of this.bets) {
      if (b.status !== 'open') continue;
      if (!b.close && now >= b.commence) { const cl = this.feed.closeOf(b.event); if (cl) this.capture(b, cl); }
      const sc = this.feed.scoreOf(b.event); if (!sc) continue;
      const ev = this.feed.events.get(b.event) || { home: b.home, away: b.away };
      b.result = S.grade(b, ev, sc); b.pnl = +S.payout(b.result, b.stake, b.dec).toFixed(2); b.status = 'settled'; b.settledAt = now; b.score = `${sc.away}-${sc.home}`;
      if (!b.group) booked.push(this.book([b]));
    }
    // arb groups: book once all legs are graded
    const groups = {}; for (const b of this.bets) if (b.group) (groups[b.group] = groups[b.group] || []).push(b);
    for (const legs of Object.values(groups)) if (legs.every((l) => l.status === 'settled') && !legs[0].booked) booked.push(this.book(legs));
    return booked;
  }
  /** Closing line for one bet. Anchored bets (H1) use the anchor's no-vig close; others the old consensus close. */
  capture(b, cl) {
    if (b.anchor && b.anchor !== 'consensus') {
      const r = CLV.clvFor(b, cl, { anchor: b.anchor, method: this.c.anchorMethod || 'power', closeWithinMin: this.c.closeWithinMin ?? 10 });
      b.clv = r; b.dCloseFair = r.dCloseFair ?? null; b.clvPct = r.clvPct; b.beatClose = r.beatClose;
      b.close = { fairDec: r.dCloseFair ?? null, bestDec: r.dCloseSoft, clvPct: r.clvPct, note: r.note, at: cl.capturedAt };
    } else {
      b.close = closeFor(b, cl, this.c.fairMethod);
      b.clv = { clvPct: b.close.clvPct, closeOk: true, beatClose: b.close.bestDec ? b.dec > b.close.bestDec : null, anchor: 'consensus' }; b.clvPct = b.close.clvPct;
    }
  }
  /** H1 CLV scoreboard (real and simulated kept apart). */
  scoreboard(strategy) {
    const mine = this.bets.filter((b) => b.strategy === strategy);
    return { closeWithinMin: this.c.closeWithinMin ?? 10, real: CLV.summarize(mine.filter((b) => !b.simulated)), sim: CLV.summarize(mine.filter((b) => b.simulated)) };
  }
  book(legs) {
    const pnl = legs.reduce((a, l) => a + l.pnl, 0), b0 = legs[0];
    for (const l of legs) l.booked = true;
    const why = legs.length > 1 ? `arb ${legs.map((l) => `${l.label}@${l.book}:${l.result}`).join(' / ')}` : `${b0.result}${b0.close && b0.close.clvPct != null ? ` · CLV ${b0.close.clvPct.toFixed(1)}%` : ''}`;
    const rec = this.e.ledger.close(b0.strategy, { pnl, total: pnl, fees: 0, slippage: 0, simulated: b0.simulated, meta: { symbol: `${b0.eventLabel} · ${legs.map((l) => l.label).join(' + ')}`, why, venue: legs.map((l) => l.book).join('+'), kind: 'bet' } });
    this.e.tape.push({ kind: 'fill', strategy: b0.strategy, msg: `${b0.simulated ? '[SIM] ' : ''}BET SETTLED ${rec.meta.symbol} · ${why} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`, pnl, simulated: b0.simulated });
    return rec;
  }
  /** CLV stats over settled-or-closed bets of a strategy (simulated and real kept apart). */
  clvStats(strategy, simulated) {
    const xs = this.bets.filter((b) => b.strategy === strategy && b.simulated === simulated && b.close && b.close.clvPct != null).map((b) => b.close.clvPct);
    return xs.length ? { n: xs.length, avgPct: xs.reduce((a, b) => a + b, 0) / xs.length, beatPct: (xs.filter((x) => x > 0).length / xs.length) * 100 } : { n: 0, avgPct: null, beatPct: null };
  }
  view(strategy) {
    const mine = this.bets.filter((b) => b.strategy === strategy);
    const strip = (b) => ({ id: b.id, t: b.t, group: b.group, event: b.eventLabel, commence: b.commence, label: b.label, book: b.book, dec: b.dec, stake: b.stake, evPct: b.evPct, simulated: b.simulated, status: b.status, result: b.result || null, pnl: b.pnl, score: b.score || null, clvPct: b.close ? b.close.clvPct : null, closeNote: b.close ? b.close.note : null, anchor: b.anchor || null, beatClose: b.beatClose ?? null, priceAgeSec: b.priceAgeSec ?? null });
    return { open: mine.filter((b) => b.status === 'open').slice(0, 20).map(strip), settled: mine.filter((b) => b.status === 'settled').slice(0, 20).map(strip),
      counts: { open: mine.filter((b) => b.status === 'open').length, settled: mine.filter((b) => b.status === 'settled').length }, clv: { real: this.clvStats(strategy, false), sim: this.clvStats(strategy, true) } };
  }
  snapshot() { return { open: this.open().length, settled: this.bets.filter((b) => b.status === 'settled').length }; }
}

/** Closing-line record for one bet from the last pre-game snapshot. */
function closeFor(b, cl, method = 'multiplicative') {
  const f = S.fairProb(cl, b.market, b.name, b.point, { method });
  const best = S.quotes(cl, { markets: [b.market] }).filter((q) => q.name === b.name && (b.market === 'h2h' || q.point === b.point)).reduce((m, q) => Math.max(m, q.dec), 0) || null;
  if (!f) return { fairDec: null, bestDec: best, clvPct: null, note: b.market === 'h2h' ? 'no close quotes' : `line moved: no close quoted at ${b.point}`, at: cl.capturedAt };
  const c = M.clv(b.dec, 1 / f.prob);
  return { fairDec: 1 / f.prob, bestDec: best, clvPct: c.clvPct, probEdgePp: c.probEdgePp, books: f.books, at: cl.capturedAt };
}

module.exports = { BetBook, closeFor };
