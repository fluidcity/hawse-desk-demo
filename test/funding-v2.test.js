'use strict';
// Funding carry v2 (batch-1 H2): persistence, predicted funding, APR/basis gates, 2-print flip, basis stop, stale force-close,
// carry mode, cross-strategy exclusivity, naive-v1 shadow control, scoreboard verdicts, and the new parsers. No network.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../server/config');
const { Engine } = require('../server/engine');
const { rec, parsePredicted, topByOi } = require('../server/feeds/funding');
const { parseBinanceSpot, parseOkxSpot, parseBybitSpot } = require('../server/feeds/spot');
const S = require('../server/strategies/funding-score');

const MIN = 60e3, H = 3600e3;
function mk(env = {}) {
  const cfg = config.build({ CARRY_ENABLED: 'false', FUNDING_HL_TOP_OI: '0', FUNDING_SYMBOLS: 'BTC', ...env }); cfg.funding.scoreFile = null;
  const e = new Engine(cfg); const s = e.strategy('funding'); return { e, s, f: e.feeds.funding };
}
// lo = cheap (long) venue, hi = rich (short) venue; hourly rates; marks optionally offset (bps on hi)
function rows(f, { lo = -0.0001, hi = 0.0003, px = 50000, hiBps = 2, sym = 'BTC' } = {}) {
  f.data.clear();
  f.put([rec('okx', sym, { rate: lo, intervalH: 1, nextFundingTime: Date.now() + H, mark: px, bid: px - 0.5, ask: px + 0.5 }),
    rec('hyperliquid', sym, { rate: hi, intervalH: 1, nextFundingTime: Date.now() + H, mark: px * (1 + hiBps / 1e4), bid: px * (1 + hiBps / 1e4) - 0.5, ask: px * (1 + hiBps / 1e4) + 0.5 })]);
}
function observe(s, n, t0 = Date.now()) { for (let i = 0; i < n; i++) { s.lastObs = 0; s.sample(t0 + i); } }

test('pure helpers: persistence/flip counts, APR on gross notional, liquidity cap, signed basis', () => {
  assert.strictEqual(S.persistCount([1, -1, 2, 3, 4]), 3); assert.strictEqual(S.persistCount([1, 2, -1]), 0);
  assert.strictEqual(S.flipCount([1, 0, -2]), 2); assert.strictEqual(S.persistOk([1, 1], 3), false);
  assert.strictEqual(S.predictedOk(null), false); assert.strictEqual(S.predictedOk(-1e-6), false); assert.strictEqual(S.predictedOk(1e-6), true);
  // $10 net on $1000/leg over 24h = 10/2000 × 365 = 182.5% APR on gross notional
  assert.ok(Math.abs(S.netAprPct({ net: 10, notional: 1000, holdH: 24 }) - 182.5) < 1e-9);
  assert.strictEqual(S.liquidityCap(10000, [{ dayNtlVlm: 1e7 }, {}]), 2500); // 1e7 × 0.0005 / 2
  assert.strictEqual(S.liquidityCap(1000, [{ dayNtlVlm: 1e9 }]), 1000);
  assert.ok(S.signedBasisBps(100.1, 100) > 9.9 && S.signedBasisBps(100, 100.1) < 0);
});

test('parsers: predictedFundings (incl. null venues), top-N by OI, spot books', () => {
  const resp = [['BTC', [['BinPerp', { fundingRate: '0.00008', nextFundingTime: 1, fundingIntervalHours: 8 }], ['HlPerp', { fundingRate: '0.0000125', nextFundingTime: 2, fundingIntervalHours: 1 }], ['BybitPerp', null]]], ['DOGE', [['HlPerp', { fundingRate: 'x' }]]], ['ZZZ', []]];
  const p = parsePredicted(resp, ['BTC', 'DOGE']);
  assert.deepStrictEqual(p.map((r) => r.venue), ['binance', 'hyperliquid']);
  assert.ok(Math.abs(p[0].hourly - 0.00001) < 1e-12);
  const meta = [{ universe: [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }, { name: 'ETH' }, { name: 'kPEPE' }] }, [{ openInterest: '10', markPx: '50000' }, { openInterest: '1e9', markPx: '1' }, { openInterest: '100', markPx: '3000' }, { openInterest: '1e12', markPx: '1' }]];
  assert.deepStrictEqual(topByOi(meta, 2), ['BTC', 'ETH']); // $500k vs $300k OI; delisted and non-plain names skipped
  assert.deepStrictEqual(parseBinanceSpot([{ symbol: 'BTCUSDT', bidPrice: '100', askPrice: '100.2' }], ['BTC', 'ETH']).map((r) => r.venue + r.symbol), ['binanceBTC']);
  assert.strictEqual(parseOkxSpot({ data: [{ instId: 'ETH-USDT', bidPx: '10', askPx: '9' }] }, ['ETH']).length, 0, 'crossed book rejected');
  const by = parseBybitSpot({ result: { list: [{ symbol: 'SOLUSDT', bid1Price: '150', ask1Price: '150.3' }] } }, ['SOL'])[0];
  assert.ok(by.mid === 150.15 && by.halfSpreadBps > 0 && by.transport === 'rest');
});

test('persistence: a qualifying spread needs 3 consecutive positive observations before it qualifies', () => {
  const { s, f } = mk(); rows(f);
  const n = 10000;
  observe(s, 2); let b = s.evaluate('BTC', n);
  assert.strictEqual(b.ok, false); assert.match(b.reason, /persistence 2\/3/);
  assert.strictEqual(b.v1.ok, true, 'naive v1 would already trade this one-off');
  observe(s, 1); b = s.evaluate('BTC', n);
  assert.strictEqual(b.ok, true, b.reason); assert.strictEqual(b.long.venue, 'okx'); assert.strictEqual(b.short.venue, 'hyperliquid');
  assert.ok(b.aprPct >= 10 && b.edge.netBps >= 8);
  // a negative observation in the middle resets the count
  s.series.set(s.pairKey('BTC', 'okx', 'hyperliquid'), [1, 1, -1, 1, 1]); assert.match(s.evaluate('BTC', n).reason, /persistence 2\/3/);
});

test('predicted funding gate, APR gate and entry-basis gate', () => {
  const { s, f } = mk(); rows(f); observe(s, 3);
  f.pred.set('hyperliquid|BTC', { venue: 'hyperliquid', symbol: 'BTC', hourly: -0.0002, ts: Date.now() });
  let b = s.evaluate('BTC', 10000); assert.strictEqual(b.ok, false); assert.match(b.reason, /predicted next spread/);
  f.pred.clear();
  const hiApr = mk({ FUNDING_MIN_APR: '100000' }); rows(hiApr.f); observe(hiApr.s, 3);
  assert.match(hiApr.s.evaluate('BTC', 10000).reason, /net APR .* < 100000%/);
  rows(f, { hiBps: 30 }); observe(s, 3);
  b = s.evaluate('BTC', 10000); assert.strictEqual(b.ok, false); assert.match(b.reason, /entry basis .* > 15bps/);
});

test('open, then 2-print flip exit (one flip is not enough) and scoreboard record', () => {
  const { s, f } = mk(); rows(f); observe(s, 3); s.arm(true);
  s.tick(Date.now()); assert.strictEqual(s.positions.length, 1); const p = s.positions[0];
  assert.strictEqual(p.mode, 'perp-perp'); assert.strictEqual(p.persistCount, 3); assert.ok(p.expectedNetBps > 0);
  rows(f, { lo: 0.0003, hi: -0.0001 }); // spread flips
  f.pred.set('hyperliquid|BTC', { venue: 'hyperliquid', symbol: 'BTC', hourly: 0.001, ts: Date.now() }); // forecast still positive, isolate the flip rule
  s.lastObs = 0; s.sample(Date.now()); s.manage(Date.now());
  assert.strictEqual(s.positions.length, 1, 'one flipped observation does not exit');
  s.lastObs = 0; s.sample(Date.now()); s.manage(Date.now());
  assert.strictEqual(s.positions.length, 0); const r = s.closedLog[0];
  assert.match(r.why, /flipped on 2 consecutive/); assert.strictEqual(r.mode, 'perp-perp');
  assert.ok(typeof r.realizedNetBps === 'number' && typeof r.expected === 'number');
  const v = s.view(); assert.strictEqual(v.score.booked.n, 1); assert.strictEqual(v.score.booked.verdict, 'collecting');
});

test('basis stop closes when the price gap moves > 40 bps against the pair, and is counted as a stop', () => {
  const { s, f } = mk(); rows(f); observe(s, 3); s.arm(true); s.tick(Date.now());
  assert.strictEqual(s.positions.length, 1);
  rows(f, { hiBps: 50 }); s.manage(Date.now());
  assert.strictEqual(s.positions.length, 0); assert.match(s.closedLog[0].why, /basis stop/); assert.strictEqual(s.closedLog[0].byStop, true);
});

test('stale leg for > 30 min forces a paper close at the last mark with 2x slippage', () => {
  const { s, f } = mk(); rows(f); observe(s, 3); s.arm(true); s.tick(Date.now());
  const p = s.positions[0]; f.get('hyperliquid', 'BTC').ts = Date.now() - 11 * MIN;
  s.manage(Date.now()); assert.strictEqual(s.positions.length, 1); assert.strictEqual(p.stale, true);
  p.staleSince = Date.now() - 31 * MIN; s.manage(Date.now());
  assert.strictEqual(s.positions.length, 0); assert.match(s.closedLog[0].why, /forced paper close .* 2× slippage/);
});

test('carry mode: long spot + short perp on one venue, exclusive per symbol with Perp Basis', () => {
  const { e, s, f } = mk({ CARRY_ENABLED: 'true' });
  f.data.clear(); f.put([rec('okx', 'BTC', { rate: 0.0002, intervalH: 1, nextFundingTime: Date.now() + H, mark: 50010, bid: 50009.5, ask: 50010.5 })]);
  const spot = { venue: 'okx', symbol: 'BTC', bid: 49999.5, ask: 50000.5, mid: 50000, halfSpreadBps: 0.1, ts: Date.now() };
  e.spotQuote = (sym, v) => (sym === 'BTC' && v === 'okx' ? spot : null);
  observe(s, 3);
  const c = s.evaluateCarry('BTC', 10000);
  assert.strictEqual(c.mode, 'carry'); assert.strictEqual(c.ok, true, c.reason); assert.ok(c.edge.netBps >= 15);
  // exclusivity: another carry-style strategy holding BTC blocks entry
  e.strategies.push({ id: 'basis', positions: [{ symbol: 'BTC' }], tick() {} });
  s.arm(true); s.tick(Date.now()); assert.strictEqual(s.positions.length, 0);
  assert.match(s.lastSkip.reason, /no pair clears/);
  e.strategies.pop(); s.lastEval = 0; s.tick(Date.now());
  assert.strictEqual(s.positions.length, 1); const p = s.positions[0];
  assert.strictEqual(p.mode, 'carry'); assert.deepStrictEqual(p.legs.map((l) => l.kind + ':' + l.side), ['spot:long', 'perp:short']);
  assert.strictEqual(e.symbolHeld('BTC', 'basis'), true, 'Perp Basis now sees BTC as held');
  // persistence gate also applies to carry
  const { e: e2, s: s2, f: f2 } = mk({ CARRY_ENABLED: 'true' }); f2.put([rec('okx', 'BTC', { rate: 0.0002, intervalH: 1, mark: 50010 })]); e2.spotQuote = () => spot;
  observe(s2, 1); assert.match(s2.evaluateCarry('BTC', 10000).reason, /persistence 1\/3/);
});

test('naive-v1 shadow trades the unpersisted spike, v2 shadow does not; neither is booked', () => {
  const { e, s, f } = mk(); rows(f); observe(s, 1);
  s.tick(Date.now());
  assert.strictEqual(s.shadow.v1.positions.length, 1); assert.strictEqual(s.shadow.v2.positions.length, 0);
  assert.strictEqual(s.positions.length, 0, 'not armed: nothing booked');
  assert.strictEqual(e.ledger.book('funding').real.realized, 0);
  rows(f, { lo: 0.0003, hi: -0.0001 }); s.lastEval = 0; s.tick(Date.now() + 1000);
  assert.strictEqual(s.shadow.v1.closed.length, 1); assert.match(s.shadow.v1.closed[0].why, /1 print/);
  assert.strictEqual(s.view().score.shadowV1.n, 1);
});

test('scoreboard verdicts follow the H2 paper-test plan', () => {
  const now = Date.now(), d = 24 * H;
  const mkRec = (i, realized, expected, extra = {}) => ({ openedAt: now - 22 * d + i * H, closedAt: now - 22 * d + i * H + 24 * H, notional: 10000, realized, expected, realizedNetBps: realized, expectedNetBps: expected, byStop: false, ...extra });
  const good = Array.from({ length: 30 }, (_, i) => mkRec(i, 8, 10));
  const m = S.summarize(good, { sleeve: 100000, now });
  assert.strictEqual(m.verdict, 'pass', JSON.stringify(m)); assert.ok(Math.abs(m.ratio - 0.8) < 1e-9);
  assert.strictEqual(S.summarize(good.slice(0, 29), { sleeve: 100000, now }).verdict, 'collecting');
  assert.strictEqual(S.summarize(good.map((x) => ({ ...x, realized: 2 })), { sleeve: 100000, now }).verdict, 'fail');
  const bigLoss = [...good.slice(1), mkRec(40, -600, 10, { byStop: true })];
  const b = S.summarize(bigLoss, { sleeve: 100000, now });
  assert.ok(b.worstLossPct > 0.5); assert.notStrictEqual(b.verdict, 'pass'); assert.ok(b.stopPct > 0);
});

test('explainer documents the v2 gates from the same config the logic reads', () => {
  const { s } = mk({ FUNDING_PERSIST_PRINTS: '4', FUNDING_BASIS_STOP_BPS: '55' });
  const txt = JSON.stringify(s.explain());
  assert.match(txt, /last 4 in a row/); assert.match(txt, /more than 55 bp against/); assert.match(txt, /naive-v1 shadow/);
});

test('predicted-negative exit: a forecast flip closes the pair before the realized spread flips', () => {
  const { s, f } = mk(); rows(f); observe(s, 3); s.arm(true); s.tick(Date.now()); assert.strictEqual(s.positions.length, 1);
  f.pred.set('hyperliquid|BTC', { venue: 'hyperliquid', symbol: 'BTC', hourly: -0.0005, ts: Date.now() });
  s.manage(Date.now()); assert.strictEqual(s.positions.length, 0); assert.match(s.closedLog[0].why, /predicted next funding spread negative/);
});
