'use strict';
// H5.1: feed loops must never stall silently. Hung fetches time out, loops always reschedule, a watchdog restarts
// loops that went quiet (and reconnects dead WebSockets), and stale feeds are surfaced in the snapshot/UI.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { InboxPoller } = require('../server/feeds/inbox');
const { fetchJson, withTimeout } = require('../server/lib/net');
const { Watchdog } = require('../server/lib/watchdog');
const { WsClient } = require('../server/lib/ws');
const { Health } = require('../server/lib/health');

const TOKEN = 'fake-read-token-wd-7c7c';
const never = () => new Promise(() => {});

test('hung fetch: inbox poll that never answers (and ignores the abort signal) times out and the loop reschedules', async () => {
  const sched = []; const h = new Health();
  const p = new InboxPoller({ baseUrl: 'https://fake-inbox.example.dev', readToken: TOKEN, timeoutMs: 150, health: h, fetchImpl: never, setTimer: (fn, ms) => { sched.push(ms); return { unref() {} }; }, clearTimer: () => {} });
  p.stopped = false;
  const t0 = Date.now(); const delay = await p.tick();
  assert.ok(Date.now() - t0 < 2000, 'tick settled');
  assert.equal(p.stats.lastError.kind, 'network'); assert.match(p.stats.lastError.msg, /ETIMEDOUT/);
  assert.deepEqual(sched, [delay], 'next poll scheduled'); assert.ok(delay > 0);
  assert.equal(p.busy, false);
  for (const s of [JSON.stringify(p.view()), JSON.stringify(h.list())]) { assert.ok(!s.includes(TOKEN)); assert.ok(!s.includes('fake-inbox.example.dev')); }
});

test('hung response body: headers arrive, body never does -> timed out, still rescheduled', async () => {
  const sched = [];
  const p = new InboxPoller({ baseUrl: 'https://fake-inbox.example.dev', readToken: TOKEN, timeoutMs: 150, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: never }), setTimer: (fn, ms) => { sched.push(ms); return null; }, clearTimer: () => {} });
  p.stopped = false; await p.tick(); assert.match(p.stats.lastError.msg, /body timed out/); assert.equal(sched.length, 1);
});

test('thrown error anywhere in a poll cycle never kills the setTimeout chain', async () => {
  const sched = [];
  const p = new InboxPoller({ baseUrl: 'https://fake-inbox.example.dev', readToken: TOKEN, setTimer: (fn, ms) => { sched.push(ms); return null; }, clearTimer: () => {} });
  p.stopped = false; p.fetchPage = async () => { throw new TypeError('boom ' + TOKEN); };
  await p.tick(); await p.tick();
  assert.equal(sched.length, 2, 'rescheduled after each failure'); assert.ok(sched[1] >= sched[0], 'with backoff');
  assert.match(p.stats.lastError.msg, /TypeError/); assert.ok(!JSON.stringify(p.view()).includes(TOKEN));
  // garbage bodies too
  const q = new InboxPoller({ baseUrl: 'https://fake-inbox.example.dev', readToken: TOKEN, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true,"events":"nope"' }), setTimer: (fn, ms) => { sched.push(ms); return null; }, clearTimer: () => {} });
  q.stopped = false; await q.tick(); assert.equal(sched.length, 3); assert.equal(q.stats.lastError.kind, 'server');
});

test('restart() supersedes an in-flight hung poll: the old cycle does not reschedule or double-run', async () => {
  let calls = 0; const timers = [];
  const p = new InboxPoller({ baseUrl: 'https://fake-inbox.example.dev', readToken: TOKEN, timeoutMs: 300, fetchImpl: () => { calls++; return never(); }, setTimer: (fn, ms) => { timers.push(ms); return { id: timers.length }; }, clearTimer: () => {} });
  p.stopped = false; const first = p.tick(); assert.equal(p.busy, true);
  p.restart(); assert.equal(p.busy, false); assert.deepEqual(timers, [0], 'fresh loop scheduled immediately');
  await first; assert.deepEqual(timers, [0], 'superseded cycle did not schedule');
  p.stop();
});

test('fetchJson against a server that accepts but never responds rejects within its timeout and marks health down', async () => {
  const socks = []; const srv = http.createServer(() => {}); srv.on('connection', (s) => socks.push(s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const h = new Health(); h.register('x', { label: 'x' });
  try {
    const t0 = Date.now();
    await assert.rejects(fetchJson(`http://127.0.0.1:${srv.address().port}/hang`, { timeoutMs: 250, health: h, id: 'x' }));
    assert.ok(Date.now() - t0 < 2000); assert.equal(h.get('x').status, 'down');
    await assert.rejects(withTimeout(never(), 50), (e) => e.code === 'ETIMEDOUT');
  } finally { socks.forEach((s) => s.destroy()); srv.close(); }
});

const clock = (t = 1e9) => { const c = { w: t, m: 0 }; c.now = () => c.w; c.mono = () => c.m; c.adv = (ms, wallOnly = false) => { c.w += ms; if (!wallOnly) c.m += ms; }; return c; };

test('watchdog: restarts a loop with no activity beyond factor x interval, logs once per attempt, backs off, resets when fresh', () => {
  const c = clock(); const h = new Health(); h.register('feed.a', { label: 'A' }); h.register('feed.b', { label: 'B' });
  const logs = []; let ra = 0, rb = 0;
  const wd = new Watchdog({ health: h, now: c.now, mono: c.mono, log: (m) => logs.push(m), factor: 3, minStaleMs: 1000 });
  wd.watch({ key: 'A loop', ids: ['feed.a'], intervalMs: 10000, restart: () => ra++ });
  wd.watch({ key: 'B loop', ids: ['feed.b'], intervalMs: 10000, restart: () => rb++ });
  wd.start(); wd.stop();
  const touch = (id, ok = true) => { const s = h.src.get(id); s.status = 'live'; if (ok) s.lastOk = c.now(); else s.lastErr = c.now(); };
  touch('feed.a'); touch('feed.b');
  c.adv(20000); touch('feed.b'); assert.deepEqual(wd.check(), []);
  c.adv(15000); touch('feed.b', false); // B only errors (e.g. geo-blocked 451) but its loop is alive
  assert.deepEqual(wd.check(), ['A loop']); assert.equal(ra, 1); assert.equal(rb, 0);
  assert.match(logs[0], /^\[watchdog\] A loop stale: no activity for 35s \(limit 30s\) -> restarting loop \(restart #1/);
  c.adv(15000); assert.deepEqual(wd.check(), [], 'inside backoff window'); assert.equal(ra, 1);
  c.adv(16000); touch('feed.b', false); assert.deepEqual(wd.check(), ['A loop']); assert.equal(ra, 2); assert.equal(wd.view().entries[0].stale, true);
  assert.ok(wd.entries.get('A loop').backoffMs === 60000, 'backoff doubled');
  touch('feed.a'); touch('feed.b'); c.adv(1000); assert.deepEqual(wd.check(), []); assert.equal(wd.entries.get('A loop').backoffMs, 0, 'reset when fresh');
  assert.equal(wd.view().restarts, 2);
});

test('watchdog: a wall-clock jump (VM paused/resumed) kicks every loop at once, regardless of backoff', () => {
  const c = clock(); const h = new Health(); h.register('feed.a', { label: 'A' }); const logs = []; let n = 0;
  const wd = new Watchdog({ health: h, now: c.now, mono: c.mono, log: (m) => logs.push(m) });
  for (const k of ['a', 'b', 'c']) wd.watch({ key: k, ids: ['feed.a'], intervalMs: 30000, restart: () => n++ });
  h.src.get('feed.a').status = 'live'; h.src.get('feed.a').lastOk = c.now();
  wd.start(); wd.stop(); c.adv(15000); assert.deepEqual(wd.check(), []);
  c.adv(19 * 60e3, true); c.adv(15000); // 19 min passed on the wall clock, 15 s on the monotonic clock
  assert.deepEqual(wd.check(), ['a', 'b', 'c']); assert.equal(n, 3);
  assert.match(logs.join('\n'), /wall clock jumped \+1140s vs monotonic/); assert.equal(wd.view().clockJumps.length, 1);
});

test('watchdog: never-connected sources get a grace period; mock rows are not "stale loops"; spec errors and restart throws are contained', () => {
  const c = clock(); const h = new Health(); h.register('p', { label: 'P' }); h.register('m', { label: 'M', kind: 'mock' }); const logs = []; let n = 0;
  const wd = new Watchdog({ health: h, now: c.now, mono: c.mono, log: (m) => logs.push(m), minStaleMs: 1000 });
  wd.watchAll({ a: { watchSpec: () => ({ key: 'pending', ids: ['p'], intervalMs: 1000, restart: () => n++ }) }, b: { watchSpec: () => { throw new Error('x'); } }, c: { watchSpec: () => null },
    d: { watchSpec: () => [{ key: 'mock', ids: ['m'], intervalMs: 1000, restart: () => n++ }, { key: 'bad', ids: ['p'], intervalMs: 1000, restart: () => { throw new Error('nope https://secret.example/x?api-key=zz'); } }] } });
  wd.start(); wd.stop();
  c.adv(5000); assert.deepEqual(wd.check(), [], 'pending rows: still connecting');
  c.adv(30000); assert.deepEqual(wd.check().sort(), ['bad', 'mock', 'pending']); assert.equal(n, 2);
  assert.ok(logs.some((l) => /bad restart failed: nope <url>/.test(l))); assert.ok(!logs.join('').includes('secret.example'));
});

// Minimal fake WebSocket: open/message/close are driven by the test.
class FakeWS { constructor(url) { this.url = url; FakeWS.all.push(this); this.closed = false; this.sent = []; } send(m) { this.sent.push(m); } close() { this.closed = true; } }
FakeWS.all = [];

test('WsClient: a half-open socket (no frames, no close event) is dropped after idleMs and reconnected', async () => {
  FakeWS.all = []; const c = clock(); const h = new Health(); h.register('ws.x', { label: 'X', transport: 'ws' }); const logs = [];
  const ws = new WsClient({ url: 'wss://fake.example/ws', health: h, id: 'ws.x', onMessage: () => null, idleMs: 60000, now: c.now, WebSocketImpl: FakeWS, log: (m) => logs.push(m), onOpen: (cl) => cl.send({ sub: 1 }) });
  ws.start(); const s1 = FakeWS.all[0]; s1.onopen(); s1.onmessage({ data: '{}' }); assert.equal(h.get('ws.x').status, 'live');
  c.adv(30000); ws.checkIdle(); assert.equal(FakeWS.all.length, 1, 'not idle yet');
  c.adv(31000); ws.checkIdle();
  assert.equal(s1.closed, true); assert.equal(s1.onmessage, null, 'old socket detached'); assert.equal(FakeWS.all.length, 2, 'reconnected');
  assert.equal(ws.idleKicks, 1); assert.match(h.get('ws.x').error, /idle 61s/); assert.match(logs[0], /^\[ws\] ws\.x: idle 61s -> reconnecting$/);
  const s2 = FakeWS.all[1]; s2.onopen(); assert.equal(s2.sent.length, 1, 'resubscribed on the new socket'); s2.onmessage({ data: '{}' }); assert.equal(h.get('ws.x').status, 'live');
  s1.onclose && s1.onclose(); assert.equal(FakeWS.all.length, 2, 'late close from the dead socket is ignored');
  ws.restart('watchdog'); assert.equal(FakeWS.all.length, 3); assert.equal(ws.reconnects, 2);
  ws.stop(); assert.equal(FakeWS.all[2].closed, true);
});

test('WsClient: a connect that never opens is abandoned after connectTimeoutMs and retried', async () => {
  FakeWS.all = []; const h = new Health(); h.register('ws.y', { label: 'Y', transport: 'ws' });
  const ws = new WsClient({ url: 'wss://fake.example/ws', health: h, id: 'ws.y', onMessage: () => null, connectTimeoutMs: 40, WebSocketImpl: FakeWS });
  ws.backoff = 10; ws.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(FakeWS.all.length >= 2, 'retried after the connect timeout'); assert.equal(FakeWS.all[0].closed, true); assert.match(h.get('ws.y').error || '', /connect timeout/);
  ws.stop();
});

test('engine: every polling/streaming feed declares a watchdog entry; stale feeds appear in the snapshot (mock rows stay labelled)', () => {
  const config = require('../server/config'); const { Engine } = require('../server/engine'); const modules = require('../server/modules');
  const e = new Engine(config.build({ FUNDING_HL_TOP_OI: '0', WS_ENABLED: 'true', CARRY_ENABLED: 'true', INBOX_STATE_FILE: '', WHALES_ENABLED: 'true', HAWSE_WEBHOOK_URL: 'https://fake-inbox.example.dev', HAWSE_READ_TOKEN: TOKEN }), { modules });
  const realWS = globalThis.WebSocket; globalThis.WebSocket = FakeWS; try { e.feeds.ws.start(); } finally { globalThis.WebSocket = realWS; }
  e.watchdog = new Watchdog({ health: e.health }).watchAll(e.feeds); e.feeds.ws.stop();
  const keys = [...e.watchdog.entries.keys()];
  for (const k of ['funding (REST poll)', 'spot books (REST poll)', 'ws.hyperliquid', 'ws.okx', 'ws.bybit', 'ws.binance', 'whale.inbox (HAWSE inbox poll)']) assert.ok(keys.includes(k), 'watched: ' + k + ' in ' + keys.join(', '));
  const row = e.health.src.get('funding.hyperliquid'); row.status = 'live'; row.lastOk = Date.now() - 19 * 60e3;
  const snap = e.snapshot({});
  const st = snap.stale.find((x) => x.id === 'funding.hyperliquid'); assert.ok(st && st.ageMs >= 19 * 60e3 && st.mock === false);
  assert.ok(snap.watchdog && snap.watchdog.entries.length === keys.length); assert.ok(snap.monoUptimeMs >= 0);
  const m = e.health.register('mock.x', { label: 'mock x', kind: 'mock' }); m.status = 'mock'; m.lastOk = Date.now() - 10 * 60e3;
  assert.equal(e.snapshot({}).stale.find((x) => x.id === 'mock.x').mock, true, 'stale MOCK rows keep their MOCK label');
  assert.ok(!JSON.stringify(snap).includes(TOKEN) && !JSON.stringify(snap).includes('fake-inbox.example.dev'));
});

test('UI: top-bar STALE badge and per-feed STALE tags are wired to snapshot.stale / health status', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'); const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="staleChip"[^>]*hidden/); assert.match(js, /function renderStaleChip\(\)/); assert.match(js, /S\.stale/); 
  assert.match(js, /stale-row/); assert.match(js, /⚠ STALE: /); assert.match(js, /watchdog \$\{wd\.restarts\} restart/);
});
