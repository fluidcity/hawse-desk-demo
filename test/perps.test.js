'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { momentumSignal, basisEdge } = require('../server/strategies/perps');

const mk = (closes) => closes.map((c, i) => ({ t: i * 300e3, o: c, h: c * 1.001, l: c * 0.999, c, v: 1, closed: true }));

test('momentumSignal: long breakout in an uptrend clears costs', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.05 + Math.sin(i) * 0.3); closes.push(closes.at(-1) + 1.5);
  const s = momentumSignal(mk(closes), { costFrac: 0.0012 });
  assert.strictEqual(s.side, 'long'); assert.ok(s.tp > s.sl);
});

test('momentumSignal: skips inside range, against trend, and when target < 3x cost', () => {
  const flat = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i) * 0.5);
  assert.strictEqual(momentumSignal(mk(flat)).side, null);
  const down = Array.from({ length: 80 }, (_, i) => 120 - i * 0.2); down.push(down.at(-1) + 3);
  const s = momentumSignal(mk(down)); assert.strictEqual(s.side, null);
  const up = Array.from({ length: 80 }, (_, i) => 100 + i * 0.05 + Math.sin(i) * 0.3); up.push(up.at(-1) + 1.5);
  const costly = momentumSignal(mk(up), { costFrac: 0.05 }); assert.strictEqual(costly.side, null); assert.match(costly.reason, /round-trip cost/);
  assert.match(momentumSignal(mk([1, 2, 3])).reason, /not enough/);
});

test('basisEdge: net = basis + funding − 4 fees − 4 slips − exit target', () => {
  const e = basisEdge({ spot: { ask: 100 }, perp: { bid: 100.5 }, spotFee: 0.001, perpFee: 0.0005, slipBps: 1, hourlyFunding: 0.0000125, holdH: 24, convergeTo: 2 });
  assert.ok(Math.abs(e.basisBps - 50) < 1e-6);
  assert.ok(Math.abs(e.costsBps - 34) < 1e-9); // 2*(10+5) + 4
  assert.ok(Math.abs(e.fundingBps - 3) < 1e-9);
  assert.ok(Math.abs(e.netBps - (50 - 2 + 3 - 34)) < 1e-6);
  const neg = basisEdge({ spot: { ask: 100 }, perp: { bid: 99.95 } }); assert.ok(neg.netBps < 0);
});
