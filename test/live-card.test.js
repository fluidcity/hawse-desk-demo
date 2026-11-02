'use strict';
// LIVE pilot card: big total / today P&L (America/Los_Angeles day), daily history, server-side downsampling that keeps every
// trade marker, and the pure logic of the zoomable live chart (time frames, zoom / pan clamping, ticks, label placement).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveHistory, ptDay, dayKeysBack, downsample } = require('../server/live/kalshi-live-history');
const LC = require('../public/livechart');
const UI = require('../public/pilot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'livecard-'));
const Z = (s) => Date.parse(s);
const settle = (at, pnlCents, tk = 'KXBTC15M-X') => ({ t: 'settle', at, tk, win: pnlCents > 0, contracts: 5, pnlMicros: pnlCents * 10000 });
const fill = (at, tk = 'KXBTC15M-X') => ({ t: 'fill', at, tk, count: 5, priceMicros: 940000, costMicros: 4700000, feeMicros: 20000 });

// ---- America/Los_Angeles calendar day ----------------------------------------------------------------------------------------
test('ptDay: midnight PT boundaries, both sides of the DST change (PDT 07:00Z, PST 08:00Z)', () => {
  assert.equal(ptDay(Z('2026-11-01T06:59:59.999Z')), '2026-10-31', '23:59:59 PDT');
  assert.equal(ptDay(Z('2026-11-01T07:00:00Z')), '2026-11-01', '00:00 PDT');
  // Nov 1 2026 is the DST end day (25 hours long): 01:30 happens twice and the day ends at 08:00Z
  assert.equal(ptDay(Z('2026-11-01T09:30:00Z')), '2026-11-01', '01:30 PST (second one)');
  assert.equal(ptDay(Z('2026-11-02T07:59:59Z')), '2026-11-01', '23:59:59 PST');
  assert.equal(ptDay(Z('2026-11-02T08:00:00Z')), '2026-11-02', '00:00 PST');
  // DST start (Mar 8 2026, a 23-hour day)
  assert.equal(ptDay(Z('2026-03-08T07:59:59Z')), '2026-03-07'); assert.equal(ptDay(Z('2026-03-08T08:00:00Z')), '2026-03-08');
  assert.equal(ptDay(Z('2026-03-09T06:59:59Z')), '2026-03-08'); assert.equal(ptDay(Z('2026-03-09T07:00:00Z')), '2026-03-09');
  assert.equal(ptDay(NaN), null);
});

test('dayKeysBack: 7 PT calendar days ending today, across month and DST changes', () => {
  assert.deepEqual(dayKeysBack('2026-11-02', 7), ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(dayKeysBack('2026-03-09', 3), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(dayKeysBack('2027-01-01', 2), ['2026-12-31', '2027-01-01']);
});

test('P&L summary: total = every settle line (fees already in pnl), today = this PT day only, record and fills', () => {
  let now = Z('2026-11-02T08:30:00Z'); // 00:30 PST Nov 2
  const h = new LiveHistory({ dir: tmp(), now: () => now });
  h.noteRow(fill(Z('2026-11-02T07:40:00Z'))); h.noteRow(settle(Z('2026-11-02T07:55:00Z'), 28)); // 23:55 PST Nov 1 -> yesterday
  h.noteRow(fill(Z('2026-11-02T08:01:00Z'))); h.noteRow(settle(Z('2026-11-02T08:15:00Z'), -472)); // 00:15 PST Nov 2 -> today
  h.noteRow(fill(Z('2026-10-30T20:00:00Z'))); h.noteRow(settle(Z('2026-10-30T20:15:00Z'), 100));
  h.noteRow({ t: 'transfer', at: now, amountCents: 7000, from: 0, to: 2, outcome: 'accepted' }); // not P&L
  const s = h.view().pnl;
  assert.equal(s.totalCents, 28 - 472 + 100); assert.equal(s.today, '2026-11-02'); assert.equal(s.todayCents, -472);
  assert.equal(s.todaySettled, 1); assert.equal(s.wins, 2); assert.equal(s.losses, 1); assert.equal(s.settled, 3); assert.equal(s.fills, 3);
  assert.equal(Math.round(s.winRate * 1000), 667); assert.equal(s.tz, 'America/Los_Angeles');
  assert.equal(s.daily.length, 7); assert.deepEqual(s.daily.map((d) => d.day), dayKeysBack('2026-11-02', 7));
  const by = Object.fromEntries(s.daily.map((d) => [d.day, d]));
  assert.deepEqual(by['2026-11-01'], { day: '2026-11-01', trades: 1, wins: 1, losses: 0, pnlCents: 28, fills: 1 });
  assert.deepEqual(by['2026-11-02'], { day: '2026-11-02', trades: 1, wins: 0, losses: 1, pnlCents: -472, fills: 1 });
  assert.deepEqual(by['2026-10-30'], { day: '2026-10-30', trades: 1, wins: 1, losses: 0, pnlCents: 100, fills: 1 });
  assert.deepEqual(by['2026-10-31'], { day: '2026-10-31', trades: 0, wins: 0, losses: 0, pnlCents: null, fills: 0 }, 'a day without settles has no number');
  // one minute before midnight the same settle still counts as today; one minute after it is yesterday
  now = Z('2026-11-02T07:59:00Z'); assert.equal(h.view().pnl.todayCents, 28, '23:59 PST Nov 1: only the 23:55 settle is today');
  now = Z('2026-11-03T08:01:00Z'); const n = h.view().pnl; assert.equal(n.today, '2026-11-03'); assert.equal(n.todayCents, null, 'no settles today -> no number'); assert.equal(n.totalCents, -344);
});

test('P&L summary with no settles: every number is null (the card shows "—"), never 0', () => {
  const h = new LiveHistory({ dir: tmp(), now: () => Z('2026-11-01T20:00:00Z') }); h.noteRow(fill(Z('2026-11-01T19:00:00Z')));
  const s = h.view().pnl; assert.equal(s.totalCents, null); assert.equal(s.todayCents, null); assert.equal(s.winRate, null); assert.equal(s.fills, 1); assert.equal(s.settled, 0);
});

// ---- downsampling that keeps markers -----------------------------------------------------------------------------------------
test('downsample: first and last kept, the read every marker sits on kept, the recent day denser, never above budget + markers', () => {
  const t0 = Z('2026-10-20T00:00:00Z'), pts = []; for (let i = 0; i < 5000; i++) pts.push({ at: t0 + i * 4 * 60000, kind: 'shard', exchangeIndex: 2, cashCents: 5000 + i });
  const keep = [t0 + 1234 * 240000 + 1000, t0 + 4000 * 240000 + 5]; const out = downsample(pts, 800, keep);
  assert.ok(out.length <= 800 + keep.length, String(out.length)); assert.equal(out[0], pts[0]); assert.equal(out[out.length - 1], pts[pts.length - 1]);
  for (const k of keep) { const i = pts.findIndex((p) => p.at >= k); assert.ok(out.includes(pts[i]), 'the first read at or after the marker'); }
  for (let i = 1; i < out.length; i++) assert.ok(out[i].at > out[i - 1].at, 'time order');
  const last = pts[pts.length - 1].at, recent = out.filter((p) => p.at > last - 86400000).length; assert.ok(recent >= 300, 'last 24 h keeps at least ~half the budget: ' + recent);
  assert.equal(downsample(pts.slice(0, 10), 800, []).length, 10, 'small inputs unchanged');
});

test('feed: every fill / settle marker is sent (compact) even after the tx list is trimmed; /api/state stays small', () => {
  let t = Z('2026-10-25T00:00:00Z'); const h = new LiveHistory({ dir: tmp(), now: () => t });
  for (let i = 0; i < 5000; i++) { t += 120000; h.record('shard read', 'shard', { cents: 5000 + (i % 97), portfolioValueCents: i % 5 }, 2); }
  for (let i = 0; i < 1200; i++) { h.noteRow(fill(t - i * 300000)); h.noteRow(settle(t - i * 300000 + 1000, i % 3 ? 20 : -30)); }
  const v = h.view(), bytes = Buffer.byteLength(JSON.stringify(v));
  assert.equal(v.marks.length, 2400, 'all 1200 fills + 1200 settles'); assert.ok(v.points.length <= 800 + 2400); assert.ok(!('src' in v.points[0]), 'no read-source text in the feed');
  assert.ok(bytes < 450000, 'view is ' + bytes + ' bytes'); assert.equal(v.tx.length, 40);
  const m = LC.unpackMark(v.marks.find((x) => x[1] === 'settle')); assert.ok(/^(WIN|LOSS) /.test(m.label)); assert.ok(Number.isFinite(m.amountCents));
  assert.strictEqual(h.view().points, h.view().points, 'cached between pushes (no re-downsampling every 1.5 s)');
  h.noteRow(settle(t + 1, 5)); assert.equal(h.view().marks.length, 2401, 'a new ledger row refreshes the cache');
});

// ---- chart math ----------------------------------------------------------------------------------------------------------------
const HOUR = 3600000, DAY = 24 * HOUR;
test('time frames: 1H / 6H / 1D / 1W / All windows end at the newest data and never start before it', () => {
  const x0 = Z('2026-10-20T00:00:00Z'), x1 = Z('2026-11-01T12:00:00Z');
  assert.deepEqual(LC.tfWindow('1H', x0, x1), { x0: x1 - HOUR, x1 }); assert.deepEqual(LC.tfWindow('6H', x0, x1), { x0: x1 - 6 * HOUR, x1 });
  assert.deepEqual(LC.tfWindow('1D', x0, x1), { x0: x1 - DAY, x1 }); assert.deepEqual(LC.tfWindow('1W', x0, x1), { x0: x1 - 7 * DAY, x1 });
  assert.deepEqual(LC.tfWindow('All', x0, x1), { x0, x1 }); assert.deepEqual(LC.tfWindow('1W', x1 - 3 * HOUR, x1), { x0: x1 - 3 * HOUR, x1 }, 'short data: clamped');
  assert.deepEqual(LC.TFS, ['1H', '6H', '1D', '1W', 'All']);
});

test('default time frame: All when everything fits in a day, 1D when the last day has data, All when the last day is empty', () => {
  const x1 = Z('2026-11-01T12:00:00Z');
  assert.equal(LC.defaultTf([x1 - 5 * HOUR, x1]), 'All');
  assert.equal(LC.defaultTf([x1 - 9 * DAY, x1 - 2 * HOUR, x1 - HOUR, x1]), '1D');
  assert.equal(LC.defaultTf([x1 - 9 * DAY, x1 - 3 * DAY, x1]), 'All', 'only one read in the last day');
  assert.equal(LC.defaultTf([]), 'All');
});

test('zoom anchored at the pointer: the time under the pointer stays put; clamped to the data and a 2-minute minimum', () => {
  const b = { x0: 0, x1: 100 * HOUR }, v = { x0: 40 * HOUR, x1: 60 * HOUR }, a = 45 * HOUR;
  const z = LC.zoomAt(v, a, 0.5, b); assert.equal(z.x1 - z.x0, 10 * HOUR); assert.ok(Math.abs((a - z.x0) / (z.x1 - z.x0) - 0.25) < 1e-9, 'anchor at the same fraction');
  const out = LC.zoomAt(v, a, 100, b); assert.deepEqual(out, b, 'zoom out stops at all data');
  const tiny = LC.zoomAt(v, a, 1e-9, b); assert.equal(tiny.x1 - tiny.x0, LC.MIN_SPAN_MS); assert.equal(LC.MIN_SPAN_MS, 2 * 60000);
  const edge = LC.zoomAt({ x0: 0, x1: 10 * HOUR }, 0, 2, b); assert.equal(edge.x0, 0); assert.equal(edge.x1, 20 * HOUR);
});

test('pan: shifts by time, never past the first or last data point, keeps the span', () => {
  const b = { x0: 0, x1: 100 }, v = { x0: 40, x1: 60 };
  assert.deepEqual(LC.panBy(v, 10, b), { x0: 50, x1: 70 }); assert.deepEqual(LC.panBy(v, 1000, b), { x0: 80, x1: 100 }); assert.deepEqual(LC.panBy(v, -1000, b), { x0: 0, x1: 20 });
  assert.deepEqual(LC.clampView({ x0: -5, x1: 300 }, b), { x0: 0, x1: 100 });
  assert.deepEqual(LC.pxToTime(195, { x0: 0, x1: 100 }, { L: 0, W: 390 }), 50);
});

test('Y axis auto-scales to the visible window (including the step value carried in from the left)', () => {
  const s = [{ pts: [[0, 10], [10, 50], [20, 12], [30, 13]] }];
  const r = LC.yRange(s, { x0: 21, x1: 30 }); assert.ok(r.lo <= 12 && r.lo > 11, JSON.stringify(r)); assert.ok(r.hi >= 13 && r.hi < 14, JSON.stringify(r));
  const all = LC.yRange(s, { x0: 0, x1: 30 }); assert.ok(all.hi >= 50 && all.lo <= 10);
  const flat = LC.yRange([{ pts: [[0, 5], [10, 5]] }], { x0: 0, x1: 10 }); assert.ok(flat.hi - flat.lo >= 0.5, 'a flat line still gets a visible range');
});

test('axis ticks adapt to the width: fewer on a phone, never closer than the minimum spacing; PT labels', () => {
  const x1 = Z('2026-11-01T20:00:00Z'), x0 = x1 - DAY;
  const ph = LC.timeTicks(x0, x1, 330), dk = LC.timeTicks(x0, x1, 1200);
  assert.ok(ph.length >= 2 && ph.length <= 5, 'phone ' + ph.length); assert.ok(dk.length > ph.length, 'desktop ' + dk.length);
  for (const T of [ph, dk]) { const w = T === ph ? 330 : 1200; for (let i = 1; i < T.length; i++) assert.ok(((T[i].t - T[i - 1].t) / DAY) * w >= LC.MIN_TICK_PX - 1e-6); }
  assert.ok(ph.every((x) => typeof x.label === 'string' && x.label.length <= 6), ph.map((x) => x.label).join(','));
  const days = LC.timeTicks(x1 - 7 * DAY, x1, 330); assert.ok(days.every((x) => /^[A-Z][a-z]{2} \d{1,2}$/.test(x.label)), days.map((x) => x.label).join(','));
  for (const x of days) assert.equal(new Date(x.t).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }), '00:00', 'day ticks on PT midnight');
  const v = LC.valueTicks(60, 80, 160); assert.ok(v.length >= 2 && v.length <= 6); for (let i = 1; i < v.length; i++) assert.ok(v[i] > v[i - 1]);
});

test('marker labels never overlap: a label that would collide is dropped (its marker dot stays)', () => {
  const items = [{ x: 100, y: 50, w: 70, h: 12 }, { x: 120, y: 52, w: 70, h: 12 }, { x: 260, y: 50, w: 70, h: 12 }, { x: 380, y: 50, w: 70, h: 12 }];
  const keep = LC.placeLabels(items, { W: 390, T: 0, H: 200 });
  assert.deepEqual(keep.map((k) => k.i), [0, 2, 3]);
  for (const k of keep) { assert.ok(k.bx >= 0 && k.bx + k.w <= 390, 'inside the canvas'); }
  for (let i = 0; i < keep.length; i++) for (let j = i + 1; j < keep.length; j++) { const a = keep[i], c = keep[j]; assert.ok(a.bx + a.w <= c.bx || c.bx + c.w <= a.bx || a.by + a.h <= c.by || c.by + c.h <= a.by); }
});

test('crosshair: step value at a time, nearest marker within reach, tooltip text has PT time, $ and the trade label', () => {
  const pts = [[0, 10], [100, 20]]; assert.equal(LC.valueAt(pts, -1), null); assert.equal(LC.valueAt(pts, 50), 10); assert.equal(LC.valueAt(pts, 150), 20);
  const marks = [{ x: 10, y: 1, label: 'buy 5 @94c' }, { x: 60, y: 1, label: 'WIN +$0.28', kind: 'settle' }];
  assert.equal(LC.nearestMark(marks, (t) => t, (y) => y, 58, 1, 12).label, 'WIN +$0.28'); assert.equal(LC.nearestMark(marks, (t) => t, (y) => y, 35, 1, 12), null);
  const at = Z('2026-11-01T21:05:07Z'), tip = LC.tipLines(at, [{ name: 'pilot pool cash', v: 72.78 }], { label: 'WIN +$0.28', tk: 'KXETH15M' });
  assert.equal(tip[0], 'Nov 1 13:05:07 PT'); assert.ok(tip.includes('pilot pool cash $72.78')); assert.ok(tip.some((l) => /WIN \+\$0\.28/.test(l)));
});

// ---- card ------------------------------------------------------------------------------------------------------------------------
const snap = (pnl, extra = {}) => {
  const t1 = Z('2026-11-01T20:00:00Z'), pts = []; for (let i = 0; i < 6; i++) pts.push({ at: t1 - (5 - i) * HOUR, kind: 'shard', exchangeIndex: 2, cashCents: 7000 + i * 10 });
  return { state: 'DISARMED', statusChip: 'DISARMED-SHADOW', config: { balanceExchangeIndex: 2, armPhrase: 'ARM LIVE' }, money: { bankrollCents: 7050, openRiskCents: 0, ...(extra.money || {}) },
    live: { count: 6, first: pts[0].at, last: t1, points: pts, tx: [], marks: [[t1 - 2 * HOUR, 'fill', 'neutral', 'buy 5 @94c', 'KX', -472], [t1 - HOUR, 'settle', 'pos', 'WIN +$0.28', 'KX', 28]], pnl } };
};
const PNL = { tz: 'America/Los_Angeles', today: '2026-11-01', totalCents: 1234, todayCents: -56, todaySettled: 2, wins: 7, losses: 3, settled: 10, fills: 14, winRate: 0.7,
  daily: dayKeysBack('2026-11-01', 7).map((day, i) => ({ day, trades: i, wins: i ? i - 1 : 0, losses: i ? 1 : 0, pnlCents: i ? (i % 2 ? 100 : -50) : null, fills: i })) };

test('card: big REAL MONEY total / today P&L above the chart, green / red by sign, record, win rate, 7-day history', () => {
  const h = UI.render(snap(PNL), { cme: true });
  const head = h.indexOf('data-pl-pnl'), chart = h.indexOf('data-pilot-chart'); assert.ok(head > 0 && chart > head, 'P&L header before the chart');
  assert.match(h, /REAL MONEY \(Kalshi\)/); assert.match(h, /class="pl-pnl-num pos"[^>]*>\+\$12\.34</); assert.match(h, /class="pl-pnl-num neg"[^>]*>−\$0\.56</);
  assert.match(h, /TOTAL P&amp;L/); assert.match(h, /TODAY/); assert.match(h, /7W–3L/); assert.match(h, /70% win rate/); assert.match(h, /10 settled/); assert.match(h, /14 fills/);
  const rows = h.match(/<tr data-pl-day="/g) || []; assert.equal(rows.length, 7); assert.match(h, /data-pl-day="2026-10-26"[^]*?<td[^>]*>—<\/td>/, 'empty day shows a dash');
  assert.ok(!/open risk now/.test(h), 'open risk hidden at $0');
  assert.match(UI.render(snap(PNL, { money: { openRiskCents: 472 } }), { cme: true }), /open risk now <b>\$4\.72<\/b>/);
});

test('card: no settles yet -> dashes, not $0.00', () => {
  const h = UI.render(snap({ ...PNL, totalCents: null, todayCents: null, wins: 0, losses: 0, settled: 0, winRate: null, daily: PNL.daily.map((d) => ({ ...d, trades: 0, wins: 0, losses: 0, pnlCents: null })) }), { cme: true });
  assert.match(h, /class="pl-pnl-num"[^>]*>—</); assert.ok(!/pl-pnl-num[^>]*>[+−]?\$0\.00/.test(h)); assert.match(h, /no settled trades yet/);
});

test('chart toolbar: 1H 6H 1D 1W All, the active one marked; legend below the canvas; interaction hint', () => {
  const h = UI.render(snap(PNL), { cme: true, tf: '6H' });
  for (const k of LC.TFS) assert.match(h, new RegExp(`data-pilot="tf" data-tf="${k}"`));
  assert.match(h, /data-tf="6H" class="pl-tfb on" aria-pressed="true"/); assert.match(h, /data-tf="1D" class="pl-tfb" aria-pressed="false"/);
  assert.ok(h.indexOf('pl-legend') > h.indexOf('data-pilot-chart'), 'legend under the chart'); assert.match(h, /drag to pan/);
  const d = UI.render(snap(PNL), { cme: true }); assert.match(d, /data-tf="All" class="pl-tfb on"/, 'default: All (5 h of data fits in a day)');
  const sp = UI.liveSpec(snap(PNL)); assert.equal(sp.marks.length, 2, 'markers from the compact list'); assert.equal(sp.marks[1].label, 'WIN +$0.28');
});

test('CSS: tap targets >= 44px, pan-y on the chart (page still scrolls), biggest numbers on the card are the P&L, no sideways scroll', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.pl-tfb\{[^}]*min-height:44px/); assert.match(css, /\.pl-lc\{[^}]*touch-action:pan-y/);
  const px = (re) => { const m = css.match(re); return m ? +m[1] : 0; };
  const big = px(/\.pl-pnl-num\{[^}]*font-size:clamp\((\d+)px/); assert.ok(big >= 34, 'P&L font ' + big);
  const others = [...css.matchAll(/\.a-pilot [^{]*\{[^}]*font-size:(\d+)px/g)].map((m) => +m[1]); assert.ok(Math.max(...others) < big, 'nothing else on the card is bigger: ' + Math.max(...others));
  assert.match(css, /\.pl-pnl\{[^}]*overflow-wrap:anywhere/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'livechart.js'), 'utf8');
  assert.match(js, /devicePixelRatio/); assert.match(js, /ResizeObserver|orientationchange/); assert.match(js, /wheel/); assert.match(js, /dblclick/);
  assert.ok(!/https?:\/\//.test(js.replace(/\/\/.*$/gm, '')), 'no CDN / network'); const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('livechart.js') > 0 && html.indexOf('livechart.js') < html.indexOf('pilot.js'), 'loaded before pilot.js');
});
