'use strict';
// Card layout (public/layout.js): pure state logic + static checks of the page wiring. Display only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'public', 'layout.js'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'layout.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const D = ['desk-pnl', 'equity', 'h2-v1', 'strategies', 'risk', 'tape'];

test('layout state: saved order/hidden round-trip through JSON and normalize unchanged', () => {
  const s = L.normalize({ order: ['tape', 'equity', 'desk-pnl', 'h2-v1', 'strategies', 'risk'], hidden: ['risk'] }, D);
  assert.deepEqual(s, { v: 1, order: ['tape', 'equity', 'desk-pnl', 'h2-v1', 'strategies', 'risk'], hidden: ['risk'] });
  assert.deepEqual(L.normalize(JSON.parse(JSON.stringify(s)), D), s);
  const p = L.parse(JSON.stringify({ hawseLayout: 1, order: s.order, hidden: s.hidden, views: { phone: { order: ['tape'], hidden: [] } } }));
  assert.deepEqual(L.normalize(p, D), s); assert.deepEqual(p.views.phone.order, ['tape']);
});

test('layout state: unknown, duplicate and junk ids are ignored; garbage input falls back to the default', () => {
  const s = L.normalize({ order: ['gone', 'risk', 'risk', 7, null, 'equity'], hidden: ['gone', 'tape', 'tape', {}] }, D);
  assert.deepEqual(s.order.filter((x) => x === 'risk' || x === 'equity'), ['risk', 'equity']); assert.ok(!s.order.includes('gone')); assert.equal(s.order.length, D.length); assert.deepEqual(s.hidden, ['tape']);
  for (const bad of [null, undefined, 'x', 42, [], { order: 'nope' }]) assert.deepEqual(L.normalize(bad, D), { v: 1, order: D, hidden: [] });
  for (const bad of ['', 'not json', '[]', '42', '{"a":1}']) assert.equal(L.parse(bad), null, bad);
});

test('layout state: cards new to the page land at their default spot, not at the end or the top', () => {
  const s = L.normalize({ order: ['tape', 'desk-pnl', 'strategies', 'risk'], hidden: [] }, D); // saved before equity + h2-v1 existed
  assert.deepEqual(s.order, ['tape', 'desk-pnl', 'equity', 'h2-v1', 'strategies', 'risk']);
  assert.deepEqual(L.normalize({ order: ['risk'] }, ['new-first', 'risk']).order, ['new-first', 'risk']);
});

test('layout state: move and hide helpers', () => {
  const s = L.normalize(null, D);
  assert.deepEqual(L.move(s, 'equity', -1).order.slice(0, 2), ['equity', 'desk-pnl']);
  assert.equal(L.move(s, 'desk-pnl', -1), s, 'no move past the top'); assert.equal(L.move(s, 'tape', 1), s);
  const h = L.setHidden(L.setHidden(s, 'risk', true), 'risk', true); assert.deepEqual(h.hidden, ['risk']);
  assert.deepEqual(L.setHidden(h, 'risk', false).hidden, []);
});

test('page: every dashboard card has a unique stable data-card-id inside one #board; menu + script wired', () => {
  const ids = [...html.matchAll(/data-card-id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 26, String(ids.length)); assert.equal(new Set(ids).size, ids.length, 'ids unique');
  const live = html.slice(html.indexOf('id="liveView"'), html.indexOf('id="demoView"'));
  const sections = [...live.matchAll(/<section class="([^"]*\bcard\b[^"]*)"([^>]*)>/g)];
  for (const m of sections) assert.match(m[2], /data-card-id="/, 'card without id: ' + m[1]);
  for (const id of ['desk-pnl', 'equity', 'h2-chart-v1', 'h2-chart-v2', 'h2-chart-v3', 'h2-v1', 'h2-v2', 'h2-v3', 'strategies', 'risk', 'funding', 'attribution', 'whale', 'wallet-follow', 'mempool', 'dex-gaps', 'onepct', 'perps', 'cme-micros', 'betting', 'bet-desk', 'recorder', 'storage', 'data-sources', 'lab', 'tape']) assert.ok(ids.includes(id), id);
  for (const id of ['layoutBtn', 'layoutPanel', 'lpList', 'lpEdit', 'lpShowAll', 'lpHideAll', 'lpReset', 'lpSaveView', 'lpViews', 'lpJson', 'lpExport', 'lpImport']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('src="layout.js"') > html.indexOf('src="app.js"'), 'layout runs after the card renderers exist');
  assert.match(html, /<div class="grid board" id="board">/);
});

test('layout.js: moves existing nodes (never re-creates them), keeps data-hidden separate, persists, no network', () => {
  assert.match(js, /board\.insertBefore\(c, /); assert.doesNotMatch(js, /outerHTML|cloneNode|board\.innerHTML/);
  assert.match(js, /classList\.toggle\('u-hidden'/); assert.doesNotMatch(js, /\.hidden = (true|false)/, 'never flips the per-card hidden attribute');
  assert.match(js, /'hawse\.layout\.v1'/); assert.match(js, /localStorage\.setItem\(KEY/);
  assert.match(js, /pointerdown/); assert.match(js, /setPointerCapture/); assert.match(css, /\.c-drag\{[^}]*touch-action:none/);
  assert.match(css, /\.layout-edit \.ctools \.c-drag\{display:inline-flex\}/, 'handles only in edit mode');
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|WebSocket|\/api\//);
});
