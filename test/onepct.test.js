'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreSetup, rsi, ema } = require('../server/strategies/one-pct');
const F = require('../server/lib/fees');
const mk = (fn, n = 120) => Array.from({ length: n }, (_, i) => { const c = fn(i), o = fn(i - 1); return { t: i, o, c, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, v: 100 }; });

test('rsi stays within 0..100 and is high on a steady rise', () => {
  const r = rsi(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.ok(r.filter((x) => x != null).every((x) => x >= 0 && x <= 100)); assert.ok(r[59] > 90);
});
test('ema converges to a constant series', () => { assert.ok(Math.abs(ema(new Array(50).fill(5), 10)[49] - 5) < 1e-9); });
test('too few bars never qualifies', () => { assert.equal(scoreSetup(mk((i) => 100 + i, 30)).pass, false); });
test('downtrend fails the trend gate (no forced trade)', () => {
  const s = scoreSetup(mk((i) => 200 - i * 0.5));
  assert.equal(s.pass, false); assert.equal(s.checks.trend, false); assert.match(s.reason, /trend/);
});
test('parabolic move far from EMA20 fails pullback gate', () => {
  const s = scoreSetup(mk((i) => 100 * Math.pow(1.01, i)));
  assert.equal(s.checks.trend, true); assert.equal(s.checks.pullback, false); assert.equal(s.pass, false);
});
test('target embeds fees+slippage so a TP fill nets the 1% target', () => {
  const s = scoreSetup(mk((i) => 100 + i * 0.1), { feeRate: 0.001, slipBps: 3, netTarget: 0.01 });
  const net = F.longRoundTripNet({ entry: s.price, exit: s.target, feeRate: 0.001, slipBps: 3 });
  assert.ok(Math.abs(net - 0.01) < 1e-9, String(net));
});
