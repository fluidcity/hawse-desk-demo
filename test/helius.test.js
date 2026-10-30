'use strict';
// Helius quota fix: webhook receiver, budget guard, estimates, admin-script planning. Local sample payloads only, NO network.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const H = require('../server/feeds/helius');
const { CreditBudget } = require('../server/lib/credits');
const { SolanaWhaleFeed, DEFAULT_SOL_WATCH } = require('../server/feeds/whales');
const { buildPlan, main } = require('../scripts/helius-webhook');
const { createHooksServer } = require('../server/server');

const SECRET = 'whsec-TEST-not-a-real-secret';
const WALLET = 'Wa11et1111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sampleTx = (sig, extra = {}) => ({ signature: sig, timestamp: 1790000000, type: 'SWAP', source: 'JUPITER', feePayer: 'Wa11et1111111111111111111111111111111111111',
  tokenTransfers: [{ mint: USDC, fromUserAccount: 'Wa11et1111111111111111111111111111111111111', toUserAccount: 'Poo1', tokenAmount: 250000 }],
  nativeTransfers: [{ fromUserAccount: 'Poo1', toUserAccount: 'Wa11et1111111111111111111111111111111111111', amount: 1600e9 }], ...extra });
const health = () => ({ rows: {}, register(id, o) { this.rows[id] = { ...o }; }, ok(id, l) { this.rows[id].ok = (this.rows[id].ok || 0) + 1; this.rows[id].lat = l; }, fail(id, m) { this.rows[id].err = m; }, setKind(id, k, n) { this.rows[id].kind = k; this.rows[id].note = n; }, setTransport() {} });

test('verifyAuth: exact match only, constant-time, empty secret never authorizes', () => {
  assert.equal(H.verifyAuth(SECRET, SECRET), true);
  assert.equal(H.verifyAuth(SECRET + 'x', SECRET), false);
  assert.equal(H.verifyAuth('', SECRET), false);
  assert.equal(H.verifyAuth(undefined, SECRET), false);
  assert.equal(H.verifyAuth('', ''), false);
});

test('handleWebhook: 503 without secret, 405 non-POST, 403 bad auth, 400 bad body, 200 ok', () => {
  const body = JSON.stringify([sampleTx('s1'), { nope: 1 }]);
  assert.equal(H.handleWebhook({ method: 'POST', headers: { authorization: SECRET }, rawBody: body }, { secret: '' }).status, 503);
  assert.equal(H.handleWebhook({ method: 'GET', headers: { authorization: SECRET }, rawBody: body }, { secret: SECRET }).status, 405);
  assert.equal(H.handleWebhook({ method: 'POST', headers: { authorization: 'wrong' }, rawBody: body }, { secret: SECRET }).status, 403);
  assert.equal(H.handleWebhook({ method: 'POST', headers: {}, rawBody: body }, { secret: SECRET }).status, 403);
  assert.equal(H.handleWebhook({ method: 'POST', headers: { authorization: SECRET }, rawBody: '{bad' }, { secret: SECRET }).status, 400);
  assert.equal(H.handleWebhook({ method: 'POST', headers: { authorization: SECRET }, rawBody: '{"a":1}' }, { secret: SECRET }).status, 400);
  const r = H.handleWebhook({ method: 'POST', headers: { authorization: SECRET }, rawBody: body }, { secret: SECRET });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, received: 2, accepted: 1 }); assert.equal(r.txs[0].signature, 's1');
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
});

test('normalizeParsed: Parsed Events → enhanced shape (raw amounts scaled by decimals, failed tx flagged)', () => {
  const n = H.normalizeParsed({ signature: 'p1', parsed: { blockTime: 1790000000, feePayer: 'F', transactionStatus: 'OK', nativeTransfers: [],
    tokenTransfers: [{ mint: USDC, fromUserAccount: 'F', toUserAccount: 'P', rawTokenAmount: '1234500000', decimals: 6 }], summary: { type: 'swap', parsedData: { protocol: 'jupiter' } } } });
  assert.equal(n.type, 'SWAP'); assert.equal(n.source, 'JUPITER'); assert.equal(n.tokenTransfers[0].tokenAmount, 1234.5); assert.equal(n.transactionError, null);
  const bad = H.normalizeParsed({ signature: 'p2', parsed: { transactionStatus: 'FAILED', summary: {} } }); assert.ok(bad.transactionError);
  assert.equal(H.normalizeParsed({}), null);
});

test('estimates: removed legacy loop ≈ 1.15M credits/day for 2 addresses; new defaults fit the 1M/month free plan', () => {
  assert.equal(H.estimates.legacyPerDay(2, 15), 1152000);
  assert.ok(H.estimates.legacyPerDay(2, 15) > H.CREDITS.freePlanMonthly, 'legacy blew the MONTHLY plan in under a day');
  assert.equal(H.estimates.pollPerMonth(2, 900), 57600); // opt-in poll at the default 15 min
  assert.ok(H.estimates.pollPerMonth(2, 900) < 100000, 'default poll fits the default 100k guard');
  assert.equal(H.estimates.webhookPerMonth(10, Date.now() - 60e3), null, 'no extrapolation from < 1 h of data');
  assert.equal(H.estimates.webhookPerMonth(100, 0 + 1, 1 + 2 * 3.6e6), 36000);
});

test('CreditBudget: hard cap refuses and counts, records unrefusable charges, rolls on a new UTC month', () => {
  let T = Date.UTC(2026, 9, 30); const b = new CreditBudget({ provider: 'x', budget: 25, file: '', now: () => T });
  assert.ok(b.trySpend(10)); assert.ok(b.trySpend(10)); assert.equal(b.trySpend(10), false);
  assert.equal(b.view().refused, 1); assert.equal(b.view().used, 20); assert.equal(b.view().remaining, 5);
  b.record(7, 'webhook-events'); assert.equal(b.view().used, 27); assert.equal(b.view().overBudget, true); assert.equal(b.remaining(), 0);
  T = Date.UTC(2026, 10, 1); assert.equal(b.view().used, 0); assert.equal(b.view().month, '2026-11'); assert.ok(b.trySpend(10));
});

test('SolanaWhaleFeed: default is MOCK (no Helius calls); webhook mode only with a secret; poll without key → mock', () => {
  assert.equal(new SolanaWhaleFeed({ health: health(), apiKey: 'k', minUsd: 1e5, priceFn: () => 150 }).mode, 'mock');
  assert.equal(new SolanaWhaleFeed({ health: health(), apiKey: 'k', minUsd: 1e5, priceFn: () => 150, webhookAuth: SECRET }).mode, 'webhook');
  assert.equal(new SolanaWhaleFeed({ health: health(), apiKey: '', minUsd: 1e5, priceFn: () => 150, mode: 'poll' }).mode, 'mock');
  const f = new SolanaWhaleFeed({ health: health(), apiKey: 'k', minUsd: 1e5, priceFn: () => 150, webhookAuth: SECRET });
  assert.equal(f.pollSec >= 300, true); assert.equal(f.timer, undefined); f.start(); assert.equal(f.timer, undefined, 'webhook mode sets no poll timer'); f.stop();
});

test('SolanaWhaleFeed webhook ingest: real events (not mock), dedupe by signature, 1 credit per delivered event, listeners fire', () => {
  const h = health(); const budget = new CreditBudget({ provider: 'helius', budget: 1000, file: '' });
  const f = new SolanaWhaleFeed({ health: h, apiKey: 'k', minUsd: 1e5, priceFn: () => 150, webhookAuth: SECRET, budget, watch: [WALLET], now: () => 1790000000000 + 2000 });
  const seen = []; f.onTx((tx, c, origin) => seen.push([tx.signature, c.dir, origin]));
  assert.equal(f.ingestWebhook([sampleTx('a'), sampleTx('b'), sampleTx('a'), sampleTx('c', { transactionError: { x: 1 } })]), 2);
  assert.equal(budget.view().used, 4, 'every delivered event is charged, including dupes/failed');
  assert.deepEqual(seen, [['a', 'buy', 'webhook'], ['b', 'buy', 'webhook']]);
  assert.equal(f.events.length, 2); assert.ok(f.events.every((e) => e.mock === false && e.whale && /\(webhook\)/.test(e.desc)));
  assert.equal(h.rows['whale.solana'].lat, 2000, 'latency = block time → receipt');
  const c = f.credits(); assert.equal(c.mode, 'webhook'); assert.equal(c.used, 4); assert.equal(c.webhook.events, 4); assert.equal(c.estMonthly, null);
  assert.ok(!JSON.stringify(f.snapshot()).includes(SECRET) && !JSON.stringify(f.publicInfo()).includes(SECRET));
});

test('SolanaWhaleFeed poll fallback: budget guard refuses before any request; key never in errors', async () => {
  const h = health(); let calls = 0;
  const fetchImpl = async (u) => { calls++; return { ok: true, text: async () => JSON.stringify({ data: [{ signature: 'q' + calls, parsed: { blockTime: 1790000000, feePayer: 'F', transactionStatus: 'OK', nativeTransfers: [], tokenTransfers: [], summary: { type: 'transfer' } } }] }) }; };
  const budget = new CreditBudget({ provider: 'helius', budget: 15, file: '' }); // room for ONE 10-credit call
  const f = new SolanaWhaleFeed({ health: h, apiKey: 'SECRETKEY123', minUsd: 1e5, priceFn: () => 150, mode: 'poll', watch: ['Addr1111', 'Addr2222'], budget, fetchImpl });
  assert.equal(f.mode, 'poll');
  await f.poll();
  assert.equal(calls, 1, 'second address refused by the guard, no request sent'); assert.equal(budget.view().used, 10); assert.equal(f.pollStats.refused, 1);
  assert.match(h.rows['whale.solana'].err, /budget/); await f.poll(); assert.equal(calls, 1, 'still refused');
  const g = new SolanaWhaleFeed({ health: h, apiKey: 'SECRETKEY123', minUsd: 1e5, priceFn: () => 150, mode: 'poll', watch: ['A'], budget: new CreditBudget({ provider: 'h', budget: 100, file: '' }),
    fetchImpl: async (u) => { throw new Error('boom ' + u); } });
  await g.poll(); assert.ok(!h.rows['whale.solana'].err.includes('SECRETKEY123'));
  const none = new SolanaWhaleFeed({ health: h, apiKey: 'k', minUsd: 1e5, priceFn: () => 150, mode: 'poll', watch: ['A'], budget: null, fetchImpl: async () => { throw new Error('should not be called'); } });
  await none.poll(); assert.equal(none.pollStats.refused, 1, 'no budget configured → refuse (fail closed)');
});

test('admin script planning: dry run by default, refuses localhost/http/busy pools, never prints secrets', async () => {
  const env = { HELIUS_API_KEY: 'HKEY-should-not-print', HELIUS_WEBHOOK_AUTH: SECRET, HELIUS_WEBHOOK_URL: 'https://hooks.example.com/hooks/helius', HELIUS_WEBHOOK_ADDRESSES: 'Wa11et1111111111111111111111111111111111111' };
  const ok = buildPlan(env, []); assert.equal(ok.cmd, 'plan'); assert.equal(ok.apply, false); assert.deepEqual(ok.errors, []); assert.equal(ok.cost, 0);
  assert.equal(ok.body.webhookType, 'enhanced'); assert.equal(ok.body.authHeader, '<HELIUS_WEBHOOK_AUTH>'); assert.deepEqual(ok.body.transactionTypes, ['SWAP', 'TRANSFER']);
  assert.equal(buildPlan(env, ['upsert']).cost, 100); assert.equal(buildPlan(env, ['bogus']).cost, 0);
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_URL: 'https://localhost:8787/hooks/helius' }, []).errors.some((e) => /publicly reachable/.test(e)));
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_URL: 'http://hooks.example.com/hooks/helius' }, []).errors.some((e) => /https/.test(e)));
  const busy = { ...env, HELIUS_WEBHOOK_ADDRESSES: DEFAULT_SOL_WATCH[0].addr };
  assert.ok(buildPlan(busy, []).errors.some((e) => /busy AMM pool/.test(e))); assert.deepEqual(buildPlan(busy, ['--allow-busy-pools']).errors, []);
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_URL: '' }, ['delete']).errors.some((e) => /required/.test(e)), 'never guesses which webhook to delete');
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_AUTH: '' }, []).errors.some((e) => /HELIUS_WEBHOOK_AUTH/.test(e)));
  // main() in dry-run mode prints a plan and makes no network call
  const realFetch = global.fetch; let fetched = 0; global.fetch = async () => { fetched++; throw new Error('no network in tests'); };
  const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { await main(env, ['upsert']); await main(env, []); } finally { console.log = realLog; global.fetch = realFetch; }
  assert.equal(fetched, 0); const out = logs.join('\n');
  assert.ok(!out.includes('HKEY-should-not-print') && !out.includes(SECRET)); assert.match(out, /dry run/);
});

test('hooks-only server: /hooks/helius ACKs 200 then ingests; 403 on bad auth; desk API not exposed', async () => {
  const ingested = []; const engine = { hooks: { '/hooks/helius': { maxBody: H.MAX_BODY, handle: (r) => H.handleWebhook(r, { secret: SECRET }), process: (r) => ingested.push(...r.txs) } } };
  const srv = createHooksServer(engine); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const req = (path, headers, body) => new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); q.on('error', reject); q.end(body); });
  try {
    const good = await req('/hooks/helius', { authorization: SECRET }, JSON.stringify([sampleTx('h1')]));
    assert.equal(good.status, 200); assert.deepEqual(JSON.parse(good.body), { ok: true, received: 1, accepted: 1 });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); assert.equal(ingested.length, 1);
    assert.equal((await req('/hooks/helius', { authorization: 'nope' }, '[]')).status, 403);
    assert.equal((await req('/api/state', {}, '')).status, 404); assert.equal((await req('/hooks/other', {}, '')).status, 404);
  } finally { srv.close(); }
});

test('WHALES_ENABLED: off by default → DEMO/MOCK, receiver disabled, no live mode even with keys; poll needs configured wallets', () => {
  const config = require('../server/config');
  const env = { HELIUS_API_KEY: 'k', HELIUS_WEBHOOK_AUTH: SECRET, HELIUS_MODE: 'poll', HELIUS_WATCH_ADDRESSES: WALLET };
  assert.equal(config.build(env).helius.mode, 'mock'); assert.equal(config.build(env).helius.enabled, false);
  assert.equal(config.build({ ...env, WHALES_ENABLED: 'true' }).helius.mode, 'poll');
  assert.equal(config.build({ ...env, WHALES_ENABLED: 'true', HELIUS_MODE: '' }).helius.mode, 'webhook');
  assert.deepEqual(config.build({ FOLLOW_WALLETS_SOL: WALLET }).helius.watch, [WALLET]);
  const h = health(); const f = new SolanaWhaleFeed({ health: h, apiKey: 'k', minUsd: 1e5, priceFn: () => 150, mode: 'poll', watch: null });
  assert.equal(f.mode, 'mock', 'never polls the default busy pools'); assert.equal(f.watchConfigured, false);
  const off = new SolanaWhaleFeed({ health: h, apiKey: 'k', minUsd: 1e5, priceFn: () => 150, mode: 'mock', enabled: false }); assert.match(h.rows['whale.solana'].note, /DEMO/); assert.equal(off.credits().enabled, false);
  // receiver wired through modules: disabled unless enabled
  const { Engine } = require('../server/engine'); const mods = require('../server/modules');
  const e1 = new Engine(config.build({ HELIUS_WEBHOOK_AUTH: SECRET, CREDITS_FILE: '' }), { modules: { whales: mods.whales } });
  assert.equal(e1.hooks['/hooks/helius'].handle({ method: 'POST', headers: { authorization: SECRET }, rawBody: '[]' }).status, 503);
  const e2 = new Engine(config.build({ HELIUS_WEBHOOK_AUTH: SECRET, WHALES_ENABLED: 'true', CREDITS_FILE: '' }), { modules: { whales: mods.whales } });
  assert.equal(e2.hooks['/hooks/helius'].handle({ method: 'POST', headers: { authorization: SECRET }, rawBody: '[]' }).status, 200);
});

test('only configured whale wallets are acted on; others are dropped (still counted as billed)', () => {
  const budget = new CreditBudget({ provider: 'h', budget: 1e6, dailyBudget: 1000, file: '' });
  const f = new SolanaWhaleFeed({ health: health(), apiKey: 'k', minUsd: 1e5, priceFn: () => 150, webhookAuth: SECRET, budget, watch: [WALLET] });
  const other = sampleTx('x', { feePayer: 'Other', tokenTransfers: [], nativeTransfers: [{ fromUserAccount: 'Other', toUserAccount: 'Pool', amount: 5e12 }] });
  assert.equal(f.ingestWebhook([other, sampleTx('y')]), 1); assert.equal(f.dropped, 1); assert.equal(budget.view().used, 2);
});

test('HARD daily cap: auto-pause at 90%, remote webhook pause requested once, visible in credits view; resets next UTC day', async () => {
  let T = Date.UTC(2026, 9, 29, 12); let pauses = 0;
  const budget = new CreditBudget({ provider: 'h', budget: 1e6, dailyBudget: 100, pauseAtPct: 90, file: '', now: () => T });
  const f = new SolanaWhaleFeed({ health: health(), apiKey: 'k', minUsd: 1e5, priceFn: () => 150, webhookAuth: SECRET, budget, watch: [WALLET], now: () => T, pauseRemote: async () => { pauses++; return { ok: true, id: 'w1' }; } });
  const batch = (k, n) => Array.from({ length: n }, (_, i) => sampleTx(k + i));
  assert.equal(f.ingestWebhook(batch('a', 80)), 80); assert.equal(budget.paused(), false);
  f.ingestWebhook(batch('b', 15)); // 95 ≥ 90% → paused
  assert.equal(budget.paused(), true); assert.equal(f.ingestWebhook(batch('c', 3)), 0, 'acts on nothing while paused');
  await new Promise((r) => setImmediate(r)); assert.equal(pauses, 1, 'remote pause requested once'); assert.match(f.autoPaused.remote, /deactivated/);
  const c = f.credits(); assert.equal(c.paused, true); assert.equal(c.dailyBudget, 100); assert.ok(c.usedToday >= 98 + 100, 'includes the 100-credit pause edit');
  assert.equal(budget.trySpend(10), false, 'poll spend refused while paused');
  T += 864e5; assert.equal(budget.paused(), false, 'new UTC day'); assert.equal(f.checkPause(), false); assert.equal(f.autoPaused, null);
});

test('pauseWebhook: matches by URL, PATCHes active:false, key redacted from errors (stubbed fetch, no network)', async () => {
  const seen = []; const fetchImpl = async (u, o = {}) => { seen.push([o.method || 'GET', String(u).replace(/api-key=[^&]+/, 'api-key=K')]); return { ok: true, text: async () => JSON.stringify([{ webhookID: 'w9', webhookURL: 'https://h.example.com/hooks/helius' }, { webhookID: 'zz', webhookURL: 'https://other' }]) }; };
  const r = await H.pauseWebhook({ apiKey: 'KEY123', url: 'https://h.example.com/hooks/helius', fetchImpl });
  assert.deepEqual(r, { ok: true, id: 'w9' }); assert.equal(seen[1][0], 'PATCH'); assert.match(seen[1][1], /webhooks\/w9\?/);
  assert.equal((await H.pauseWebhook({ apiKey: 'KEY123', url: 'https://nope', fetchImpl })).ok, false);
  const e = await H.pauseWebhook({ apiKey: 'KEY123', url: 'x', fetchImpl: async (u) => { throw new Error('fail ' + u); } }); assert.ok(!e.error.includes('KEY123'));
});

test('Jupiter: default host is api.jup.ag (lite-api retired), optional key goes in x-api-key header only, keyless paced at 0.5 rps', async () => {
  const config = require('../server/config'); const fs = require('fs'); const path = require('path');
  assert.equal(config.build({}).jupiter.base, 'https://api.jup.ag');
  for (const f of ['server/config.js', 'server/feeds/dex.js']) assert.ok(!/https:\/\/lite-api/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f);
  const { DexFeed } = require('../server/feeds/dex');
  const mk = (key) => new DexFeed({ health: health(), cfg: { jupiterBase: 'https://api.jup.ag', jupiterKey: key }, evmCfg: { chains: [] }, priceFn: () => 150 });
  assert.equal(mk('').jupGapMs, 2100); assert.equal(mk('JKEY').jupGapMs, 1100);
  const orig = global.fetch; const seen = [];
  global.fetch = async (u, o) => { seen.push({ u: String(u), h: o.headers }); return { ok: true, status: 200, text: async () => '{"outAmount":"1"}' }; };
  try { const d = mk('JKEY'); d.jupGapMs = 0; await d.jq('A', 'B', 1); } finally { global.fetch = orig; }
  assert.equal(seen[0].h['x-api-key'], 'JKEY'); assert.ok(!seen[0].u.includes('JKEY')); assert.match(seen[0].u, /^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?/);
});
