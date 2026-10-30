'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../server/betting/math');
const S = require('../server/betting/scanner');
const { BetBook } = require('../server/betting/book');
const { LiveBetPlacer } = require('../server/betting/live');
const { OddsFeed, normalizeOddsApi, scoreFromApi } = require('../server/feeds/odds');
const { Engine } = require('../server/engine');
const config = require('../server/config');
const B = require('../server/strategies/betting');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('american ↔ decimal and implied probability', () => {
  near(M.americanToDecimal(-110), 1.909090909); near(M.americanToDecimal(150), 2.5); near(M.americanToDecimal(100), 2);
  assert.equal(M.decimalToAmerican(2.5), 150); assert.equal(M.decimalToAmerican(1.5), -200); near(M.implied(2.5), 0.4);
});

test('no-vig: multiplicative normalises; power keeps favourite/longshot shape; both sum to 1', () => {
  const m = M.noVig([1.909090909, 1.909090909]); near(m.probs[0], 0.5); near(m.overround, 0.047619, 1e-5); near(m.fair[0], 2);
  const fav = M.noVig([1.5, 2.6]); near(fav.probs[0] + fav.probs[1], 1); near(fav.probs[0], (1 / 1.5) / (1 / 1.5 + 1 / 2.6));
  const pw = M.noVig([1.5, 2.6], 'power'); near(pw.probs[0] + pw.probs[1], 1, 1e-9);
  assert.ok(pw.probs[0] > fav.probs[0], 'power method shifts margin off the favourite (longshot bias)');
  const three = M.noVig([2.1, 3.4, 3.6]); near(three.probs.reduce((a, b) => a + b, 0), 1);
  assert.throws(() => M.noVig([1.9]), RangeError);
});

test('EV and fractional Kelly with caps', () => {
  near(M.ev(0.5, 2.1), 0.05); near(M.ev(0.5, 1.9), -0.05); near(M.ev(0.4, 2.5), 0);
  const k = M.kelly(0.55, 2.0, { fraction: 1, maxPct: 1 }); near(k.full, 0.1); near(k.stakePct, 0.1);
  near(M.kelly(0.55, 2.0, { fraction: 0.25, maxPct: 1 }).stakePct, 0.025);
  near(M.kelly(0.55, 2.0, { fraction: 0.25, maxPct: 0.02 }).stakePct, 0.02, 1e-12); // cap binds
  assert.equal(M.kelly(0.45, 2.0).stakePct, 0); // negative edge → no bet
  assert.equal(M.kelly(1, 2.0).stakePct, 0); // degenerate input refused
});

test('arbitrage: detection, equal-payout stakes, and rejection when Σ implied ≥ 1', () => {
  const a = M.arb([2.1, 2.05], 1000); assert.ok(a); near(a.sumImplied, 1 / 2.1 + 1 / 2.05);
  near(a.stakes[0] * 2.1, a.stakes[1] * 2.05, 1e-9); near(a.stakes[0] + a.stakes[1], 1000); assert.ok(a.profit > 0); near(a.marginPct, (1 / a.sumImplied - 1) * 100);
  assert.equal(M.arb([1.95, 1.95]), null); assert.equal(M.arb([2, 2]), null);
  assert.ok(M.arb([3.2, 3.6, 3.9]));
});

test('middles: totals and spreads windows, costs and both-win payoff', () => {
  const t = M.middle({ kind: 'totals', a: { point: 220.5, dec: 1.91 }, b: { point: 223.5, dec: 1.91 } });
  near(t.width, 3); assert.ok(t.ifOneWins < 0 && t.ifBothWin > 80);
  assert.equal(M.middle({ kind: 'totals', a: { point: 223.5, dec: 1.91 }, b: { point: 220.5, dec: 1.91 } }), null);
  const s = M.middle({ kind: 'spreads', a: { point: 3.5, dec: 1.91 }, b: { point: -2.5, dec: 1.91 } }); near(s.width, 1);
  assert.equal(M.middle({ kind: 'spreads', a: { point: 3, dec: 1.91 }, b: { point: -3, dec: 1.91 } }), null);
});

test('CLV: beat / lost the close', () => {
  const c = M.clv(2.1, 2.0); near(c.clvPct, 5); near(c.probEdgePp, (0.5 - 1 / 2.1) * 100);
  assert.ok(M.clv(1.9, 2.0).clvPct < 0); assert.equal(M.clv(1, 2), null);
});

// ---------- scanner on a fixed fixture ----------
const book = (key, h2h, spread, total) => ({ key, title: key, markets: {
  h2h: [{ name: 'Home', dec: h2h[0] }, { name: 'Away', dec: h2h[1] }],
  spreads: [{ name: 'Home', point: spread[0], dec: spread[1] }, { name: 'Away', point: -spread[0], dec: spread[2] }],
  totals: [{ name: 'Over', point: total[0], dec: total[1] }, { name: 'Under', point: total[0], dec: total[2] }] } });
const fixture = () => ({ id: 'e1', sport: 'basketball_nba', home: 'Home', away: 'Away', commence: Date.now() + 3600e3, simulated: true, books: [
  book('a', [1.91, 1.91], [-3.5, 1.91, 1.91], [220.5, 1.91, 1.91]),
  book('b', [1.90, 1.92], [-3.5, 1.90, 1.92], [220.5, 1.92, 1.90]),
  book('c', [1.92, 1.90], [-3.5, 1.91, 1.91], [220.5, 1.91, 1.91]),
  book('soft', [2.15, 1.72], [-2.5, 1.91, 1.91], [223.5, 1.91, 1.91]),
  book('sharp', [1.88, 2.06], [-3.5, 1.93, 1.89], [220.5, 1.90, 1.92]),
] });

test('scanner: line shopping + EV vs other books, arb across books, middles, spread signal', () => {
  const ev = fixture();
  const best = S.bestPrices(ev); assert.equal(best['h2h|Home|'].book, 'soft'); assert.equal(best['h2h|Home|'].dec, 2.15);
  const evs = S.evOpportunities(ev, { minEdgePct: 2, minBooks: 3 });
  const home = evs.find((o) => o.market === 'h2h' && o.name === 'Home'); assert.ok(home, 'soft book home ML is +EV');
  assert.equal(home.book, 'soft'); assert.ok(home.evPct > 5); assert.equal(home.consensusBooks, 4); // excludes its own price
  const arbs = S.arbOpportunities(ev, { minMarginPct: 0 });
  const h2h = arbs.find((a) => a.market === 'h2h'); assert.ok(h2h); assert.deepEqual(h2h.legs.map((l) => l.book).sort(), ['sharp', 'soft']); near(h2h.sumImplied, 1 / 2.15 + 1 / 2.06);
  const mids = S.middleOpportunities(ev, { maxCostPct: 5 });
  assert.ok(mids.find((m) => m.market === 'totals' && m.width === 3), 'over 220.5 / under 223.5 middle');
  assert.ok(mids.find((m) => m.market === 'spreads' && m.width === 1), 'home -2.5 / away +3.5 middle');
  const sig = S.spreadSignals(ev, { minPointEdge: 1, pointValuePct: 3, minEdgePct: 0, minBooks: 3 });
  const s = sig.find((o) => o.name === 'Home'); assert.ok(s); assert.equal(s.book, 'soft'); assert.equal(s.point, -2.5); assert.equal(s.pointEdge, 1); assert.match(s.assumption, /assumed/);
});

test('scanner: no single-book arbs; incomplete h2h markets are not arbs', () => {
  const ev = { id: 'x', home: 'H', away: 'A', books: [{ key: 'only', markets: { h2h: [{ name: 'H', dec: 2.2 }, { name: 'A', dec: 2.2 }] } }] };
  assert.equal(S.arbOpportunities(ev).length, 0);
  const ev3 = { id: 'y', home: 'H', away: 'A', books: [{ key: 'p', markets: { h2h: [{ name: 'H', dec: 3.5 }, { name: 'A', dec: 3.5 }, { name: 'Draw', dec: 3.5 }] } }, { key: 'q', markets: { h2h: [{ name: 'H', dec: 3.6 }, { name: 'A', dec: 3.6 }] } }] };
  assert.equal(S.arbOpportunities(ev3).length, 1, 'three-way arb needs all three outcomes (p has them all)');
});

test('grading: moneyline, spread incl. push, totals', () => {
  const ev = { home: 'H', away: 'A' };
  assert.equal(S.grade({ market: 'h2h', name: 'H' }, ev, { home: 101, away: 99 }), 'won');
  assert.equal(S.grade({ market: 'spreads', name: 'H', point: -3 }, ev, { home: 103, away: 100 }), 'push');
  assert.equal(S.grade({ market: 'spreads', name: 'A', point: 3.5 }, ev, { home: 103, away: 100 }), 'won');
  assert.equal(S.grade({ market: 'totals', name: 'Over', point: 200.5 }, ev, { home: 100, away: 100 }), 'lost');
  near(S.payout('won', 10, 2.5), 15); near(S.payout('lost', 10, 2.5), -10); near(S.payout('push', 10, 2.5), 0);
});

test('The Odds API normalisation + score parsing', () => {
  const e = normalizeOddsApi({ id: 'z', sport_key: 'basketball_nba', commence_time: '2026-11-01T00:00:00Z', home_team: 'H', away_team: 'A', bookmakers: [{ key: 'dk', title: 'DK', last_update: '2026-10-31T23:00:00Z', markets: [{ key: 'spreads', outcomes: [{ name: 'H', price: 1.91, point: -2.5 }, { name: 'A', price: 1.91, point: 2.5 }] }] }] });
  assert.equal(e.simulated, false); assert.equal(e.books[0].markets.spreads[0].point, -2.5); assert.equal(e.commence, Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(scoreFromApi({ completed: true, home_team: 'H', away_team: 'A', scores: [{ name: 'H', score: '101' }, { name: 'A', score: '99' }] }), { home: 101, away: 99 });
  assert.equal(scoreFromApi({ completed: false, scores: null }), null);
});

test('real-money bet placement is a stub that refuses', () => {
  assert.throws(() => new LiveBetPlacer().placeBet({ stake: 10 }), (e) => e.code === 'LIVE_BETTING_DISABLED');
  const eng = new Engine(config.build({}), { modules: { betting: require('../server/modules').betting } });
  assert.throws(() => eng.placeLiveBet(), (e) => e.code === 'LIVE_BETTING_DISABLED');
  assert.ok(!JSON.stringify(config.publicFlags(config.build({ ODDS_API_KEY: 'secret-odds-key' }))).includes('secret-odds-key'));
});

test('odds feed: API key never appears in errors; first failure falls back to labelled MOCK', async () => {
  const health = { register() {}, ok() {}, fail(id, msg) { this.last = msg; } };
  const cfg = config.build({ ODDS_API_KEY: 'k3y-SHOULD-NOT-LEAK' }).betting;
  const feed = new OddsFeed({ health, cfg, fetchImpl: async (u) => { throw new Error('connect failed ' + String(u)); } });
  await feed.pollOdds(); feed.stop();
  assert.equal(feed.mode, 'mock'); assert.equal(feed.simulated, true); assert.ok(!health.last.includes('k3y-SHOULD-NOT-LEAK')); assert.ok(!feed.note.includes('k3y-SHOULD-NOT-LEAK'));
});

test('mock market end to end: bets are SIMULATED, capped, graded, CLV recorded, booked to the sim ledger only', () => {
  let T = Date.UTC(2026, 9, 1); let seed = 42; const rng = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const cfg = config.build({}); const e = new Engine(cfg, { modules: {} });
  const feed = e.addFeed('odds', new OddsFeed({ health: e.health, cfg: cfg.betting, rng, now: () => T })); const bk = e.addFeed('bets', new BetBook(e, feed, cfg.betting));
  const ss = [B.BetEV, B.BetSpread, B.BetArb].map((K) => e.addStrategy(new K(e, feed, bk))); ss.forEach((s) => s.arm(true)); feed.mode = 'mock';
  for (let i = 0; i < 600; i++) { T += 5000; feed.mockTick(); e.tick(T); }
  assert.ok(bk.bets.length > 0, 'some paper bets placed'); assert.ok(bk.bets.every((b) => b.simulated && b.paper));
  const settled = bk.bets.filter((b) => b.status === 'settled'); assert.ok(settled.length > 0);
  assert.ok(settled.some((b) => b.close && b.close.clvPct != null), 'CLV captured at close');
  for (const s of ss) { const a = e.ledger.attribution().find((x) => x.id === s.id); assert.equal(a.real, 0, 'mock bets never reach the real book'); }
  const ev = ss[0]; for (const b of bk.bets.filter((x) => x.strategy === 'bet_ev')) assert.ok(b.stake <= ev.alloc * 1.5 * cfg.betting.maxStakePct / 100 + 0.01, 'per-bet cap');
  // arb groups are booked once with total PnL ≥ 0 at quoted prices (pushes return stake)
  const groups = {}; for (const b of bk.bets.filter((x) => x.group && x.status === 'settled')) (groups[b.group] = groups[b.group] || []).push(b);
  for (const legs of Object.values(groups)) if (legs.length >= 2) assert.ok(legs.reduce((a, l) => a + l.pnl, 0) >= -0.05);
});

test('exposure caps refuse oversize, per-event and total exposure', () => {
  const e = { ledger: { close() {} }, tape: { push() {} } }; const bk = new BetBook(e, {}, {});
  const base = { bankroll: 1000, simulated: true, eventId: 'e', maxStakePct: 2, maxEventPct: 3, maxOpenPct: 5 };
  assert.equal(bk.check('s', { ...base, stakes: [20] }).ok, true);
  assert.match(bk.check('s', { ...base, stakes: [25] }).reason, /per-bet/);
  bk.place('s', { id: 'e', home: 'H', away: 'A', simulated: true }, [{ market: 'h2h', name: 'H', dec: 2, stake: 20 }]);
  assert.match(bk.check('s', { ...base, stakes: [15] }).reason, /per-event/);
  bk.place('s', { id: 'f', home: 'H', away: 'A', simulated: true }, [{ market: 'h2h', name: 'H', dec: 2, stake: 20 }]);
  assert.match(bk.check('s', { ...base, eventId: 'g', stakes: [15] }).reason, /total open/);
});
