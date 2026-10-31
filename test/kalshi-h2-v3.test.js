'use strict';
// Kalshi H2 v3 arm (config/frozen/kalshi-h2-v3.json): v2 decisions + paper size caps. PAPER ONLY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { KalshiH2Paper, loadFrozen, FROZEN, DEFAULT_FILE } = require('../server/kalshi-h2');
const { KalshiH2V2, V2_FILE } = require('../server/kalshi-h2/v2');
const { KalshiH2V3, sizeOrder, fillLadder, feeOrder, depthAt, askLadderOf, refillSeries, V3_FILE } = require('../server/kalshi-h2/v3');

// Pinned SEPARATELY from the code: editing any frozen file (or a pin in the code) breaks this test.
const V3_SHA256 = '5498e1cbea6c45e427876dd2971f041421ef18ad06c103dc7921898f5179ce1c';
const V2_SHA256 = 'ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c';
const V1_SHA256 = '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2v3-'));
function fakeKalshi() { const L = { book: [], settle: [], market: [], series: [], trade: [] }; return { L, tracked: [], on(k, f) { L[k].push(f); }, track(m) { this.tracked.push(m.ticker); }, emit(k, x) { for (const f of L[k]) f(x); } }; }
const CLOSE = Date.parse('2026-11-02T16:00:00Z'), OPEN = CLOSE - 900e3;
function rig({ dir = tmp(), recorderDir = null, file = V3_FILE, pins = FROZEN, v3 = true } = {}) {
  let t = Date.parse('2026-11-02T15:44:00Z'); const clock = { now: () => t, set: (x) => (t = x) };
  const k = fakeKalshi(); const h = new KalshiH2Paper({ kalshi: k, dir, now: clock.now }); h.start(); h.stop(); h.running = true;
  const a = new KalshiH2V2({ v1: h, kalshi: k, dir, recorderDir, now: clock.now }); a.start(); a.stop(); a.running = true;
  let b = null; if (v3) { b = new KalshiH2V3({ v1: h, v2: a, kalshi: k, dir, recorderDir, file, pins, now: clock.now }); b.start(); b.stop(); if (b.cfg) b.running = true; }
  return { dir, k, h, a, b, clock };
}
const DEF = (ya) => [[ya, 50], [Math.min(0.999, ya + 0.004), 100]];
function book(r, tk, secLeft, ya, series = 'KXBTC15M', ladder = null, close = CLOSE) {
  r.clock.set(close - secLeft * 1000);
  const L = ya == null ? [] : ladder || DEF(ya);
  r.k.emit('book', { tk, series, rx: r.clock.now(), sent: r.clock.now() - 50, close, open: close - 900e3, secLeft, strike: 1, ya, yas: L.length ? L[0][1] : null, yb: ya == null ? null : ya - 0.01, ybs: 10, askLadder: L });
}
// earlier minutes, then books every second from 605 s; signal at 580 s (ya 0.95); v1 fills on the 579 s book
function market(r, tk, earlier, { series = 'KXBTC15M', vol = 0, sigLadder = null, fillLadder: fl = null, refill = null, close = CLOSE } = {}) {
  [890, 830, 770, 710, 650].forEach((s, i) => { if (earlier[i] !== undefined) book(r, tk, s, earlier[i], series, null, close); });
  for (let s = 605; s > 580; s--) book(r, tk, s, s > 600 ? earlier[4] : 0.9, series, null, close);
  if (vol) r.k.emit('trade', { tk, id: tk + '-t1', ex: close - 600e3, c: vol, s: series }); // inside the 60 s before the signal (580 s left)
  r.k.emit('trade', { tk, id: tk + '-old', ex: close - 700e3, c: 99999, s: series }); // outside the window: never counted
  book(r, tk, 580, 0.95, series, sigLadder, close); book(r, tk, 579, 0.95, series, fl, close);
  if (refill) for (let s = 575; s >= 515; s -= 5) book(r, tk, s, 0.95, series, refill, close);
}
const ledger = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const L3 = (dir, line = null) => ledger(path.join(dir, 'v3', ...(line ? [line] : []), 'ledger.jsonl'));
const settle = (r, tk, result, close = CLOSE) => r.k.emit('settle', { tk, result, status: 'finalized', settledAt: close + 60e3 });

test('frozen v3 config: hash pinned in the test AND the code; v1/v2 files and pins unchanged; paper-only; spec values', () => {
  assert.equal(sha(V3_FILE), V3_SHA256, 'config/frozen/kalshi-h2-v3.json was edited after the freeze: make a new version instead');
  assert.equal(sha(DEFAULT_FILE), V1_SHA256, 'v1 file unchanged'); assert.equal(sha(V2_FILE), V2_SHA256, 'v2 file unchanged');
  assert.deepEqual([FROZEN['kalshi-h2-v1'], FROZEN['kalshi-h2-v2'], FROZEN['kalshi-h2-v3']], [V1_SHA256, V2_SHA256, V3_SHA256]);
  const { cfg } = loadFrozen(V3_FILE);
  assert.equal(cfg.mode, 'paper-only'); assert.equal(cfg.liveOrders, false); assert.equal(cfg.version, 'v3');
  assert.equal(cfg.base.v1.sha256, V1_SHA256); assert.equal(cfg.base.v2.sha256, V2_SHA256);
  assert.deepEqual(cfg.sizing.lines.map((l) => [l.id, l.pctOfBalance, l.startBalance]), [['3pct', 0.03, 10000], ['7pct', 0.07, 10000]]);
  assert.deepEqual(cfg.sizing.perAssetDollarCap, { BTC: 5000, ETH: 400, SOL: 250, XRP: 250 }); assert.equal(cfg.sizing.overallDollarCap, null);
  assert.equal(cfg.sizing.participation.share, 0.1); assert.equal(cfg.sizing.participation.windowMs, 60000);
  const p2 = loadFrozen(V2_FILE).cfg.pass; assert.deepEqual([cfg.pass.minV1Signals, cfg.pass.alpha, cfg.pass.keptMeanNetGtCents], [p2.minV1Signals, p2.alpha, p2.keptMeanNetGtCents]);
  assert.equal(cfg.pass.firstLookOnly, true);
});

test('loader refusals: an edited v3 copy; v3 without v2 / with a wrong v2 hash; v1 and v2 never run the v3 file', () => {
  const d = tmp(), f = path.join(d, 'kalshi-h2-v3.json'); fs.writeFileSync(f, fs.readFileSync(V3_FILE, 'utf8').replace('"BTC": 5000', '"BTC": 50000'));
  assert.throws(() => loadFrozen(f), /edited after the freeze/);
  const r = rig({ v3: false });
  const a = new KalshiH2V3({ v1: r.h, v2: r.a, dir: path.join(d, 'l1'), file: f }); a.start();
  assert.equal(a.running, false); assert.match(a.error, /edited after the freeze/); assert.equal(fs.existsSync(path.join(d, 'l1')), false, 'refused run writes no ledger');
  const b = new KalshiH2V3({ v1: r.h, v2: null, dir: path.join(d, 'l2') }); b.start(); assert.equal(b.running, false); assert.match(b.error, /v2 is not running/);
  const c = new KalshiH2V3({ v1: r.h, v2: { ...r.a, cfg: r.a.cfg, running: true, hash: 'f'.repeat(64) }, dir: path.join(d, 'l3') }); c.start(); assert.match(c.error, /not the v2 hash/);
  const e = new KalshiH2V3({ v1: { cfg: r.h.cfg, running: true, hash: 'e'.repeat(64) }, v2: r.a, dir: path.join(d, 'l5') }); e.start(); assert.match(e.error, /not the v1 hash/);
  const g = new KalshiH2V3({ v1: r.h, v2: r.a, dir: path.join(d, 'l6'), file: V2_FILE }); g.start(); assert.equal(g.running, false); assert.match(g.error, /not a v3 sizing config/);
  const v1On3 = new KalshiH2Paper({ dir: path.join(d, 'l4'), file: V3_FILE }); v1On3.start(); assert.equal(v1On3.running, false); assert.match(v1On3.error, /not an entry-rule config/);
  const v2On3 = new KalshiH2V2({ v1: r.h, dir: path.join(d, 'l7'), file: V3_FILE }); try { v2On3.start(); } catch { /* v2 rejects the foreign file by throwing */ } assert.notEqual(v2On3.running, true);
  for (const x of ['l2', 'l3', 'l4', 'l5', 'l6', 'l7']) assert.equal(fs.existsSync(path.join(d, x)), false);
  // a paper-only edit that sets liveOrders is refused by the loader even with a matching pin
  const lf = path.join(d, 'live.json'); fs.writeFileSync(lf, fs.readFileSync(V3_FILE, 'utf8').replace('"liveOrders": false', '"liveOrders": true'));
  assert.throws(() => loadFrozen(lf, { ...FROZEN, 'kalshi-h2-v3': sha(lf) }), /paper-only/);
});

test('sizeOrder: min of X% of balance, per-asset cap, overall cap, participation, cash; names the binding cap(s)', () => {
  const { cfg } = loadFrozen(V3_FILE);
  let z = sizeOrder({ cfg, asset: 'BTC', ask: 0.95, balance: 10000, cash: 10000, vol: 5000, pct: 0.03 });
  assert.equal(z.requestedDollars, 300); assert.equal(z.contracts, 315); assert.deepEqual(z.bound, ['pct']); assert.equal(z.caps.asset, 5263); assert.equal(z.caps.participation, 500);
  z = sizeOrder({ cfg, asset: 'BTC', ask: 0.95, balance: 10000, cash: 10000, vol: 5000, pct: 0.07 }); assert.equal(z.contracts, 500); assert.deepEqual(z.bound, ['participation']);
  z = sizeOrder({ cfg, asset: 'ETH', ask: 0.95, balance: 10000, cash: 10000, vol: 50000, pct: 0.07 }); assert.equal(z.contracts, 421); assert.deepEqual(z.bound, ['asset']);
  z = sizeOrder({ cfg, asset: 'SOL', ask: 0.95, balance: 100000, cash: 100000, vol: 1e6, pct: 0.03 }); assert.equal(z.contracts, 263); assert.deepEqual(z.bound, ['asset']);
  z = sizeOrder({ cfg, asset: 'BTC', ask: 0.95, balance: 10000, cash: 50, vol: 5000, pct: 0.03 }); assert.deepEqual(z.bound, ['cash']); assert.equal(z.contracts, 51);
  z = sizeOrder({ cfg, asset: 'BTC', ask: 0.95, balance: 10000, cash: 10000, vol: 0, pct: 0.03 }); assert.equal(z.contracts, 0); assert.deepEqual(z.bound, ['participation']);
  z = sizeOrder({ cfg, asset: 'BTC', ask: 0.95, balance: 10000, cash: 10000, vol: null, pct: 0.03 }); assert.equal(z.contracts, 0); assert.deepEqual(z.bound, ['unknown_volume']);
  z = sizeOrder({ cfg, asset: 'DOGE', ask: 0.95, balance: 10000, cash: 10000, vol: 5000, pct: 0.03 }); assert.equal(z.contracts, 0, 'no cap configured -> not traded');
  z = sizeOrder({ cfg: { ...cfg, sizing: { ...cfg.sizing, overallDollarCap: 100 } }, asset: 'BTC', ask: 0.95, balance: 10000, cash: 10000, vol: 5000, pct: 0.03 }); assert.equal(z.contracts, 105); assert.deepEqual(z.bound, ['overall']);
});

test('fillLadder: visible depth within 1c fills; the remainder stays UNFILLED and is only stress-priced at worst level + 1c', () => {
  const F = { limitAboveSignalAsk: 0.01, limitCap: 0.99 };
  let f = fillLadder({ ladder: [[0.95, 250], [0.955, 100], [0.97, 1000]], ask: 0.95, want: 315, F });
  assert.deepEqual(f.levels, [[0.95, 250], [0.955, 65]]); assert.equal(f.filled, 315); assert.equal(f.unfilled, 0); assert.deepEqual(f.flags, []); assert.equal(f.limit, 0.96);
  assert.ok(Math.abs(f.vwap - 299.575 / 315) < 1e-6); assert.ok(Math.abs(f.slippageCents - 0.1032) < 1e-3);
  f = fillLadder({ ladder: [[0.95, 250], [0.955, 100], [0.97, 1000]], ask: 0.95, want: 500, F });
  assert.equal(f.filled, 350); assert.equal(f.unfilled, 150); assert.equal(f.stressPx, 0.98); assert.deepEqual(f.flags, ['remainder_unfilled', 'remainder_priced_worst_plus_1c']);
  f = fillLadder({ ladder: [], ask: 0.95, want: 10, F }); assert.equal(f.filled, 0); assert.equal(f.unfilled, 10); assert.deepEqual(f.flags, ['remainder_unfilled', 'no_visible_depth']);
  f = fillLadder({ ladder: [[0.985, 10]], ask: 0.98, want: 50, F }); assert.equal(f.limit, 0.99); assert.equal(f.stressPx, 0.99, 'stress price capped at 99c');
  assert.deepEqual(depthAt([[0.95, 10], [0.96, 5], [0.97, 1]], 0.96), { contracts: 15, dollars: 14.3, bestAsk: 0.95, bestSize: 10, levels: 3 });
  assert.deepEqual(askLadderOf({ no: [[0.05, 10], [0.04, 3]] }), [[0.95, 10], [0.96, 3]], 'recorded rows: YES ask = 1 - NO bid');
});

test('feeOrder: Kalshi fee rounded up to the cent ONCE per order (not per contract)', () => {
  assert.equal(feeOrder([[0.95, 1]]), 0.01); assert.equal(feeOrder([[0.95, 100]]), 0.34); // 0.3325 -> 0.34 (per contract would be $1.00)
  assert.equal(feeOrder([[0.95, 250], [0.955, 65]]), 1.03); assert.equal(feeOrder([]), 0); assert.equal(feeOrder([[0.5, 100]]), 1.75);
});

test('refillSeries: depth at the limit every 5 s for 60 s, latest book at or before each point', () => {
  const s = refillSeries([[1000, [[0.95, 10]]], [13000, [[0.95, 40], [0.96, 5]]]], 1000, 0.96, { windowMs: 60000, sampleEveryMs: 5000 });
  assert.equal(s.length, 13); assert.deepEqual(s[0], { s: 0, contracts: 10, dollars: 9.5, bestAsk: 0.95 }); assert.equal(s[2].contracts, 10); assert.equal(s[3].contracts, 45);
});

test('live: v3 trades exactly v2 takes on v1\'s fill snapshot; two lines with their own ledgers; balance compounds; refill logged; v1/v2 untouched', () => {
  const r = rig(), one = rig({ v3: false });
  const fl = [[0.95, 250], [0.955, 100], [0.97, 1000]], refill = [[0.95, 80], [0.958, 20], [0.97, 1000]];
  for (const x of [r, one]) {
    market(x, 'A', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 5000, sigLadder: [[0.95, 300], [0.96, 40], [0.97, 9]], fillLadder: fl, refill }); // take
    market(x, 'B', [0.6, 0.7, 0.8, 0.86, 0.85], { vol: 5000, fillLadder: fl }); // v2 skip -> not traded by v3
    settle(x, 'A', 'yes'); settle(x, 'B', 'no');
  }
  assert.deepEqual(ledger(path.join(r.dir, 'v1', 'ledger.jsonl')), ledger(path.join(one.dir, 'v1', 'ledger.jsonl')), 'v1 behaves exactly as without v3');
  assert.deepEqual(ledger(path.join(r.dir, 'v2', 'ledger.jsonl')).map((x) => [x.t, x.tk, x.decision]), ledger(path.join(one.dir, 'v2', 'ledger.jsonl')).map((x) => [x.t, x.tk, x.decision]), 'v2 behaves exactly as without v3');
  const M = L3(r.dir), sig = M.filter((x) => x.t === 'signal');
  assert.deepEqual(sig.map((x) => [x.tk, x.decision, x.paper]), [['A', 'take', true], ['B', 'skip', true]]);
  const bA = M.find((x) => x.t === 'book' && x.tk === 'A'), bB = M.find((x) => x.t === 'book' && x.tk === 'B');
  assert.equal(bA.traded, true); assert.equal(bA.lagMs, 1000); assert.deepEqual(bA.signalLadder, [[0.95, 300], [0.96, 40], [0.97, 9]], 'full decision-time ladder');
  assert.deepEqual(bA.fillLadder, fl); assert.equal(bA.depthAtFill.contracts, 350); assert.equal(bA.depthAtSignal.contracts, 340); assert.equal(bA.vol60, 5000); assert.equal(bA.nTrades, 1);
  assert.equal(bB.traded, false); assert.match(bB.reason, /v2 skip/);
  const o3 = L3(r.dir, '3pct').filter((x) => x.t === 'order'), o7 = L3(r.dir, '7pct').filter((x) => x.t === 'order');
  assert.equal(o3.length, 1); assert.equal(o7.length, 1);
  assert.deepEqual([o3[0].requested, o3[0].filled, o3[0].unfilled, o3[0].fee, o3[0].bound], [315, 315, 0, 1.03, ['pct']]); assert.deepEqual(o3[0].levels, [[0.95, 250], [0.955, 65]]);
  assert.deepEqual([o7[0].requested, o7[0].filled, o7[0].unfilled, o7[0].fee, o7[0].bound], [500, 350, 150, 1.14, ['participation']]);
  assert.deepEqual(o7[0].flags, ['remainder_unfilled', 'remainder_priced_worst_plus_1c']); assert.equal(o7[0].stress.px, 0.98);
  assert.ok(o3.every((o) => o.paper === true && o.requestedDollars === 300));
  const s3 = L3(r.dir, '3pct').filter((x) => x.t === 'settle'), s7 = L3(r.dir, '7pct').filter((x) => x.t === 'settle');
  assert.ok(Math.abs(s3[0].pnl - (315 - 299.575 - 1.03)) < 1e-6); assert.ok(Math.abs(s7[0].pnl - (350 - 333 - 1.14)) < 1e-6);
  assert.ok(s7[0].stressPnl !== s7[0].pnl && Math.abs(s7[0].balanceAfter - (10000 + s7[0].pnl)) < 1e-6, 'stress line (remainder at worst + 1c) is logged but never booked');
  const rf = M.find((x) => x.t === 'refill' && x.tk === 'A'); assert.ok(rf, 'refill row'); assert.equal(rf.samples.length, 13); assert.equal(rf.samples[0].contracts, 350); assert.equal(rf.samples[12].contracts, 100);
  // compounding: the next take is sized off the settled balance
  const C2 = CLOSE + 900e3; market(r, 'C', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 5000, fillLadder: [[0.95, 5000]], close: C2 });
  const o3c = L3(r.dir, '3pct').filter((x) => x.t === 'order' && x.tk === 'C')[0];
  assert.ok(Math.abs(o3c.balanceBefore - (10000 + 315 - 299.575 - 1.03)) < 1e-6); assert.equal(o3c.requested, Math.floor((o3c.balanceBefore * 0.03) / 0.95));
  const st = r.b.snapshot(); assert.equal(st.paper, true); assert.match(st.label, /PAPER.*UNPROVEN/); assert.equal(st.stats.passTest.label, 'UNPROVEN');
  const l7 = st.stats.lines.find((l) => l.id === '7pct'); assert.equal(l7.capBound.participation, 2, 'A and C: 10% of 5,000 = 500 < 7% line'); assert.ok(l7.fillRate > 0 && l7.fillRate < 1);
  assert.equal(st.stats.compare.v2.n, 1); assert.equal(st.stats.compare.v1.n, 2); assert.ok(st.stats.capacity.reference.fillable);
  // restart: replay only; nothing sized twice; balances restored from the line ledgers
  const n3 = L3(r.dir, '3pct').length; const again = new KalshiH2V3({ v1: r.h, v2: r.a, dir: r.dir, now: r.clock.now }); again.start(); again.stop();
  assert.equal(L3(r.dir, '3pct').length, n3); assert.equal(again.lines[0].balance, r.b.lines[0].balance);
});

test('unknown volume (no live trade feed) -> logged, zero contracts, never assumed', () => {
  const r = rig(); r.k.L.trade.length = 0; r.b.tradeFeed = false;
  market(r, 'A', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 5000, fillLadder: [[0.95, 5000]] });
  const o = L3(r.dir, '3pct').find((x) => x.t === 'order'); assert.deepEqual([o.requested, o.filled, o.bound], [0, 0, ['unknown_volume']]);
  assert.equal(L3(r.dir).find((x) => x.t === 'book').volKnown, false);
  settle(r, 'A', 'yes'); assert.equal(L3(r.dir, '3pct').filter((x) => x.t === 'settle').length, 0, 'no P&L without a fill');
});

test('backfill at start: sizes old v2 takes from RECORDED books and trades; no recorded book -> book_unknown', () => {
  const dir = tmp(), rec = tmp(), day = path.join(rec, '2026-11-02'); fs.mkdirSync(day, { recursive: true });
  const src = rig({ dir, v3: false });
  market(src, 'A', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 1 }); market(src, 'D', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 1 }); settle(src, 'A', 'yes'); settle(src, 'D', 'no');
  const fillRx = CLOSE - 579e3, sigRx = CLOSE - 580e3;
  const bk = (rx, tk, no) => JSON.stringify({ rx, t: 'book', tk, s: 'KXBTC15M', secLeft: Math.round((CLOSE - rx) / 1000), yes: [], no, ya: +(1 - no[0][0]).toFixed(4), yas: no[0][1] });
  fs.writeFileSync(path.join(day, 'kalshi.book.0001-1.jsonl'), [bk(sigRx - 20e3, 'A', [[0.05, 400], [0.04, 60]]), bk(fillRx, 'A', [[0.05, 200], [0.045, 50], [0.03, 999]]), bk(fillRx + 30e3, 'A', [[0.05, 600]])].join('\n') + '\n');
  fs.writeFileSync(path.join(day, 'kalshi.trade.0001-1.jsonl'), [{ rx: sigRx, t: 'trade', id: 'x1', tk: 'A', ex: sigRx - 10e3, c: 3000, s: 'KXBTC15M' }, { rx: sigRx, t: 'trade', id: 'x1', tk: 'A', ex: sigRx - 10e3, c: 3000, s: 'KXBTC15M' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const now = () => CLOSE + 3600e3, k = fakeKalshi();
  const h = new KalshiH2Paper({ kalshi: k, dir, now }); h.start(); h.stop(); h.running = true;
  const a = new KalshiH2V2({ v1: h, kalshi: k, dir, now }); a.start(); a.stop(); a.running = true;
  const b = new KalshiH2V3({ v1: h, v2: a, kalshi: k, dir, recorderDir: rec, now }); b.start(); b.stop();
  const M = L3(dir); assert.deepEqual(M.filter((x) => x.t === 'signal').map((x) => [x.tk, x.decision, x.backfill]), [['A', 'take', true], ['D', 'take', true]]);
  const bA = M.find((x) => x.t === 'book' && x.tk === 'A'); assert.equal(bA.traded, true); assert.deepEqual(bA.fillLadder, [[0.95, 200], [0.955, 50], [0.97, 999]]); assert.equal(bA.vol60, 3000, 'deduped by trade id');
  assert.deepEqual(bA.signalLadder, [[0.95, 400], [0.96, 60]]); assert.equal(bA.volSource, 'recorded kalshi.trade');
  const bD = M.find((x) => x.t === 'book' && x.tk === 'D'); assert.equal(bD.traded, false); assert.equal(bD.reason, 'book_unknown');
  const o = L3(dir, '3pct').find((x) => x.t === 'order'); assert.deepEqual([o.tk, o.requested, o.filled, o.unfilled, o.bound, o.backfill], ['A', 300, 250, 50, ['participation'], true]);
  const rf = M.find((x) => x.t === 'refill' && x.tk === 'A'); assert.equal(rf.samples[0].contracts, 250); assert.equal(rf.samples[6].contracts, 600); assert.match(rf.source, /recorded/);
  assert.equal(L3(dir, '3pct').filter((x) => x.t === 'settle').length, 1); assert.equal(L3(dir, '7pct').filter((x) => x.t === 'settle').length, 1);
  assert.equal(b.backfill.needed, 2);
});

test('pass gate: first look only, persisted once; n and Fisher from v2, kept net from the v3 3% line', () => {
  const d = tmp(), f = path.join(d, 'kalshi-h2-v3.json'); fs.writeFileSync(f, fs.readFileSync(V3_FILE, 'utf8').replace('"minV1Signals": 1500', '"minV1Signals": 2'));
  const pins = { ...FROZEN, 'kalshi-h2-v3': sha(f) }, r = rig({ file: f, pins });
  market(r, 'A', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 5000, fillLadder: [[0.95, 5000]] }); market(r, 'B', [0.6, 0.7, 0.8, 0.86, 0.85], { vol: 5000 });
  settle(r, 'A', 'yes'); assert.equal(L3(r.dir).filter((x) => x.t === 'verdict').length, 0); settle(r, 'B', 'no');
  const V = L3(r.dir).filter((x) => x.t === 'verdict'); assert.equal(V.length, 1); assert.equal(V[0].n, 2); assert.ok(V[0].keptNetCentsPerContract > 0);
  const C2 = CLOSE + 900e3; market(r, 'C', [0.8, 0.85, 0.88, 0.9, 0.9], { vol: 5000, fillLadder: [[0.95, 5000]], close: C2 }); settle(r, 'C', 'no', C2);
  assert.equal(L3(r.dir).filter((x) => x.t === 'verdict').length, 1, 'never recomputed');
});

test('no order path: v3 has no network, auth or order code; wired only as a paper feed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'kalshi-h2', 'v3.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of [/require\(['"](https?|net|tls|undici|node-fetch|ws)['"]\)/, /\bfetch\(/, /kalshi-auth/, /publicGet/, /\bPOST\b/, /\/portfolio\//, /createOrder|placeOrder|submitOrder|sendOrder/, /process\.env/])
    assert.doesNotMatch(src, bad, 'v3.js must stay paper-only: ' + bad);
  const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort(); assert.deepEqual(reqs, ['./index', './stats', './v2', './v2-audit', 'fs', 'path']);
  const mods = fs.readFileSync(path.join(__dirname, '..', 'server', 'modules.js'), 'utf8'); assert.match(mods, /if \(c\.v2 && c\.v3\) engine\.kalshiH2v3 = engine\.addFeed\('kalshiH2v3', new KalshiH2V3\(/);
  const proto = Object.getOwnPropertyNames(KalshiH2V3.prototype); assert.ok(!proto.some((n) => /^(place|submit|send|create|cancel)|Order$|live/i.test(n)), proto.join(','));
});
