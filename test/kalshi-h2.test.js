'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { KalshiH2Paper, loadFrozen, FROZEN, DEFAULT_FILE } = require('../server/kalshi-h2');
const S = require('../server/kalshi-h2/stats');

// Pinned SEPARATELY from the code: editing config/frozen/kalshi-h2-v1.json (or the code's pin) breaks this test.
const V1_SHA256 = '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2-'));
function fakeKalshi() { const L = { book: [], settle: [], market: [], series: [] }; return { L, tracked: [], on(k, f) { L[k].push(f); }, track(m) { this.tracked.push(m.ticker); }, emit(k, x) { for (const f of L[k]) f(x); } }; }
function rig() {
  const dir = tmp(); let t = Date.parse('2026-11-02T15:00:00Z'); const clock = { now: () => t, set: (x) => (t = x) };
  const k = fakeKalshi(); const h = new KalshiH2Paper({ kalshi: k, dir, now: clock.now }); h.start(); h.stop(); h.running = true; // no timers in tests; tick() called by hand
  return { dir, k, h, clock };
}
// one book event; close fixed so secLeft is derived from the fake clock
function book(r, tk, secLeft, ya, yas = 50, series = 'KXBTC15M', ladder) {
  const close = Date.parse('2026-11-02T16:00:00Z'); r.clock.set(close - secLeft * 1000);
  r.k.emit('book', { tk, series, rx: r.clock.now(), sent: r.clock.now() - 50, close, secLeft, strike: 1, ya, yas, yb: ya == null ? null : ya - 0.01, ybs: 10, askLadder: ladder || (ya == null ? [] : [[ya, yas], [Math.min(0.999, ya + 0.004), 100]]) });
}
const seq = (r, tk, from, to, ya, series = 'KXBTC15M') => { for (let t = from; t >= to; t--) book(r, tk, t, ya, 50, series); };
const rows = (r) => fs.readFileSync(path.join(r.dir, 'v1', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('frozen config: file hash equals the pin in the test AND in the code; edits are refused (new version required)', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(DEFAULT_FILE)).digest('hex');
  assert.equal(sha, V1_SHA256, 'config/frozen/kalshi-h2-v1.json was edited after the freeze: make kalshi-h2-v2.json with a new hash instead');
  assert.equal(FROZEN['kalshi-h2-v1'], V1_SHA256);
  const { cfg, hash } = loadFrozen(); assert.equal(hash, V1_SHA256); assert.equal(cfg.mode, 'paper-only'); assert.equal(cfg.liveOrders, false);
  assert.deepEqual([cfg.rule.secondsLeftMin, cfg.rule.secondsLeftMax, cfg.rule.yesAskMin, cfg.rule.yesAskMax], [360, 600, 0.93, 0.979]);
  assert.deepEqual(cfg.rule.series, ['KXBTC15M', 'KXETH15M', 'KXSOL15M']);
  assert.deepEqual([cfg.targets.minWeeks, cfg.targets.minSignals], [8, 2500]);
  // tamper with a copy: one character in the price band
  const d = tmp(), f = path.join(d, 'kalshi-h2-v1.json'); fs.writeFileSync(f, fs.readFileSync(DEFAULT_FILE, 'utf8').replace('"yesAskMin": 0.93', '"yesAskMin": 0.92'));
  assert.throws(() => loadFrozen(f), /edited after the freeze/);
  const h = new KalshiH2Paper({ dir: path.join(d, 'ledger'), file: f }); h.start();
  assert.equal(h.running, false); assert.match(h.error, /edited after the freeze/); assert.equal(fs.existsSync(path.join(d, 'ledger')), false, 'refused run writes no ledger');
  // a new version without a pinned hash is refused too (v2 and v3 are pinned now, so use an unpinned v99)
  const f2 = path.join(d, 'kalshi-h2-v99.json'); fs.writeFileSync(f2, fs.readFileSync(DEFAULT_FILE, 'utf8').replace('"version": "v1"', '"version": "v99"'));
  assert.throws(() => loadFrozen(f2), /no pinned hash/);
});

test('fees: 1-lot is cent-rounded up, large-order is amortized', () => {
  assert.equal(S.fee1(0.95), 0.01); assert.equal(S.fee1(0.93), 0.01); assert.equal(S.fee1(0.979), 0.01); assert.equal(S.fee1(0.5), 0.02); assert.equal(S.fee1(0.7), 0.02);
  assert.ok(Math.abs(S.feeLarge(0.95) - 0.003325) < 1e-12); assert.ok(Math.abs(S.feeLarge(0.5) - 0.0175) < 1e-12);
});

test('signal -> next-snapshot fill -> official settlement; skips are logged with reasons; one entry per market', () => {
  const r = rig();
  // A: books every second from before 600 s left; touches at 580 s -> signal, fills on the NEXT book at the worse of signal ask and next ask
  seq(r, 'A', 605, 581, 0.9); book(r, 'A', 580, 0.95, 30); book(r, 'A', 579, 0.955, 20); book(r, 'A', 578, 0.96);
  // B: first book already inside the window -> joined_late (never a signal)
  book(r, 'B', 500, 0.95);
  // C: 7 s hole inside the window before the touch -> incomplete_coverage
  seq(r, 'C', 603, 599, 0.9); book(r, 'C', 592, 0.94);
  // D: next ask jumps above signal ask + 1c -> no_fill_within_limit
  seq(r, 'D', 602, 598, 0.9); book(r, 'D', 597, 0.94); book(r, 'D', 596, 0.97, 5, 'KXBTC15M', [[0.97, 5]]);
  // E: never touches the band -> observed no_touch
  seq(r, 'E', 602, 359, 0.6);
  // F: signal but the next book comes too late -> fill_snapshot_too_late (by tick)
  seq(r, 'F', 602, 596, 0.9); book(r, 'F', 595, 0.93); r.clock.set(r.clock.now() + 7000); r.h.tick();
  // G (ETH): signal + fill, settles NO (a loss)
  seq(r, 'G', 601, 599, 0.9, 'KXETH15M'); book(r, 'G', 598, 0.97, 8, 'KXETH15M'); book(r, 'G', 597, 0.97, 8, 'KXETH15M');
  // XRP is out of scope for H2
  seq(r, 'X', 605, 590, 0.95, 'KXXRP15M');
  r.k.emit('settle', { tk: 'A', result: 'yes', status: 'finalized', settledAt: r.clock.now() });
  r.k.emit('settle', { tk: 'G', result: 'no', status: 'finalized', settledAt: r.clock.now() });
  r.k.emit('settle', { tk: 'A', result: 'yes', status: 'finalized' }); // duplicate ignored
  const L = rows(r), by = (t) => L.filter((x) => x.t === t);
  assert.deepEqual(by('signal').map((x) => x.tk), ['A', 'D', 'F', 'G']);
  assert.deepEqual(by('fill').map((x) => [x.tk, x.px]), [['A', 0.955], ['G', 0.97]]);
  assert.deepEqual(by('skip').map((x) => [x.tk, x.reason]).sort(), [['B', 'joined_late'], ['C', 'incomplete_coverage'], ['D', 'no_fill_within_limit'], ['F', 'fill_snapshot_too_late']]);
  assert.deepEqual(by('observed').map((x) => [x.tk, x.outcome]), [['E', 'no_touch']]);
  const sA = by('settle').find((x) => x.tk === 'A'), sG = by('settle').find((x) => x.tk === 'G');
  assert.equal(sA.pnl1, 0.035); assert.equal(sA.pnlSpec, 0.04); assert.ok(sA.pnlL > sA.pnl1); assert.equal(sA.source, 'kalshi official result');
  assert.equal(sG.pnl1, -0.98); assert.equal(by('settle').length, 2);
  assert.ok(L.every((x) => x.v === 'v1'));
  const st = r.h.stats();
  assert.equal(st.signals, 4); assert.equal(st.fills, 2); assert.equal(st.settled, 2); assert.equal(st.wins, 1);
  assert.equal(st.meanPnlCents.oneLotFee, -47.25); assert.equal(st.verdict, 'UNVERIFIED — not enough data');
  assert.equal(st.askSize.measured, 4); assert.equal(st.askSize.share, 0.75); // A 30, D 50, F 50 are >= 10; G 8 is not
  // replay: a fresh instance on the same ledger restores everything and does not re-enter A
  const h2 = new KalshiH2Paper({ kalshi: fakeKalshi(), dir: r.dir, now: r.clock.now }); h2.start(); h2.stop(); h2.running = true;
  assert.deepEqual([h2.stats().signals, h2.stats().settled, h2.stats().meanPnlCents.oneLotFee], [4, 2, -47.25]);
  assert.equal(h2.sessions, 2); assert.equal(h2.startAt, r.h.startAt);
});

test('fail-stop: fee schedule or tick change halts new signals and is logged', () => {
  const r = rig();
  r.k.emit('series', { s: 'KXBTC15M', fee_type: 'quadratic', fee_multiplier: 1 }); assert.equal(r.h.halted, null);
  r.k.emit('market', { tk: 'M', series: 'KXBTC15M', pls: 'tapered_deci_cent', ranges: [{ start: '0.0000', end: '0.1000', step: '0.0010' }, { start: '0.1000', end: '0.9000', step: '0.0100' }, { start: '0.9000', end: '1.0000', step: '0.0010' }] });
  assert.equal(r.h.halted, null);
  r.k.emit('series', { s: 'KXBTC15M', fee_type: 'quadratic', fee_multiplier: 1.5 });
  assert.match(r.h.halted, /fee schedule changed/);
  seq(r, 'A', 605, 589, 0.95);
  assert.equal(rows(r).filter((x) => x.t === 'signal').length, 0);
  assert.equal(r.h.stats().verdict, 'FAIL-STOP');
  const r2 = rig(); r2.k.emit('market', { tk: 'M', series: 'KXETH15M', pls: 'linear_cent', ranges: null }); assert.match(r2.h.halted, /tick structure changed/);
});

test('stats: Wilson CI, seeded day bootstrap, weeks/assets, rolling 4-week fail-stop, verdict only after BOTH targets', () => {
  const w = S.wilson(96, 100); assert.ok(w.lo < 0.96 && w.hi > 0.96 && w.lo > 0.9);
  const { cfg } = loadFrozen(); const startAt = Date.parse('2026-11-02T00:00:00Z'), DAY = 86400e3;
  const mk = (nPerDay, days, pnlWin, lossEvery, assets = ['BTC', 'ETH', 'SOL']) => { const trades = [], signals = []; let i = 0;
    for (let d = 0; d < days; d++) for (let k = 0; k < nPerDay; k++, i++) { const at = startAt + d * DAY + k * 60e3, win = i % lossEvery !== 0, asset = assets[i % assets.length];
      signals.push({ tk: 'T' + i, asset, at, ya: 0.95, yas: 25 }); trades.push({ tk: 'T' + i, asset, at, px: 0.95, fee1: 0.01, win, pnl1: win ? pnlWin : -0.96, pnlL: win ? pnlWin + 0.0067 : -0.9533, pnlSpec: win ? pnlWin : -0.96 }); } return { trades, signals }; };
  // 60 days x 45/day = 2700 signals, 1 loss in 40 -> positive
  let x = mk(45, 60, 0.04, 40);
  let st = S.summarize({ cfg, startAt, now: startAt + 60 * DAY, signals: x.signals, fills: x.trades.length, trades: x.trades, skips: {}, unsettled: 0 });
  assert.equal(st.signals, 2700); assert.ok(st.progress.weeks > 8); assert.equal(st.enough, true);
  assert.ok(st.ci95Cents.dayBootstrap.lo != null && st.ci95Cents.dayBootstrap.lo < st.meanPnlCents.oneLotFee && st.ci95Cents.dayBootstrap.hi > st.meanPnlCents.oneLotFee);
  const again = S.summarize({ cfg, startAt, now: startAt + 60 * DAY, signals: x.signals, fills: x.trades.length, trades: x.trades, skips: {}, unsettled: 0 });
  assert.deepEqual(again.ci95Cents, st.ci95Cents, 'bootstrap is seeded/reproducible');
  assert.equal(Object.keys(st.perAsset).length, 3); assert.ok(st.weeks.length >= 8);
  assert.equal(st.verdict, 'PASS (all criteria met)');
  // same data but only 7 weeks elapsed -> UNVERIFIED even with 2,500+ signals
  x = mk(55, 49, 0.04, 40);
  st = S.summarize({ cfg, startAt, now: startAt + 49 * DAY, signals: x.signals, fills: x.trades.length, trades: x.trades, skips: {}, unsettled: 0 });
  assert.ok(st.signals >= 2500); assert.equal(st.verdict, 'UNVERIFIED — not enough data');
  // losing: 1 loss in 10 -> mean < 0 after 2,500 and rolling 4-week loss > 60c/100 -> FAIL-STOP
  x = mk(45, 60, 0.04, 10);
  st = S.summarize({ cfg, startAt, now: startAt + 60 * DAY, signals: x.signals, fills: x.trades.length, trades: x.trades, skips: {}, unsettled: 0 });
  assert.equal(st.verdict, 'FAIL-STOP'); assert.equal(st.failStops.length, 2);
  // thin book: ask size < 10 in most signals fails criterion 5
  x = mk(45, 60, 0.04, 40); for (const s of x.signals) s.yas = 3;
  st = S.summarize({ cfg, startAt, now: startAt + 60 * DAY, signals: x.signals, fills: x.trades.length, trades: x.trades, skips: {}, unsettled: 0 });
  assert.equal(st.criteria.askDepth, false); assert.equal(st.verdict, 'FAIL (criteria not met)');
});

test('engine wiring: kalshiH2 mounts as its own feed (not a desk strategy) and constructs without files', () => {
  const { Engine } = require('../server/engine');
  const config = require('../server/config');
  const cfg = config.build({ KALSHI_H2_DIR: path.join(tmp(), 'never'), RECORDER_DIR: path.join(tmp(), 'rec') });
  const e = new Engine(cfg, { modules: require('../server/modules') });
  assert.ok(e.feeds.kalshiH2); assert.ok(!e.strategies.some((s) => /kalshi/i.test(s.id || s.name || '')));
  assert.equal(fs.existsSync(cfg.kalshiH2.dir), false);
  const snap = e.feeds.kalshiH2.snapshot(); assert.equal(snap.paper, true); assert.match(snap.label, /PAPER/);
});
