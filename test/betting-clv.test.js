const test = require('node:test');
const assert = require('node:assert/strict');
const CLV = require('../server/betting/clv');
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

const T0 = Date.UTC(2026, 10, 1, 12), START = T0 + 3600e3;
const close = (pinH, pinA, dkH, leadMin = 5) => ({ id: 'e1', home: 'H', away: 'A', commence: START, capturedAt: START - leadMin * 60e3,
  books: [{ key: 'pinnacle', markets: { h2h: [{ name: 'H', dec: pinH }, { name: 'A', dec: pinA }] } }, { key: 'dk', markets: { h2h: [{ name: 'H', dec: dkH }, { name: 'A', dec: 1.8 }] } }] });
const bet = (o = {}) => ({ market: 'h2h', name: 'H', point: null, book: 'dk', dec: 2.1, commence: START, sport: 'basketball_nba', ...o });

test('clvFor: taken price vs the anchor no-vig close; beatClose vs the same book', () => {
  const r = CLV.clvFor(bet(), close(1.95, 1.95, 2.0), { method: 'multiplicative' });
  near(r.dCloseFair, 2); near(r.clvPct, 5); assert.equal(r.beatClose, true); assert.equal(r.closeOk, true); assert.equal(r.closeLeadMin, 5);
  const worse = CLV.clvFor(bet({ dec: 1.9 }), close(1.95, 1.95, 2.0), { method: 'multiplicative' }); assert.ok(worse.clvPct < 0); assert.equal(worse.beatClose, false);
  const old = CLV.clvFor(bet(), close(1.95, 1.95, 2.0, 45)); assert.equal(old.closeOk, false); assert.match(old.note, /approximate close/);
  assert.equal(CLV.clvFor(bet(), null).clvPct, null);
  assert.equal(CLV.clvFor(bet({ market: 'spreads', point: -3 }), close(1.95, 1.95, 2.0)).clvPct, null);
});

test('bootstrap CI brackets the mean and is reproducible', () => {
  const xs = Array.from({ length: 200 }, (_, i) => ((i * 37) % 11) - 4); const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ci = CLV.bootstrapCI(xs); assert.ok(ci[0] < m && m < ci[1]); assert.deepEqual(ci, CLV.bootstrapCI(xs)); assert.equal(CLV.bootstrapCI([1]), null);
});

test('summarize: only valid closes count, groups by sport/book, verdict follows the paper-test plan', () => {
  const mk = (clvPct, o = {}) => ({ stake: 10, status: 'settled', pnl: 1, sport: 'nba', book: 'dk', market: 'h2h', priceAgeSec: 30, clv: { clvPct, closeOk: true, beatClose: clvPct > 0 }, ...o });
  const few = CLV.summarize([mk(2), mk(-1), mk(3, { book: 'fd', clv: { clvPct: 3, closeOk: false, beatClose: true } })]);
  assert.equal(few.n, 2); assert.equal(few.approx, 1); near(few.mean, 0.5); assert.equal(few.byBook.dk.n, 2); assert.equal(few.verdict.status, 'collecting');
  const pass = CLV.summarize(Array.from({ length: 320 }, (_, i) => mk(i % 4 === 0 ? -0.5 : 2.5)));
  assert.equal(pass.verdict.status, 'pass'); assert.ok(pass.ci95[0] > 0); near(pass.beatClosePct, 75);
  const fail = CLV.summarize(Array.from({ length: 320 }, (_, i) => mk(i % 2 ? -1 : 0.5)));
  assert.equal(fail.verdict.status, 'fail');
  assert.equal(pass.roi.settled, 320); assert.match(pass.roi.note, /1500/);
});

test('BetBook: anchored bets get the anchor CLV at kickoff; scoreboard keeps real and simulated apart', () => {
  const { BetBook } = require('../server/betting/book');
  const e = { ledger: { close: () => ({ meta: {} }) }, tape: { push() {} } };
  const cl = close(1.95, 1.95, 2.0); const feed = { closeOf: () => cl, scoreOf: () => null, events: new Map() };
  const bk = new BetBook(e, feed, { anchorMethod: 'multiplicative', closeWithinMin: 10 });
  const ev = { id: 'e1', home: 'H', away: 'A', sport: 'nba', commence: START };
  bk.place('bet_ev', { ...ev, simulated: false }, [{ market: 'h2h', name: 'H', label: 'H ML', book: 'dk', dec: 2.1, stake: 10 }], { kind: 'ev', meta: { anchor: 'pinnacle' } });
  bk.place('bet_ev', { ...ev, simulated: true }, [{ market: 'h2h', name: 'H', label: 'H ML', book: 'dk', dec: 1.9, stake: 10 }], { kind: 'ev', meta: { anchor: 'pinnacle' } });
  bk.settle(START + 1);
  const real = bk.bets.find((b) => !b.simulated); near(real.clvPct, 5); assert.equal(real.beatClose, true); near(real.dCloseFair, 2);
  const sb = bk.scoreboard('bet_ev'); assert.equal(sb.real.n, 1); assert.equal(sb.sim.n, 1); assert.ok(sb.real.mean > 0 && sb.sim.mean < 0, 'never blended');
});
