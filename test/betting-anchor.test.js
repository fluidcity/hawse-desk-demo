const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../server/betting/anchor');
const { normalizeOddsApi } = require('../server/betting/data/odds');

const NOW = Date.UTC(2026, 10, 1, 12);
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);
const G = { anchor: 'pinnacle', method: 'multiplicative', minEdgePct: 2, minEdgeSpreadsPct: 2.5, minEdgeLongshotPct: 4, longshotDec: 4, maxPriceAgeSec: 600, maxAgeGapSec: 300, maxHoldPct: 5, minMinutes: 20, maxHours: 36, maxDecimalOdds: 10 };
const book = (key, h, a, { age = 60, spread } = {}) => ({ key, lastUpdate: NOW - age * 1000, markets: { h2h: [{ name: 'H', dec: h }, { name: 'A', dec: a }], ...(spread ? { spreads: spread } : {}) } });
const event = (books, mins = 120) => ({ id: 'e1', sport: 'basketball_nba', home: 'H', away: 'A', commence: NOW + mins * 60e3, books });

test('pinnacleFair de-vigs the anchor only, with overround, age and a multiplicative cross-check', () => {
  const ev = event([book('pinnacle', 1.95, 1.95, { age: 30 }), book('dk', 2.2, 1.7)]);
  const f = A.pinnacleFair(ev, 'h2h', '', { anchor: 'pinnacle', method: 'power', now: NOW });
  near(f.probs[0].prob, 0.5); near(f.overround, 2 / 1.95 - 1); assert.equal(f.ageSec, 30); near(f.cross.probs[0], 0.5);
  assert.equal(A.pinnacleFair(ev, 'h2h', '', { anchor: 'nobody', now: NOW }), null);
  // spreads need the anchor at the SAME line on both sides
  const sp = event([book('pinnacle', 1.95, 1.95, { spread: [{ name: 'H', point: -3, dec: 1.95 }, { name: 'A', point: 3, dec: 1.95 }] })]);
  assert.ok(A.pinnacleFair(sp, 'spreads', -3, { now: NOW })); assert.equal(A.pinnacleFair(sp, 'spreads', -3.5, { now: NOW }), null);
});

test('anchored EV: a soft price above Pinnacle fair passes; thresholds differ by market and for longshots', () => {
  const r = A.anchoredOpportunities(event([book('pinnacle', 1.95, 1.95), book('dk', 2.1, 1.75)]), G, NOW);
  const h = r.cands.find((c) => c.name === 'H'); assert.equal(h.ok, true); near(h.evPct, 5); assert.equal(h.book, 'dk'); assert.equal(h.anchor, 'pinnacle');
  assert.equal(r.cands.find((c) => c.name === 'A').ok, false);
  assert.equal(A.minEdgeFor('h2h', 2, G), 2); assert.equal(A.minEdgeFor('spreads', 2, G), 2.5); assert.equal(A.minEdgeFor('h2h', 4.5, G), 4);
  // 3% edge at a longshot price fails the 4% longshot bar
  const ls = A.anchoredOpportunities(event([book('pinnacle', 1.2, 5.0 * 1.0), book('dk', 1.1, 5.3)]), { ...G, maxHoldPct: 50 }, NOW).cands.find((c) => c.name === 'A');
  assert.ok(ls.evPct > 2 && ls.evPct < 4, String(ls.evPct)); assert.equal(ls.ok, false); assert.match(ls.reason, /< 4%/);
});

test('anchored gates: hold, stale prices, age gap and time-to-start are named skips', () => {
  const hold = A.anchoredOpportunities(event([book('pinnacle', 1.85, 1.85), book('dk', 2.2, 1.7)]), G, NOW).cands[0];
  assert.equal(hold.ok, false); assert.match(hold.reason, /anchor hold 8\.1% > 5%/);
  const stale = A.anchoredOpportunities(event([book('pinnacle', 1.95, 1.95, { age: 900 }), book('dk', 2.1, 1.75)]), G, NOW).cands[0];
  assert.match(stale.reason, /stale price/);
  const gap = A.anchoredOpportunities(event([book('pinnacle', 1.95, 1.95, { age: 10 }), book('dk', 2.1, 1.75, { age: 500 })]), G, NOW).cands[0];
  assert.match(gap.reason, /apart > 300 s/);
  assert.equal(A.anchoredOpportunities(event([book('pinnacle', 1.95, 1.95), book('dk', 2.1, 1.75)], 10), G, NOW).skips[0].reason, 'too close to start');
  assert.equal(A.anchoredOpportunities(event([book('pinnacle', 1.95, 1.95), book('dk', 2.1, 1.75)], 40 * 60), G, NOW).skips[0].reason, 'too far from start');
  assert.equal(A.anchoredOpportunities(event([book('dk', 2.1, 1.75)]), G, NOW).skips[0].reason, 'no anchor book');
});

test('market last_update from The Odds API is used for price age', () => {
  const e = normalizeOddsApi({ id: 'z', sport_key: 'basketball_nba', commence_time: '2026-11-01T14:00:00Z', home_team: 'H', away_team: 'A', bookmakers: [
    { key: 'pinnacle', title: 'Pinnacle', last_update: '2026-11-01T11:59:00Z', markets: [{ key: 'h2h', last_update: '2026-11-01T11:50:00Z', outcomes: [{ name: 'H', price: 1.95 }, { name: 'A', price: 1.95 }] }] }] });
  assert.equal(A.marketAgeSec(e.books[0], 'h2h', NOW), 600); assert.equal(A.marketAgeSec(e.books[0], 'spreads', NOW), 60);
});

test('BetEV uses the anchor, falls back to consensus only when the anchor has no prices, and records H1 bet fields', () => {
  const config = require('../server/config'); const { Engine } = require('../server/engine'); const { BetBook } = require('../server/betting/book');
  const B = require('../server/betting/strategies')(require('../server/strategies/base').Strategy);
  const cfg = config.build({ CREDITS_FILE: '' }); const e = new Engine(cfg, { modules: {} });
  const evs = new Map([['e1', { ...event([book('pinnacle', 1.95, 1.95), book('dk', 2.1, 1.75)]), simulated: false }],
    ['e2', { ...event([book('a', 2.3, 1.7), book('b', 1.95, 1.95), book('c', 1.95, 1.95), book('d', 1.95, 1.95)]), id: 'e2', simulated: false }]]);
  const feed = { mode: 'live', simulated: false, events: evs, upcoming: () => [...evs.values()], closeOf: () => null, scoreOf: () => null, snapshot: () => ({}) };
  const bk = new BetBook(e, feed, cfg.betting); const s = new B.BetEV(e, feed, bk);
  const opps = s.scan(NOW);
  const a = opps.find((o) => o.eventId === 'e1' && o.name === 'H'); assert.equal(a.anchor, 'pinnacle'); assert.equal(a.ok, true);
  const c = opps.find((o) => o.eventId === 'e2' && o.name === 'H'); assert.equal(c.anchor, 'consensus'); assert.equal(c.fallback, true);
  const placed = bk.place('bet_ev', evs.get('e1'), [{ ...a, stake: 10 }], { kind: 'ev', meta: { anchor: a.anchor, pFair: a.fairProb, dTaken: a.dec, priceAgeSec: a.priceAgeSec } })[0];
  assert.equal(placed.anchor, 'pinnacle'); near(placed.pFair, 0.5); assert.equal(placed.dTaken, 2.1); assert.equal(placed.priceAgeSec, 60);
  assert.match(JSON.stringify(s.explain()), /Pinnacle/);
});
