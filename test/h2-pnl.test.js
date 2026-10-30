'use strict';
// H7 Stage K: live P&L view on the frozen H2 card (display only; paper fills only; realized vs unrealized kept apart).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { KalshiH2Paper, loadFrozen, DEFAULT_FILE } = require('../server/kalshi-h2');
const S = require('../server/kalshi-h2/stats');
const V1 = '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c';
const DAY = 86400e3, WEEK = 7 * DAY, HOUR = 3600e3;
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(DEFAULT_FILE)).digest('hex');

function fakeKalshi() { const L = { book: [], settle: [], market: [], series: [] }; return { L, on(k, f) { L[k].push(f); }, track() {}, emit(k, x) { for (const f of L[k]) f(x); } }; }
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2pnl-')); let t = Date.parse('2026-11-02T15:00:00Z'); const clock = { now: () => t, set: (x) => (t = x) };
  const k = fakeKalshi(); const h = new KalshiH2Paper({ kalshi: k, dir, now: clock.now }); h.start(); h.stop(); h.running = true;
  return { dir, k, h, clock };
}
const close = Date.parse('2026-11-02T16:00:00Z');
function book(r, tk, secLeft, ya, yb = ya == null ? null : ya - 0.01) {
  r.clock.set(close - secLeft * 1000);
  r.k.emit('book', { tk, series: 'KXBTC15M', rx: r.clock.now(), close, secLeft, strike: 1, ya, yas: 50, yb, ybs: 10, askLadder: ya == null ? [] : [[ya, 50]] });
}

test('open paper fill is marked to the bid as UNREALIZED and never enters realized; settlement moves it to realized', () => {
  const r = rig();
  for (let s = 605; s >= 581; s--) book(r, 'A', s, 0.9);
  book(r, 'A', 580, 0.95); book(r, 'A', 579, 0.955); // signal at 0.95, fill on the next book at 0.955
  let P = r.h.snapshot().pnl; assert.equal(P.unrealized.open.length, 1);
  book(r, 'A', 300, 0.97, 0.95); // later book: bid 0.95
  P = r.h.snapshot().pnl; const o = P.unrealized.open[0];
  assert.equal(o.tk, 'A'); assert.equal(o.px, 0.955); assert.equal(o.mark, 0.95);
  // 0.95 bid − 0.955 entry − 0.01 entry fee − 0.01 exit fee at the bid = −2.5¢
  assert.equal(o.unrealizedCents, -2.5); assert.equal(P.unrealized.totalCents, -2.5);
  assert.deepEqual([P.realizedCents.total, P.realizedCents.n, P.curve.length], [0, 0, 0], 'unrealized is not realized');
  assert.match(P.unrealized.note, /not realized/); assert.match(P.source, /paper fills only/);
  r.k.emit('settle', { tk: 'A', result: 'yes', status: 'finalized', settledAt: r.clock.now() });
  P = r.h.snapshot().pnl;
  assert.equal(P.unrealized.open.length, 0); assert.equal(P.unrealized.totalCents, null); assert.equal(r.h.marks.size, 0);
  assert.equal(P.realizedCents.total, 3.5); assert.equal(P.realizedCents.today, 3.5); assert.equal(P.realizedCents.thisWeek, 3.5);
  assert.deepEqual(P.curve.map((p) => [p.tk, p.cumCents]), [['A', 3.5]]);
  // an open fill with no book since the fill shows "unmarked", not a made-up mark
  const P2 = S.livePnl({ fills: [{ tk: 'Z', px: 0.95, fee1: 0.01, at: 1, settled: false }], now: 2, startAt: 1 });
  assert.equal(P2.unrealized.open[0].mark, null); assert.equal(P2.unrealized.open[0].unrealizedCents, null); assert.equal(P2.unrealized.unmarked, 1); assert.equal(P2.unrealized.totalCents, null);
  assert.equal(r.h.snapshot().stats.verdict, 'UNVERIFIED — not enough data');
});

test('cumulative realized curve is in settle order; today / this test week / total split correctly', () => {
  const startAt = Date.parse('2026-11-02T08:00:00Z'), now = startAt + 8 * DAY + 5 * HOUR; // in test week 2
  const T = (tk, sAt, pnl1) => ({ tk, settledAt: sAt, at: sAt, pnl1 });
  const trades = [T('c', now - HOUR, -0.98), T('a', startAt + DAY, 0.04), T('b', startAt + 7 * DAY + HOUR, 0.03), T('d', now - 2 * HOUR, 0.02)];
  const dayStartMs = () => now - 3 * HOUR; // pin "today" so the test does not depend on the box time zone
  const P = S.livePnl({ trades, now, startAt, dayStartMs });
  assert.deepEqual(P.curve.map((p) => p.tk), ['a', 'b', 'd', 'c']);
  assert.deepEqual(P.curve.map((p) => p.cumCents), [4, 7, 9, -89]);
  assert.equal(P.realizedCents.total, -89); assert.equal(P.realizedCents.today, -96); assert.equal(P.realizedCents.thisWeek, -93); assert.equal(P.realizedCents.n, 4);
  // default "today" is box-local midnight
  const P0 = S.livePnl({ trades, now, startAt }); const d = new Date(now); d.setHours(0, 0, 0, 0);
  assert.equal(P0.realizedCents.today, Math.round(trades.filter((t) => t.settledAt >= d.getTime()).reduce((a, t) => a + t.pnl1 * 100, 0) * 1e6) / 1e6);
});

test('per-week table (signals, win rate, net) drives the 6-of-8 positive-weeks criterion; UNVERIFIED kept; frozen file untouched', () => {
  assert.equal(sha(), V1);
  const { cfg } = loadFrozen(), startAt = Date.parse('2026-11-02T00:00:00Z');
  const signals = [], trades = [];
  for (let w = 0; w < 3; w++) for (let i = 0; i < 4; i++) {
    const at = startAt + w * WEEK + i * HOUR, win = w !== 1 || i === 0, px = 0.95, fee = S.fee1(px, cfg.fees.rate);
    signals.push({ tk: `T${w}${i}`, at, ya: px, yas: 50 });
    if (i < 3) trades.push({ tk: `T${w}${i}`, at, px, fee1: fee, win, pnl1: (win ? 1 : 0) - px - fee, pnlL: 0, pnlSpec: 0 });
  }
  const now = startAt + 4 * WEEK + DAY; // week 4 complete with no trades, week 5 in progress
  const st = S.summarize({ cfg, startAt, now, signals, fills: trades.length, trades, skips: {}, unsettled: 0 });
  const W = st.weekTable;
  assert.deepEqual(W.map((w) => w.week), [1, 2, 3, 4, 5]);
  assert.deepEqual(W.map((w) => w.signals), [4, 4, 4, 0, 0]);
  assert.deepEqual(W.map((w) => w.settled), [3, 3, 3, 0, 0]);
  assert.deepEqual(W.map((w) => w.winRate), [1, 0.333333, 1, null, null]);
  assert.deepEqual(W.map((w) => w.netCents), [12, -188, 12, 0, 0]);
  assert.deepEqual(W.map((w) => w.complete), [true, true, true, true, false]);
  assert.deepEqual(W.map((w) => w.positive), [true, false, true, false, false]);
  const pw = st.miro.find((m) => m.key === 'positiveWeeks');
  assert.equal(pw.value, W.filter((w) => w.complete && w.week <= 8 && w.positive).length);
  assert.equal(pw.value, 2); assert.equal(pw.status, 'pending', '2 positive of 4 complete + 4 weeks left = 6 still reachable');
  // one more complete non-positive week makes 6 of 8 unreachable → not met (decided early)
  const st2 = S.summarize({ cfg, startAt, now: startAt + 5 * WEEK + DAY, signals, fills: trades.length, trades, skips: {}, unsettled: 0 });
  assert.equal(st2.miro.find((m) => m.key === 'positiveWeeks').status, 'not met'); assert.equal(st2.weekTable.filter((w) => w.complete).length, 5);
  // never PASS before 8 weeks + 2,500 signals (this sample also trips the frozen rolling-4-week fail-stop, which still shows)
  assert.equal(st.enough, false); assert.ok(['UNVERIFIED — not enough data', 'FAIL-STOP'].includes(st.verdict)); assert.doesNotMatch(st.verdict, /PASS/);
  assert.equal(sha(), V1, 'frozen v1 file unchanged');
});

test('H2 card UI: live P&L block labels realized vs UNREALIZED, PAPER, and keeps UNVERIFIED until enough data', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), fn = js.slice(js.indexOf('function h2Pnl('), js.indexOf('function renderGaps('));
  assert.ok(fn.length > 100, 'h2Pnl present'); assert.ok(js.includes('h2Pnl(H, c, pc)'), 'wired into the H2 card');
  for (const s of ['UNREALIZED', 'NOT in realized', 'PAPER', 'realized total', 'Per test week', 'st.enough && !st.failStops.length ? \'\' : \' <span class="badge stale">UNVERIFIED</span>\'']) assert.ok(fn.includes(s), s);
  assert.doesNotMatch(fn, /fetch\(|POST/, 'display only');
});
