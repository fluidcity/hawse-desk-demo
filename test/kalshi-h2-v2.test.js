'use strict';
// Kalshi H2 v2 arm (config/frozen/kalshi-h2-v2.json): frozen no-jump filter on v1 signals. PAPER ONLY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { KalshiH2Paper, loadFrozen, FROZEN } = require('../server/kalshi-h2');
const { KalshiH2V2, decide, ingest, newTrack, fisherOneSided, summarizeV2, V2_FILE } = require('../server/kalshi-h2/v2');

// Pinned SEPARATELY from the code: editing config/frozen/kalshi-h2-v2.json (or the code's pin) breaks this test.
const V2_SHA256 = 'ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c';
const V1_SHA256 = '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2v2-'));
function fakeKalshi() { const L = { book: [], settle: [], market: [], series: [] }; return { L, tracked: [], on(k, f) { L[k].push(f); }, track(m) { this.tracked.push(m.ticker); }, emit(k, x) { for (const f of L[k]) f(x); } }; }
const CLOSE = Date.parse('2026-11-02T16:00:00Z'), OPEN = CLOSE - 900e3;
function rig({ v2 = true, dir = tmp(), recorderDir = null } = {}) {
  let t = Date.parse('2026-11-02T15:44:00Z'); const clock = { now: () => t, set: (x) => (t = x) };
  const k = fakeKalshi(); const h = new KalshiH2Paper({ kalshi: k, dir, now: clock.now }); h.start(); h.stop(); h.running = true;
  let a = null; if (v2) { a = new KalshiH2V2({ v1: h, kalshi: k, dir, recorderDir, now: clock.now }); a.start(); a.stop(); a.running = true; }
  return { dir, k, h, a, clock };
}
function book(r, tk, secLeft, ya, yas = 50, series = 'KXBTC15M') {
  r.clock.set(CLOSE - secLeft * 1000);
  r.k.emit('book', { tk, series, rx: r.clock.now(), sent: r.clock.now() - 50, close: CLOSE, secLeft, strike: 1, ya, yas, yb: ya == null ? null : ya - 0.01, ybs: 10, askLadder: ya == null ? [] : [[ya, yas], [Math.min(0.999, ya + 0.004), 100]] });
}
// one book in each earlier minute (secLeft 890, 830, 770, 710, 650 = minutes 15:45..15:49), then the v1 window: books every second from 605 s; touch at 580 s
// (the 605..601 s books are still in minute 15:49, so they carry that minute's ask; 600..581 s are the signal's own minute)
function market(r, tk, earlier, touch = 0.95, series = 'KXBTC15M') {
  [890, 830, 770, 710, 650].forEach((s, i) => { if (earlier[i] !== undefined) book(r, tk, s, earlier[i], 50, series); });
  for (let s = 605; s > 580; s--) book(r, tk, s, s > 600 ? earlier[4] : 0.9, 50, series); book(r, tk, 580, touch, 50, series); book(r, tk, 579, touch, 50, series);
}
const ledger = (dir, v) => { const f = path.join(dir, v, 'ledger.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const run = (r) => {
  market(r, 'A', [0.8, 0.85, 0.88, 0.9, 0.9]); // max 0.90 -> take
  market(r, 'B', [0.6, 0.7, 0.8, 0.86, 0.85]); // max 0.86 (< 0.87) on full books -> skip
  market(r, 'C', [0.6, undefined, 0.8, 0.85, 0.85]); // a minute with no book and max < 0.87 -> unknown
  market(r, 'D', [undefined, 0.9, 0.7, 0.8, 0.8]); // partial books but max 0.90 >= 0.87 -> take
  market(r, 'E', [null, null, null, null, null]); // books in every minute, never a YES ask -> no earlier quote -> take
  for (const [tk, res] of [['A', 'yes'], ['B', 'no'], ['C', 'yes'], ['D', 'yes'], ['E', 'no']]) r.k.emit('settle', { tk, result: res, status: 'finalized', settledAt: CLOSE + 60e3 });
};

test('frozen v2 config: hash pinned in the test AND the code; paper-only; names the exact v1 hash; threshold 0.87', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(V2_FILE)).digest('hex');
  assert.equal(sha, V2_SHA256, 'config/frozen/kalshi-h2-v2.json was edited after the freeze: make kalshi-h2-v3.json instead');
  assert.equal(FROZEN['kalshi-h2-v2'], V2_SHA256); assert.equal(FROZEN['kalshi-h2-v1'], V1_SHA256, 'v1 pin unchanged');
  const { cfg } = loadFrozen(V2_FILE);
  assert.equal(cfg.name, 'fav93_98_v2_nojump'); assert.equal(cfg.mode, 'paper-only'); assert.equal(cfg.liveOrders, false);
  assert.equal(cfg.base.sha256, V1_SHA256); assert.equal(cfg.filter.skipIfBelow, 0.87); assert.equal(cfg.filter.noEarlierQuote, 'take');
  assert.deepEqual([cfg.pass.minV1Signals, cfg.pass.alpha, cfg.pass.keptMeanNetGtCents], [1500, 0.05, 0]);
});

test('loader refusals: an edited v2 copy, a v1 hash mismatch, v1 not running, and v1 never runs the v2 file', () => {
  const d = tmp(), f = path.join(d, 'kalshi-h2-v2.json'); fs.writeFileSync(f, fs.readFileSync(V2_FILE, 'utf8').replace('"skipIfBelow": 0.87', '"skipIfBelow": 0.86'));
  assert.throws(() => loadFrozen(f), /edited after the freeze/);
  const r = rig({ v2: false });
  const a = new KalshiH2V2({ v1: r.h, dir: path.join(d, 'l1'), file: f }); a.start();
  assert.equal(a.running, false); assert.match(a.error, /edited after the freeze/); assert.equal(fs.existsSync(path.join(d, 'l1')), false, 'refused run writes no ledger');
  const b = new KalshiH2V2({ v1: { ...r.h, cfg: r.h.cfg, running: true, hash: 'f'.repeat(64) }, dir: path.join(d, 'l2') }); b.start();
  assert.equal(b.running, false); assert.match(b.error, /not the v1 hash/); assert.equal(fs.existsSync(path.join(d, 'l2')), false);
  const c = new KalshiH2V2({ v1: { cfg: r.h.cfg, hash: V1_SHA256, running: false }, dir: path.join(d, 'l3') }); c.start();
  assert.equal(c.running, false); assert.match(c.error, /v1 is not running/);
  const v1OnV2 = new KalshiH2Paper({ dir: path.join(d, 'l4'), file: V2_FILE }); v1OnV2.start();
  assert.equal(v1OnV2.running, false); assert.match(v1OnV2.error, /not an entry-rule config/); assert.equal(fs.existsSync(path.join(d, 'l4')), false);
});

test('decide(): take / skip / no earlier quote / partial below -> unknown / partial at-or-above -> take', () => {
  const F = loadFrozen(V2_FILE).cfg.filter, sigAt = OPEN + 5 * 60e3 + 20e3, sig = { bookRx: sigAt, ya: 0.95, close: CLOSE };
  const tr = (asks) => { const t = newTrack(OPEN); asks.forEach((a, i) => { if (a !== undefined) ingest(t, { rx: OPEN + i * 60e3 + 30e3, ya: a }, 'live'); }); return t; };
  let d = decide(tr([0.8, 0.85, 0.88, 0.9, 0.9]), sig, F); assert.deepEqual([d.decision, d.v2Skip, d.maxEarlierAsk, d.coverage, d.earlierMinutes], ['take', false, 0.9, 'full', 5]);
  assert.equal(d.prevMinuteAsk, 0.9); assert.equal(d.dask1, 0.05);
  d = decide(tr([0.6, 0.7, 0.8, 0.869, 0.85]), sig, F); assert.deepEqual([d.decision, d.v2Skip, d.maxEarlierAsk], ['skip', true, 0.869]);
  d = decide(tr([0.6, 0.7, 0.8, 0.87, 0.85]), sig, F); assert.equal(d.decision, 'take', '0.87 itself is not below 0.87');
  d = decide(tr([null, null, null, null, null]), sig, F); assert.deepEqual([d.decision, d.maxEarlierAsk, d.coverage], ['take', null, 'full']); assert.match(d.why, /no earlier YES-ask quote/);
  d = decide(tr([0.6, undefined, 0.8, 0.85, 0.85]), sig, F); assert.deepEqual([d.decision, d.v2Skip, d.coverage, d.minutesWithBooks], ['unknown', null, 'partial', 4]);
  d = decide(tr([undefined, 0.9, 0.7, 0.8, 0.8]), sig, F); assert.deepEqual([d.decision, d.coverage], ['take', 'partial']);
  d = decide(null, sig, F); assert.deepEqual([d.decision, d.coverage], ['unknown', 'none']);
  // the minute close is the LAST non-null ask of that minute, not its max; books in the signal's own minute do not count
  const t = tr([0.6, 0.6, 0.6, 0.6, 0.6]); ingest(t, { rx: OPEN + 4 * 60e3 + 1e3, ya: 0.95 }, 'live'); ingest(t, { rx: OPEN + 5 * 60e3 + 1e3, ya: 0.99 }, 'live');
  d = decide(t, sig, F); assert.deepEqual([d.decision, d.maxEarlierAsk], ['skip', 0.6]);
});

test('fisherOneSided: matches the hypergeometric tail; empty group -> null', () => {
  assert.ok(Math.abs(fisherOneSided({ keptLoss: 1, keptN: 10, skipLoss: 5, skipN: 10 }) - 0.070433) < 1e-6);
  assert.ok(Math.abs(fisherOneSided({ keptLoss: 0, keptN: 2, skipLoss: 2, skipN: 2 }) - 0.166667) < 1e-6);
  assert.equal(fisherOneSided({ keptLoss: 3, keptN: 10, skipLoss: 0, skipN: 5 }), 1);
  assert.equal(fisherOneSided({ keptLoss: 0, keptN: 0, skipLoss: 1, skipN: 3 }), null);
});

test('pass test: UNPROVEN (pending) below 1,500 known signals; met / retired after; unknown never counts', () => {
  const { cfg } = loadFrozen(V2_FILE);
  const mk = (n, d, lossEvery, pnlWin, pnlLoss) => Array.from({ length: n }, (_, i) => { const win = (i % lossEvery) !== 0; return { sig: { tk: d + i, decision: d, bookRx: i }, fill: { px: 0.95 }, settle: { win, pnl1: win ? pnlWin : pnlLoss, pnlL: 0, settledAt: i } }; });
  let s = summarizeV2({ cfg, rows: [...mk(1000, 'take', 50, 0.04, -0.96), ...mk(400, 'skip', 5, 0.04, -0.96), ...mk(300, 'unknown', 2, 0.04, -0.96)] });
  assert.equal(s.passTest.status, 'pending'); assert.equal(s.passTest.label, 'UNPROVEN'); assert.equal(s.passTest.have, 1400); assert.equal(s.unknownSettled, 300);
  assert.ok(s.passTest.parts.every((p) => p.status === 'pending'));
  s = summarizeV2({ cfg, rows: [...mk(1200, 'take', 50, 0.04, -0.96), ...mk(300, 'skip', 5, 0.04, -0.96)] });
  assert.equal(s.passTest.status, 'met'); assert.match(s.passTest.label, /^PASS/); assert.ok(s.fisherP < 0.05); assert.ok(s.kept.meanNetCents > 0);
  s = summarizeV2({ cfg, rows: [...mk(1200, 'take', 20, 0.04, -0.96), ...mk(300, 'skip', 5, 0.04, -0.96)] }); // kept lose 5% at +4c/-96c -> negative
  assert.equal(s.passTest.status, 'not met'); assert.match(s.passTest.label, /^RETIRED/); assert.equal(s.passTest.parts.find((p) => p.key === 'kept').status, 'not met');
  s = summarizeV2({ cfg, rows: [...mk(1200, 'take', 5, 0.3, -0.7), ...mk(300, 'skip', 5, 0.3, -0.7)] }); // same loss rate -> Fisher not met
  assert.equal(s.passTest.parts.find((p) => p.key === 'fisher').status, 'not met'); assert.equal(s.passTest.status, 'not met');
});

test('live: every v1 signal gets one v2 row (skipped ones too); fills and official results copied; v1 ledger byte-identical to a v1-only run', () => {
  const r = rig(); run(r);
  const one = rig({ v2: false }); run(one);
  assert.deepEqual(ledger(r.dir, 'v1'), ledger(one.dir, 'v1'), 'v1 behaves exactly as without v2');
  const v1sig = ledger(r.dir, 'v1').filter((x) => x.t === 'signal').map((x) => x.tk); assert.deepEqual(v1sig, ['A', 'B', 'C', 'D', 'E']);
  const L = ledger(r.dir, 'v2'), sig = L.filter((x) => x.t === 'signal');
  assert.deepEqual(sig.map((x) => [x.tk, x.decision, x.maxEarlierAsk, x.coverage]), [['A', 'take', 0.9, 'full'], ['B', 'skip', 0.86, 'full'], ['C', 'unknown', 0.85, 'partial'], ['D', 'take', 0.9, 'partial'], ['E', 'take', null, 'full']]);
  assert.ok(sig.every((x) => x.paper === true && x.askDepth === 50 && x.v1At && x.dask1 !== undefined && !x.backfill));
  const fills = L.filter((x) => x.t === 'fill'); assert.equal(fills.length, 5, 'skipped and unknown signals keep their (v1) fill for the comparison');
  assert.deepEqual(fills.map((x) => x.v2Trade), [true, false, false, true, true]); assert.ok(fills.every((x) => x.size === r.h.cfg.sizing.contracts && x.fee1 === 0.01));
  const v1settle = ledger(r.dir, 'v1').filter((x) => x.t === 'settle'), v2settle = L.filter((x) => x.t === 'settle');
  assert.deepEqual(v2settle.map((x) => [x.tk, x.result, x.pnl1]), v1settle.map((x) => [x.tk, x.result, x.pnl1]));
  const s = r.a.snapshot(); assert.equal(s.paper, true); assert.match(s.label, /PAPER.*UNPROVEN/);
  assert.deepEqual(s.stats.decisions, { take: 3, skip: 1, unknown: 1 }); assert.equal(s.stats.v2.taken, 3); assert.equal(s.stats.v2.losses, 1);
  assert.equal(s.stats.skipped.lossRate, 1); assert.equal(s.stats.passTest.label, 'UNPROVEN'); assert.equal(s.stats.curve.length, 3);
  // restart: replay only, nothing decided twice, nothing duplicated
  const n = L.length; const again = new KalshiH2V2({ v1: r.h, dir: r.dir, now: r.clock.now }); again.start(); again.stop();
  const L2 = ledger(r.dir, 'v2'); assert.equal(L2.length, n + 1); assert.equal(L2[L2.length - 1].t, 'session');
});

test('backfill at start: decides old v1 signals from RECORDED books (gzip or plain) honestly; d_bps from the recorded reference', () => {
  const dir = tmp(), rec = tmp(), day = path.join(rec, '2026-11-02'); fs.mkdirSync(day, { recursive: true });
  const src = rig({ v2: false, dir }); market(src, 'A', [0.6, 0.7, 0.8, 0.86, 0.85]); market(src, 'C', [0.95, 0.9, 0.9, 0.9, 0.9], 0.95, 'KXETH15M'); src.k.emit('settle', { tk: 'A', result: 'no', status: 'finalized', settledAt: CLOSE + 60e3 });
  const rows = (tk, asks, sr = 'KXBTC15M') => asks.map((a, i) => (a === undefined ? null : JSON.stringify({ rx: OPEN + i * 60e3 + 30e3, t: 'book', tk, s: sr, secLeft: 900 - i * 60 - 30, ya: a }))).filter(Boolean);
  fs.writeFileSync(path.join(day, 'kalshi.book.0001.jsonl.gz'), zlib.gzipSync(rows('A', [0.6, 0.7, 0.8, 0.86, 0.85]).join('\n') + '\n'));
  fs.writeFileSync(path.join(day, 'kalshi.book.0002.jsonl'), rows('C', [0.6, 0.7, undefined, 0.8, 0.8], 'KXETH15M').join('\n') + '\n'); // C: hole in the recording -> unknown, even though the live run saw 0.95
  fs.writeFileSync(path.join(day, 'ref.0001.jsonl'), JSON.stringify({ rx: OPEN + 5 * 60e3 + 19e3, t: 'ref', asset: 'BTC', med: 1.002, n: 3 }) + '\n');
  const k = fakeKalshi(), h = new KalshiH2Paper({ kalshi: k, dir, now: () => CLOSE + 3600e3 }); h.start(); h.stop(); h.running = true;
  const a = new KalshiH2V2({ v1: h, kalshi: k, dir, recorderDir: rec, now: () => CLOSE + 3600e3 }); a.start(); a.stop();
  const sig = ledger(dir, 'v2').filter((x) => x.t === 'signal');
  assert.deepEqual(sig.map((x) => [x.tk, x.decision, x.maxEarlierAsk, x.coverage, x.backfill]), [['A', 'skip', 0.86, 'full', true], ['C', 'unknown', 0.8, 'partial', true]]);
  assert.ok(Math.abs(sig[0].dBps - Math.log(1.002) * 1e4) < 1e-3); assert.match(sig[0].refSrc, /recorded/);
  assert.equal(sig[1].dBps, null, 'no recorded ETH reference -> d_bps unknown, not guessed');
  assert.equal(ledger(dir, 'v2').filter((x) => x.t === 'settle').length, 1);
  assert.equal(a.backfill.needed, 2); assert.equal(a.backfill.files, 3);
});

test('v2 is read-only paper code: no exchange endpoints, no order or portfolio paths, no network calls', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server', 'kalshi-h2', 'v2.js'), 'utf8');
  assert.doesNotMatch(s, /\/portfolio|\/orders?\b|createOrder|placeOrder|fetch\(|https?:\/\/|require\('(https?|net|tls|ws)'\)/);
});

test('engine wiring: kalshiH2v2 mounts after v1 as its own feed (KALSHI_H2_V2=false turns it off)', () => {
  const { Engine } = require('../server/engine'), config = require('../server/config');
  let cfg = config.build({ KALSHI_H2_DIR: path.join(tmp(), 'never'), RECORDER_DIR: path.join(tmp(), 'rec') });
  let e = new Engine(cfg, { modules: require('../server/modules') }); const names = Object.keys(e.feeds);
  assert.ok(e.feeds.kalshiH2v2); assert.ok(names.indexOf('kalshiH2v2') > names.indexOf('kalshiH2')); assert.equal(fs.existsSync(cfg.kalshiH2.dir), false);
  cfg = config.build({ KALSHI_H2_V2: 'false', KALSHI_H2_DIR: path.join(tmp(), 'never'), RECORDER_DIR: path.join(tmp(), 'rec') });
  e = new Engine(cfg, { modules: require('../server/modules') }); assert.equal(e.feeds.kalshiH2v2, undefined);
});
