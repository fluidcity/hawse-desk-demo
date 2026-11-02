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

// ---- audit layer (display/logging only; server/kalshi-h2/v2-audit.js). None of these change a frozen decision. ----
const AU = require('../server/kalshi-h2/v2-audit');
const { sessOf } = require('../server/kalshi-h2/v2');

test('audit: miro-exact shadow uses minute-boundary as-of asks only (no intra-minute spikes, entry minute excluded, valid two-sided quotes)', () => {
  const F = loadFrozen(V2_FILE).cfg.filter, sig = { bookRx: OPEN + 5 * 60e3 + 20e3, ya: 0.95, close: CLOSE, secLeft: 580 };
  const t = newTrack(OPEN), put = (rx, ya, yb, sess = 'live') => ingest(t, { rx, ya, yb }, 'live', { sess });
  for (let i = 0; i < 5; i++) { put(OPEN + i * 60e3 + 1e3, 0.80, 0.79); put(OPEN + i * 60e3 + 59e3, 0.80, 0.79); }
  put(OPEN + 2 * 60e3 + 30e3, 0.99, 0.98); // intra-minute spike: neither definition sees it (both read the minute close)
  put(OPEN + 5 * 60e3 + 5e3, 0.99, 0.98); // inside the entry minute: never counted
  let sh = AU.miroShadow(t, sig, { thr: F.skipIfBelow }), d = decide(t, sig, F);
  assert.deepEqual([sh.entryM, sh.expectedEarlier, sh.nEarlierObserved, sh.nEarlierQuotes, sh.nEarlierValid, sh.partialHistory, sh.miroMaxEarlierAsk, sh.miroDecision], [9, 5, 5, 5, 5, false, 0.8, 'skip']);
  assert.deepEqual([d.decision, d.maxEarlierAsk], ['skip', 0.8], 'frozen agrees');
  assert.deepEqual(sh.earlierAsks.map((e) => e[0]), [14, 13, 12, 11, 10], 'checkpoints are m = 14 .. entry_m + 1');
  assert.equal(sh.miroDask1, 0.15); assert.equal(sh.minutesLeft, r6(580 / 60)); assert.equal(sh.month, '2026-11');
  // the last row of a minute has a NULL ask: frozen uses the last non-null ask (0.90), miro's as-of close is the null (not a quote)
  put(OPEN + 3 * 60e3 + 59.5e3, 0.90, 0.89); put(OPEN + 3 * 60e3 + 59.9e3, null, 0.89);
  sh = AU.miroShadow(t, sig, { thr: 0.87 }); d = decide(t, sig, F);
  assert.deepEqual([d.decision, d.maxEarlierAsk], ['take', 0.9]); assert.deepEqual([sh.miroDecision, sh.miroMaxEarlierAsk, sh.nEarlierQuotes, sh.nEarlierValid], ['skip', 0.8, 4, 4]);
  // a one-sided quote (no bid) is not a valid miro quote
  const t2 = newTrack(OPEN); for (let i = 0; i < 5; i++) ingest(t2, { rx: OPEN + i * 60e3 + 1e3, ya: i === 2 ? 0.9 : 0.8, yb: i === 2 ? null : 0.79 }, 'live');
  assert.deepEqual([decide(t2, sig, F).decision, AU.miroShadow(t2, sig, { thr: 0.87 }).miroDecision], ['take', 'skip']);
});
const r6 = (x) => Math.round(x * 1e6) / 1e6;

test('audit: an unchanged (deduped) recorded minute is carried only when the recorder provably watched; partial_history otherwise', () => {
  const F = loadFrozen(V2_FILE).cfg.filter, sig = { bookRx: OPEN + 5 * 60e3 + 20e3, ya: 0.95, close: CLOSE, secLeft: 580 };
  const mk = (sessB) => { const t = newTrack(OPEN); [0, 2, 3, 4].forEach((i) => ingest(t, { rx: OPEN + i * 60e3 + 10e3, ya: 0.8 + i * 0.01, yb: 0.7 }, 'recorded', { sess: i === 2 ? sessB : 'rec:1' })); return t; };
  let t = mk('rec:1'), sh = AU.miroShadow(t, sig, { thr: 0.87 });
  assert.equal(decide(t, sig, F).decision, 'unknown', 'frozen: a minute with no recorded row is missing');
  assert.deepEqual([sh.nEarlierObserved, sh.partialHistory, sh.miroDecision], [5, false, 'skip'], 'same session, no gap: the as-of close carries');
  sh = AU.miroShadow(t, sig, { thr: 0.87, gaps: [{ from: OPEN + 30e3, to: OPEN + 70e3 }] }); assert.deepEqual([sh.nEarlierObserved, sh.partialHistory], [4, true], 'recorded outage: not carried');
  sh = AU.miroShadow(mk('rec:2'), sig, { thr: 0.87 }); assert.deepEqual([sh.nEarlierObserved, sh.partialHistory], [4, true], 'recorder restarted: not carried');
  // recorder started mid-market
  const late = newTrack(OPEN); [3, 4].forEach((i) => ingest(late, { rx: OPEN + i * 60e3 + 10e3, ya: 0.8, yb: 0.7 }, 'recorded', { sess: 'rec:1' }));
  sh = AU.miroShadow(late, sig, { thr: 0.87 }); assert.deepEqual([sh.nEarlierObserved, sh.expectedEarlier, sh.partialHistory], [2, 5, true]);
  assert.equal(sessOf('kalshi.book.192425-236645.jsonl.gz'), 'rec:236645');
  const t3 = newTrack(OPEN); ingest(t3, { rx: OPEN + 1e3, ya: 0.8, yb: 0.7 }, 'live', { rowsOnly: true }); assert.equal(t3.mins.size, 0, 'rowsOnly never reaches decide()'); assert.equal(t3.rows.length, 1);
});

test('audit: fee per order = roundup_to_cent(0.07*C*P*(1-P)); kept EV under actual / flat 1c / flat 2c', () => {
  assert.equal(AU.feeOrder(1, 0.95), 0.01); assert.equal(AU.feeOrder(100, 0.95), 0.34); assert.equal(AU.feeOrder(10, 0.5), 0.18); assert.equal(AU.feeOrder(1, 0.5), 0.02);
  const { cfg } = loadFrozen(V2_FILE);
  const row = (d, win, px) => ({ sig: { tk: d + px + win, decision: d, bookRx: px * 1e3, askDepth: 20 }, fill: { px, size: 1, fee1: AU.feeOrder(1, px) }, settle: { win, px, pnl1: (win ? 1 : 0) - px - AU.feeOrder(1, px), settledAt: 1 } });
  const s = summarizeV2({ cfg, rows: [row('take', true, 0.95), row('take', true, 0.96), row('skip', false, 0.95)] });
  assert.deepEqual(s.audit.feeModels.kept, { actual: 3.5, flat1: 3.5, flat2: 2.5 }); assert.equal(s.audit.feeModels.feeMismatch, 0);
  assert.equal(s.audit.depth.share, 1); assert.equal(s.audit.equity.skippedHypothetical.length, 1); assert.equal(s.audit.running.length, 3);
  assert.equal(s.audit.reference.skippedLossRate, 0.063); assert.ok(s.audit.caveats.some((c) => /retune 0\.87/.test(c)));
});

test('audit: ONLY the first look at the 1,500 gate counts; later signals never change it; partial_history split reported', () => {
  const { cfg } = loadFrozen(V2_FILE);
  const mk = (n, d, lossEvery, off, partial = false) => Array.from({ length: n }, (_, i) => { const win = (i % lossEvery) !== 0, px = 0.95; return { sig: { tk: d + off + i, decision: d, bookRx: off + i * 2 + (d === 'skip' ? 1 : 0), partialHistory: partial }, fill: { px }, settle: { win, px, pnl1: win ? 0.04 : -0.96, pnlL: 0, settledAt: off + i } }; });
  const first = [...mk(1200, 'take', 50, 0), ...mk(300, 'skip', 5, 0, true)];
  let s = summarizeV2({ cfg, rows: first }); assert.equal(s.passTest.status, 'met');
  assert.equal(s.passTest.firstLook.n, 1500); assert.equal(s.passTest.firstLook.withoutPartialHistory.n, 1200); assert.equal(s.passTest.firstLook.withoutPartialHistory.met, false, 'no skipped left without partial_history');
  const later = [...first, ...mk(3000, 'take', 3, 1e7)]; // a disastrous tail after the gate
  s = summarizeV2({ cfg, rows: later }); assert.equal(s.passTest.status, 'met', 'first look stands'); assert.equal(s.audit.interim.all.met, false, 'interim (display) shows the drift');
  // class: the verdict row is persisted once and wins on replay
  const r = rig(); for (const x of first) r.a.rows.set(x.sig.tk, x); r.a.checkVerdict(); r.a.checkVerdict();
  let V = ledger(r.dir, 'v2').filter((x) => x.t === 'verdict'); assert.equal(V.length, 1); assert.equal(V[0].status, 'met'); assert.equal(V[0].n, 1500);
  const b = new KalshiH2V2({ v1: r.h, dir: r.dir, now: r.clock.now }); b.start(); b.stop(); b.running = true;
  for (const x of [...mk(1200, 'take', 2, 0), ...mk(300, 'skip', 2, 0)]) b.rows.set(x.sig.tk, x); b.checkVerdict();
  V = ledger(r.dir, 'v2').filter((x) => x.t === 'verdict'); assert.equal(V.length, 1); assert.equal(b.stats().passTest.status, 'met'); assert.equal(b.stats().passTest.firstLook.persisted, true);
});

test('audit: live rows carry every logged field; settlement value vs strike in bps (fills and no-fills); watch flags are flags only', () => {
  const r = rig(); run(r);
  const L = ledger(r.dir, 'v2'), sig = L.filter((x) => x.t === 'signal');
  for (const x of sig) for (const k of ['entryM', 'minutesLeft', 'month', 'nEarlierQuotes', 'nEarlierObserved', 'partialHistory', 'miroDecision', 'watch', 'askDepth', 'dask1', 'asset']) assert.ok(k in x, `${x.tk} logs ${k}`);
  assert.deepEqual(sig.map((x) => [x.tk, x.entryM, x.partialHistory, x.miroDecision, x.miroAgrees]), [['A', 9, false, 'take', true], ['B', 9, false, 'skip', true], ['C', 9, true, 'skip', null], ['D', 9, true, 'take', true], ['E', 9, false, 'take', true]]);
  assert.equal(sig[4].nEarlierQuotes, 0); assert.equal(sig[0].watch.jumped, false);
  r.k.emit('settle', { tk: 'A', result: 'yes', value: 101.5, strike: 100 }); r.k.emit('settle', { tk: 'A', result: 'yes', value: 1, strike: 1 });
  const sv = ledger(r.dir, 'v2').filter((x) => x.t === 'settle_value'); assert.equal(sv.length, 6, 'one per signal (no-fills too) + one value upgrade for A');
  assert.equal(sv[0].settleBps, null, 'the fixture settle carried no value'); const svA = sv.filter((x) => x.tk === 'A'); assert.equal(svA.length, 2); assert.ok(Math.abs(svA[1].settleBps - 150) < 1e-6);
  assert.equal(r.a.snapshot().signals.find((x) => x.tk === 'A').settleBps, svA[1].settleBps);
  const s = r.a.snapshot().stats; assert.deepEqual(s.decisions, { take: 3, skip: 1, unknown: 1 }, 'decisions unchanged by the audit'); assert.equal(s.audit.shadow.partialHistory, 2);
});

test('audit: old ledger rows get an annotation from the recorded books (decision untouched) plus the recorded settle value', () => {
  const dir = tmp(), rec = tmp(), day = path.join(rec, '2026-11-02'); fs.mkdirSync(day, { recursive: true });
  const src = rig({ v2: false, dir }); market(src, 'A', [0.6, 0.7, 0.8, 0.86, 0.85]);
  const k = fakeKalshi(), h = new KalshiH2Paper({ kalshi: k, dir, now: () => CLOSE + 3600e3 }); h.start(); h.stop(); h.running = true;
  const sigA = JSON.parse(fs.readFileSync(path.join(dir, 'v1', 'ledger.jsonl'), 'utf8').split('\n').find((l) => l.includes('"t":"signal"')));
  fs.mkdirSync(path.join(dir, 'v2'), { recursive: true }); // a pre-audit v2 row: decision present, audit fields absent
  fs.writeFileSync(path.join(dir, 'v2', 'ledger.jsonl'), JSON.stringify({ at: 1, v: 'v2', t: 'signal', tk: 'A', series: 'KXBTC15M', asset: 'BTC', bookRx: sigA.bookRx, secLeft: sigA.secLeft, ya: sigA.ya, close: CLOSE, strike: 1, decision: 'skip', maxEarlierAsk: 0.86, dask1: 0.05 }) + '\n');
  const rows = [0.6, 0.7, 0.8, 0.86, 0.85].map((a, i) => JSON.stringify({ rx: OPEN + i * 60e3 + 30e3, t: 'book', tk: 'A', s: 'KXBTC15M', secLeft: 900 - i * 60 - 30, ya: a, yb: a - 0.01 }));
  fs.writeFileSync(path.join(day, 'kalshi.book.154400-777.jsonl'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(day, 'kalshi.market.154400-777.jsonl'), JSON.stringify({ t: 'settle', tk: 'A', result: 'no', value: 0.999, strike: 1, close: CLOSE }) + '\n');
  const a = new KalshiH2V2({ v1: h, kalshi: k, dir, recorderDir: rec, now: () => CLOSE + 3600e3 }); a.start(); a.stop();
  const L = ledger(dir, 'v2'), an = L.filter((x) => x.t === 'annot');
  assert.equal(an.length, 1); assert.equal(an[0].decision, undefined, 'an annotation never carries a decision');
  assert.deepEqual([an[0].entryM, an[0].nEarlierObserved, an[0].miroDecision, an[0].miroMaxEarlierAsk, an[0].miroAgrees], [9, 5, 'skip', 0.86, true]);
  assert.equal(L.filter((x) => x.t === 'signal').length, 1); assert.equal(a.snapshot().signals[0].decision, 'skip');
  assert.ok(Math.abs(L.find((x) => x.t === 'settle_value').settleBps - -10) < 1e-6);
  const b = new KalshiH2V2({ v1: h, kalshi: k, dir, recorderDir: rec, now: () => CLOSE + 3600e3 }); b.start(); b.stop();
  assert.equal(ledger(dir, 'v2').filter((x) => x.t === 'annot' || x.t === 'settle_value').length, 2, 'annotated once');
});
