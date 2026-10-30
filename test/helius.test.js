'use strict';
// Helius via the HAWSE inbox: feed modes, credit accounting, budget guard, auto-pause, admin-script planning. Local only, NO network.
const test = require('node:test');
const assert = require('node:assert');
const H = require('../server/feeds/helius');
const { CreditBudget } = require('../server/lib/credits');
const { SolanaWhaleFeed, DEFAULT_SOL_WATCH } = require('../server/feeds/whales');
const { PROPOSED_WATCH, resolveWatch, estimateCredits } = require('../server/feeds/helius-watch');
const { buildPlan, main, redactAll } = require('../scripts/helius-webhook');

const SECRET = 'whsec-TEST-not-a-real-secret';
const READ = 'read-TEST-not-a-real-token';
const BASE = 'https://fake-inbox-TEST.example.workers.dev';
const WALLET = 'Wa11et1111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sampleTx = (sig, extra = {}) => ({ signature: sig, timestamp: 1790000000, type: 'SWAP', source: 'JUPITER', feePayer: WALLET,
  tokenTransfers: [{ mint: USDC, fromUserAccount: WALLET, toUserAccount: 'Poo1', tokenAmount: 250000 }],
  nativeTransfers: [{ fromUserAccount: 'Poo1', toUserAccount: WALLET, amount: 1600e9 }], ...extra });
const health = () => ({ rows: {}, register(id, o) { this.rows[id] = { ...o }; }, ok(id, l) { this.rows[id].ok = (this.rows[id].ok || 0) + 1; this.rows[id].lat = l; }, fail(id, m) { this.rows[id].err = m; }, setKind(id, k, n) { this.rows[id].kind = k; this.rows[id].note = n; }, setTransport() {} });
const INBOX = { baseUrl: BASE, readToken: READ, stateFile: '' };
const noNet = async () => { throw new Error('no network in tests'); };
const feed = (o = {}) => new SolanaWhaleFeed({ health: health(), minUsd: 1e5, priceFn: () => 150, mode: 'inbox', inbox: INBOX, fetchImpl: noNet, watch: [WALLET], ...o });
const ev = (txs, receivedAt = 1790000000000 + 1500) => ({ id: 1, receivedAt, delivered: txs.length, txs });

test('estimates: removed legacy loop ≈ 1.15M credits/day; webhook extrapolation needs ≥ 1 h of data', () => {
  assert.equal(H.estimates.legacyPerDay(2, 15), 1152000);
  assert.ok(H.estimates.legacyPerDay(2, 15) > H.CREDITS.freePlanMonthly, 'legacy blew the MONTHLY plan in under a day');
  assert.equal(H.estimates.webhookPerMonth(10, Date.now() - 60e3), null, 'no extrapolation from < 1 h of data');
  assert.equal(H.estimates.webhookPerMonth(100, 0 + 1, 1 + 2 * 3.6e6), 36000);
  assert.equal(H.WEBHOOKS_URL, 'https://api-mainnet.helius-rpc.com/v0/webhooks');
  assert.equal(H.inboxHookUrl('https://x.example.dev/'), 'https://x.example.dev/helius'); assert.equal(H.inboxHookUrl(''), '');
});

test('proposed watch list: verified labels + sources, small, measured, fits the caps; env overrides it', () => {
  assert.ok(PROPOSED_WATCH.length >= 1 && PROPOSED_WATCH.length <= 10, 'SMALL list');
  for (const w of PROPOSED_WATCH) {
    assert.match(w.addr, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); assert.equal(w.source, 'https://solscan.io/account/' + w.addr); assert.ok(w.label && w.txPerDay >= 0 && w.measured);
    assert.ok(!DEFAULT_SOL_WATCH.some((p) => p.addr === w.addr), 'no busy pools');
  }
  const e = estimateCredits(PROPOSED_WATCH);
  assert.ok(e.perDay < 10000 && e.planned <= 30000 * 0.5, `planned ${e.planned}/day must stay under half the daily cap`);
  assert.ok(e.perMonth < H.CREDITS.freePlanMonthly * 0.15); assert.match(e.assumption, /1 credit\/event/);
  assert.equal(resolveWatch({}).accounts.length, PROPOSED_WATCH.length);
  const o = resolveWatch({ HELIUS_WATCH_ADDRESSES: WALLET }); assert.equal(o.source, 'HELIUS_WATCH_ADDRESSES'); assert.equal(o.accounts[0].txPerDay, null);
  assert.equal(estimateCredits(o.accounts).perDay, null, 'unmeasured address → unknown, not a made-up number');
});

test('CreditBudget: hard cap refuses and counts, records unrefusable charges, rolls on a new UTC month', () => {
  let T = Date.UTC(2026, 9, 30); const b = new CreditBudget({ provider: 'x', budget: 25, file: '', now: () => T });
  assert.ok(b.trySpend(10)); assert.ok(b.trySpend(10)); assert.equal(b.trySpend(10), false);
  assert.equal(b.view().refused, 1); assert.equal(b.view().used, 20); assert.equal(b.view().remaining, 5);
  b.record(7, 'webhook-events'); assert.equal(b.view().used, 27); assert.equal(b.view().overBudget, true); assert.equal(b.remaining(), 0);
  T = Date.UTC(2026, 10, 1); assert.equal(b.view().used, 0); assert.equal(b.view().month, '2026-11'); assert.ok(b.trySpend(10));
});

test('SolanaWhaleFeed modes: inbox only when configured; otherwise labelled MOCK "inbox not configured"; start() makes no call', () => {
  assert.equal(feed().mode, 'inbox');
  const h = health(); let calls = 0;
  const f = new SolanaWhaleFeed({ health: h, minUsd: 1e5, priceFn: () => 150, mode: 'inbox', inbox: { baseUrl: '', readToken: '' }, fetchImpl: async () => { calls++; return {}; } });
  assert.equal(f.mode, 'mock'); assert.match(h.rows['whale.solana'].note, /inbox not configured/); assert.match(h.rows['whale.inbox'].note, /inbox not configured \(HAWSE_WEBHOOK_URL \/ HAWSE_READ_TOKEN missing\)/);
  f.start(); f.stop(); assert.equal(calls, 0);
  assert.equal(f.credits().inbox.configured, false);
  assert.equal(new SolanaWhaleFeed({ health: health(), minUsd: 1e5, priceFn: () => 150, inbox: { baseUrl: BASE }, enabled: true }).mode, 'mock', 'token missing → mock');
  const off = new SolanaWhaleFeed({ health: h, minUsd: 1e5, priceFn: () => 150, mode: 'mock', enabled: false, inbox: INBOX }); assert.match(h.rows['whale.solana'].note, /DEMO/); assert.equal(off.credits().enabled, false); assert.equal(off.credits().inbox, null);
});

test('inbox ingest: real events (not mock), dedupe by signature, 1 credit per delivered event, listeners fire, test payloads not billed', () => {
  const h = health(); const budget = new CreditBudget({ provider: 'helius', budget: 1000, file: '' });
  const f = feed({ health: h, budget, now: () => 1790000000000 + 2000 });
  const seen = []; f.onTx((tx, c, origin) => seen.push([tx.signature, c.dir, origin]));
  assert.equal(f.ingestInboxEvent(ev([sampleTx('a'), sampleTx('b'), sampleTx('a'), sampleTx('c', { transactionError: { x: 1 } })])), 2);
  assert.equal(budget.view().used, 4, 'every delivered event is charged, including dupes/failed');
  assert.deepEqual(seen, [['a', 'buy', 'inbox'], ['b', 'buy', 'inbox']]);
  assert.equal(f.events.length, 2); assert.ok(f.events.every((e) => e.mock === false && e.whale && /\(inbox\)/.test(e.desc)));
  assert.equal(h.rows['whale.solana'].lat, 2000, 'latency = block time → desk'); assert.equal(f.delivery.lastLagMs, 1500, 'block time → inbox receipt');
  f.ingestInboxEvent(ev([sampleTx('HAWSE-TEST-fake-1')]));
  assert.equal(budget.view().used, 4, 'our own verification POST never went through Helius: not billed'); assert.equal(f.delivery.test, 1);
  assert.ok(f.events[0].test && f.events[0].mock, 'test payload is labelled, never a real event'); assert.equal(seen.length, 2, 'test payloads never reach strategies');
  const c = f.credits(); assert.equal(c.mode, 'inbox'); assert.equal(c.used, 4); assert.equal(c.delivery.events, 4); assert.match(c.estBasis, /planned|observed|1 cr/);
  for (const s of [JSON.stringify(f.snapshot()), JSON.stringify(f.publicInfo()), JSON.stringify(h.rows)]) { assert.ok(!s.includes(READ)); assert.ok(!s.includes(BASE)); assert.ok(!s.includes('fake-inbox-TEST')); }
});

test('backfilled txs (older than INBOX_MAX_SIGNAL_AGE_SEC) are shown but never drive strategies', () => {
  const f = feed({ now: () => 1790000000000 + 3600e3 }); const seen = []; f.onTx((tx) => seen.push(tx.signature));
  f.ingestInboxEvent(ev([sampleTx('old')])); assert.equal(seen.length, 0); assert.match(f.events[0].desc, /backfill/);
});

test('WHALES_ENABLED: off by default → DEMO/MOCK even with keys; inbox mode when enabled; watch resolution', () => {
  const config = require('../server/config');
  const env = { HELIUS_API_KEY: 'k', HAWSE_WEBHOOK_URL: BASE, HAWSE_READ_TOKEN: READ, HELIUS_WATCH_ADDRESSES: WALLET };
  assert.equal(config.build(env).helius.mode, 'mock'); assert.equal(config.build(env).helius.enabled, false);
  const on = config.build({ ...env, WHALES_ENABLED: 'true' }).helius; assert.equal(on.mode, 'inbox'); assert.equal(on.webhookUrl, BASE + '/helius');
  assert.equal(config.build({ ...env, WHALES_ENABLED: 'true', HELIUS_MODE: 'poll' }).helius.mode, 'inbox', 'the old poll mode is gone');
  assert.equal(config.build({ INBOX_POLL_SEC: '5' }).helius.inbox.pollSec, 15); assert.equal(config.build({ INBOX_POLL_SEC: '600' }).helius.inbox.pollSec, 60);
  assert.deepEqual(config.build({ FOLLOW_WALLETS_SOL: WALLET }).helius.watch, [WALLET]);
  assert.equal(config.publicFlags(config.build(env)).inboxConfigured, true); assert.ok(!JSON.stringify(config.publicFlags(config.build(env))).includes(READ));
  // wired through modules: no local receiver; feed uses the inbox
  const { Engine } = require('../server/engine'); const mods = require('../server/modules');
  const e = new Engine(config.build({ ...env, WHALES_ENABLED: 'true', CREDITS_FILE: '', INBOX_STATE_FILE: '' }), { modules: { whales: mods.whales } });
  assert.equal(e.feeds['whale.solana'].mode, 'inbox'); assert.ok(!(e.hooks && e.hooks['/hooks/helius']), 'old receiver removed');
  const d = new Engine(config.build({ CREDITS_FILE: '', INBOX_STATE_FILE: '' }), { modules: { whales: mods.whales } }); assert.equal(d.feeds['whale.solana'].mode, 'mock');
});

test('only watched accounts are acted on; others are dropped (still counted as billed); default watch = proposed list', () => {
  const budget = new CreditBudget({ provider: 'h', budget: 1e6, dailyBudget: 1000, file: '' });
  const f = feed({ budget });
  const other = sampleTx('x', { feePayer: 'Other', tokenTransfers: [], nativeTransfers: [{ fromUserAccount: 'Other', toUserAccount: 'Pool', amount: 5e12 }] });
  assert.equal(f.ingestInboxEvent(ev([other, sampleTx('y')])), 1); assert.equal(f.dropped, 1); assert.equal(budget.view().used, 2);
  const p = feed({ watch: null }); assert.equal(p.watch.length, PROPOSED_WATCH.length); assert.equal(p.watchConfigured, false);
  const ex = PROPOSED_WATCH[0].addr; // exchange deposit: someone sends 5,000 SOL to the hot wallet
  assert.equal(p.ingestInboxEvent(ev([sampleTx('dep', { type: 'TRANSFER', feePayer: 'Someone', tokenTransfers: [], nativeTransfers: [{ fromUserAccount: 'Someone', toUserAccount: ex, amount: 5000e9 }] })])), 1);
  assert.match(p.events[0].desc, new RegExp(PROPOSED_WATCH[0].label.replace(/[()]/g, '.')));
});

test('HARD daily cap: auto-pause at 90%, remote webhook pause requested once, visible in credits view; resets next UTC day', async () => {
  let T = Date.UTC(2026, 9, 29, 12); let pauses = 0;
  const budget = new CreditBudget({ provider: 'h', budget: 1e6, dailyBudget: 100, pauseAtPct: 90, file: '', now: () => T });
  const f = feed({ budget, now: () => T, pauseRemote: async () => { pauses++; return { ok: true, id: 'w1' }; } });
  const batch = (k, n) => ev(Array.from({ length: n }, (_, i) => sampleTx(k + i)), T);
  assert.equal(f.ingestInboxEvent(batch('a', 80)), 80, 'stored (as backfill: old block times)'); assert.equal(budget.paused(), false);
  f.ingestInboxEvent(batch('b', 15)); // 95 ≥ 90% → paused
  assert.equal(budget.paused(), true); f.ingestInboxEvent(batch('c', 3)); assert.ok(f.dropped >= 3, 'acts on nothing while paused');
  await new Promise((r) => setImmediate(r)); assert.equal(pauses, 1, 'remote pause requested once'); assert.match(f.autoPaused.remote, /deactivated/);
  const c = f.credits(); assert.equal(c.paused, true); assert.equal(c.dailyBudget, 100); assert.ok(c.usedToday >= 98 + 100, 'includes the 100-credit pause edit');
  T += 864e5; assert.equal(budget.paused(), false, 'new UTC day'); assert.equal(f.checkPause(), false); assert.equal(f.autoPaused, null);
});

test('pauseWebhook: matches by URL, PATCHes active:false, key + URL redacted from errors (stubbed fetch, no network)', async () => {
  const seen = []; const fetchImpl = async (u, o = {}) => { seen.push([o.method || 'GET', String(u).replace(/api-key=[^&]+/, 'api-key=K')]); return { ok: true, text: async () => JSON.stringify([{ webhookID: 'w9', webhookURL: BASE + '/helius' }, { webhookID: 'zz', webhookURL: 'https://other' }]) }; };
  const r = await H.pauseWebhook({ apiKey: 'KEY123', url: BASE + '/helius', fetchImpl });
  assert.deepEqual(r, { ok: true, id: 'w9' }); assert.equal(seen[1][0], 'PATCH'); assert.match(seen[1][1], /^https:\/\/api-mainnet\.helius-rpc\.com\/v0\/webhooks\/w9\?/);
  assert.equal((await H.pauseWebhook({ apiKey: 'KEY123', url: 'https://nope', fetchImpl })).ok, false);
  const e = await H.pauseWebhook({ apiKey: 'KEY123', url: 'x', fetchImpl: async (u) => { throw new Error('fail ' + u); } }); assert.ok(!e.error.includes('KEY123') && !e.error.includes('helius-rpc'));
});

test('admin script: dry run by default, ONE enhanced webhook at <HAWSE_WEBHOOK_URL>/helius, estimate printed, never prints secrets or calls out', async () => {
  const env = { HELIUS_API_KEY: 'HKEY-should-not-print', HELIUS_WEBHOOK_AUTH: SECRET, HAWSE_WEBHOOK_URL: BASE, HAWSE_READ_TOKEN: READ, CREDITS_FILE: '' };
  const ok = buildPlan(env, []); assert.equal(ok.cmd, 'plan'); assert.equal(ok.apply, false); assert.deepEqual(ok.errors, []); assert.equal(ok.cost, 0);
  assert.equal(ok.url, BASE + '/helius'); assert.equal(ok.body.webhookURL, '<HAWSE_WEBHOOK_URL>/helius'); assert.equal(ok.api, 'https://api-mainnet.helius-rpc.com/v0/webhooks');
  assert.equal(ok.body.webhookType, 'enhanced'); assert.equal(ok.body.authHeader, '<HELIUS_WEBHOOK_AUTH>'); assert.deepEqual(ok.body.transactionTypes, ['SWAP', 'TRANSFER']);
  assert.deepEqual(ok.addresses, PROPOSED_WATCH.map((w) => w.addr)); assert.ok(ok.estimate.perDay > 0);
  assert.equal(buildPlan(env, ['create']).cost, 100); assert.ok(buildPlan(env, ['upsert']).errors.some((e) => /unknown command/.test(e)));
  assert.ok(buildPlan({ ...env, HAWSE_WEBHOOK_URL: 'https://localhost:8787' }, []).errors.some((e) => /publicly reachable/.test(e)));
  assert.ok(buildPlan({ ...env, HAWSE_WEBHOOK_URL: 'http://inbox.example.com' }, []).errors.some((e) => /https/.test(e)));
  assert.ok(buildPlan({ ...env, HAWSE_WEBHOOK_URL: '' }, ['delete']).errors.some((e) => /HAWSE_WEBHOOK_URL/.test(e)), 'never guesses which webhook to delete');
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_AUTH: '' }, []).errors.some((e) => /HELIUS_WEBHOOK_AUTH/.test(e)));
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_AUTH: 'Bearer x' }, []).errors.some((e) => /raw value/.test(e)));
  const busy = { ...env, HELIUS_WEBHOOK_ADDRESSES: DEFAULT_SOL_WATCH[0].addr };
  assert.ok(buildPlan(busy, []).errors.some((e) => /busy AMM pool/.test(e))); assert.deepEqual(buildPlan(busy, ['--allow-busy-pools']).errors, []);
  assert.ok(buildPlan({ ...env, HELIUS_WEBHOOK_ADDRESSES: 'not-an-address!' }, []).errors.some((e) => /base58/.test(e)));
  assert.equal(buildPlan({ ...env, HELIUS_API_KEY: '' }, []).errors.length, 1);
  // main() without --apply prints a plan and makes no network call; output is redacted
  const realFetch = global.fetch; let fetched = 0; global.fetch = async () => { fetched++; throw new Error('no network in tests'); };
  const logs = []; const log = (s) => logs.push(redactAll(s, env));
  try { await main(env, ['create'], log); await main(env, [], log); } finally { global.fetch = realFetch; process.exitCode = 0; }
  assert.equal(fetched, 0); const out = logs.join('\n');
  for (const s of ['HKEY-should-not-print', SECRET, READ, BASE, 'fake-inbox-TEST']) assert.ok(!out.includes(s), 'printed ' + s);
  assert.match(out, /dry run/); assert.match(out, /expected credits\/day: ~[\d,]+/); assert.match(out, /assumption:/); assert.match(out, /solscan\.io\/account\//);
  assert.equal(redactAll(`x ${BASE}/helius ${READ} api-key=abc`, env), 'x ***/helius *** api-key=***');
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
