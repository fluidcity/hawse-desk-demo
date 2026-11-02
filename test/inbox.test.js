'use strict';
// InboxPoller against a LOCAL fake HAWSE inbox (127.0.0.1, fake token/URL). No real inbox, no Helius, no network.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { InboxPoller, RETENTION_MS } = require('../server/feeds/inbox');
const { SolanaWhaleFeed } = require('../server/feeds/whales');
const { CreditBudget } = require('../server/lib/credits');

const TOKEN = 'fake-read-token-TEST-9f9f';
const WALLET = 'Wa11et1111111111111111111111111111111111111';
const tx = (sig, ts = Math.floor(Date.now() / 1000)) => ({ signature: sig, timestamp: ts, type: 'TRANSFER', source: 'SYSTEM_PROGRAM', feePayer: WALLET, tokenTransfers: [], nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: 'Dest', amount: 2000e9 }] });

/** Minimal fake of the Worker's GET /events contract. `script` = queue of forced responses for the next requests. */
async function fakeInbox() {
  const s = { events: [], queries: [], script: [], auths: [] };
  s.add = (payload, at = Date.now()) => { s.events.push({ id: s.events.length + 1, received_at: at, payload }); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); s.queries.push(u.search); s.auths.push(req.headers.authorization);
    const forced = s.script.shift();
    if (forced) { res.writeHead(forced.status, forced.headers || {}); return res.end(forced.body || ''); }
    if (u.pathname !== '/events') { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{"ok":false}'); }
    const since = +u.searchParams.get('since') || 0, limit = Math.min(200, Math.max(1, +u.searchParams.get('limit') || 100));
    const rest = s.events.filter((e) => e.id > since), page = rest.slice(0, limit);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cursor: page.length ? page[page.length - 1].id : since, more: rest.length > limit, count: page.length, events: page }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${srv.address().port}`; s.close = () => new Promise((r) => srv.close(r));
  return s;
}
const health = () => ({ rows: {}, register(id, o) { this.rows[id] = { ...o }; }, ok(id, l) { this.rows[id].lat = l; this.rows[id].err = null; }, fail(id, m) { this.rows[id].err = m; }, setKind(id, k, n) { this.rows[id].kind = k; this.rows[id].note = n; }, setTransport() {} });
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hawse-inbox-')), 'data', 'inbox-state.json');
const poller = (inbox, o = {}) => new InboxPoller({ baseUrl: inbox.base, readToken: TOKEN, pollSec: 30, setTimer: () => null, clearTimer: () => {}, ...o });

test('pagination: loops immediately while more=true, cursor advances to the last id, ascending delivery', async () => {
  const inbox = await fakeInbox(); try {
    for (let i = 1; i <= 250; i++) inbox.add([tx('s' + i)]);
    const got = []; const p = poller(inbox, { limit: 100, onEvent: (e) => got.push(e) });
    const delay = await p.tick();
    assert.equal(got.length, 250); assert.deepEqual(got.map((e) => e.id), Array.from({ length: 250 }, (_, i) => i + 1));
    assert.equal(p.state.cursor, 250); assert.equal(p.stats.pages, 3); assert.deepEqual(inbox.queries, ['?since=0&limit=100', '?since=100&limit=100', '?since=200&limit=100']);
    assert.equal(delay, 30000, 'caught up → normal interval'); assert.equal(inbox.auths[0], 'Bearer ' + TOKEN);
    await p.tick(); assert.equal(inbox.queries.at(-1), '?since=250&limit=100'); assert.equal(got.length, 250, 'nothing new');
    const capped = poller(inbox, { limit: 10, maxPagesPerTick: 2 }); assert.equal(await capped.tick(), 1000, 'still more after the page cap → come back in 1 s');
  } finally { await inbox.close(); }
});

test('cursor + dedupe persist across restart (atomic state file); Helius retries deduped by signature', async () => {
  const inbox = await fakeInbox(); const stateFile = tmpState(); try {
    inbox.add([tx('A'), tx('B')]); inbox.add([tx('A')]); // Helius retried the same tx in a second delivery
    const got = []; const p1 = poller(inbox, { stateFile, onEvent: (e) => got.push(e) });
    await p1.tick();
    assert.deepEqual(got.map((e) => e.txs.map((t) => t.signature)), [['A', 'B'], []]); assert.equal(got[1].dupes, 1); assert.equal(got[1].delivered, 1, 'still a delivered (billed) event');
    assert.equal(p1.stats.dupes, 1); const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); assert.equal(saved.cursor, 2); assert.ok(saved.sigs.includes('A'));
    assert.ok(!fs.existsSync(stateFile + '.tmp')); assert.ok(!fs.readFileSync(stateFile, 'utf8').includes(TOKEN));
    // restart: resumes at cursor 2, and a late retry of B (new inbox id) is still a dupe
    inbox.add([tx('B'), tx('C')]);
    const got2 = []; const p2 = poller(inbox, { stateFile, onEvent: (e) => got2.push(e) });
    assert.equal(p2.state.cursor, 2); await p2.tick();
    assert.equal(inbox.queries.at(-1), '?since=2&limit=100'); assert.equal(p2.state.cursor, 3); assert.deepEqual(got2[0].txs.map((t) => t.signature), ['C']); assert.equal(got2[0].dupes, 1);
    // a corrupt state file falls back to cursor 0 instead of crashing
    fs.writeFileSync(stateFile, '{nope'); assert.equal(poller(inbox, { stateFile }).state.cursor, 0);
  } finally { await inbox.close(); }
});

test('backoff: 401/403 long, 429 honours Retry-After (else exponential), 5xx + network exponential, reset on success', async () => {
  const inbox = await fakeInbox(); try {
    const h = health(); const p = poller(inbox, { health: h });
    inbox.script.push({ status: 401 }); assert.equal(await p.tick(), 5 * 60e3); assert.match(p.stats.lastError.msg, /auth rejected \(HTTP 401\): check HAWSE_READ_TOKEN/);
    inbox.script.push({ status: 403 }); assert.equal(await p.tick(), 10 * 60e3, 'auth backoff doubles'); assert.equal(p.stats.authFails, 2);
    await p.tick(); assert.equal(p.fails, 0, 'success resets'); assert.equal(p.stats.backoffMs, 0);
    inbox.script.push({ status: 429, headers: { 'retry-after': '120' } }); assert.equal(await p.tick(), 120e3);
    inbox.script.push({ status: 429, headers: { 'retry-after': '1' } }); assert.equal(await p.tick(), 30e3, 'never faster than the poll interval');
    await p.tick();
    inbox.script.push({ status: 429 }); assert.equal(await p.tick(), 60e3); inbox.script.push({ status: 429 }); assert.equal(await p.tick(), 120e3); assert.equal(p.stats.rateLimited, 4);
    await p.tick();
    inbox.script.push({ status: 500 }); assert.equal(await p.tick(), 60e3); inbox.script.push({ status: 503 }); assert.equal(await p.tick(), 120e3);
    for (let i = 0; i < 6; i++) inbox.script.push({ status: 502 }); for (let i = 0; i < 6; i++) await p.tick(); assert.equal(p.stats.backoffMs, 5 * 60e3, 'capped at 5 min');
    await p.tick();
    inbox.script.push({ status: 200, body: 'not json' }); await p.tick(); assert.match(p.stats.lastError.msg, /invalid JSON/);
    inbox.script.push({ status: 200, body: '{"ok":false}' }); await p.tick(); assert.match(p.stats.lastError.msg, /unexpected shape/);
    assert.equal(p.state.cursor, 0, 'errors never move the cursor');
    const port = inbox.base.split(':').pop(); await inbox.close();
    const dead = poller({ base: 'http://127.0.0.1:' + port }, { health: h }); assert.equal(await dead.tick(), 60e3); assert.match(dead.stats.lastError.msg, /inbox unreachable \((ECONNREFUSED|UND_ERR_SOCKET|ECONNRESET)\)/);
  } finally { await inbox.close().catch(() => {}); }
});

test('gap: offline longer than the 24 h retention is recorded once, shown in health + view; shorter outage is not', async () => {
  const inbox = await fakeInbox(); const stateFile = tmpState(); try {
    let T = Date.UTC(2026, 9, 30, 12); const h = health();
    const p = poller(inbox, { stateFile, now: () => T, health: h }); await p.tick(); assert.equal(p.state.gaps.length, 0);
    T += 23 * 3.6e6; await p.tick(); assert.equal(p.state.gaps.length, 0, '23 h: still inside retention');
    T += 30 * 3.6e6; // the box was off for 30 h
    const p2 = poller(inbox, { stateFile, now: () => T, health: h }); await p2.tick();
    assert.equal(p2.state.gaps.length, 1); assert.equal(p2.state.gaps[0].hours, 30); assert.equal(RETENTION_MS, 24 * 3.6e6);
    assert.match(h.rows['whale.inbox'] ? h.rows['whale.inbox'].note : p2.note(), /GAP: offline 30 h/);
    const v = p2.view(); assert.equal(v.gapCount, 1); assert.equal(v.gaps[0].hours, 30);
    T += 60e3; await p2.tick(); assert.equal(p2.state.gaps.length, 1, 'recorded once per outage');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).gaps.length, 1, 'gap persisted');
    T += 3 * 60e3; assert.equal(p2.view().stale, true, 'no successful poll for > 4 intervals → STALE');
  } finally { await inbox.close(); }
});

test('health row: registered with label + staleMs; "inbox not configured" when URL/token missing; clamps; start() idle when unconfigured', () => {
  const h = health(); const p = new InboxPoller({ baseUrl: '', readToken: '', health: h, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(p.configured, false); assert.match(h.rows['whale.inbox'].note, /inbox not configured \(HAWSE_WEBHOOK_URL \/ HAWSE_READ_TOKEN missing\)/);
  p.start(); assert.equal(p.timer, undefined); assert.equal(p.view().configured, false);
  assert.equal(new InboxPoller({ baseUrl: 'ftp://x', readToken: 't' }).configured, false);
  const h2 = health(); const q = new InboxPoller({ baseUrl: 'https://x.example.dev/', readToken: 't', pollSec: 5, limit: 999, health: h2 });
  assert.equal(q.pollMs, 15000); assert.equal(q.limit, 200); assert.equal(q.baseUrl, 'https://x.example.dev'); assert.equal(h2.rows['whale.inbox'].staleMs, 60000);
  assert.equal(new InboxPoller({ baseUrl: 'https://x', readToken: 't', pollSec: 600 }).pollMs, 60000);
});

test('no secret leakage: token + inbox URL never appear in health, errors, view(), feed credits, state file or console', async () => {
  const inbox = await fakeInbox(); const stateFile = tmpState();
  const logs = []; const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  try {
    const h = health(); const budget = new CreditBudget({ provider: 'helius', budget: 1e6, file: '' });
    const leakyFetch = async (u, o) => { if (String(u).includes('boom')) throw new Error(`connect failed for ${u} with ${o.headers.authorization}`); return fetch(u, o); };
    const f = new SolanaWhaleFeed({ health: h, minUsd: 1e5, priceFn: () => 150, mode: 'inbox', watch: [WALLET], budget, fetchImpl: leakyFetch, inbox: { baseUrl: inbox.base, readToken: TOKEN, stateFile } });
    f.inbox.setTimer = () => null;
    inbox.add([tx('L1')]); await f.inbox.tick();
    inbox.script.push({ status: 500, body: 'echo ' + TOKEN + ' ' + inbox.base }); await f.inbox.tick();
    inbox.script.push({ status: 401 }); await f.inbox.tick();
    f.inbox.baseUrl = inbox.base + '/boom'; await f.inbox.tick(); assert.match(f.inbox.stats.lastError.msg, /^inbox unreachable/, 'raw error text (with URL + header) is not echoed');
    const host = inbox.base.replace('http://', '');
    const blobs = [JSON.stringify(h.rows), JSON.stringify(f.inbox.view()), JSON.stringify(f.credits()), JSON.stringify(f.publicInfo()), JSON.stringify(f.snapshot()), fs.readFileSync(stateFile, 'utf8'), logs.join('\n')];
    for (const b of blobs) { assert.ok(!b.includes(TOKEN), 'token leaked: ' + b.slice(0, 120)); assert.ok(!b.includes(host), 'inbox URL leaked: ' + b.slice(0, 120)); }
    assert.equal(f.events.length, 1); assert.equal(budget.view().used, 1);
  } finally { Object.assign(console, orig); await inbox.close(); }
});

test('end to end: feed in inbox mode picks deliveries up from the fake inbox, bills per delivered event, ignores HAWSE-TEST for billing', async () => {
  const inbox = await fakeInbox(); try {
    const h = health(); const budget = new CreditBudget({ provider: 'helius', budget: 1e6, file: '' });
    const f = new SolanaWhaleFeed({ health: h, minUsd: 1e5, priceFn: () => 150, mode: 'inbox', watch: [WALLET], budget, inbox: { baseUrl: inbox.base, readToken: TOKEN, stateFile: '' } });
    f.inbox.setTimer = () => null; const seen = []; f.onTx((t) => seen.push(t.signature));
    inbox.add([tx('R1'), tx('R2')]); inbox.add([tx('R1')]); inbox.add([tx('HAWSE-TEST-e2e-1')]);
    await f.inbox.tick();
    assert.deepEqual(seen, ['R1', 'R2']); assert.equal(budget.view().used, 3, '2 + 1 retried delivery; the test POST is free');
    assert.equal(f.delivery.test, 1); assert.ok(f.events.some((e) => e.test && e.mock)); assert.ok(f.events.filter((e) => !e.test).every((e) => e.mock === false));
    const c = f.credits(); assert.equal(c.inbox.cursor, 3); assert.equal(c.inbox.dupes, 1); assert.equal(c.inbox.configured, true); assert.equal(h.rows['whale.inbox'].kind, 'live');
    assert.match(f.snapshot().transport || JSON.stringify(f.snapshot()), /inbox poll/);
    f.start(); f.stop(); // timers cleaned up
  } finally { await inbox.close(); }
});

test('scrub(): token, base URL (with or without scheme), Bearer values and URLs are redacted from any message', () => {
  const p = new InboxPoller({ baseUrl: 'https://secret-inbox.example.dev', readToken: TOKEN });
  const m = p.scrub(`GET https://secret-inbox.example.dev/events failed; auth Bearer ${TOKEN}; host secret-inbox.example.dev; other http://a.b/c?x=1`);
  for (const s of [TOKEN, 'secret-inbox', 'a.b/c']) assert.ok(!m.includes(s), s + ' in ' + m);
});
