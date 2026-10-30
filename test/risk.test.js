'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RiskGate } = require('../server/lib/risk');
const D0 = Date.parse('2026-10-29T10:00:00Z'), D1 = Date.parse('2026-10-30T00:30:00Z');

test('open by default', () => {
  const g = new RiskGate({ startEquity: 10000, dailyLossPct: 3, maxDrawdownPct: 10, now: D0 });
  assert.equal(g.update(10000, D0).ok, true);
});

test('daily loss halt trips at limit and clears next UTC day', () => {
  const g = new RiskGate({ startEquity: 10000, dailyLossPct: 3, maxDrawdownPct: 10, now: D0 });
  g.update(9750, D0); assert.equal(g.canOpen().ok, true);
  g.update(9700, D0); assert.equal(g.canOpen().ok, false); assert.match(g.canOpen().reason, /daily loss/);
  g.update(9800, D0); assert.equal(g.canOpen().ok, false, 'stays halted intraday even after partial recovery');
  g.update(9800, D1); assert.equal(g.canOpen().ok, true); assert.equal(g.dayStart, 9800);
});

test('drawdown breaker is measured from peak and latches until manual reset', () => {
  const g = new RiskGate({ startEquity: 10000, dailyLossPct: 50, maxDrawdownPct: 10, now: D0 });
  g.update(12000, D0); assert.equal(g.peak, 12000);
  g.update(10900, D0); assert.equal(g.canOpen().ok, true);  // 9.17% dd
  g.update(10800, D0); assert.equal(g.canOpen().ok, false); // 10% dd
  assert.match(g.canOpen().reason, /drawdown breaker/);
  g.update(11900, D1); assert.equal(g.canOpen().ok, false, 'latched across days');
  g.resetBreaker(); assert.equal(g.canOpen().ok, true); assert.equal(g.peak, 11900);
});

test('manual halt overrides everything; resume clears only manual', () => {
  const g = new RiskGate({ startEquity: 10000, now: D0 });
  g.halt(); assert.deepEqual(g.canOpen(), { ok: false, reason: 'manual halt' });
  g.resume(); assert.equal(g.canOpen().ok, true);
});

test('limit validation', () => {
  const g = new RiskGate({ startEquity: 10000, now: D0 });
  assert.throws(() => g.setLimits({ dailyLossPct: 0 }));
  assert.throws(() => g.setLimits({ maxDrawdownPct: 150 }));
  g.setLimits({ dailyLossPct: 1 }); g.update(9899, D0); assert.equal(g.canOpen().ok, false);
  assert.throws(() => new RiskGate({ startEquity: 0 }));
});
