'use strict';
// LIVE pilot card: the big TOTAL P&L cycles all time -> this week -> this month -> this year (America/Los_Angeles calendar,
// computed on the desk from the ledger's settle lines). Fixed timestamps around every boundary, both DST changes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LiveHistory, periodStarts, PERIODS, dayKeysBack } = require('../server/live/kalshi-live-history');
const UI = require('../public/pilot');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pnlper-'));
const Z = (s) => Date.parse(s);
const settle = (at, pnlCents) => ({ t: 'settle', at, tk: 'KXBTC15M-X', win: pnlCents > 0, contracts: 5, pnlMicros: pnlCents * 10000 });
const fill = (at) => ({ t: 'fill', at, tk: 'KXBTC15M-X', count: 5, priceMicros: 940000, costMicros: 4700000, feeMicros: 20000 });
const hist = (now, rows) => { const h = new LiveHistory({ dir: tmp(), now: () => now }); for (const r of rows) h.noteRow(r); return h.view().pnl; };

test('periodStarts: Monday / 1st of month / Jan 1 of the PT calendar day, across month, year and DST changes', () => {
  assert.equal(PERIODS.join(), 'all,week,month,year');
  assert.deepEqual(periodStarts('2026-11-01'), { week: '2026-10-26', month: '2026-11-01', year: '2026-01-01' }, 'Sun Nov 1 (DST end) -> Mon Oct 26');
  assert.deepEqual(periodStarts('2026-11-02'), { week: '2026-11-02', month: '2026-11-01', year: '2026-01-01' }, 'a Monday starts its own week');
  assert.deepEqual(periodStarts('2026-03-08'), { week: '2026-03-02', month: '2026-03-01', year: '2026-01-01' }, 'Sun Mar 8 (DST start)');
  assert.deepEqual(periodStarts('2027-01-02'), { week: '2026-12-28', month: '2027-01-01', year: '2027-01-01' }, 'week reaches back into last year');
  assert.deepEqual(periodStarts('2028-02-29'), { week: '2028-02-28', month: '2028-02-01', year: '2028-01-01' }, 'leap day');
});

test('week: since Monday 00:00 PT (PST 08:00Z after DST ends, PDT 07:00Z after it starts); a Sunday 23:59 settle is last week', () => {
  // Mon Nov 2 2026 00:00 PST = 08:00Z
  let s = hist(Z('2026-11-02T20:00:00Z'), [settle(Z('2026-11-02T07:59:59Z'), 100), settle(Z('2026-11-02T08:00:00Z'), -30), settle(Z('2026-11-02T19:00:00Z'), 50)]);
  assert.equal(s.periods.week.since, '2026-11-02'); assert.equal(s.periods.week.cents, 20); assert.equal(s.periods.week.settled, 2);
  assert.equal(s.periods.week.wins, 1); assert.equal(s.periods.week.losses, 1); assert.equal(s.periods.all.cents, 120); assert.equal(s.periods.month.cents, 120, 'Nov 1 23:59 PST is still November');
  assert.match(s.periods.week.label, /this week · since Mon Nov 2/);
  // Mon Mar 9 2026 00:00 PDT = 07:00Z (the week before held the 23-hour DST-start Sunday)
  s = hist(Z('2026-03-11T18:00:00Z'), [settle(Z('2026-03-09T06:59:59Z'), 7), settle(Z('2026-03-09T07:00:00Z'), 9), settle(Z('2026-03-08T09:30:00Z'), 11)]);
  assert.equal(s.periods.week.since, '2026-03-09'); assert.equal(s.periods.week.cents, 9); assert.equal(s.periods.week.settled, 1); assert.equal(s.periods.month.cents, 27);
  // now on the DST-end Sunday itself (25 hours): the second 01:30 still belongs to the week that began Mon Oct 26
  s = hist(Z('2026-11-01T09:45:00Z'), [settle(Z('2026-10-26T06:59:00Z'), 1000), settle(Z('2026-10-26T07:00:00Z'), 5), settle(Z('2026-11-01T09:30:00Z'), 3)]);
  assert.equal(s.periods.week.since, '2026-10-26'); assert.equal(s.periods.week.cents, 8, 'Sun Oct 25 23:59 PDT is excluded');
});

test('month and year: calendar month / year to date in PT; the UTC date does not matter', () => {
  // Nov 1 00:00 PDT = 07:00Z: a settle at 06:59Z is still October 31 in PT (although it is Nov 1 in UTC)
  let s = hist(Z('2026-11-01T18:00:00Z'), [settle(Z('2026-11-01T06:59:59Z'), 400), settle(Z('2026-11-01T07:00:00Z'), -100)]);
  assert.equal(s.periods.month.since, '2026-11-01'); assert.equal(s.periods.month.cents, -100); assert.equal(s.periods.year.cents, 300); assert.equal(s.periods.all.cents, 300);
  assert.match(s.periods.month.label, /this month · Nov 2026/); assert.match(s.periods.year.label, /this year · 2026/);
  // Jan 1 2027 00:00 PST = 08:00Z; on Sat Jan 2 the week (since Mon Dec 28) still holds December's settle, the year does not
  s = hist(Z('2027-01-02T20:00:00Z'), [settle(Z('2027-01-01T07:59:59Z'), 250), settle(Z('2027-01-01T08:00:00Z'), 60), settle(Z('2026-12-27T20:00:00Z'), 999)]);
  assert.equal(s.periods.year.since, '2027-01-01'); assert.equal(s.periods.year.cents, 60); assert.equal(s.periods.month.cents, 60);
  assert.equal(s.periods.week.since, '2026-12-28'); assert.equal(s.periods.week.cents, 310); assert.equal(s.periods.all.cents, 1309);
});

test('periods: real ledger numbers only; a period with no settle is null (card shows "—"), fills and record per period; all = totals', () => {
  const s = hist(Z('2026-11-20T20:00:00Z'), [fill(Z('2026-10-05T18:00:00Z')), settle(Z('2026-10-05T18:15:00Z'), 28), fill(Z('2026-11-03T18:00:00Z')), settle(Z('2026-11-03T18:15:00Z'), -472),
    { t: 'transfer', at: Z('2026-11-20T19:00:00Z'), amountCents: 7000, from: 0, to: 2, outcome: 'accepted' }]);
  assert.equal(s.periods.week.cents, null); assert.equal(s.periods.week.settled, 0); assert.equal(s.periods.week.winRate, null, 'transfers are not P&L');
  assert.equal(s.periods.month.cents, -472); assert.equal(s.periods.month.losses, 1); assert.equal(s.periods.month.fills, 1);
  assert.equal(s.periods.year.cents, -444); assert.equal(s.periods.year.wins, 1); assert.equal(s.periods.year.settled, 2); assert.equal(s.periods.year.winRate, 0.5);
  assert.deepEqual(s.periods.all, { key: 'all', label: 'all time', since: null, cents: s.totalCents, settled: s.settled, wins: s.wins, losses: s.losses, fills: s.fills, winRate: s.winRate });
  const e = hist(Z('2026-11-20T20:00:00Z'), []); for (const k of PERIODS) assert.equal(e.periods[k].cents, null, k);
  assert.equal(e.todayCents, null); assert.equal(e.daily.length, 7, 'today and the 7-day table are unchanged');
});

// ---- the card --------------------------------------------------------------------------------------------------------------
const per = (key, label, cents, w, l) => ({ key, label, since: null, cents, settled: w + l, wins: w, losses: l, fills: w + l + 1, winRate: w + l ? w / (w + l) : null });
const PNL = { tz: 'America/Los_Angeles', today: '2026-11-04', totalCents: 1234, todayCents: -56, todaySettled: 2, wins: 7, losses: 3, settled: 10, fills: 14, winRate: 0.7,
  periods: { all: { ...per('all', 'all time', 1234, 7, 3), fills: 14 }, week: per('week', 'this week · since Mon Nov 2', -80, 1, 2), month: per('month', 'this month · Nov 2026', 300, 4, 1), year: per('year', 'this year · 2026', null, 0, 0) },
  daily: dayKeysBack('2026-11-04', 7).map((day, i) => ({ day, trades: i, wins: i ? i - 1 : 0, losses: i ? 1 : 0, pnlCents: i ? (i % 2 ? 100 : -50) : null, fills: i })) };
const snap = (pnl) => ({ state: 'DISARMED', statusChip: 'DISARMED-SHADOW', live: { pnl, count: 0, points: [], marks: [], tx: [] }, money: {} });

test('card: TOTAL is a real button (Enter / Space, >= 44px), label names the period, hint names the next one; TODAY and 7 days unchanged', () => {
  const h = UI.render(snap(PNL), { cme: true });
  assert.match(h, /<button type="button" class="pl-pnl-box pl-pnl-cyc" data-pilot="pnl-period" data-period="all" data-next="week" aria-label="TOTAL P&amp;L all time: \+\$12\.34\. Tap to show this week"/);
  assert.match(h, /TOTAL P&amp;L <span class="dim">· all time<\/span>/); assert.match(h, /tap to change · next: week/);
  assert.match(h, /class="pl-pnl-num pos"[^>]*>\+\$12\.34</); assert.match(h, /7W–3L · 70% win rate · 10 settled · 14 fills/);
  const w = UI.render(snap(PNL), { cme: true, pnlPeriod: 'week' });
  assert.match(w, /data-period="week" data-next="month"/); assert.match(w, /TOTAL P&amp;L <span class="dim">· this week · since Mon Nov 2 PT<\/span>/);
  assert.match(w, /class="pl-pnl-num neg"[^>]*>−\$0\.80</); assert.match(w, /this week: 1W–2L · 33% win rate · 3 settled · 4 fills/, 'the record follows the period');
  const m = UI.render(snap(PNL), { cme: true, pnlPeriod: 'month' }); assert.match(m, /data-next="year"/); assert.match(m, /\+\$3\.00/); assert.match(m, /this month: 4W–1L/);
  const y = UI.render(snap(PNL), { cme: true, pnlPeriod: 'year' }); assert.match(y, /data-next="all"/); assert.match(y, /class="pl-pnl-num"[^>]*>—</, 'no settle this year -> dash');
  assert.match(y, /this year: no settled trades yet/); assert.ok(!/pl-pnl-num[^>]*>[+−]?\$0\.00/.test(y));
  for (const x of [h, w, m, y]) { assert.match(x, /class="pl-pnl-num neg"[^>]*>−\$0\.56</, 'TODAY stays'); assert.equal((x.match(/<tr data-pl-day="/g) || []).length, 7); }
  const bad = UI.render(snap(PNL), { cme: true, pnlPeriod: 'decade' }); assert.match(bad, /data-period="all"/, 'unknown -> all time');
  const old = UI.render(snap({ ...PNL, periods: undefined }), { cme: true, pnlPeriod: 'week' }); assert.match(old, /data-period="all"/); assert.match(old, /\+\$12\.34/);
  assert.equal(UI.nextPeriod('all'), 'week'); assert.equal(UI.nextPeriod('week'), 'month'); assert.equal(UI.nextPeriod('month'), 'year'); assert.equal(UI.nextPeriod('year'), 'all');
});

test('card wiring: the choice persists in localStorage; the cycle button is >= 44px and shows focus', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'pilot.js'), 'utf8');
  assert.match(js, /localStorage\.getItem\('hawse\.pilot\.pnlPeriod'\)/); assert.match(js, /localStorage\.setItem\('hawse\.pilot\.pnlPeriod'/);
  assert.match(js, /b\.dataset\.pilot === 'pnl-period'/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.pl-pnl-cyc\{[^}]*min-height:44px/); assert.match(css, /\.pl-pnl-cyc\{[^}]*cursor:pointer/); assert.match(css, /\.pl-pnl-cyc:focus-visible\{[^}]*outline/);
});
