'use strict';
// H7 Stage L: the Cloudflare recorder Worker/Durable Object, run in Node with fakes (node:sqlite stands in for ctx.storage.sql).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const SRC = path.join(__dirname, '..', 'cloudflare', 'recorder', 'src', 'index.js');
const load = () => import(SRC);

function sqlShim() {
  const db = new DatabaseSync(':memory:');
  return { exec(q, ...p) { if (/^\s*SELECT/i.test(q)) { const rows = db.prepare(q).all(...p); return { toArray: () => rows }; } if (p.length) db.prepare(q).run(...p); else db.exec(q); return { toArray: () => [] }; } };
}
const T0 = Date.UTC(2026, 9, 30, 21, 0, 0); // 14:00 PDT, a 15-minute window start
function fakes(t0 = T0, over = {}) {
  const store = new Map(); let alarm = null; const calls = []; const c = { t: t0 }; const sql = sqlShim(); const r2 = [];
  const ctx = { storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v), setAlarm: async (t) => { alarm = t; }, deleteAlarm: async () => { alarm = null; } } };
  const env = { SERIES: 'KXBTC15M', POLY_ASSETS: 'btc', FLUSH_MS: '60000', ...over };
  const ws = Math.floor(t0 / 900e3) * 900; let tradeN = 0;
  const fetch = async (u, o) => { calls.push({ u: String(u), o }); const url = new URL(u), p = url.pathname;
    if (url.hostname.endsWith('kalshi.com')) {
      if (p.endsWith('/markets')) return Response.json({ markets: [{ ticker: 'KXBTC15M-26OCT301715-15', event_ticker: 'E', open_time: new Date(t0 - 1000).toISOString(), close_time: new Date(t0 + 900000).toISOString(), floor_strike: 76000 }] });
      if (p.endsWith('/orderbook')) return Response.json({ orderbook_fp: { yes_dollars: [['0.4400', '50.00'], ['0.4500', '12.00']], no_dollars: [['0.5300', '30.00']] } });
      if (p.endsWith('/markets/trades')) { tradeN++; return Response.json({ trades: [{ trade_id: 'a' + tradeN, ticker: 'KXBTC15M-26OCT301715-15', created_time: new Date(c.t - 500).toISOString(), yes_price_dollars: '0.45', no_price_dollars: '0.55', count_fp: '3.00', taker_side: 'yes' }, { trade_id: 'a1', ticker: 'KXBTC15M-26OCT301715-15', created_time: new Date(t0 - 900).toISOString(), yes_price_dollars: '0.44', no_price_dollars: '0.56', count_fp: '1.00', taker_side: 'no' }] }); }
      if (/\/markets\/[A-Z0-9-]+$/.test(p)) return Response.json({ market: { status: 'finalized', result: 'yes', close_time: new Date(t0 + 900000).toISOString() } });
    }
    if (url.hostname === 'gamma-api.polymarket.com') return Response.json(url.searchParams.get('slug') === `btc-updown-15m-${ws}` ? [{ conditionId: '0xc0nd', clobTokenIds: '["111","222"]', outcomes: '["Up","Down"]', endDate: new Date((ws + 900) * 1000).toISOString() }] : []);
    if (url.hostname === 'clob.polymarket.com') return Response.json({ timestamp: String(c.t), hash: 'h' + url.searchParams.get('token_id'), bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.52', size: '80' }] });
    if (url.hostname === 'data-api.polymarket.com') return Response.json([{ transactionHash: '0xt1', asset: '111', size: 5, price: 0.5, side: 'BUY', outcome: 'Up', timestamp: Math.floor(c.t / 1000), proxyWallet: '0xWALLET' }]);
    return new Response('x', { status: 404 }); };
  return { ctx, env, fetch, store, calls, c, sql, r2, now: () => c.t, alarm: () => alarm };
}
const mk = async (F) => { const { Recorder } = await load(); return new Recorder(F.ctx, F.env, { fetch: F.fetch, now: F.now, sql: F.sql }); };
const step = async (r, F, n, ms = 1000) => { for (let i = 0; i < n; i++) { F.c.t += ms; await r.alarm(); } };
const chunkRows = (buf) => zlib.gunzipSync(Buffer.from(buf)).toString().trim().split('\n').map((l) => JSON.parse(l));

test('cf recorder: outbound is GET-only to public Kalshi/Polymarket market-data paths; no order/auth code; no secret in config', async () => {
  const { getPublic, publicUrl } = await load(); const seen = []; const f = async (u, o) => { seen.push([u, o.method, Object.keys(o.headers || {}).join()]); return new Response('{}'); };
  await getPublic('https://api.elections.kalshi.com/trade-api/v2', '/markets/KXBTC15M-X/orderbook', { depth: 10 }, f);
  assert.deepEqual(seen, [['https://api.elections.kalshi.com/trade-api/v2/markets/KXBTC15M-X/orderbook?depth=10', 'GET', 'accept,user-agent']]);
  for (const [b, p] of [['https://api.elections.kalshi.com/trade-api/v2', '/markets/trades'], ['https://api.elections.kalshi.com/trade-api/v2', '/markets/KXBTC15M-X'], ['https://gamma-api.polymarket.com', '/markets'], ['https://clob.polymarket.com', '/book'], ['https://data-api.polymarket.com', '/trades']])
    assert.ok(publicUrl(b, p, {}), b + p);
  for (const [b, p] of [['https://api.elections.kalshi.com/trade-api/v2', '/portfolio/orders'], ['https://api.elections.kalshi.com/trade-api/v2', '/markets/X/../../portfolio/balance'], ['https://evil.example.com/trade-api/v2', '/markets'],
    ['http://api.elections.kalshi.com/trade-api/v2', '/markets'], ['https://clob.polymarket.com', '/order'], ['https://clob.polymarket.com', '/auth/api-key'], ['https://data-api.polymarket.com', '/positions']])
    assert.throws(() => getPublic(b, p, {}, f), /refused/, b + p);
  const src = fs.readFileSync(SRC, 'utf8');
  for (const re of [/KALSHI-ACCESS/, /POLY_API|POLY_SIGNATURE|L2 ?header/i, /crypto\.subtle\.sign|createSign/, /['"`]\/portfolio/, /['"`]\/orders?['"`]/, /KALSHI_(API_KEY|PRIVATE)/]) assert.ok(!re.test(src), String(re));
  assert.ok(!/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/.test(src), 'no non-GET outbound request');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'recorder', 'wrangler.jsonc'), 'utf8');
  assert.ok(!/BEGIN|api[_-]?key\s*[:=]\s*['"][^'"]+|[0-9a-f]{64}/i.test(cfg), 'no secret or token digest in wrangler config');
});

test('cf recorder: 1 s alarm loop records Kalshi books+trades and Polymarket books+trades (wallet dropped), one gzipped chunk per minute in SQLite', async () => {
  const F = fakes(); const r = await mk(F);
  await r.fetch(new Request('https://x/start', { method: 'POST' })); assert.equal(F.store.get('running'), true); assert.ok(F.alarm());
  await step(r, F, 1); assert.equal(F.alarm() % 1000, 0, 'next alarm on the 1 s grid');
  const book = r.buf.find((x) => x.s === 'kalshi.book'); assert.equal(book.ya, 0.47); assert.equal(book.yas, 30); assert.equal(book.yb, 0.45); assert.equal(book.src, 'cf'); assert.equal(book.tk, 'KXBTC15M-26OCT301715-15');
  await step(r, F, 9);
  const s = r.status(); assert.equal(s.stored.chunks, 0, 'no flush before FLUSH_MS');
  assert.equal(r.buf.filter((x) => x.s === 'kalshi.book').length, 1, 'unchanged book is polled but written once');
  assert.ok(s.kalshi[0].books >= 10, 'polled every tick');
  const kt = r.buf.filter((x) => x.s === 'kalshi.trade'); assert.ok(kt.length >= 3); assert.equal(new Set(kt.map((x) => x.id)).size, kt.length, 'trades deduped by trade_id');
  assert.ok(r.buf.some((x) => x.s === 'poly.market' && x.slug.startsWith('btc-updown-15m-')));
  assert.equal(r.buf.filter((x) => x.s === 'poly.book').length, 2, 'two outcome tokens, hash unchanged → written once each');
  const pt = r.buf.filter((x) => x.s === 'poly.trade'); assert.equal(pt.length, 1); assert.ok(!JSON.stringify(pt).includes('WALLET'), 'wallet dropped');
  await step(r, F, 51); const s2 = r.status(); assert.equal(s2.stored.chunks, 1); assert.ok(s2.ok); assert.equal(s2.stale, false);
  const [ch] = r.store.list(0); assert.ok(ch.streams['kalshi.book'] >= 1 && ch.streams['kalshi.trade'] >= 3);
  const rows = chunkRows(r.store.get(ch.id)); assert.equal(rows[0].reason, 'do-start', 'restart is an explicit gap'); assert.equal(rows.length, ch.rows);
  assert.ok(F.calls.every((c) => c.o.method === 'GET'));
  const perSec = F.calls.length / 61; assert.ok(perSec < 12, `request budget ${perSec.toFixed(1)}/s`);
  let aborted = null; r.ctx.abort = (why) => { aborted = why; }; const rs = await (await r.fetch(new Request('https://x/restart', { method: 'POST' }))).json();
  assert.equal(rs.restarting, true); await new Promise((ok) => setTimeout(ok, 80)); assert.match(String(aborted), /restart/, '/restart aborts the instance'); assert.equal(r.buf.length, 0, 'flushed before abort');
  await r.fetch(new Request('https://x/stop', { method: 'POST' })); assert.equal(F.alarm(), null); const n = F.calls.length; await r.alarm(); assert.equal(F.calls.length, n, 'stopped: alarm does nothing');
});

test('cf recorder: 429 is counted per host, cools that host, and the gap is written and shown in /status', async () => {
  const F = fakes(); const r = await mk(F); await r.fetch(new Request('https://x/start', { method: 'POST' })); await step(r, F, 2);
  const ok = F.fetch; r.http = async (u, o) => (String(u).includes('kalshi.com') ? new Response('', { status: 429 }) : ok(u, o));
  await step(r, F, 1); r.http = ok; await step(r, F, 7);
  const s = r.status(), h = s.http['api.elections.kalshi.com']; assert.ok(h.s429 >= 1); assert.ok(h.share429 > 0 && h.share429 < 0.5);
  assert.ok(r.buf.some((x) => x.t === 'http-429'));
  assert.ok(s.gaps >= 0 && Array.isArray(s.recentGaps));
  // A long outage (no successful book for > GAP_MS) is a gap row with from/to.
  r.http = async () => { throw new Error('network down'); }; await step(r, F, 8); r.http = ok; await step(r, F, 1);
  const g = r.buf.find((x) => x.stream === 'kalshi.book' && x.reason === 'poll-gap'); assert.ok(g && g.ms >= 8000, 'gap row'); assert.ok(r.status().errors['api.elections.kalshi.com network'] >= 1);
});

test('cf recorder: retention prunes by age and by byte cap; counters survive a restart; settled market recorded', async () => {
  const F = fakes(T0, { RETAIN_DAYS: '1', MAX_BYTES: '100000000' }); const r = await mk(F);
  const blob = (n) => new Uint8Array(n);
  r.store.add({ t0: T0 - 3 * 86400e3, t1: T0 - 3 * 86400e3 + 1, rows: 1, streams: {}, data: blob(10) });
  for (let i = 0; i < 5; i++) r.store.add({ t0: T0 - i, t1: T0 - i, rows: 1, streams: {}, data: blob(1000) });
  assert.equal(r.store.prune(T0, 1, 3500), 3, 'one by age, two oldest by bytes'); assert.equal(r.store.totals().chunks, 3); assert.ok(r.store.totals().bytes <= 3500);
  await r.fetch(new Request('https://x/start', { method: 'POST' })); await step(r, F, 61);
  const before = r.status(); assert.ok(before.flushes >= 1);
  const r2 = await mk(F); const s = r2.status(); assert.equal(s.restarts, before.restarts + 1); assert.equal(s.flushes, before.flushes); assert.equal(s.lastWriteAt, before.lastWriteAt);
  // jump past the close: the official result is fetched once and written.
  F.c.t = T0 + 900000 + 30000; await r.alarm(); for (let i = 0; i < 12; i++) { F.c.t += 1000; await r.alarm(); }
  assert.ok(r.buf.some((x) => x.t === 'settle' && x.result === 'yes'));
});

test('cf recorder: stale when no write for STALE_MS; R2 mirror used only when bound', async () => {
  const F = fakes(); const puts = []; F.env.BUCKET = { put: async (k, b) => puts.push(k) }; const r = await mk(F);
  assert.equal(r.status().stale, true, 'never written → stale'); await r.fetch(new Request('https://x/start', { method: 'POST' })); await step(r, F, 61);
  assert.equal(r.status().stale, false); assert.equal(puts.length, 1); assert.match(puts[0], /^rec\/2026-10-30\/\d{9}-cf\.jsonl\.gz$/);
  F.c.t += 181000; assert.equal(r.status().stale, true);
  const h = await (await r.fetch(new Request('https://x/health'))).json(); assert.deepEqual(Object.keys(h).sort(), ['lastWriteAgeS', 'ok', 'running', 'stale']);
});

test('cf recorder: Worker entry: /health public, READ token for /status + /pull, ADMIN token for /start,/stop; token not forwarded', async () => {
  const W = (await load()).default; const hits = []; const d = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const env = { READ_TOKEN_SHA256: d('read-token-0123456789'), ADMIN_TOKEN_SHA256: d('admin-token-0123456789'), RECORDER: { idFromName: () => 'id', get: () => ({ fetch: async (rq) => { hits.push([new URL(rq.url).pathname + new URL(rq.url).search, rq.headers.get('authorization')]); return new Response('ok'); } }) } };
  const R = { authorization: 'Bearer read-token-0123456789' }, A = { authorization: 'Bearer admin-token-0123456789' };
  const st = async (u, o) => (await W.fetch(new Request('https://x' + u, o), env)).status;
  assert.equal(await st('/health'), 200);
  assert.equal(await st('/status'), 401); assert.equal(await st('/status', { headers: { authorization: 'Bearer nope-nope-nope-nope' } }), 401);
  assert.equal((await W.fetch(new Request('https://x/status', { headers: R }), { ...env, READ_TOKEN_SHA256: '' })).status, 401, 'no digest configured → closed');
  assert.equal(await st('/status', { headers: R }), 200); assert.equal(await st('/pull/list?after=3', { headers: R }), 200); assert.equal(await st('/pull/chunk?id=4', { headers: R }), 200);
  assert.equal(await st('/start', { method: 'POST', headers: R }), 401, 'read token cannot start/stop');
  assert.equal(await st('/start', { headers: A }), 405); assert.equal(await st('/start', { method: 'POST', headers: A }), 200);
  assert.equal(await st('/restart', { method: 'POST', headers: R }), 401, 'read token cannot restart'); assert.equal(await st('/restart', { method: 'POST', headers: A }), 200);
  assert.equal(await st('/orders', { headers: A }), 404); assert.equal(await st('/pull/list', { method: 'POST', headers: R }), 405);
  assert.ok(hits.every(([, auth]) => auth == null), 'token not forwarded to the DO'); assert.ok(hits.some(([p]) => p === '/pull/list?after=3'));
});

test('cf recorder: a full Kalshi trades page follows the cursor until it meets a seen trade; early flush past MAX_BUF_ROWS', async () => {
  const F = fakes(T0, { MAX_BUF_ROWS: '1500' }); const r = await mk(F); await r.fetch(new Request('https://x/start', { method: 'POST' })); await step(r, F, 2);
  const ok = F.fetch, pages = []; let n = 0;
  r.http = async (u, o) => { const url = new URL(u); if (!url.pathname.endsWith('/markets/trades')) return ok(u, o); pages.push(url.searchParams.get('cursor'));
    const cur = url.searchParams.get('cursor'); const mkT = (id) => ({ trade_id: id, ticker: 'KXBTC15M-26OCT301715-15', created_time: new Date(F.c.t - 100).toISOString(), yes_price_dollars: '0.5', no_price_dollars: '0.5', count_fp: '1', taker_side: 'yes' });
    if (!cur) return Response.json({ cursor: 'p2', trades: Array.from({ length: 1000 }, () => mkT('n' + n++)) });
    return Response.json({ cursor: 'p3', trades: [...Array.from({ length: 999 }, () => mkT('n' + n++)), mkT('a1')] }); };
  const before = r.status().stored.chunks; await step(r, F, 2);
  assert.deepEqual(pages, [null, 'p2'], 'second page fetched, stopped at the seen trade');
  assert.ok(!r.buf.some((x) => x.reason === 'trade-page-limit' && x.rx > T0 + 2000), 'no page-limit gap when the cursor closed the hole');
  assert.ok(r.status().stored.chunks > before, 'flushed early on row count, before FLUSH_MS');
});

test('cf recorder: a market\'s first trades poll also follows the cursor, and a still-full last page is a page-limit gap', async () => {
  const F = fakes(T0); const r = await mk(F); await r.fetch(new Request('https://x/start', { method: 'POST' }));
  const ok = F.fetch, pages = []; let n = 0;
  r.http = async (u, o) => { const url = new URL(u); if (!url.pathname.endsWith('/markets/trades')) return ok(u, o);
    if (url.searchParams.get('ticker') === 'KXBTC15M-26OCT301715-15') pages.push(url.searchParams.get('cursor'));
    const mkT = () => ({ trade_id: 'f' + n++, ticker: url.searchParams.get('ticker'), created_time: new Date(F.c.t - 100).toISOString(), yes_price_dollars: '0.5', no_price_dollars: '0.5', count_fp: '1', taker_side: 'yes' });
    return Response.json({ cursor: 'c' + n, trades: Array.from({ length: 1000 }, mkT) }); };
  await step(r, F, 2);
  assert.equal(pages.length, 3, 'TRADE_PAGES=3 pages on the first poll');
  assert.ok(r.buf.some((x) => x.reason === 'trade-page-limit' && x.key === 'KXBTC15M-26OCT301715-15'));
});
