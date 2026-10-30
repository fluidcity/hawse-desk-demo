'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { solMatrix, midMatrix, pairWethPx, EVM_TOKENS } = require('../server/feeds/dex');
const { GapScanner, evaluate } = require('../server/strategies/gaps');
const { Ledger } = require('../server/lib/ledger');

test('solMatrix: buy-on-i / sell-on-j in bps, null-safe', () => {
  const m = solMatrix([10, 10.01, null], [100, 99.9, 100.1], 1000);
  assert.ok(Math.abs(m[0][0] - 0) < 1e-9);
  assert.ok(Math.abs(m[1][2] - ((10.01 * 100.1 - 1000) / 1000) * 1e4) < 1e-9);
  assert.equal(m[2][0], null);
});

test('midMatrix and pairWethPx orientation', () => {
  const m = midMatrix([100, 101]); assert.ok(Math.abs(m[0][1] - 100) < 1e-9); assert.ok(m[1][0] < 0);
  const t = EVM_TOKENS.base;
  assert.equal(pairWethPx({ baseToken: { address: t.weth }, quoteToken: { address: t.usdc }, priceNative: '2000' }, t), 2000);
  assert.equal(pairWethPx({ baseToken: { address: t.usdc }, quoteToken: { address: t.weth }, priceNative: '0.0005' }, t), 2000);
  assert.equal(pairWethPx({ baseToken: { address: t.weth }, quoteToken: { address: '0xdead' }, priceNative: '1' }, t), null);
});

test('evaluate: failure probability makes small gross gaps negative EV; indicative rows never ok', () => {
  const a = evaluate({ label: 'x', grossUsd: 0.5, execCostUsd: 0.4, tipUsd: 0.05, pSuccess: 0.35, notional: 1000, exec: true, minEvUsd: 0 });
  assert.ok(a.evUsd < 0 && !a.ok);
  const b = evaluate({ label: 'y', grossUsd: 20, execCostUsd: 0.4, tipUsd: 0.05, pSuccess: 0.35, notional: 1000, exec: false, minEvUsd: 0 });
  assert.ok(b.evUsd > 0 && !b.ok, 'indicative (mid-price) gaps are never tradable');
});

function fakeEngine(feed) {
  const ledger = new Ledger({ startEquity: 10000 }); const tape = []; 
  return { ledger, cfg: { paperStartEquity: 10000, gaps: { notionalUsd: 1000, pSuccess: 0.5, solTipLamports: 100000, solPriorityMicroLamports: 50000, evmGasUnits: 180000, evmPoolFeeBps: 5, minEvUsd: 0.5 } },
    price: (s) => (s === 'SOL' ? 100 : 2000), canOpen: () => ({ ok: true }),
    tape: { push: (x) => tape.push(x), skip: (id, r) => tape.push({ kind: 'skip', r }), skipCounts: () => ({}) }, _tape: tape };
}
const solFeed = (buy) => ({ chains: [], evm: {}, gas: {}, para: {}, sol: { mode: 'live', labels: ['A', 'B'], bps: solMatrix([10, buy], [100, 100], 1000), notional: 1000, tri: null } });

test('GapScanner: no gap -> logs skip, books nothing', () => {
  const e = fakeEngine(); const s = new GapScanner(e, solFeed(10)); s.arm(true);
  s.tick(1e6); s.tick(1e6 + 6000);
  assert.equal(e.ledger.book('gaps').real.trades, 0);
  assert.ok(e._tape.some((x) => x.kind === 'skip'));
});

test('GapScanner: real gap must persist 2 scans; failed landing books the fee loss', () => {
  const e = fakeEngine(); const s = new GapScanner(e, solFeed(10.05), { rng: () => 0.99 }); s.arm(true);
  s.tick(1e6); assert.equal(e.ledger.book('gaps').real.trades, 0, 'first sighting is not traded');
  s.tick(1e6 + 6000); const b = e.ledger.book('gaps').real;
  assert.equal(b.trades, 1); assert.ok(b.realized < 0, 'failed attempt still pays fees');
});

test('GapScanner: landed attempt books gross minus all costs', () => {
  const e = fakeEngine(); const s = new GapScanner(e, solFeed(10.05), { rng: () => 0 }); s.arm(true);
  s.tick(1e6); s.tick(1e6 + 6000); const b = e.ledger.book('gaps').real;
  assert.ok(b.realized > 0 && b.realized < 5, 'net < gross $5 after costs');
  assert.equal(e.ledger.book('gaps').sim.trades, 0);
});
