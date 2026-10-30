'use strict';
// miro add-on (H7 Stage J): market-agnostic series lists, display-only pass criteria, rebuilt-index agreement rate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { build } = require('../server/config');
const S = require('../server/kalshi-h2/stats');
const { loadFrozen } = require('../server/kalshi-h2');
const { IndexAgreement, assetOfSeries } = require('../server/recorder/agreement');
const { Recorder } = require('../server/recorder');
const FROZEN = path.join(__dirname, '..', 'config', 'frozen', 'kalshi-h2-v1.json');
const V1 = '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c';
const DAY = 86400e3, WEEK = 7 * DAY;

test('miro (a): Kalshi series lists come from env, defaults are the 4 crypto 15m + sports/daily ones', () => {
  const d = build({}).recorder.kalshi;
  assert.deepEqual(d.series, ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M']);
  assert.deepEqual(d.extraSeries, ['KXNFLGAME', 'KXNBAGAME', 'KXNHLGAME', 'KXBTCD']);
  const e = build({ RECORDER_KALSHI_SERIES: 'KXBTC15M, KXDOGE15M', RECORDER_KALSHI_EXTRA_SERIES: 'KXMLBGAME' }).recorder.kalshi;
  assert.deepEqual(e.series, ['KXBTC15M', 'KXDOGE15M']); assert.deepEqual(e.extraSeries, ['KXMLBGAME']);
});

function mk(cfg, startAt, { weeks, perWeek = 20, win = () => true, yas = 50 }) {
  const signals = [], trades = [];
  for (let w = 0; w < weeks; w++) for (let i = 0; i < perWeek; i++) {
    const at = startAt + w * WEEK + i * 3600e3 + 1000, px = 0.9, ok = win(w, i), fee = S.fee1(px, cfg.fees.rate);
    signals.push({ tk: `T${w}-${i}`, at, ya: px, yas: typeof yas === 'function' ? yas(w, i) : yas });
    trades.push({ tk: `T${w}-${i}`, asset: ['BTC', 'ETH', 'SOL'][i % 3], at, px, fee1: fee, win: ok, pnl1: (ok ? 1 : 0) - px - fee, pnlL: (ok ? 1 : 0) - px - 0.0063, pnlSpec: 0 });
  }
  return { signals, trades };
}
const run = (cfg, startAt, now, x) => S.summarize({ cfg, startAt, now, signals: x.signals, fills: x.trades.length, trades: x.trades, skips: {}, unsettled: 0 });
const by = (st, k) => st.miro.find((m) => m.key === k);

test('miro (b): pass criteria shown as pending / met / not met; frozen config and verdict untouched', () => {
  const before = crypto.createHash('sha256').update(fs.readFileSync(FROZEN)).digest('hex'); assert.equal(before, V1);
  const { cfg } = loadFrozen(); const startAt = Date.parse('2026-11-02T00:00:00Z');
  // early: 2 weeks in, all winning → everything still pending (weeks not yet decided either: 2 of 6 needed)
  let x = mk(cfg, startAt, { weeks: 2 }); let st = run(cfg, startAt, startAt + 2 * WEEK + DAY, x);
  assert.equal(by(st, 'meanNetOneLot').status, 'pending'); assert.equal(by(st, 'positiveWeeks').status, 'pending'); assert.equal(by(st, 'askDepth').status, 'pending');
  assert.equal(by(st, 'positiveWeeks').value, 2); assert.ok(by(st, 'meanNetOneLot').value > 0, 'value shown even while pending');
  // 6 complete positive weeks → that criterion is decided (met) even before 8 weeks; others still pending (not enough data)
  x = mk(cfg, startAt, { weeks: 6 }); st = run(cfg, startAt, startAt + 6 * WEEK + DAY, x); assert.equal(by(st, 'positiveWeeks').status, 'met'); assert.equal(by(st, 'meanNetOneLot').status, 'pending');
  // 3 losing complete weeks → can no longer reach 6 of 8 → not met, early
  x = mk(cfg, startAt, { weeks: 4, win: (w) => w >= 3 }); st = run(cfg, startAt, startAt + 3 * WEEK + DAY, x); assert.equal(by(st, 'positiveWeeks').status, 'not met');
  // a complete week with NO trades counts as not positive
  x = mk(cfg, startAt, { weeks: 1 }); st = run(cfg, startAt, startAt + 4 * WEEK, x); assert.equal(by(st, 'positiveWeeks').value, 1); assert.equal(by(st, 'positiveWeeks').status, 'not met');
  // full run (8 weeks, 2560 signals): mean > 0 met; ask depth decided by share of signals with best-ask size >= 10
  x = mk(cfg, startAt, { weeks: 8, perWeek: 320, yas: (w, i) => (i % 10 < 7 ? 50 : 3) }); st = run(cfg, startAt, startAt + 8 * WEEK + DAY, x);
  assert.equal(st.enough, true); assert.equal(by(st, 'meanNetOneLot').status, 'met'); assert.equal(by(st, 'positiveWeeks').status, 'met');
  assert.equal(by(st, 'askDepth').value, 0.7); assert.equal(by(st, 'askDepth').status, 'not met');
  assert.equal(st.criteria.askDepth, false, 'existing frozen-criteria verdict path agrees');
  x = mk(cfg, startAt, { weeks: 8, perWeek: 320, win: (w, i) => i % 10 !== 0 }); st = run(cfg, startAt, startAt + 8 * WEEK + DAY, x);
  assert.equal(by(st, 'meanNetOneLot').status, 'not met'); assert.equal(by(st, 'askDepth').status, 'met');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(FROZEN)).digest('hex'), V1, 'frozen v1 file unchanged');
});

test('miro (c): agreement rate of the rebuilt index vs official 15m outcomes', () => {
  const rows = []; const A = new IndexAgreement({ store: { write: (s, r) => rows.push([s, r]) }, cfg: { minSettled: 3 } });
  assert.equal(assetOfSeries('KXBTC15M'), 'BTC'); assert.equal(assetOfSeries('KXBTCD'), null);
  const close = Date.parse('2026-10-30T22:00:00Z');
  // 1 s samples: price 100 for the last 60 s before close (and a spike AFTER close that must be ignored)
  for (let t = close - 70000; t < close + 5000; t += 1000) A.onRef({ asset: 'BTC', med: t >= close ? 999 : 100 }, t);
  let out = A.onSettle({ tk: 'KXBTC15M-A', s: 'KXBTC15M', result: 'yes', strike: 99.5, value: 100.01, close });
  assert.equal(out[0].agree, true); assert.equal(out[0].n, 60); assert.equal(out[0].avg, 100); assert.ok(Math.abs(out[0].diffBps + 1) < 0.01);
  assert.equal(A.onSettle({ tk: 'KXBTC15M-A', s: 'KXBTC15M', result: 'yes', strike: 99.5, close }), null, 'each market counted once');
  out = A.onSettle({ tk: 'KXBTC15M-B', s: 'KXBTC15M', result: 'yes', strike: 100.5, value: 100.6, close }); assert.equal(out[0].agree, false); assert.equal(out[0].ours, 'no');
  // poor coverage → insufficient, not counted either way
  out = A.onSettle({ tk: 'KXETH15M-C', s: 'KXETH15M', result: 'no', strike: 1, close }); assert.equal(out[0].status, 'insufficient');
  // non-crypto / non-15m settles ignored
  assert.equal(A.onSettle({ tk: 'KXNFLGAME-X', s: 'KXNFLGAME', result: 'yes', strike: 1, close }), null);
  let v = A.view().sources.ref; assert.equal(v.compared, 2); assert.equal(v.agree, 1); assert.equal(v.insufficient, 1); assert.equal(v.status, 'pending');
  A.onSettle({ tk: 'KXBTC15M-D', s: 'KXBTC15M', result: 'no', strike: 101, close }); v = A.view().sources.ref;
  assert.equal(v.compared, 3); assert.equal(v.status, 'not met', '2/3 < 99.5% once minSettled reached'); assert.ok(v.ci95.lo < v.rate);
  // optional CF feed source appears only when sampled
  assert.equal(A.view().sources.cf, undefined); for (let t = close - 60000; t < close; t += 1000) A.onCf({ id: 'BRTI', v: 100 }, t);
  out = A.onSettle({ tk: 'KXBTC15M-E', s: 'KXBTC15M', result: 'yes', strike: 99, close }); assert.deepEqual(out.map((r) => [r.src, r.agree]), [['ref', true], ['cf', true]]);
  assert.ok(rows.every(([s]) => s === 'agree'));
});

test('miro (c): recorder hub wires ref ticks and Kalshi settle rows into the agreement view', () => {
  const H = { register() {}, ok() {}, fail() {} }; const store = { write() {}, view: () => ({}), start() {} };
  const ref = { listeners: [], start() {}, stop() {}, view: () => ({}), watchSpec: () => [] };
  const ls = {}; const kalshi = { on: (k, f) => (ls[k] = f), start() {}, stop() {}, view: () => ({}), watchSpec: () => [] };
  const r = new Recorder({ health: H, cfg: { dir: '/tmp/x', capBytes: 1, maxFileBytes: 1, rotateMs: 1, ref: { enabled: true }, kalshi: { enabled: true }, agree: { minSettled: 1 } }, deps: { store, ref, kalshi } });
  const close = 1793400000000; for (let t = close - 60000; t < close; t += 1000) ref.listeners[0]({ asset: 'SOL', med: 200 }, t);
  ls.settle({ tk: 'KXSOL15M-Z', s: 'KXSOL15M', result: 'yes', strike: 199, close });
  const a = r.agree.view().sources.ref; assert.equal(a.agree, 1); assert.equal(a.status, 'met');
});

test('miro (c): RefPriceRecorder.tick feeds its 1 s median rows to listeners', () => {
  const { RefPriceRecorder } = require('../server/recorder/refprice');
  const H = { register() {}, ok() {}, fail() {} }; let t = 1793400000000; const got = [];
  const r = new RefPriceRecorder({ store: { write() {} }, health: H, cfg: { venues: [] }, now: () => t });
  r.listeners.push((row, at) => got.push([row.asset, row.med, at]));
  r.take('coinbase', [{ asset: 'BTC', px: 100 }]); r.take('kraken', [{ asset: 'BTC', px: 102 }]); r.tick();
  assert.deepEqual(got, [['BTC', 101, t]]);
});
