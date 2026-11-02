'use strict';
// P&L headlines (display only): ledger realized-event history, the per-strategy board, and the card/header renderers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Ledger } = require('../server/lib/ledger');
const { pnlBoard, spark, localMidnight } = require('../server/lib/pnl-board');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('ledger flows: every realized change is recorded, per book, and sums to realized; totals unchanged', () => {
  const L = new Ledger({ startEquity: 10000 });
  L.charge('a', { amount: 2, simulated: false }); L.cashflow('a', { amount: 0.5, simulated: false }); L.close('a', { pnl: 10, simulated: false });
  L.close('a', { pnl: -3, simulated: true }); L.close('b', { pnl: 7, simulated: true });
  const sum = (id, sim) => L.flowsOf(id, sim).reduce((x, [, v]) => x + v, 0);
  assert.equal(sum('a', false), L.book('a').real.realized); assert.equal(sum('a', true), L.book('a').sim.realized); assert.equal(sum('b', true), 7);
  assert.equal(L.flowsOf('b', false).length, 0, 'no real events for a SIM-only book');
  const t = L.totals(); assert.equal(t.realPnl, 8.5); assert.equal(t.simPnl, 4);
  for (let i = 0; i < 4100; i++) L.close('c', { pnl: 1, simulated: false });
  assert.ok(L.flowsOf('c', false).length <= 4000); assert.equal(sum('c', false), 4100, 'bounded history keeps the sum');
});

test('pnlBoard: today / 7d windows, 7d not covered on a young desk, SIM and real kept apart, no events = 0 events', () => {
  const now = Date.UTC(2026, 9, 30, 20), L = new Ledger({ startEquity: 10000 });
  const midnight = localMidnight(now);
  L.close('x', { pnl: 5, simulated: false }); L.flows.get('x|real')[0][0] = midnight - 3600e3; // yesterday
  L.close('x', { pnl: 2, simulated: false }); L.flows.get('x|real')[1][0] = midnight + 60e3;   // today
  L.close('x', { pnl: -1, simulated: true }); L.flows.get('x|sim')[0][0] = midnight + 120e3;
  const strategies = [{ id: 'x', alloc: 1000 }, { id: 'y', alloc: 500 }];
  const young = pnlBoard(L, strategies, { now, since: now - 86400e3 * 2 });
  const x = young.strategies[0], y = young.strategies[1];
  assert.equal(x.real.realized, 7); assert.equal(x.real.today, 2); assert.equal(x.real.d7, 7); assert.equal(x.real.d7Covered, false);
  assert.equal(x.sim.realized, -1); assert.equal(x.sim.today, -1); assert.equal(young.desk.real.realized, 7); assert.equal(young.desk.sim.realized, -1);
  assert.equal(y.real.events, 0); assert.equal(y.sim.events, 0); assert.deepEqual(y.real.spark, []);
  const old = pnlBoard(L, strategies, { now, since: now - 86400e3 * 8 }); assert.equal(old.d7Covered, true);
  const sp = x.real.spark; assert.deepEqual(sp[0].slice(1), [0]); assert.equal(sp[sp.length - 1][1], 7);
  const many = spark(Array.from({ length: 500 }, (_, i) => [i, 1]), 0); assert.ok(many.length <= 49); assert.equal(many[many.length - 1][1], 500);
});

test('engine snapshot exposes the board (display only)', () => {
  const eng = fs.readFileSync(path.join(ROOT, 'server', 'engine.js'), 'utf8');
  assert.match(eng, /pnlBoard: pnlBoard\(this\.ledger, this\.strategies/);
  const board = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'pnl-board.js'), 'utf8');
  assert.doesNotMatch(board, /\.close\(|\.charge\(|\.cashflow\(|placeOrder|fetch\(/, 'board never books or trades');
});

// Pull the P&L helper block out of the client IIFE and run it in a sandbox.
function helpers() {
  const a = appJs.indexOf('  // ---------- P&L headlines'), b = appJs.indexOf('  function renderDeskPnl()');
  assert.ok(a > 0 && b > a, 'helper block present');
  const pre = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pct = (n, d = 2) => n == null || !isFinite(n) ? '—' : \`\${n >= 0 ? '+' : ''}\${n.toFixed(d)}%\`; let S = { now: Date.now(), uptimeMs: 1000 };
    let cmeOn = false; const isCme = () => cmeOn, ORB = { up: '#3dffb0', down: '#ff3d5a', flat: '#6b7a89' }, specs = []; const orbCanvas = (sp, cls) => { specs.push(sp); return '<canvas class="orb ' + cls + '" data-k="o' + specs.length + '"></canvas>'; };`;
  const ctx = {}; vm.runInNewContext(pre + appJs.slice(a, b) + '\nthis.out = { pnlHead, sparkSvg, fmtPnl, windows, bookHead, setS: (x) => { S = x; }, setCme: (v) => { cmeOn = v; }, specs };', ctx);
  return ctx.out;
}

test('pnlHead: big signed number, % of sleeve, SIM tag, "no trades yet" instead of $0, sparkline only with >= 2 points', () => {
  const H = helpers();
  const empty = H.pnlHead({ label: 'Realized P&L', value: 0, n: 0, pctBase: 1000 });
  assert.match(empty, /no trades yet/); assert.doesNotMatch(empty, /\$0|0\.00|ph-spark|%/);
  const win = H.pnlHead({ value: 12.5, n: 3, pctBase: 1000, brk: [['today', 2.5], ['7d', null]], spark: [[1, 0], [2, 12.5]] });
  assert.match(win, /class="pnlhead pos"/); assert.match(win, /\+\$12\.50/); assert.match(win, /\+1\.25% <small>of sleeve/); assert.match(win, /ph-spark/); assert.match(win, />n\/a</);
  assert.doesNotMatch(win, /badge sim/, 'real-data headline carries no SIM tag');
  const lose = H.pnlHead({ value: -4, n: 1, sim: true, spark: [[1, -4]] });
  assert.match(lose, /pnlhead neg sim/); assert.match(lose, /badge sim[^>]*>SIM</); assert.match(lose, /−\$4\.00/); assert.doesNotMatch(lose, /ph-spark/, 'one point is not a curve');
  const cents = H.pnlHead({ unit: '¢', value: 37, n: 2, tags: '<span class="badge stale">UNVERIFIED</span>' }); assert.match(cents, /\+37\.00¢/); assert.match(cents, />UNVERIFIED</);
  assert.equal(H.sparkSvg([]), ''); assert.equal(H.fmtPnl(null), '—');
  const w = H.windows([[Date.now() - 8 * 86400e3, 100], [Date.now() - 2 * 86400e3, 5], [Date.now(), 1]]); assert.equal(w.d7, 6); assert.equal(w.today, 1);
  H.setS({ now: 10 * 3600e3, uptimeMs: 3600e3, pnlBoard: { since: 9 * 3600e3 } });
  const bh = H.bookHead({ realized: 3, unrealized: 0, today: 3, d7: 3, d7Covered: false, events: 2, trades: 2, spark: [] }, { sim: false, alloc: 100 });
  assert.equal(bh.brk[1][1], null, '7d is n/a until the desk has 7 days of ledger'); assert.match(bh.brk[1][2], /desk up 1m|desk up 60m|desk up 1\.0h/);
});

test('cards wire the headline in: 12 strategy cards, H2 v1/v2/v3, desk header; labels kept; no network/order calls', () => {
  assert.match(html, /<section class="deskpnl card" id="deskPnl"/);
  assert.ok(html.indexOf('id="deskPnl"') < html.indexOf('class="hero card"'), 'desk P&L header sits at the top');
  assert.match(appJs, /renderDeskPnl\(\); renderHero\(\);/);
  const strats = appJs.slice(appJs.indexOf('function renderStrats()'), appJs.indexOf('// ---------- risk ----------'));
  assert.match(strats, /\$\{head\}/); assert.match(strats, /data-arm="\$\{esc\(s\.id\)\}"/); assert.match(strats, /SIM P&L · simulated inputs/); assert.match(strats, /SIM book \(separate\)/);
  const v1 = appJs.slice(appJs.indexOf('function renderH2()'), appJs.indexOf('function renderH2v2()'));
  assert.match(v1, /head1 \+ `<div class="subh">Paper ledger only/); assert.match(v1, /UNVERIFIED/); assert.match(v1, /per 1-contract test/);
  const v2 = appJs.slice(appJs.indexOf('function renderH2v2()'), appJs.indexOf('function renderH2v3()'));
  assert.match(v2, /head2 \+ `<div class="subh">Paper only, own ledger/); assert.match(v2, /esc\(P\.label\)/);
  const v3 = appJs.slice(appJs.indexOf('function renderH2v3()'), appJs.indexOf('function h2v3Compare('));
  assert.match(v3, /heads3/); assert.match(v3, /pctBase: L\.start/);
  const desk = appJs.slice(appJs.indexOf('  // ---------- P&L headlines'), appJs.indexOf('// ---------- mode switch'));
  assert.match(desk, /not added to the desk total/); assert.match(desk, /SIM book · mock\/simulated inputs/);
  assert.doesNotMatch(desk, /\bpost\(|fetch\(|XMLHttpRequest|sendBeacon/);
  assert.doesNotMatch(desk, /simPnl \+|realPnl \+|real\.realized \+ .*sim\.realized/, 'real and SIM never summed');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(css, /@media\(max-width:700px\)\{\n  \.deskpnl\{grid-template-columns:1fr\}/);
});

test('chart style switch: CME sparklines are ORB canvases, Classic keeps the SVG, both only with >= 2 points', () => {
  const H = helpers();
  assert.match(H.sparkSvg([[1, 0], [2, 5]]), /<svg class="ph-spark"/);
  H.setCme(true);
  const c = H.sparkSvg([[1, 0], [2, -5]]); assert.match(c, /<canvas class="orb ph-spark"/); assert.doesNotMatch(c, /<svg/);
  const sp = H.specs[H.specs.length - 1]; assert.equal(sp.compact, 1); assert.equal(sp.base, 0); assert.equal(sp.series[0].col, '#ff3d5a');
  assert.equal(H.sparkSvg([[1, 0]]), ''); H.setCme(false);
  assert.match(appJs, /localStorage\.getItem\('hawse\.chartStyle'\)/, 'choice is persisted per device');
  assert.match(appJs, /=== 'classic' \? 'classic' : 'cme'/, 'default is CME');
});
