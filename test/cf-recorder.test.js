'use strict';
// H7 Stage I: Cloudflare recorder SKELETON (not deployed). Run its Durable Object class in Node with fakes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SRC = path.join(__dirname, '..', 'cloudflare', 'recorder', 'src', 'index.js');
const load = () => import(SRC);

function fakes(t0 = Date.UTC(2026, 9, 30, 21, 0, 0)) {
  const store = new Map(); let alarm = null; const puts = []; const calls = []; const c = { t: t0 };
  const ctx = { storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v), setAlarm: async (t) => { alarm = t; }, deleteAlarm: async () => { alarm = null; } } };
  const env = { SERIES: 'KXBTC15M', FLUSH_MS: '60000', BUCKET: { put: async (k, body, o) => puts.push({ k, body, o }) } };
  const fetch = async (u, o) => { calls.push({ u, o }); const url = new URL(u);
    if (url.pathname.endsWith('/markets')) return Response.json({ markets: [{ ticker: 'KXBTC15M-26OCT301715-15', close_time: new Date(t0 + 600000).toISOString(), floor_strike: 76000 }] });
    if (url.pathname.endsWith('/orderbook')) return Response.json({ orderbook_fp: { yes_dollars: [['0.4400', '50.00'], ['0.4500', '12.00']], no_dollars: [['0.5300', '30.00']] } });
    return new Response('x', { status: 404 }); };
  return { ctx, env, fetch, store, puts, calls, c, now: () => c.t, alarm: () => alarm };
}

test('cf skeleton: getPublic refuses anything but GET on public Kalshi /markets paths', async () => {
  const { getPublic } = await load(); const seen = []; const f = async (u, o) => { seen.push([u, o.method]); return new Response('{}'); };
  await getPublic('https://api.elections.kalshi.com/trade-api/v2', '/markets/KXBTC15M-X/orderbook', { depth: 10 }, f);
  assert.deepEqual(seen, [['https://api.elections.kalshi.com/trade-api/v2/markets/KXBTC15M-X/orderbook?depth=10', 'GET']]);
  for (const [b, p] of [['https://api.elections.kalshi.com/trade-api/v2', '/portfolio/orders'], ['https://api.elections.kalshi.com/trade-api/v2', '/markets/X/../../portfolio/balance'], ['https://evil.example.com/trade-api/v2', '/markets'], ['http://api.elections.kalshi.com/trade-api/v2', '/markets']])
    assert.throws(() => getPublic(b, p, {}, f), /refused/, b + p);
  const src = fs.readFileSync(SRC, 'utf8');
  for (const re of [/KALSHI-ACCESS/, /crypto\.subtle\.sign|createSign/, /['"`]\/portfolio/, /['"`]\/orders/, /KALSHI_(API_KEY|PRIVATE)/]) assert.ok(!re.test(src), String(re));
  assert.ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/.test(src), 'no non-GET outbound request');
  assert.ok(!/BEGIN|api[_-]?key\s*[:=]\s*['"][^'"]+/i.test(fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'recorder', 'wrangler.jsonc'), 'utf8')), 'no secret in wrangler config');
});

test('cf skeleton: start → alarm loop polls books on the second grid, flushes one gzipped JSONL object per minute to R2, 429 → gap row', async () => {
  const { Recorder } = await load(); const F = fakes(); const r = new Recorder(F.ctx, F.env, { fetch: F.fetch, now: F.now });
  await r.fetch(new Request('https://x/start', { method: 'POST' })); assert.equal(F.store.get('running'), true); assert.ok(F.alarm());
  await r.alarm(); assert.equal(F.alarm() % 1000, 0, 'next alarm on the 1 s grid'); assert.equal(r.n.rows, 1);
  const book = r.buf.find((x) => x.t === 'book'); assert.equal(book.ya, 0.47); assert.equal(book.yas, 30); assert.equal(book.yb, 0.45); assert.equal(book.src, 'cf');
  assert.equal(F.puts.length, 0, 'no flush before FLUSH_MS');
  const f429 = F.fetch; r.http = async (u, o) => (String(u).includes('orderbook') ? new Response('', { status: 429 }) : f429(u, o)); F.c.t += 1000; await r.alarm();
  assert.equal(r.n.s429, 1); assert.ok(r.buf.some((x) => x.reason === 'http-429'));
  r.http = f429; F.c.t += 60000; await r.alarm(); assert.equal(F.puts.length, 1);
  const p = F.puts[0]; assert.match(p.k, /^rec\/2026-10-30\/kalshi\.book\.2100\d\d-cf\.jsonl\.gz$/);
  const rows = zlib.gunzipSync(Buffer.from(p.body)).toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].reason, 'do-start', 'eviction/restart is an explicit gap'); assert.ok(rows.filter((x) => x.t === 'book').length >= 2);
  assert.ok(F.calls.every((c) => c.o.method === 'GET'));
  await r.fetch(new Request('https://x/stop', { method: 'POST' })); assert.equal(F.alarm(), null); const n = F.calls.length; await r.alarm(); assert.equal(F.calls.length, n, 'stopped: alarm does nothing');
});

test('cf skeleton: Worker entry requires the bearer token and only routes /status, /start, /stop', async () => {
  const W = (await load()).default; let hit = 0; const env = { STATUS_TOKEN: 't0k', RECORDER: { idFromName: () => 'id', get: () => ({ fetch: async () => { hit++; return new Response('ok'); } }) } };
  assert.equal((await W.fetch(new Request('https://x/status'), env)).status, 401);
  assert.equal((await W.fetch(new Request('https://x/status', { headers: { authorization: 'Bearer nope' } }), env)).status, 401);
  assert.equal((await W.fetch(new Request('https://x/status'), { ...env, STATUS_TOKEN: '' })).status, 401, 'no token configured → closed');
  const H = { authorization: 'Bearer t0k' };
  assert.equal((await W.fetch(new Request('https://x/orders', { headers: H }), env)).status, 404);
  assert.equal((await W.fetch(new Request('https://x/start', { headers: H }), env)).status, 405);
  assert.equal((await W.fetch(new Request('https://x/status', { headers: H }), env)).status, 200); assert.equal(hit, 1);
});
