'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { frontMonth, etSessionMinute, TradovateFeed } = require('../server/feeds/tradovate');
const { OpeningRangeBreakout, openingRange, breakout } = require('../server/strategies/orb');
const { Ledger } = require('../server/lib/ledger');
const { Health } = require('../server/lib/health');
const F = require('../server/lib/fees');

test('frontMonth rolls 8 days before the third-Friday expiry', () => {
  assert.equal(frontMonth('MES', Date.UTC(2026, 9, 29)), 'MESZ6');
  assert.equal(frontMonth('MNQ', Date.UTC(2026, 11, 14)), 'MNQH7'); // Dec 18 2026 expiry, roll Dec 10
  assert.equal(frontMonth('MES', Date.UTC(2027, 0, 5)), 'MESH7');
});

test('etSessionMinute: 09:30 ET = 0 (EDT and EST)', () => {
  assert.equal(etSessionMinute(Date.UTC(2026, 6, 1, 13, 30)).min, 0);
  assert.equal(etSessionMinute(Date.UTC(2026, 11, 1, 14, 45)).min, 15);
});

test('openingRange needs the full OR and one bar after it; breakout on close', () => {
  const bars = Array.from({ length: 15 }, (_, m) => ({ m, h: 101 + (m === 3 ? 1 : 0), l: 99, c: 100 }));
  assert.equal(openingRange(bars, 15), null);
  bars.push({ m: 15, h: 103, l: 100, c: 102.5 });
  const or = openingRange(bars, 15); assert.deepEqual(or, { high: 102, low: 99 });
  assert.equal(breakout(bars[15], or), 'long'); assert.equal(breakout({ c: 98 }, or), 'short'); assert.equal(breakout({ c: 100 }, or), null);
});

test('futuresRoundTrip MES: 1 tick slip each side + fee per side', () => {
  const r = F.futuresRoundTrip({ side: 'long', entry: 6800, exit: 6810, contracts: 1, pointValue: 5, tickSize: 0.25, slipTicks: 1, feePerSide: 0.72 });
  assert.equal(r.gross, 50); assert.equal(r.slippage, 2.5); assert.ok(Math.abs(r.net - (50 - 2.5 - 1.44)) < 1e-9);
});

function harness() {
  const ledger = new Ledger({ startEquity: 10000 }); const tape = [];
  const e = { ledger, cfg: { paperStartEquity: 10000, orb: { minutes: 15, targetR: 1.5, feePerSide: 0.72, maxRiskPct: 8, minWidthPct: 0.01, maxWidthPct: 5, lastEntryMinute: 240, flatMinute: 385 } },
    canOpen: () => ({ ok: true }), tape: { push: (x) => tape.push(x), skip: (id, r) => tape.push({ kind: 'skip', r }), skipCounts: () => ({}) } };
  const feed = new TradovateFeed({ health: new Health(), cfg: { configured: false, simBarMs: 1000 } });
  feed.data.MNQ.bars = []; // only exercise MES
  return { e, feed, tape };
}

test('unconfigured Tradovate → SIMULATED mode, trades book only to the SIM book', () => {
  const { e, feed } = harness(); assert.equal(feed.mode, 'sim');
  const s = new OpeningRangeBreakout(e, feed); s.arm(true); assert.equal(s.dataMode(), 'sim');
  const d = feed.data.MES; d.sessionId = 1;
  for (let m = 0; m < 15; m++) d.bars.push({ t: m, m, o: 6800, h: 6804, l: 6796, c: 6800 });
  d.bars.push({ t: 15, m: 15, o: 6800, h: 6806, l: 6800, c: 6805 }); d.last = 6805; s.tick(1);
  assert.equal(s.positions.length, 1); const p = s.positions[0];
  assert.equal(p.side, 'long'); assert.equal(p.stop, 6796); assert.ok(Math.abs(p.target - (6805 + 1.5 * 9)) < 1e-9); assert.ok(p.simulated);
  d.bars.push({ t: 16, m: 16, o: 6805, h: 6830, l: 6804, c: 6825 }); s.tick(2);
  assert.equal(s.positions.length, 0);
  const b = e.ledger.book('orb'); assert.equal(b.real.trades, 0); assert.equal(b.sim.trades, 1);
  const expect = F.futuresRoundTrip({ side: 'long', entry: 6805, exit: 6818.5, contracts: p.qty, pointValue: 5, tickSize: 0.25, slipTicks: 1, feePerSide: 0.72 }).net;
  assert.ok(Math.abs(b.sim.realized - expect) < 1e-9, 'sim realized equals net of fees and slippage');
});

test('stop and target in the same bar → stop assumed', () => {
  const { e, feed } = harness(); const s = new OpeningRangeBreakout(e, feed); s.arm(true);
  const d = feed.data.MES; d.sessionId = 1;
  for (let m = 0; m < 15; m++) d.bars.push({ t: m, m, o: 6800, h: 6804, l: 6796, c: 6800 });
  d.bars.push({ t: 15, m: 15, o: 6800, h: 6806, l: 6800, c: 6805 }); s.tick(1);
  d.bars.push({ t: 16, m: 16, o: 6805, h: 6830, l: 6790, c: 6810 }); s.tick(2);
  assert.ok(e.ledger.book('orb').sim.realized < 0);
});

test('no order path exists in the Tradovate module', () => {
  const src = require('fs').readFileSync(require.resolve('../server/feeds/tradovate.js'), 'utf8');
  assert.ok(!/order\/place|placeOrder|startorderstrategy|placeOSO/i.test(src));
});
