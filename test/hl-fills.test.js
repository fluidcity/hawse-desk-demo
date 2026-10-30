'use strict';
// Hyperliquid wallet fills (H3): parsing, order grouping, open/increase/reduce/flip classification, tid diffing,
// the add-date look-ahead guard, and offline wallet scoring. No network (fetch is injected).
const test = require('node:test');
const assert = require('node:assert');
const { parseFill, fillsToSignals, HlFillsFeed } = require('../server/feeds/hl-fills');
const { scoreWallet, buildWatchlist } = require('../server/lib/wallet-score');

const W = '0x' + 'a'.repeat(40);
let tid = 1;
const fill = (o) => ({ coin: 'BTC', px: '50000', sz: '1', side: 'B', time: 1000, startPosition: '0', dir: 'Open Long', closedPnl: '0', fee: '1', hash: '0xh', oid: 1, tid: tid++, ...o });

test('parseFill rejects spot fills and malformed rows', () => {
  assert.strictEqual(parseFill(fill({ coin: '@107' })), null); assert.strictEqual(parseFill(fill({ coin: 'PURR/USDC' })), null);
  assert.strictEqual(parseFill(fill({ px: '0' })), null); assert.strictEqual(parseFill(fill()).side, 'buy');
});

test('fills of one order are grouped; open, increase, reduce and flip are classified', () => {
  const open = fillsToSignals([fill({ sz: '0.6' }), fill({ sz: '0.6', startPosition: '0.6', time: 1001 })], { wallet: W, minUsd: 50000 });
  assert.strictEqual(open.length, 1); assert.strictEqual(open[0].kind, 'open'); assert.strictEqual(open[0].side, 'long'); assert.ok(Math.abs(open[0].usd - 60000) < 1e-6);
  const inc = fillsToSignals([fill({ startPosition: '2', oid: 2 })], { wallet: W }); assert.strictEqual(inc[0].kind, 'increase');
  const red = fillsToSignals([fill({ side: 'A', startPosition: '2', sz: '1.5', oid: 3 })], { wallet: W });
  assert.strictEqual(red.length, 1); assert.strictEqual(red[0].kind, 'reduce'); assert.strictEqual(red[0].side, 'long'); assert.ok(Math.abs(red[0].frac - 0.75) < 1e-9);
  const flip = fillsToSignals([fill({ side: 'A', startPosition: '1', sz: '3', oid: 4 })], { wallet: W });
  assert.deepStrictEqual(flip.map((s) => s.kind + ':' + s.side), ['reduce:long', 'open:short']); assert.strictEqual(flip[0].frac, 1);
  const small = fillsToSignals([fill({ sz: '0.5', oid: 5 })], { wallet: W, minUsd: 50000 }); assert.strictEqual(small.length, 0, '$25k open is below the $50k floor');
});

test('feed diffs by tid and ignores fills before max(start, addedAt)', async () => {
  let now = 10_000; const pages = [];
  const f = new HlFillsFeed({ wallets: [{ addr: W, addedAt: 0 }], minUsd: 1, fetch: async () => pages.shift(), now: () => now });
  const old = fill({ time: 5000, oid: 9 }); pages.push([old]);
  assert.strictEqual((await f.pollNext()).length, 0, 'history before the feed started is never replayed');
  const a = fill({ time: 11_000, oid: 10 }); pages.push([a, old]); now = 12_000;
  const got = await f.pollNext(); assert.strictEqual(got.length, 1); assert.strictEqual(got[0].wallet, W);
  pages.push([a, old]); assert.strictEqual((await f.pollNext()).length, 0, 'same tid twice is not a new signal');
  const g = new HlFillsFeed({ wallets: [{ addr: W, addedAt: 20_000 }], minUsd: 1, fetch: async () => [fill({ time: 15_000, oid: 11 })], now: () => 0 });
  assert.strictEqual((await g.pollNext()).length, 0, 'fills before the wallet add date do not count');
});

test('feed is idle (no calls) without valid wallets', async () => {
  let calls = 0; const f = new HlFillsFeed({ wallets: [{ addr: 'nope' }], fetch: async () => { calls++; return []; } });
  assert.strictEqual(f.mode, 'off'); await f.pollNext(); assert.strictEqual(calls, 0);
});

test('wallet scoring: trade count, lucky-bet share, median hold, PnL/σ, add dates preserved', () => {
  const now = 40 * 864e5, fills = []; let t = now - 25 * 864e5;
  for (let i = 0; i < 24; i++) { // 24 round trips, 2 h each, +$100 each
    fills.push(fill({ time: t, startPosition: '0', oid: 1000 + 2 * i, fee: '0' }));
    fills.push(fill({ time: t + 2 * 3.6e6, side: 'A', startPosition: '1', dir: 'Close Long', closedPnl: '100', oid: 1001 + 2 * i, fee: '0' }));
    t += 864e5;
  }
  const s = scoreWallet(fills, { now }); assert.strictEqual(s.trades, 24); assert.strictEqual(s.realized, 2400); assert.strictEqual(s.medianHoldMin, 120); assert.ok(s.pass, s.why.join());
  const hft = scoreWallet(fills.map((f, i) => (i % 2 ? { ...f, time: fills[i - 1].time + 60e3 } : f)), { now }); assert.ok(!hft.pass); assert.match(hft.why.join(), /median hold/);
  const lucky = scoreWallet([...fills, fill({ time: now - 864e5, startPosition: '1', side: 'A', closedPnl: '5000', oid: 1, fee: '0' })], { now }); assert.match(lucky.why.join(), /largest trade/);
  const wl = buildWatchlist([{ addr: W, ...s }], { wallets: [{ addr: W, addedAt: 123 }] }, { now }); assert.strictEqual(wl.wallets[0].addedAt, 123);
});
