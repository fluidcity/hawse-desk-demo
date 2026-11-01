'use strict';
// Stage Z: Kalshi LIVE pilot (v3 7% of exchange shard 2 cash, the 15-minute crypto shard; no loss limit). Every exchange call here is a mock: zero real network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const P = require('../server/live/kalshi-pilot');
const R = require('../server/live/kalshi-rest');
const proxy = require('../scripts/auth-proxy');
const { createServer, pilotLocal } = require('../server/server');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const PEM = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }); // throwaway test key
/** Mock fetch for the REAL signed client: records every request; answers balance / api_keys / orders. */
function mockFetch({ balance = 15000, keys = null, status = 200, dateSkewMs = 0, now = Date.now } = {}) {
  const reqs = [];
  const f = async (url, o) => { const u = new URL(url); reqs.push({ method: o.method, path: u.pathname, body: o.body, headers: o.headers });
    const j = status !== 200 ? { error: { code: status === 403 ? 'insufficient_scope' : 'unauthorized', message: 'no' } } : u.pathname.endsWith('/portfolio/balance') ? { balance }
      : u.pathname.endsWith('/api_keys') ? (keys ? { api_keys: keys } : {}) : {};
    return { ok: status === 200, status, headers: { get: (h) => (h === 'date' ? new Date(now() - dateSkewMs).toUTCString() : null) }, json: async () => j }; };
  f.reqs = reqs; return f;
}
const ENV_ON = { LIVE_PILOT_ENABLED: 'true', KALSHI_TRADE_KEY_ID: 'trade-kid', KALSHI_TRADE_PRIVATE_KEY_PEM: PEM };
const CFG = JSON.parse(fs.readFileSync(P.PILOT_FILE, 'utf8'));
const TK = 'KXBTC15M-26NOV011015-15';
/** A pinned temp copy of the frozen file with some fields changed (e.g. the daily stop switched on). */
function cfgFile(patch) { const d = tmp(), f = path.join(d, 'p.json'); const c = JSON.parse(JSON.stringify(CFG)); patch(c); fs.writeFileSync(f, JSON.stringify(c)); return { file: f, pin: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') }; }

function fakeClient(over = {}) {
  const calls = []; let n = 0;
  const c = { keyId: 'trade-kid', subaccount: null, lastSkewMs: 0, calls, balance: 10000, balanceArgs: [], pv: 0, aggregate: null, breakdown: undefined, deposits: [], orders: [], fills: [], fillRatio: 1,
    // shard-scoped read ({ exchangeIndex }) = 'balance' (sizing); unscoped = 'balance_all' (display only: all shards)
    async getBalance(o = {}) { calls.push(o.exchangeIndex == null ? 'balance_all' : 'balance'); c.balanceArgs.push(o);
      return o.exchangeIndex == null ? { balance: c.aggregate != null ? c.aggregate : c.balance, portfolio_value: c.pv, balance_breakdown: c.breakdown } : { balance: c.balance, portfolio_value: c.pv }; },
    async getDeposits() { calls.push('deposits'); if (c.depositsError) throw c.depositsError; return { deposits: c.deposits }; },
    async getApiKeys() { calls.push('api_keys'); return { api_keys: [{ api_key_id: 'trade-kid', scopes: ['read', 'write::trade'] }] }; },
    async createOrder(o) { R.validateOrder(o); calls.push(['create', o]); const id = 'oid-' + (++n), f = Math.floor(o.count * c.fillRatio);
      c.orders.push({ order_id: id, client_order_id: o.clientOrderId, status: 'executed', fill_count_fp: f.toFixed(2), taker_fill_cost_dollars: (f * (o.priceCents - 1) / 100).toFixed(4), taker_fees_dollars: f ? '0.0300' : '0.0000' });
      if (f) { c.fills.push({ fill_id: 'f-' + n, order_id: id, count_fp: f.toFixed(2), yes_price_dollars: (o.priceCents / 100 - 0.01).toFixed(4), fee_cost: '0.0300', is_taker: true }); c.balance -= f * (o.priceCents - 1) + 3; }
      return { order_id: id, client_order_id: o.clientOrderId, fill_count: f.toFixed(2), remaining_count: (o.count - f).toFixed(2) }; },
    async getFills({ orderId }) { calls.push('fills'); return { fills: c.fills.filter((x) => x.order_id === orderId) }; },
    async getOrders() { calls.push('orders'); return { orders: c.orders }; },
    async getOrder(id) { calls.push('order'); const o = c.orders.find((x) => x.order_id === id); if (!o) throw Object.assign(new Error('not found'), { status: 404 }); return { order: o }; },
    async cancelOrder(id) { calls.push(['cancel', id]); return { order_id: id }; },
    async getSettlements(tk) { calls.push('settlements'); return { settlements: c.settled ? [{ ticker: tk, revenue: c.settled }] : [] }; },
    ...over };
  return c;
}
function fakes({ ya = 0.95, vol = 1000, close } = {}) {
  const v1 = { rowListeners: [] }, line = { id: '7pct', orders: new Map() };
  const v3 = { rows: new Map(), lines: [{ id: '3pct', orders: new Map() }, line], volumeAt: () => ({ vol, known: true }) };
  const take = (tk = TK, at = Date.now()) => { v3.rows.set(tk, { sig: { tk, asset: 'BTC', ya, bookRx: at, close: close != null ? close : at + 480000, decision: 'take' } }); for (const f of v1.rowListeners) f({ t: 'signal', tk }); };
  return { v1, v3, line, take };
}
function pilot({ env = ENV_ON, client = fakeClient(), dir = tmp(), v = fakes(), file, pin, now, sleep = async () => {} } = {}) {
  const p = new P.KalshiPilot({ v1: v.v1, v3: v.v3, dir, killFile: path.join(dir, 'KILL'), env, client, file, pin, now, sleep });
  p.start(); p.stop(); return { p, client, dir, v };
}

test('frozen hashes: pilot config pinned; v1/v2/v3 unchanged; pilot follows v3 7pct with daily stop OFF by default', () => {
  assert.equal(sha('config/frozen/kalshi-live-pilot.json'), P.PILOT_SHA256);
  assert.equal(sha('config/frozen/kalshi-h2-v1.json'), '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c');
  assert.equal(sha('config/frozen/kalshi-h2-v2.json'), 'ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c');
  assert.equal(sha('config/frozen/kalshi-h2-v3.json'), '5498e1cbea6c45e427876dd2971f041421ef18ad06c103dc7921898f5179ce1c');
  assert.equal(CFG.perTradePct, 0.07); assert.equal(CFG.follows.line, '7pct'); assert.equal(CFG.version, 'p5'); assert.equal(CFG.bankrollCents, undefined, 'no bankroll cap'); assert.equal(CFG.balanceExchangeIndex, 2); assert.equal(P.PILOT_SHA256, 'a7d67ee97402c392d450acb9e4b7965b24b55ed88925a76caff0e6d8fc32d2a7');
  assert.equal(CFG.dailyLossStopCents, null); assert.equal(CFG.shrinkToDailyBudget, false);
  assert.equal(CFG.maxOpenRiskCents, undefined); assert.equal(CFG.totalLossStopCents, undefined); assert.equal(CFG.maxTradeCents, undefined, 'no per-trade dollar ceiling');
  assert.ok(!Object.keys(CFG).some((k) => /loss ?limit|totalLoss/i.test(k)), 'no loss-limit field'); assert.equal(CFG.armPhrase, 'ARM LIVE'); assert.equal(P.loadPilotConfig().cfg.armPhrase, 'ARM LIVE'); assert.equal(CFG.order.maxPriceCents, 98);
  const { file } = cfgFile((c) => { c.perTradePct = 0.5; }); assert.throws(() => P.loadPilotConfig(file), /edited after the freeze/);
});

test('inert when env is unset (or the flag is not exactly "true"): DISABLED, no client, no files, no orders', () => {
  for (const env of [{}, { ...ENV_ON, LIVE_PILOT_ENABLED: 'TRUE' }, { ...ENV_ON, KALSHI_TRADE_KEY_ID: '' }, { LIVE_PILOT_ENABLED: 'true', KALSHI_API_KEY_ID: 'ro', KALSHI_PRIVATE_KEY_PEM: 'SECRETRO' }, { KALSHI_API_KEY_ID: 'desk', KALSHI_PRIVATE_KEY_PEM: PEM }]) {
    const dir = tmp(); const p = new P.KalshiPilot({ dir, env, fetchImpl: () => { throw new Error('network!'); } }); p.start();
    assert.equal(p.state, 'DISABLED'); assert.equal(p.client, null); assert.ok(p.inert.length); assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(p.onTake({ tk: TK, ya: 0.95 }), null); const s = p.snapshot(); assert.equal(s.statusChip, 'DISABLED');
    assert.ok(!/"ro"|SECRETRO|"desk"|PRIVATE KEY/.test(JSON.stringify(s)));
  }
  assert.throws(() => R.makeTradeClient({ env: { KALSHI_API_KEY_ID: 'ro', KALSHI_PRIVATE_KEY_PEM: 'SECRETRO' } }), (e) => !e.message.includes('SECRETRO'));
  assert.equal(R.makeTradeClient({ env: {} }), null);
});

test('order validation: only the three series, only YES BUY, integer contracts, 1..98 cents', () => {
  const ok = { ticker: TK, side: 'yes', action: 'buy', count: 3, priceCents: 96, clientOrderId: 'hp1-abc-s1' };
  assert.ok(R.validateOrder(ok));
  for (const bad of [{ ticker: 'KXXRP15M-26NOV011015-15' }, { ticker: 'KXBTCD-26NOV01' }, { side: 'no' }, { action: 'sell' }, { priceCents: 99 }, { priceCents: 0 }, { count: 0 }, { count: 1.5 }, { clientOrderId: '' }])
    assert.throws(() => R.validateOrder({ ...ok, ...bad }), /refused/, JSON.stringify(bad));
});

test('signed client (mock fetch): V2 body is bid/IOC/dollar price; signature over ts+METHOD+/trade-api/v2 path without query', async () => {
  const ed = crypto.generateKeyPairSync('ed25519'); const pem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  const seen = []; const fetchImpl = async (url, o) => { seen.push({ url, ...o }); return { ok: true, status: 201, headers: { get: () => new Date(1793386800000).toUTCString() }, json: async () => ({ order_id: 'o1', fill_count: '1.00', remaining_count: '0.00' }) }; };
  const c = R.makeTradeClient({ env: { KALSHI_TRADE_KEY_ID: 'k1', KALSHI_TRADE_PRIVATE_KEY_PEM: pem, KALSHI_TRADE_SUBACCOUNT: '3' }, fetchImpl, now: () => 1793386800500 });
  await c.createOrder({ ticker: TK, side: 'yes', action: 'buy', count: 2, priceCents: 96, clientOrderId: 'hp1-x-s1' });
  const b = JSON.parse(seen[0].body); assert.deepEqual(b, { ticker: TK, side: 'bid', count: '2.00', price: '0.9600', time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', client_order_id: 'hp1-x-s1', subaccount: 3 });
  assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, 'https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders');
  const h = seen[0].headers; assert.ok(crypto.verify(null, Buffer.from(h['KALSHI-ACCESS-TIMESTAMP'] + 'POST/trade-api/v2/portfolio/events/orders'), ed.publicKey, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  assert.equal(c.lastSkewMs, 500);
  await c.getFills({ ticker: TK, orderId: 'o1' }); assert.match(seen[1].url, /\/portfolio\/fills\?ticker=.*&order_id=o1&subaccount=3$/);
  assert.ok(crypto.verify(null, Buffer.from(seen[1].headers['KALSHI-ACCESS-TIMESTAMP'] + 'GET/trade-api/v2/portfolio/fills'), ed.publicKey, Buffer.from(seen[1].headers['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  await assert.rejects(c.createOrder({ ticker: TK, side: 'yes', action: 'buy', count: 1, priceCents: 99, clientOrderId: 'hp1-x-s2' }), /refused/); assert.equal(seen.length, 2, 'refused orders never reach fetch');
  assert.throws(() => R.makeTradeClient({ env: { KALSHI_TRADE_KEY_ID: 'k', KALSHI_TRADE_PRIVATE_KEY_PEM: 'SECRETVALUE' } }), (e) => !e.message.includes('SECRETVALUE'));
  assert.equal(R.dollarsToMicros('0.0175'), 17500); assert.equal(R.dollarsToMicros('12.345678'), 12345678);
});

test('fee math matches Kalshi: ceil_to_cent(0.07 * C * P * (1-P)); live P&L uses the fee_cost Kalshi reports', () => {
  for (const [c, p] of [[1, 95], [7, 95], [100, 50], [3, 98], [250, 93], [1, 1]]) assert.equal(P.feeCents(c, p), Math.ceil(Math.round(0.07 * c * (p / 100) * (1 - p / 100) * 1e8) / 1e6), `${c}@${p}`);
  assert.equal(P.feeCents(7, 95), 3); assert.equal(P.feeCents(100, 50), 175); assert.equal(P.worstCents(7, 96), 7 * 96 + P.feeCents(7, 96));
});

test('sizing: 7% of the live bankroll ($10.50 at $150), price <= ask+1c and <= 98c, asset caps, 10% of volume, total open risk <= bankroll', () => {
  const base = { cfg: CFG, tk: TK, askCents: 95, limitCents: 96, bankrollCents: 15000, availCents: 15000, vol: 1000 };
  let z = P.planSlice(base); assert.equal(z.perTradeCents, 1050); assert.equal(z.contracts, 11); assert.deepEqual(z.bound, ['pct']);
  z = P.planSlice({ ...base, vol: 40 }); assert.equal(z.contracts, 4); assert.deepEqual(z.bound, ['participation']);
  z = P.planSlice({ ...base, vol: null }); assert.equal(z.contracts, 0); assert.deepEqual(z.bound, ['unknown_volume']);
  z = P.planSlice({ ...base, bankrollCents: 10000000, vol: 1e9, tk: 'KXSOL15M-X', limitCents: 96, availCents: 1e9, openRiskCents: -1e9 }); assert.equal(z.caps.asset, Math.floor(25000 / 95));
  z = P.planSlice({ ...base, openRiskCents: 14500 }); assert.equal(z.contracts, 5); assert.ok(z.worstCents <= 500); assert.deepEqual(z.bound, ['openRisk']);
  z = P.planSlice({ ...base, openRiskCents: 14950 }); assert.equal(z.contracts, 0);
  z = P.planSlice({ ...base, filled: 5 }); assert.equal(z.contracts, 6);
  z = P.planSlice({ ...base, limitCents: 99 }); assert.equal(z.contracts, 0); assert.deepEqual(z.bound, ['price']);
  z = P.planSlice({ ...base, tk: 'KXXRP15M-X' }); assert.deepEqual(z.bound, ['series']);
  const { p } = pilot({ v: fakes({ ya: 0.98 }) }); p.v3.rows.set(TK, { sig: { tk: TK, ya: 0.98, decision: 'take', close: Date.now() + 480000 } }); p.onV1Row({ t: 'signal', tk: TK });
  assert.equal(p.signals.get(TK).limit, 98, 'ask 98c -> limit stays 98c, never 99c');
  const v = fakes({ ya: 0.95 }); const q = pilot({ v }).p; v.take(); assert.equal(q.signals.get(TK).limit, 96);
});

test('DISARMED = SHADOW: each v3 take logs a would-be order (no money) and sends nothing; non-take decisions are ignored', async () => {
  const v = fakes(); const { p, client } = pilot({ v });
  assert.equal(p.state, 'DISARMED'); v.take(); await p.signals.get(TK).run; await p.infoRun;
  v.v3.rows.set('KXETH15M-B', { sig: { tk: 'KXETH15M-B', ya: 0.95, decision: 'skip' } }); for (const f of v.v1.rowListeners) f({ t: 'signal', tk: 'KXETH15M-B' });
  assert.equal(p.shadow.length, 1); assert.equal(p.shadow[0].noMoney, true); assert.equal(p.shadow[0].contracts, 7, '7% of the live $100 balance'); assert.equal(p.shadow[0].limit, 96);
  assert.deepEqual(client.calls, ['balance', 'deposits', 'balance_all'], 'shadow makes read-only GETs only: shard 2 balance (sizing), then display-only deposits and all-shard balance');
  assert.deepEqual(client.balanceArgs[0], { exchangeIndex: 2 }); assert.equal(p.snapshot().statusChip, 'DISARMED-SHADOW');
  v.line.orders.set(TK, { filled: 7, vwap: 0.955, unfilled: 0, fee: 0.03 }); const cmp = p.snapshot().compare[0]; assert.equal(cmp.paper.filled, 7); assert.equal(cmp.shadow.contracts, 7);
});

test('arm refused without the phrase, without the flag, on a failed preflight, while HALTED; armed state is never restored on restart', async () => {
  const dir = tmp(); const { p } = pilot({ dir });
  assert.equal((await p.arm('arm live $150')).ok, false); assert.equal((await p.arm('')).ok, false); assert.equal(p.state, 'DISARMED');
  const off = pilot({ env: { ...ENV_ON, LIVE_PILOT_ENABLED: 'false' } }).p; assert.equal((await off.arm('ARM LIVE')).ok, false); assert.equal(off.state, 'DISABLED');
  const bad = pilot({ client: fakeClient({ async getApiKeys() { return { api_keys: [{ api_key_id: 'trade-kid', scopes: ['read'] }] }; } }) }).p;
  const r = await bad.arm('ARM LIVE'); assert.equal(r.ok, false); assert.match(r.error, /this key can't trade, make a read\+trade key/);
  const skew = pilot({ client: fakeClient({ lastSkewMs: 9000 }) }).p; assert.equal((await skew.arm('ARM LIVE')).ok, false);
  assert.equal((await p.arm('ARM LIVE')).ok, true); assert.equal(p.state, 'ARMED');
  const again = pilot({ dir }).p; assert.equal(again.state, 'DISARMED', 'restart comes back DISARMED');
  await again.halt('test'); assert.equal((await again.arm('ARM LIVE')).ok, false);
  assert.equal(pilot({ dir }).p.state, 'HALTED', 'HALTED survives a restart');
});

test('armed: IOC slices, intent persisted before send, partial fill -> next slice, real fees from fills, balance before/after; hold to settlement', async () => {
  const v = fakes(), client = fakeClient({ fillRatio: 0.5 }); const { p, dir } = pilot({ v, client });
  assert.ok((await p.arm('ARM LIVE')).ok); v.take(); await p.signals.get(TK).run;
  const creates = client.calls.filter((c) => c[0] === 'create').map((c) => c[1]);
  assert.deepEqual(creates.map((o) => o.count), [7, 4, 2]); for (const o of creates) { assert.equal(o.priceCents, 96); assert.equal(o.side, 'yes'); assert.equal(o.action, 'buy'); }
  assert.equal(new Set(creates.map((o) => o.clientOrderId)).size, 3, 'unique client_order_id per slice');
  const rows = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const idx = (t, coid) => rows.findIndex((r) => r.t === t && r.coid === coid);
  for (const o of creates) { assert.ok(idx('order_intent', o.clientOrderId) < idx('order_sent', o.clientOrderId)); assert.ok(idx('order_sent', o.clientOrderId) < idx('ack', o.clientOrderId)); }
  const s = p.signals.get(TK); assert.equal(s.filled, 3 + 2 + 1); assert.equal(s.feeMicros, 3 * 30000, 'fees are the fee_cost Kalshi reported');
  assert.ok(rows.some((r) => r.t === 'cancel' && /IOC remainder/.test(r.reason)));
  assert.ok(!rows.some((r) => r.t === 'stop'), 'no false halt: balance matched');
  client.settled = 600; for (const f of v.v1.rowListeners) f({ t: 'settle', tk: TK, win: true, result: 'yes' }); await new Promise((r) => setImmediate(r));
  const st = p.signals.get(TK).settle; assert.equal(st.pnlMicros, 6e6 - s.costMicros - s.feeMicros); assert.equal(st.source, 'kalshi settlement');
  const t = p.snapshot().trades[0]; assert.equal(t.contracts, 6); assert.equal(t.balanceBeforeCents, 10000); assert.ok(t.balanceAfterCents > 10000);
  assert.ok(!client.calls.some((c) => c[0] === 'create' && c[1].action !== 'buy'));
});

test('outside the frozen v3 entry window, or with the ask above the limit: no order', async () => {
  const v = fakes({ close: Date.now() + 120000 }), client = fakeClient(); const { p } = pilot({ v, client }); await p.arm('ARM LIVE'); v.take(); await p.signals.get(TK).run;
  assert.equal(client.calls.filter((c) => c[0] === 'create').length, 0);
});

test('HALT cancels the pilot\'s own resting orders (never others) and blocks; kill file halts', async () => {
  const v = fakes(), client = fakeClient(); const { p, dir } = pilot({ v, client }); await p.arm('ARM LIVE'); v.take(); await p.signals.get(TK).run;
  client.orders.push({ order_id: 'rest-1', client_order_id: 'hp1-' + TK + '-s9', status: 'resting' }, { order_id: 'mine-manual', client_order_id: 'bryan-1', status: 'resting' });
  await p.halt('HALT button'); assert.equal(p.state, 'HALTED');
  const cancels = client.calls.filter((c) => c[0] === 'cancel').map((c) => c[1]); assert.deepEqual(cancels, ['rest-1']);
  v.take('KXETH15M-C'); assert.equal(client.calls.filter((c) => c[0] === 'create').length, 1, 'nothing new after HALT');
  const k = pilot({ client: fakeClient() }); await k.p.arm('ARM LIVE'); fs.writeFileSync(path.join(k.dir, 'KILL'), ''); k.p.tick(); assert.equal(k.p.state, 'HALTED'); assert.match(k.p.haltReason, /kill file/);
  void dir;
});

test('auto-HALT: auth failure, repeated API errors, unreconciled fills, balance mismatch, exception in the order path', async () => {
  const err = (s) => Object.assign(new Error('x'), { status: s });
  let v = fakes(), c = fakeClient({ async createOrder() { throw err(401); } }), x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; assert.equal(x.state, 'HALTED');
  v = fakes(); c = fakeClient({ async createOrder() { throw err(503); } }); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /without a clear answer/);
  v = fakes(); c = fakeClient(); c.getFills = async () => ({ fills: [] }); c.getOrder = async (id) => ({ order: { order_id: id, status: 'canceled', fill_count_fp: '0.00' } }); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /unreconciled/);
  v = fakes(); c = fakeClient({ subaccount: 3 }); const cg = c.getBalance; let k = 0; c.getBalance = async () => (k++ ? { balance: 5000 } : cg()); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /balance mismatch/);
  v = fakes(); c = fakeClient({ async createOrder() { return null; } }); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; assert.equal(x.state, 'HALTED');
  x = pilot({ client: fakeClient() }).p; for (let i = 0; i < 3; i++) x.apiError(err(500)); assert.match(x.haltReason, /3 Kalshi API errors/);
});

test('idempotent restart: an intent sent before a crash is reconciled by client_order_id and never re-sent', async () => {
  const dir = tmp(), v = fakes(), c1 = fakeClient(); c1.getFills = () => new Promise(() => {}); // crash after the order went out
  const a = pilot({ dir, v, client: c1 }).p; await a.arm('ARM LIVE'); v.take(); await new Promise((r) => setImmediate(r));
  assert.equal(c1.calls.filter((c) => c[0] === 'create').length, 1);
  const rows = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); fs.writeFileSync(path.join(dir, 'ledger.jsonl'), rows.filter((r) => r.t !== 'ack' && r.t !== 'cancel').map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c2 = fakeClient(); c2.orders = c1.orders; c2.fills = c1.fills; const v2 = fakes(); const b = pilot({ dir, v: v2, client: c2 }).p; await b.startupReconcile;
  assert.equal(b.state, 'DISARMED'); assert.equal(c2.calls.filter((c) => c[0] === 'create').length, 0); assert.equal(b.signals.get(TK).filled, 7);
  assert.ok(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').includes('"t":"reconciled"'));
  await b.arm('ARM LIVE'); v2.take(); await new Promise((r) => setImmediate(r)); assert.equal(c2.calls.filter((c) => c[0] === 'create').length, 0, 'the same market is never traded twice');
  const d2 = tmp(); fs.writeFileSync(path.join(d2, 'ledger.jsonl'), rows.filter((r) => r.t === 'order_intent').map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c3 = new P.KalshiPilot({ dir: d2, env: {} }); c3.start(); await c3.startupReconcile; assert.equal(c3.state, 'DISABLED');
});

test('no loss limit: realized P&L deeply negative never halts (info only); reset after any HALT still needs the phrase on localhost', async () => {
  const { p } = pilot(); for (let i = 0; i < 40; i++) p.write({ t: 'settle', tk: 'KXBTC15M-L' + i, pnlMicros: -500e6 });
  assert.equal(p.realizedMicros, -20000e6); assert.equal(p.checkStops(), null); assert.equal(p.state, 'DISARMED', '-$20,000 realized: still no halt');
  assert.equal(p.snapshot().money.realizedCents, -2000000); assert.equal(p.snapshot().loss, undefined);
  assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /info only, not a limit/);
  await p.halt('manual'); assert.equal(p.state, 'HALTED'); assert.equal(p.reset('nope').ok, false); assert.equal(p.reset('RESET PILOT').ok, true); assert.equal(p.state, 'DISARMED');
});

test('daily stop is OFF by default: a large day loss does not halt and does not shrink size', () => {
  const { p } = pilot(); p.write({ t: 'settle', tk: 'KXBTC15M-Y', pnlMicros: -50e6 }); assert.equal(p.checkStops(), null); assert.equal(p.state, 'DISARMED');
  const z = P.planSlice({ cfg: CFG, tk: TK, askCents: 95, limitCents: 96, bankrollCents: 10000, availCents: 10000, vol: 1000, dayLossCents: 990 }); assert.equal(z.contracts, 7); assert.equal(z.caps.daily, undefined);
});

test('daily stop explicitly ON ($10): halts and blocks; shrink-to-budget sizes down to the remaining daily budget or skips under 1 contract', async () => {
  const on = cfgFile((c) => { c.dailyLossStopCents = 1000; c.shrinkToDailyBudget = true; }); const cfg = JSON.parse(fs.readFileSync(on.file, 'utf8'));
  const base = { cfg, tk: TK, askCents: 95, limitCents: 96, bankrollCents: 10000, availCents: 10000, vol: 1000 };
  assert.equal(P.planSlice(base).contracts, 7);
  let z = P.planSlice({ ...base, dayLossCents: 700 }); assert.equal(z.contracts, 3); assert.ok(700 + z.worstCents <= 1000); assert.deepEqual(z.bound, ['daily']);
  z = P.planSlice({ ...base, dayLossCents: 500, dayOpenRiskCents: 300 }); assert.equal(z.contracts, 2);
  z = P.planSlice({ ...base, dayLossCents: 920 }); assert.equal(z.contracts, 0, 'under 1 contract -> skip');
  const { p } = pilot({ file: on.file, pin: on.pin }); await p.arm('ARM LIVE'); p.write({ t: 'settle', tk: 'KXBTC15M-W', pnlMicros: -10e6 }); p.checkStops();
  assert.equal(p.state, 'HALTED'); assert.match(p.haltReason, /daily loss stop/); assert.equal((await p.arm('ARM LIVE')).ok, false);
});

test('desk: arm/reset are loopback-only and refuse any forwarded request; halt is open; proxy hard-blocks arm and forwards pilot-halt', async () => {
  const req = (remote, headers) => ({ socket: { remoteAddress: remote }, headers: { host: '127.0.0.1:8788', 'content-type': 'application/json', ...headers } });
  assert.equal(pilotLocal(req('127.0.0.1', {})).ok, true);
  assert.equal(pilotLocal(req('100.64.1.2', {})).ok, false);
  assert.equal(pilotLocal(req('127.0.0.1', { 'x-forwarded-for': '100.64.1.2' })).ok, false);
  assert.equal(pilotLocal(req('127.0.0.1', { forwarded: 'for=1.2.3.4' })).ok, false);
  const { p } = pilot(); const srv = createServer({ kalshiPilot: p, routes: [] }, {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const post = (pth, body, headers = {}) => new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: pth, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (r) => { let d = ''; r.on('data', (x) => { d += x; }); r.on('end', () => res([r.statusCode, JSON.parse(d)])); }); q.end(JSON.stringify(body)); });
  try {
    assert.equal((await post('/api/live/kalshi-pilot/arm', { phrase: 'ARM LIVE' }, { 'x-forwarded-for': '100.64.1.2' }))[0], 403);
    assert.equal((await post('/api/live/kalshi-pilot/arm', { phrase: 'wrong' }))[0], 403);
    assert.equal(p.state, 'DISARMED');
    assert.equal((await post('/api/live/kalshi-pilot/test-key', {}, { 'x-forwarded-for': '100.64.1.2' }))[0], 403, 'Test key is this-machine only');
    const [tc, tr] = await post('/api/live/kalshi-pilot/test-key', {}); assert.equal(tc, 200); assert.equal(tr.keyTest.ok, true); assert.ok(!p.client.calls.some((c) => Array.isArray(c)), 'no order or cancel');
    const [code, r] = await post('/api/live/kalshi-pilot/halt', {}, { 'x-forwarded-for': '100.64.1.2' }); assert.equal(code, 200); assert.equal(r.state, 'HALTED');
  } finally { srv.close(); }
  const all = Object.keys(proxy.POST_ROUTES);
  assert.ok(all.includes('pilot-halt'));
  for (const pth of ['/api/live/kalshi-pilot/arm', '/api/live/kalshi-pilot/test-key', '/api/live/kalshi-pilot/reset', '/api/live/kalshi-pilot/disarm', '/api/live/anything']) assert.equal(proxy.policy('POST', pth, all)[0], 403, pth);
  assert.equal(proxy.policy('POST', '/api/live/kalshi-pilot/halt', ['pilot-halt']), null);
  assert.equal(proxy.policy('POST', '/api/live/kalshi-pilot/halt', ['halt'])[0], 403, 'the desk halt name does not cover the pilot halt');
  assert.equal(proxy.config({ HAWSE_ACCESS_TOKEN: 'x'.repeat(40), HAWSE_PROXY_ALLOW_POST: 'arm,halt,resume,pilot-halt' }).allowPost.includes('pilot-halt'), true);
});

test('repo-wide: only the pilot client names order endpoints / builds orders; every other live order path is still a stub', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const files = ['server', 'scripts', 'public', 'cloudflare'].filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => walk(path.join(ROOT, d)));
  const rel = (f) => path.relative(ROOT, f);
  const ep = files.filter((f) => /['"`]\/portfolio\/(events\/)?orders/.test(fs.readFileSync(f, 'utf8'))).map(rel); assert.deepEqual(ep, [path.join('server', 'live', 'kalshi-rest.js')]);
  const co = files.filter((f) => /\.createOrder\s*\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort(); assert.deepEqual(co, [path.join('server', 'live', 'kalshi-pilot.js')]);
  // signing keys: the trade override is read only by the pilot client; the desk key only by ws-sign.js (WS auth) and the pilot client
  const tradeEnv = files.filter((f) => /KALSHI_TRADE_PRIVATE_KEY_PEM/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(tradeEnv, [path.join('server', 'live', 'kalshi-rest.js')]);
  const signers = files.filter((f) => /crypto\.sign\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.ok(!signers.includes(path.join('server', 'live', 'kalshi-pilot.js')) && signers.includes(path.join('server', 'live', 'kalshi-rest.js')), 'only the pilot client signs Kalshi REST');
  assert.ok(!/KALSHI_\w*(PEM|KEY_ID|KEY_PATH)/.test(fs.readFileSync(path.join(ROOT, 'server', 'live', 'kalshi-pilot.js'), 'utf8')), 'the pilot module never reads key values itself');
  // makeTradeClient is required by exactly one module: the pilot
  const users = files.filter((f) => /makeTradeClient|kalshi-rest['"]/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(users, [path.join('server', 'live', 'kalshi-pilot.js'), path.join('server', 'live', 'kalshi-rest.js')]);
  for (const f of files.filter((x) => x.includes(path.sep + 'public' + path.sep))) assert.ok(!/KALSHI_TRADE|portfolio/.test(fs.readFileSync(f, 'utf8')), rel(f));
  const { LiveBroker } = require('../server/lib/broker'); assert.throws(() => new LiveBroker().placeOrder({}), /disabled/);
  const v3src = fs.readFileSync(path.join(ROOT, 'server', 'kalshi-h2', 'v3.js'), 'utf8'); assert.ok(!/kalshi-pilot|live\//.test(v3src), 'v3 does not know the pilot exists');
});

test('card: HALT always visible, ARM only on this machine, "Daily stop: OFF", SHADOW rows say NO MONEY; Scoreboard LIVE chip is separate from paper', async () => {
  const UI = require('../public/pilot.js'), SB = require('../public/scoreboard.js');
  const v = fakes(); const { p } = pilot({ v }); v.take(); await p.signals.get(TK).run; await p.infoRun; const snap = p.snapshot();
  assert.equal(snap.title, 'LIVE · REAL MONEY · Kalshi pilot (v3 7% of shard 2 cash)');
  const hc = UI.render(snap, {}); assert.match(hc, /No loss limit: the pilot trades until you press HALT or a safety stop trips; the balance can go to zero\./);
  assert.match(hc, /shard 2 available cash \(the shard the 15-minute crypto markets trade on\), read at /); assert.match(hc, /open positions<\/span> (\$0\.00|<span class="dim">not read yet<\/span>) <span class="dim">\(not used for sizing\)/); assert.match(hc, /pending deposits/); assert.match(hc, /info only, not a limit/);
  assert.doesNotMatch(hc + UI.render(snap, { local: true }), /Loss limit|LOSS LIMIT|realized-loss|headroom|overshoot/); assert.equal((hc.match(/loss limit/gi) || []).length, 1, 'only the No loss limit statement');
  assert.match(UI.render(snap, { local: true }), /ARM LIVE/);
  const h = UI.render(snap, { local: false }); assert.match(h, /data-pilot="halt"/); assert.doesNotMatch(h, /data-pilot="arm"/); assert.match(h, /Daily stop: OFF \(paper arms have none\)/); assert.match(h, /SHADOW · NO MONEY/); assert.match(h, /DISARMED-SHADOW/);
  assert.match(UI.render(snap, { local: true }), /data-pilot="arm"/);
  const off = new P.KalshiPilot({ dir: tmp(), env: {} }); off.start(); const ho = UI.render(off.snapshot(), { local: true }); assert.match(ho, /data-pilot="halt"/); assert.doesNotMatch(ho, /data-pilot="arm"/); assert.match(ho, />DISABLED</);
  assert.ok(!JSON.stringify(snap).match(/BEGIN|PRIVATE KEY-----/));
  const m = SB.summarize({ feeds: { kalshiPilot: { statusChip: 'ARMED', money: { settled: 2, wins: 1, losses: 1, realizedCents: -150 } } }, strategies: [] });
  assert.equal(m.live.realizedCents, -150); assert.equal(m.real.net, 0, 'live money never added to the real-data/paper totals');
  assert.match(SB.render(m), /LIVE · REAL MONEY/);
});

test('engine wiring: kalshiPilot mounts last (after v3), DISABLED with no env, and its feed snapshot carries no env values', () => {
  const { Engine } = require('../server/engine'), config = require('../server/config');
  const d = tmp(); const cfg = config.build({ KALSHI_H2_DIR: path.join(d, 'h2'), RECORDER_DIR: path.join(d, 'rec'), LIVE_PILOT_DIR: path.join(d, 'pilot'), LIVE_PILOT_KILL_FILE: path.join(d, 'KILL') });
  assert.equal(JSON.stringify(cfg.livePilot).includes('env'), false);
  const e = new Engine(cfg, { modules: require('../server/modules') }); const names = Object.keys(e.feeds);
  assert.ok(names.includes('kalshiPilot')); assert.ok(names.indexOf('kalshiH2v3') < names.indexOf('kalshiPilot'));
  if (!process.env.LIVE_PILOT_ENABLED) assert.equal(e.kalshiPilot.state, 'DISABLED');
  assert.equal(e.kalshiPilot.dir, path.join(d, 'pilot'));
});

test('a settlement credit from an earlier market landing between slices is not a false balance-mismatch halt', async () => {
  const v = fakes(), c = fakeClient({ fillRatio: 0.5 }); const orig = c.createOrder; let k = 0;
  c.createOrder = async (o) => { const r = await orig(o); if (++k === 1) { await new Promise((x) => setImmediate(x)); } return r; };
  const sleepCredit = async () => { c.balance += 700; }; // the earlier market paid out while we waited 10 s
  const dir = tmp(); const p = new P.KalshiPilot({ v1: v.v1, v3: v.v3, dir, killFile: path.join(dir, 'KILL'), env: ENV_ON, client: c, sleep: sleepCredit }); p.start(); p.stop();
  await p.arm('ARM LIVE'); v.take(); await p.signals.get(TK).run;
  assert.equal(p.state, 'ARMED', p.haltReason); assert.equal(c.calls.filter((x) => x[0] === 'create').length, 3);
});

test('layout: the live pilot card (HALT) is pinned first and never hidden, even by a saved/imported layout', () => {
  const L = require('../public/layout.js'); const D = ['kalshi-live-pilot', 'scoreboard', 'tape'];
  const s = L.normalize({ order: ['tape', 'kalshi-live-pilot', 'scoreboard'], hidden: ['kalshi-live-pilot', 'tape'] }, D);
  assert.deepEqual(s.hidden, ['tape']); assert.equal(s.order.indexOf('kalshi-live-pilot'), 0, 'an old saved layout cannot push it down');
  assert.equal(L.move(s, 'kalshi-live-pilot', 1), s, 'cannot be moved down'); assert.equal(L.move(s, 'tape', -1), s, 'nothing moves above it');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'); assert.match(html, /data-card-id="kalshi-live-pilot"/); assert.match(html, /<script src="pilot.js"><\/script>/);
});

test('full-balance bankroll: a $400 balance -> $400 bankroll and 7% = $28 (asset caps still apply); a $90 account counts $90', () => {
  const big = pilot({ client: fakeClient({ balance: 40000 }) }).p; big.balanceCents = 40000; assert.equal(big.bankrollCents(), 40000, '$400 in the account -> $400 bankroll');
  let z = big.plan({ tk: TK, decisionAsk: 95, limit: 96 }, 0, 1000); assert.equal(z.perTradeCents, 2800, '7% of $400 = $28'); assert.equal(z.contracts, 29); assert.equal(z.sizing.bankrollCents, 40000);
  const small = pilot().p; small.balanceCents = 9000; assert.equal(small.bankrollCents(), 9000, '$90 in the account -> $90 bankroll');
  assert.equal(small.plan({ tk: TK, decisionAsk: 95, limit: 96 }, 0, 1000).perTradeCents, 630);
  // asset caps still bind on a big balance: SOL $250, ETH $400
  const huge = pilot().p; huge.balanceCents = 1e7; z = huge.plan({ tk: 'KXSOL15M-26NOV011015-15', decisionAsk: 95, limit: 96 }, 0, 1e9); assert.equal(z.perTradeCents, 700000); assert.equal(z.contracts, Math.floor(25000 / 95)); assert.deepEqual(z.bound, ['asset']);
  z = huge.plan({ tk: 'KXETH15M-26NOV011015-15', decisionAsk: 95, limit: 96 }, 0, 1e9); assert.equal(z.contracts, Math.floor(40000 / 95)); assert.equal(z.sizing.capBound, 'asset cap');
  // no balance read at all: no bankroll (shadow skips, armed halts; tested below)
  assert.equal(pilot().p.bankrollCents(), null);
});

test('total open risk <= the live bankroll (not $150)', () => {
  const base = { cfg: CFG, tk: TK, askCents: 95, limitCents: 96, availCents: 1e9, vol: 1e6 };
  let z = P.planSlice({ ...base, bankrollCents: 40000, openRiskCents: 39500 }); assert.equal(z.contracts, 5); assert.ok(z.worstCents <= 500); assert.deepEqual(z.bound, ['openRisk']);
  z = P.planSlice({ ...base, bankrollCents: 40000, openRiskCents: 39950 }); assert.equal(z.contracts, 0);
  z = P.planSlice({ ...base, bankrollCents: 40000, openRiskCents: 15000 }); assert.equal(z.contracts, 29, '$150 already open is fine on a $400 bankroll');
  assert.equal(P.planSlice({ ...base, bankrollCents: 1000, openRiskCents: 1000 }).contracts, 0, 'open risk at the bankroll: nothing more');
});

test('bankroll follows deposits and wins (compounds) with no restart; armed halts if the balance cannot be read', async () => {
  let t = Date.parse('2026-11-01T18:00:00Z'); const now = () => t;
  const v = fakes(), c = fakeClient({ balance: 8000 }), { p } = pilot({ v, client: c, now });
  await p.refreshBalance(); assert.equal(p.bankrollCents(), 8000);
  c.balance = 15000; t += 21000; await p.refreshBalance(); assert.equal(p.bankrollCents(), 15000, 'deposit to $150 counts');
  c.balance = 40000; t += 21000; await p.refreshBalance(); assert.equal(p.bankrollCents(), 40000, 'deposit to $400 counts');
  assert.ok((await p.arm('ARM LIVE')).ok); v.take(TK, t); await p.signals.get(TK).run;
  const s = p.signals.get(TK); assert.equal(s.filled, 29); assert.equal(p.bankrollCents(), 40000, 'own open cost is still counted while the position is open');
  // win: Kalshi pays $1 per contract; the next decision sizes from the bigger balance
  c.settled = 2900; c.balance += 2900; await p.onV1Row({ t: 'settle', tk: TK, win: true, result: 'yes' }); assert.ok(p.signals.get(TK).settle); assert.ok(p.realizedMicros > 0);
  t += 21000; p.disarm(); await p.refreshBalance(); const after = p.bankrollCents(); assert.ok(after > 40000, 'the win compounds: ' + after); assert.equal(after, c.balance);
  const tk2 = 'KXBTC15M-26NOV011030-B'; v.take(tk2, t); await p.signals.get(tk2).run; assert.equal(p.shadow[p.shadow.length - 1].sizing.targetCents, Math.floor(after * 0.07));
  // armed and the balance can't be read: halt (never size blind)
  const v2 = fakes(), c2 = fakeClient(); const x = pilot({ v: v2, client: c2 }).p; assert.ok((await x.arm('ARM LIVE')).ok);
  c2.getBalance = async () => { throw new Error('HTTP 503'); }; v2.take(); await x.signals.get(TK).run;
  assert.equal(x.state, 'HALTED'); assert.match(x.haltReason, /balance unreadable/); assert.equal(c2.calls.filter((q) => q[0] === 'create').length, 0);
});

test('arm phrase: exactly "ARM LIVE" (from the frozen config)', async () => {
  for (const bad of ['ARM LIVE $150 LOSS LIMIT', 'ARM LIVE $150', 'arm live', 'ARM LIVE ', ' ARM LIVE', 'ARM  LIVE', 'ARMLIVE', '']) {
    const { p } = pilot(); assert.equal((await p.arm(bad)).ok, false, JSON.stringify(bad)); assert.equal(p.state, 'DISARMED');
  }
  const { p } = pilot(); assert.equal(p.snapshot().config.armPhrase, 'ARM LIVE'); assert.ok((await p.arm('ARM LIVE')).ok); assert.equal(p.state, 'ARMED');
  const { file: f2, pin: p2 } = cfgFile((c) => { delete c.armPhrase; }); assert.throws(() => P.loadPilotConfig(f2, p2), /armPhrase/);
  const { file: f3, pin: p3 } = cfgFile((c) => { delete c.balanceExchangeIndex; }); assert.throws(() => P.loadPilotConfig(f3, p3), /balanceExchangeIndex/);
});

const BD = [{ exchange_index: 0, balance: '72.5100' }, { exchange_index: 1, balance: '7.0300' }, { exchange_index: 2, balance: '0.0000' }, { exchange_index: 3, balance: '0.0000' }];
const POOLROW = (name, i, d) => new RegExp(`${name.replace(/&/g, '&amp;')} <span class="dim">\\(shard ${i}\\)</span></td><td class="r"><b>\\$${d.replace('.', '\\.')}</b>`);
test('p5 sizing uses shard 2 available cash only: shard 2 $50 with $72.51 on shard 0 and $7.03 on shard 1 -> bankroll $50; portfolio_value, other shards and pending deposits never size', async () => {
  let t = Date.parse('2026-11-01T18:00:00Z'); const now = () => t;
  const bd = BD.map((x) => (x.exchange_index === 2 ? { ...x, balance: '50.0000' } : x));
  const v = fakes(), c = fakeClient({ balance: 5000, aggregate: 12954, pv: 5650, breakdown: bd,
    deposits: [{ id: 'd1', status: 'pending', amount_cents: 5000 }, { id: 'd2', status: 'applied', amount_cents: 10000 }, { id: 'd3', status: 'failed', amount_cents: 700 }] });
  const { p } = pilot({ v, client: c, now }); v.take(TK, t); await p.signals.get(TK).run; await p.infoRun; const r = p.shadow[p.shadow.length - 1];
  assert.equal(p.bankrollCents(), 5000); assert.equal(r.sizing.bankrollCents, 5000); assert.equal(r.sizing.targetCents, 350, '7% of shard 2 $50 (not the $129.54 total, not shard 0, not + positions or pending)');
  assert.deepEqual(c.balanceArgs[0], { exchangeIndex: 2 }, 'sizing read is GET /portfolio/balance?exchange_index=2');
  assert.ok(c.balanceArgs.filter((a) => a.exchangeIndex != null).every((a) => a.exchangeIndex === 2), 'no sizing read of any other shard');
  const m = p.snapshot().money; assert.equal(m.openPositionsCents, 5650, 'portfolio_value shown as open positions'); assert.equal(m.otherShardCents, 7954); assert.deepEqual(m.deposits, { pendingCents: 5000, pendingCount: 1, at: t });
  assert.deepEqual(m.otherShards, [{ exchangeIndex: 0, cents: 7251 }, { exchangeIndex: 1, cents: 703 }, { exchangeIndex: 3, cents: 0 }]);
  assert.deepEqual(m.balanceSource, { exchangeIndex: 2, field: 'balance (available cash)', at: t });
  const h = require('../public/pilot.js').render(p.snapshot(), {}); assert.match(h, /open positions<\/span> \$56\.50 <span class="dim">\(not used for sizing\)/); assert.match(h, /pending deposits<\/span> \$50\.00 <span class="dim">\(not in any pool yet, not used for sizing\)/);
  assert.match(h, POOLROW('Default', 0, '72.51')); assert.match(h, POOLROW('Combos', 1, '7.03')); assert.match(h, POOLROW('Crypto & Commodities', 2, '50.00')); assert.match(h, POOLROW('Sports', 3, '0.00'));
  assert.match(h, /Only the pilot's pool is used for sizing\. Kalshi's app\/web \(or the Move cash box on the desk PC\) move cash between pools; API orders don't/);
  // a bigger pending deposit, more open positions and cash on another shard change nothing about the next size
  c.deposits = [{ id: 'd4', status: 'pending', amount_cents: 100000 }]; c.pv = 900000; c.aggregate = 500000; t += 61000; v.take('KXBTC15M-26NOV011030-B', t); await p.signals.get('KXBTC15M-26NOV011030-B').run; await p.infoRun;
  assert.equal(p.shadow[p.shadow.length - 1].sizing.bankrollCents, 5000); assert.equal(p.snapshot().money.deposits.pendingCents, 100000);
  // deposits read failing = "unknown", never a halt, never sizing
  c.depositsError = new Error('HTTP 500'); t += 61000; await p.refreshInfo(); assert.equal(p.snapshot().money.deposits.unknown, true); assert.equal(p.state, 'DISARMED');
  assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /pending deposits<\/span> unknown \(read failed\)/);
  // the REAL client sends exchange_index=2 on the sizing read and nothing on the aggregate read; deposits is a GET
  const f = mockFetch(); const rc = R.makeTradeClient({ env: ENV_ON, fetchImpl: f }); await rc.getBalance({ exchangeIndex: 2 }); await rc.getBalance(); await rc.getDeposits({ limit: 20 });
  assert.deepEqual(f.reqs.map((q) => q.method + ' ' + q.path), ['GET /trade-api/v2/portfolio/balance', 'GET /trade-api/v2/portfolio/balance', 'GET /trade-api/v2/portfolio/deposits']);
  assert.deepEqual(P.parseBalance({ balance: 0, portfolio_value: 5650, balance_breakdown: BD }, 2), { cents: 0, portfolioValueCents: 5650, otherShardCents: 7954,
    shards: [{ exchangeIndex: 0, cents: 7251 }, { exchangeIndex: 1, cents: 703 }, { exchangeIndex: 2, cents: 0 }, { exchangeIndex: 3, cents: 0 }] });
});

test('p5: shard 2 at $0 -> stopped trading, no order attempt even when ARMED; shards 0/1 cash shown but never used; resumes when shard 2 is funded', async () => {
  let t = Date.parse('2026-11-01T19:00:00Z'); const now = () => t;
  const v = fakes(), c = fakeClient({ balance: 20000, aggregate: 27954, breakdown: BD.map((x) => (x.exchange_index === 2 ? { ...x, balance: '200.0000' } : x)) });
  const { p, dir } = pilot({ v, client: c, now }); assert.ok((await p.arm('ARM LIVE')).ok, 'arm while shard 2 is funded');
  c.balance = 0; c.aggregate = 7954; c.breakdown = BD; const before = c.calls.length; t += 1000; v.take(TK, t); await p.signals.get(TK).run;
  assert.equal(p.state, 'ARMED', 'not a halt'); assert.equal(p.haltReason, null);
  assert.equal(c.calls.slice(before).filter((q) => Array.isArray(q)).length, 0, 'no order, no cancel'); assert.equal(p.signals.get(TK).slices.length, 0, 'no order intent');
  const led = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'); assert.ok(!/order_intent|order_sent/.test(led));
  assert.match(p.snapshot().money.outOfMoney, /stopped trading: shard 2 cash \$0\.00 can't buy one contract/);
  t += 61000; await p.refreshInfo(); const h = require('../public/pilot.js').render(p.snapshot(), {});
  assert.match(h, /stopped trading: shard 2 cash \$0\.00/); assert.match(h, POOLROW('Default', 0, '72.51')); assert.match(h, POOLROW('Combos', 1, '7.03')); assert.match(h, POOLROW('Sports', 3, '0.00')); assert.match(h, /not used by the pilot/);
  assert.equal(p.bankrollCents(), 0, 'shard 0/1 cash is not the bankroll');
  // cash lands on shard 2 (e.g. moved in Kalshi's app): the next take trades without a restart
  c.balance = 10000; const tk2 = 'KXBTC15M-26NOV011100-B'; t += 1000; v.take(tk2, t); await p.signals.get(tk2).run;
  assert.equal(p.signals.get(tk2).filled, 7); assert.equal(p.snapshot().money.outOfMoney, null);
  // arming with $0 on shard 2 is refused by the preflight even if other shards hold cash
  const x = pilot({ client: fakeClient({ balance: 0, aggregate: 7954, breakdown: BD }) }).p; const r = await x.arm('ARM LIVE'); assert.equal(r.ok, false); assert.match(r.error, /shard 2 available cash is \$0\.00/); assert.equal(x.state, 'DISARMED');
});

test('p5: a market whose exchange_index differs from the sizing shard is never traded (shadow or armed); plain status, not a halt; the recorder keeps exchange_index from discovery', async () => {
  const markets = new Map([[TK, { tk: TK, exchangeIndex: 0 }], ['KXETH15M-26NOV011015-15', { tk: 'KXETH15M-26NOV011015-15', exchangeIndex: 2 }]]);
  const kalshi = { markets, on() {} };
  const mk = (over = {}) => { const v = fakes(), c = fakeClient({ balance: 20000 }), dir = tmp(); const p = new P.KalshiPilot({ v1: v.v1, v3: v.v3, kalshi, dir, killFile: path.join(dir, 'KILL'), env: ENV_ON, client: c, sleep: async () => {}, ...over }); p.start(); p.stop(); return { p, v, c, dir }; };
  // armed: mismatch -> no intent, no order, not halted
  let { p, v, c, dir } = mk(); assert.ok((await p.arm('ARM LIVE')).ok); const before = c.calls.length; v.take(TK); await new Promise((r) => setImmediate(r));
  assert.equal(p.state, 'ARMED'); assert.equal(p.haltReason, null); assert.equal(c.calls.slice(before).filter((q) => Array.isArray(q)).length, 0, 'no order attempt');
  assert.equal(p.signals.get(TK).slices.length, 0); const led = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(led.find((r) => r.t === 'signal' && r.tk === TK).marketShard, 0); assert.match(led.find((r) => r.t === 'slice_skip').reason, /exchange shard 0 but the pilot sizes from shard 2 cash/);
  assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /not trading KXBTC15M-26NOV011015-15: that market is on exchange shard 0/);
  // a matching market (shard 2) trades normally and clears the notice
  const eth = 'KXETH15M-26NOV011015-15'; v.take(eth); await p.signals.get(eth).run; assert.ok(p.signals.get(eth).filled > 0); assert.equal(p.snapshot().money.shardMismatch, null);
  // shadow: mismatch -> skipped row, no sizing
  ({ p, v, c } = mk()); v.take(TK); const sh = p.shadow[p.shadow.length - 1]; assert.equal(sh.contracts, 0); assert.deepEqual(sh.bound, ['shard']); assert.match(sh.skipped, /shard 0/); assert.equal(p.state, 'DISARMED');
  // the last guard in sendSlice: market moved shard between the signal and the slice
  ({ p, v, c } = mk()); markets.set(TK, { tk: TK, exchangeIndex: 2 }); await p.arm('ARM LIVE'); const s = p.sig(TK); Object.assign(s, { limit: 96, decisionAsk: 95 }); markets.set(TK, { tk: TK, exchangeIndex: 1 });
  assert.equal(await p.sendSlice(s, 1, { contracts: 1, bound: [], caps: {}, sizing: null }), null); assert.ok(!c.calls.some((q) => Array.isArray(q) && q[0] === 'create'));
  // unknown exchange_index: the configured shard is used (an insufficient_balance reject would still halt after one attempt)
  ({ p, v, c } = mk({ kalshi: { markets: new Map(), on() {} } })); await p.arm('ARM LIVE'); v.take(TK); await p.signals.get(TK).run; assert.ok(p.signals.get(TK).filled > 0);
  // the recorder keeps exchange_index from the public /markets discovery row (no extra request)
  const { KalshiRecorder } = require('../server/recorder/kalshi'); const rec = new KalshiRecorder({ store: { write() {} }, health: { register() {} }, get: async () => ({}) });
  assert.equal(rec.track({ ticker: 'KXBTC15M-X', series_ticker: 'KXBTC15M', exchange_index: 2, open_time: '2026-11-01T18:00:00Z', close_time: '2026-11-01T18:15:00Z' }).exchangeIndex, 2);
  assert.equal(rec.track({ ticker: 'KXSOL15M-Y', close_time: '2026-11-01T18:15:00Z' }).exchangeIndex, null); assert.equal(rec.track({ ticker: 'KXSOL15M-Y', exchange_index: 2 }).exchangeIndex, 2, 'later discovery fills it in');
});

test('test key (read-only) reports the shard 2 balance, the all-shard aggregate and the per-shard breakdown', async () => {
  const c = fakeClient({ balance: 0, aggregate: 7954, pv: 5650, breakdown: BD }); const { p } = pilot({ client: c });
  const r = await p.testKey(); assert.equal(r.ok, true); assert.equal(r.exchangeIndex, 2); assert.equal(r.balanceCents, 0); assert.equal(r.aggregateCents, 7954); assert.equal(r.otherShardCents, 7954);
  assert.deepEqual(r.shards.map((x) => x.cents), [7251, 703, 0, 0]); assert.deepEqual(c.balanceArgs[0], { exchangeIndex: 2 });
  assert.ok(c.calls.every((q) => typeof q === 'string'), 'GETs only'); const k = p.snapshot().keyTest; assert.equal(k.aggregateCents, 7954); assert.equal(k.shards.length, 4);
  assert.match(require('../public/pilot.js').render(p.snapshot(), { local: true }), /shard 2 \$0\.00 \(sizing\) · all shards \$79\.54 \(shard 0 \$72\.51, shard 1 \$7\.03, shard 2 \$0\.00, shard 3 \$0\.00\)/);
});

test('insufficient balance: Kalshi rejects the first armed order -> one attempt, HALTED with a plain message, nothing else sent', async () => {
  for (const [st, code, msg] of [[400, 'insufficient_balance', 'Insufficient balance to place this order'], [422, 'insufficient_balance', 'Required: $5.00, Available: $0.00'], [400, 'bad_request', 'INSUFFICIENT_FUNDS']]) {
    const v = fakes(), c = fakeClient({ async createOrder(o) { c.calls.push(['create', o]); throw new R.KalshiHttpError(st, code, msg); } });
    const { p, dir } = pilot({ v, client: c }); await p.arm('ARM LIVE'); const before = c.calls.length; v.take(); await p.signals.get(TK).run;
    const after = c.calls.slice(before); assert.deepEqual(after.filter((q) => Array.isArray(q)).map((q) => q[0]), ['create'], code + ': exactly one order attempt, no cancels');
    assert.equal(after[after.length - 1][0], 'create', 'no request after the rejected order');
    assert.equal(p.state, 'HALTED'); assert.match(p.haltReason, /Kalshi rejected the order for insufficient balance on the trading shard/);
    assert.match(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'), /insufficient balance on the trading shard/);
    assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /Kalshi rejected the order for insufficient balance on the trading shard/);
    v.take('KXETH15M-26NOV011015-15'); await new Promise((r) => setImmediate(r)); assert.equal(c.calls.slice(before).length, after.length, 'later signals send nothing');
  }
  // any other clear reject (e.g. 400 invalid_price, 409, 429 on the order) is also one attempt then HALT
  for (const st of [400, 409, 429]) {
    const v = fakes(), c = fakeClient({ async createOrder(o) { c.calls.push(['create', o]); throw new R.KalshiHttpError(st, 'invalid_price', 'no'); } });
    const { p } = pilot({ v, client: c }); await p.arm('ARM LIVE'); const before = c.calls.length; v.take(); await p.signals.get(TK).run;
    assert.equal(p.state, 'HALTED'); assert.match(p.haltReason, new RegExp('Kalshi rejected the order \\(' + st)); assert.equal(c.calls.slice(before).filter((q) => Array.isArray(q)).length, 1);
  }
  assert.ok(P.isInsufficient({ status: 400, code: 'insufficient_balance' }) && !P.isInsufficient({ status: 400, code: 'insufficient_scope' }) && !P.isPermission({ status: 400, code: 'insufficient_balance' }));
});

test('429 too_many_requests is not a halt: reads back off and retry; 3 errors in a row is still the existing halt', async () => {
  const e429 = () => new R.KalshiHttpError(429, 'too_many_requests', 'slow down');
  // shadow: 429 -> stale + backoff (no read until it passes), never a halt
  let t = Date.parse('2026-11-01T18:00:00Z'); const now = () => t;
  let v = fakes(), c = fakeClient({ balance: 10000 }); let { p } = pilot({ v, client: c, now }); await p.refreshBalance(); assert.equal(p.balanceCents, 10000);
  const ok = c.getBalance; c.getBalance = async (o) => { c.calls.push('balance429'); throw e429(); };
  t += 21000; await p.refreshBalance(); assert.equal(p.balanceStale, true); assert.equal(p.backoffMs, 2000); assert.equal(p.state, 'DISARMED');
  t += 1000; await p.refreshBalance(); assert.equal(c.calls.filter((q) => q === 'balance429').length, 1, 'no read during the backoff');
  t += 20000; await p.refreshBalance(); assert.equal(p.backoffMs, 4000, 'doubles');
  c.getBalance = ok; c.balance = 12000; t += 25000; await p.refreshBalance(); assert.equal(p.balanceCents, 12000); assert.equal(p.backoffMs, 0); assert.equal(p.balanceStale, false);
  // armed: one 429 on the pre-slice read waits and retries the READ only, then trades normally
  v = fakes(); c = fakeClient(); ({ p } = pilot({ v, client: c })); await p.arm('ARM LIVE'); let n = 0; const g = c.getBalance; c.getBalance = async (o) => { if (n++ === 0) { c.calls.push('balance429'); throw e429(); } return g(o); };
  v.take(); await p.signals.get(TK).run; assert.equal(p.state, 'ARMED', p.haltReason); assert.equal(p.signals.get(TK).filled, 7);
  assert.equal(c.calls.filter((q) => Array.isArray(q) && q[0] === 'create').length, 1, 'the order itself is never retried');
  // armed: 429 three times in a row -> the existing consecutive-API-error halt, no order sent
  v = fakes(); c = fakeClient(); ({ p } = pilot({ v, client: c })); await p.arm('ARM LIVE'); c.getBalance = async () => { throw e429(); };
  v.take(); await p.signals.get(TK).run; assert.equal(p.state, 'HALTED'); assert.match(p.haltReason, /3 Kalshi API errors in a row/); assert.equal(c.calls.filter((q) => Array.isArray(q)).length, 0);
});

test('shard 2 cash below one contract: the pilot just stops trading with a plain status (not an error, not a halt); it resumes when cash is back', async () => {
  const v = fakes(), c = fakeClient(); const { p } = pilot({ v, client: c }); await p.arm('ARM LIVE');
  c.balance = 50; v.take(); await p.signals.get(TK).run;
  assert.equal(p.state, 'ARMED', 'not a halt'); assert.equal(p.haltReason, null); assert.equal(c.calls.filter((q) => Array.isArray(q)).length, 0, 'no order');
  const m = p.snapshot().money.outOfMoney; assert.match(m, /stopped trading: shard 2 cash \$0\.50 can't buy one contract at 96c \(not an error/);
  assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /stopped trading: shard 2 cash/);
  c.balance = 0; const tk2 = 'KXBTC15M-26NOV011030-B'; v.take(tk2); await p.signals.get(tk2).run; assert.equal(p.state, 'ARMED'); assert.match(p.snapshot().money.outOfMoney, /\$0\.00/);
  c.balance = 10000; const tk3 = 'KXBTC15M-26NOV011045-C'; v.take(tk3); await p.signals.get(tk3).run; assert.equal(p.signals.get(tk3).filled, 7); assert.equal(p.snapshot().money.outOfMoney, null, 'resumes with cash');
  // shadow too: a plain skip, not an error
  const s = pilot({ client: fakeClient({ balance: 0 }) }); s.v.take(); await s.p.signals.get(TK).run; assert.match(s.p.shadow[0].skipped, /stopped trading/); assert.equal(s.p.state, 'DISARMED');
});

test('main account (no subaccount): unrelated balance moves never halt; only the pilot\'s own fills are checked; preflight needs one trade of cash', async () => {
  // between the pre-slice balance and the after-slice balance Bryan's other trading moves the account by -$37.12: no halt
  let v = fakes(), c = fakeClient({ balance: 40000 }), cg = c.getBalance, k = 0; c.getBalance = async () => { const b = await cg(); return k++ >= 2 ? { balance: b.balance - 3712 } : b; };
  let x = pilot({ v, client: c }).p; assert.ok((await x.arm('ARM LIVE')).ok); v.take(); await x.signals.get(TK).run;
  assert.equal(x.state, 'ARMED', x.haltReason); assert.equal(x.signals.get(TK).filled, 29, '7% of the full $400'); assert.equal(x.snapshot().mainAccount, true);
  // a pilot fill above its own limit is still caught
  v = fakes(); c = fakeClient(); const co = c.createOrder; c.createOrder = async (o) => { const r = await co(o); c.fills[c.fills.length - 1].yes_price_dollars = '0.9900'; return r; };
  x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /above the 96c limit/);
  // settlement revenue that includes Bryan's own positions in the same market (more than the pilot's payout) is not a mismatch; less is
  v = fakes(); c = fakeClient(); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run;
  c.settled = 7 * 100 + 500; await x.onV1Row({ t: 'settle', tk: TK, win: true, result: 'yes' }); assert.equal(x.state, 'ARMED', x.haltReason); assert.ok(x.signals.get(TK).settle);
  // preflight: a zero balance cannot cover a trade
  x = pilot({ client: fakeClient({ balance: 0 }) }).p; const r = await x.arm('ARM LIVE'); assert.equal(r.ok, false); assert.match(r.error, /shard 2 available cash is \$0\.00: nothing to trade \(move cash to shard 2: Kalshi's app\/web move cash between shards, API orders don't\)/);
  // other orders on the account are never cancelled
  v = fakes(); c = fakeClient(); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run;
  c.orders.push({ order_id: 'bryan-1', client_order_id: 'manual-xyz', status: 'resting' }, { order_id: 'bryan-2', status: 'resting' }); await x.halt('test');
  assert.ok(!c.calls.some((q) => q[0] === 'cancel' && /bryan/.test(q[1])));
});

test('key: dedicated trade pair wins only when BOTH are set, else the desk key; card/API show source + set/not set only', () => {
  const desk = { KALSHI_API_KEY_ID: 'desk-kid', KALSHI_PRIVATE_KEY_PEM: PEM };
  assert.deepEqual(R.tradeEnvPresence(desk), { keySource: 'existing desk key', keySet: true, subaccount: false, enabledFlag: false });
  assert.equal(R.resolveTradeKey({ env: { ...desk, KALSHI_TRADE_KEY_ID: 'trade-kid' } }).source, 'existing desk key', 'half a trade pair is ignored');
  assert.equal(R.resolveTradeKey({ env: { ...desk, KALSHI_TRADE_KEY_ID: 'trade-kid', KALSHI_TRADE_PRIVATE_KEY_PEM: PEM } }).source, 'dedicated trade key');
  const d = tmp(), f = path.join(d, 'k.pem'); fs.writeFileSync(f, PEM);
  assert.equal(R.tradeEnvPresence({ KALSHI_API_KEY_ID: 'desk-kid', KALSHI_PRIVATE_KEY_PATH: f }).keySet, true, "the desk's key file (KALSHI_PRIVATE_KEY_PATH) works too");
  assert.deepEqual(R.tradeEnvPresence({}), { keySource: null, keySet: false, subaccount: false, enabledFlag: false });
  const c = R.makeTradeClient({ env: desk, fetchImpl: mockFetch() }); assert.equal(c.keyId, 'desk-kid'); assert.equal(c.keySource, 'existing desk key');
  const p = new P.KalshiPilot({ dir: tmp(), env: { ...desk, LIVE_PILOT_ENABLED: 'true' }, client: fakeClient() }); p.start(); p.stop();
  const snap = JSON.stringify(p.snapshot()); assert.ok(!/desk-kid|PRIVATE KEY|KALSHI_/.test(snap)); assert.equal(p.snapshot().env.keySource, 'existing desk key');
  const html = require('../public/pilot.js').render(p.snapshot(), { local: true }); assert.match(html, /Kalshi key: <b>set<\/b> \(existing desk key\)/); assert.match(html, /Test key \(read-only balance check\)/);
  assert.ok(!require('../public/pilot.js').render(p.snapshot(), { local: false }).includes('Test key'), 'Test key only on this machine');
});

test('permission denied: a 401 or 403 (or insufficient scope) on the first armed order -> one attempt, HALTED "this key can\'t trade", nothing else sent', async () => {
  for (const [st, code] of [[401, 'unauthorized'], [403, 'forbidden'], [400, 'insufficient_scope']]) {
    const v = fakes(), c = fakeClient({ async createOrder(o) { c.calls.push(['create', o]); throw Object.assign(new R.KalshiHttpError(st, code, 'denied'), {}); } });
    const { p, dir } = pilot({ v, client: c }); await p.arm('ARM LIVE'); const before = c.calls.length; v.take(); await p.signals.get(TK).run;
    const after = c.calls.slice(before); assert.deepEqual(after.filter((q) => Array.isArray(q)).map((q) => q[0]), ['create'], st + ': exactly one order attempt, no cancels');
    assert.equal(after[after.length - 1][0], 'create', st + ': no request after the refused order');
    assert.equal(p.state, 'HALTED'); assert.match(p.haltReason, /this key can't trade, make a read\+trade key/);
    assert.match(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'), /this key can't trade, make a read\+trade key/);
    assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /this key can&#39;t trade, make a read\+trade key/);
    v.take('KXETH15M-26NOV011015-15'); await new Promise((r) => setImmediate(r)); assert.equal(c.calls.slice(before).filter((q) => Array.isArray(q)).length, 1, 'later signals send nothing');
  }
  assert.ok(P.isPermission({ status: 403 }) && P.isPermission({ status: 400, code: 'insufficient_scope' }) && !P.isPermission({ status: 400, code: 'invalid_price' }));
});

test('Test key (read-only balance check): signed GETs only, works while DISABLED, reports balance / scope / bad key / clock skew; never an order', async () => {
  const env = { KALSHI_API_KEY_ID: 'desk-kid', KALSHI_PRIVATE_KEY_PEM: PEM }; // LIVE_PILOT_ENABLED unset
  let f = mockFetch({ balance: 15012 }), p = new P.KalshiPilot({ dir: tmp(), env, fetchImpl: f }); p.start(); assert.equal(p.state, 'DISABLED');
  let r = await p.testKey(); assert.equal(r.ok, true); assert.equal(r.balanceCents, 15012); assert.equal(r.tradeScope, null); assert.match(r.scopeNote, /can't be verified until the first armed order/);
  const all = () => f.reqs.map((q) => q.method + ' ' + q.path);
  assert.ok(f.reqs.every((q) => q.method === 'GET' && !q.body), all().join()); assert.ok(f.reqs.every((q) => !/orders/.test(q.path)), 'no order endpoint');
  assert.ok(f.reqs[0].path.endsWith('/portfolio/balance') && f.reqs[0].headers['KALSHI-ACCESS-SIGNATURE'], 'a signed GET balance');
  assert.deepEqual(fs.readdirSync(p.dir), [], 'no ledger rows while DISABLED');
  f = mockFetch({ keys: [{ api_key_id: 'desk-kid', scopes: ['read', 'write::trade'] }] }); p = new P.KalshiPilot({ dir: tmp(), env, fetchImpl: f }); r = await p.testKey(); assert.equal(r.tradeScope, true); assert.equal(r.scopeNote, 'trade scope present');
  f = mockFetch({ keys: [{ api_key_id: 'desk-kid', scopes: ['read'] }] }); p = new P.KalshiPilot({ dir: tmp(), env, fetchImpl: f }); r = await p.testKey(); assert.equal(r.ok, true); assert.equal(r.tradeScope, false); assert.match(r.scopeNote, /can't trade, make a read\+trade key/);
  f = mockFetch({ status: 401 }); p = new P.KalshiPilot({ dir: tmp(), env, fetchImpl: f }); r = await p.testKey(); assert.equal(r.ok, false); assert.match(r.error, /rejected the key \(401\)/);
  f = mockFetch({ dateSkewMs: 30000 }); p = new P.KalshiPilot({ dir: tmp(), env, fetchImpl: f }); r = await p.testKey(); assert.equal(r.ok, false); assert.match(r.error, /clock skew/);
  p = new P.KalshiPilot({ dir: tmp(), env: { KALSHI_API_KEY_ID: 'k', KALSHI_PRIVATE_KEY_PEM: 'SECRETVALUE' }, fetchImpl: mockFetch() }); r = await p.testKey(); assert.equal(r.ok, false); assert.ok(!JSON.stringify(p.snapshot()).includes('SECRETVALUE'));
  p = new P.KalshiPilot({ dir: tmp(), env: {}, fetchImpl: mockFetch() }); r = await p.testKey(); assert.equal(r.ok, false); assert.match(r.error, /no Kalshi key/);
});

test('order path is REST only: no websocket in the pilot or its client; orders go out as HTTPS POST via fetch', async () => {
  for (const f of ['server/live/kalshi-pilot.js', 'server/live/kalshi-rest.js', 'server/live/kalshi-transfer.js', 'server/live/kalshi-live-history.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); assert.ok(!/WebSocket|wss?:\/\/|\bws-sign\b|recorder\/kalshi-ws/.test(code), f + ' must not use a websocket');
    assert.deepEqual([...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).filter((m) => !['fs', 'path', 'crypto', './kalshi-rest', './kalshi-transfer', './kalshi-live-history'].includes(m)), [], f + ' requires only fs/path/crypto/the REST client');
  }
  assert.match(R.HOST, /^https:\/\//);
  const f = mockFetch(), c = R.makeTradeClient({ env: ENV_ON, fetchImpl: f });
  await c.createOrder({ ticker: TK, side: 'yes', action: 'buy', count: 1, priceCents: 96, clientOrderId: 'hp1-test-s1' });
  assert.equal(f.reqs.length, 1); assert.equal(f.reqs[0].method, 'POST'); assert.equal(f.reqs[0].path, '/trade-api/v2/portfolio/events/orders');
});

test('.gitignore keeps Kalshi key files and hawse.env out of git', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const rule of ['*.pem', 'kalshi_trade_key*', 'hawse.env', '.env']) assert.ok(gi.includes(rule), rule);
  const { execFileSync } = require('child_process');
  let git = true; try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  if (git) for (const f of ['kalshi_trade_key.pem', 'keys/desk.pem', 'kalshi_trade_key', 'kalshi_trade_key.txt', 'hawse.env', 'config/hawse.env'])
    assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT, stdio: 'ignore' }), f + ' must be ignored');
});

test('shadow sizing tracks the live balance: throttled read-only GET before each decision; $80 -> $150 -> $400 sizes at 7% of $80, $150, $400', async () => {
  let t = Date.parse('2026-11-01T18:00:00Z'); const now = () => t;
  const v = fakes(), c = fakeClient({ balance: 8000 }); const { p } = pilot({ v, client: c, now });
  const sized = [];
  for (const [bal, tk] of [[8000, 'KXBTC15M-26NOV011015-A'], [15000, 'KXBTC15M-26NOV011030-B'], [40000, 'KXBTC15M-26NOV011045-C']]) {
    c.balance = bal; v.take(tk, t); await p.signals.get(tk).run; sized.push(p.shadow[p.shadow.length - 1]); t += 21000;
  }
  assert.deepEqual(sized.map((r) => r.sizing.bankrollCents), [8000, 15000, 40000]);
  assert.deepEqual(sized.map((r) => r.sizing.targetCents), [560, 1050, 2800], '7% of $80, $150, $400 (shard 2 cash)');
  assert.deepEqual(sized.map((r) => r.contracts), [5, 11, 29]); assert.ok(sized.every((r) => r.sizing.pct === 7 && r.noMoney));
  assert.deepEqual(sized.map((r) => r.sizing.sizeCents), [5 * 96, 11 * 96, 29 * 96], 'order dollars = contracts x limit');
  assert.deepEqual(c.calls.filter((q) => q === 'balance'), ['balance', 'balance', 'balance'], 'one shard 2 read per decision, no restart needed'); assert.ok(c.calls.every((q) => typeof q === 'string'), 'read-only GETs only');
  // throttle: a second decision within 20 s reuses the last read
  c.balance = 9000; v.take('KXETH15M-26NOV011045-D', t); await p.signals.get('KXETH15M-26NOV011045-D').run; t += 5000; v.take('KXSOL15M-26NOV011045-E', t); await p.signals.get('KXSOL15M-26NOV011045-E').run;
  assert.equal(c.calls.filter((q) => q === 'balance').length, 4, 'at most one balance read per 20 s');
  // a failed read in shadow: no halt, balance marked stale, last known value used
  t += 21000; c.getBalance = async () => { c.calls.push('balance'); throw new Error('HTTP 503'); };
  v.take('KXBTC15M-26NOV011100-F', t); await p.signals.get('KXBTC15M-26NOV011100-F').run; const r = p.shadow[p.shadow.length - 1];
  assert.equal(p.state, 'DISARMED'); assert.equal(r.balanceStale, true); assert.equal(r.sizing.bankrollCents, 9000); assert.equal(p.snapshot().money.balanceStale, true);
  assert.match(require('../public/pilot.js').render(p.snapshot(), {}), /stale/);
  // never had a balance: the decision is skipped (there is no fallback bankroll)
  const c2 = fakeClient({ async getBalance() { throw new Error('timeout'); } }), q = pilot({ client: c2, v: fakes() });
  q.v.take(); await q.p.signals.get(TK).run; assert.equal(q.p.shadow[0].contracts, 0); assert.match(q.p.shadow[0].skipped, /no Kalshi balance yet/); assert.equal(q.p.state, 'DISARMED');
  // short timeout
  const c3 = fakeClient({ getBalance: () => new Promise(() => {}) }), w = pilot({ client: c3 }).p; const t0 = Date.now();
  await w.refreshBalance({ timeoutMs: 30 }); assert.ok(Date.now() - t0 < 1000); assert.equal(w.balanceStale, true); assert.match(w.balanceError, /timed out/);
});

test('sizing fields on every shadow / intent / compare row, persisted in the ledger, shown on the card with the cap that bound', async () => {
  const dir = tmp(); let v = fakes({ vol: 60 }), c = fakeClient({ balance: 15000 }); let x = pilot({ v, client: c, dir }).p;
  v.take(); await x.signals.get(TK).run; const sh = x.shadow[0];
  assert.deepEqual({ ...sh.sizing }, { bankrollCents: 15000, pct: 7, targetCents: 1050, sizeCents: 6 * 96, contracts: 6, limitCents: 96, capBound: '10% volume', capped: true });
  // armed: the order intent carries the same fields (7% line binding here)
  v = fakes(); x = pilot({ v, client: fakeClient({ balance: 15000 }), dir: tmp() }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run;
  const it = [...x.signals.get(TK).intents.values()][0]; assert.equal(it.sizing.bankrollCents, 15000); assert.equal(it.sizing.capBound, '7% line'); assert.equal(it.sizing.capped, false); assert.equal(it.sizing.sizeCents, 11 * 96);
  const led = fs.readFileSync(path.join(x.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(led.filter((r) => r.t === 'order_intent').every((r) => r.sizing && r.sizing.pct === 7));
  // restart: rebuilt from the ledger, the snapshot still has the sizing
  const y = new P.KalshiPilot({ v1: fakes().v1, v3: fakes().v3, dir: x.dir, killFile: path.join(x.dir, 'KILL'), env: ENV_ON, client: fakeClient(), sleep: async () => {} }); y.start(); y.stop();
  const snap = y.snapshot(); assert.equal(snap.trades[0].sizing.targetCents, 1050); assert.equal(snap.compare[0].sizing.bankrollCents, 15000);
  const h = require('../public/pilot.js').render(snap, {}); assert.match(h, /7% × \$150\.00 = \$10\.50 → 11 × 96¢ = <b>\$10\.56<\/b>/); assert.match(h, /bound: 7% line/);
  const s2 = pilot({ v: (v = fakes({ vol: 60 })), client: fakeClient({ balance: 15000 }), dir }).p; v.take(); await s2.signals.get(TK).run;
  assert.match(require('../public/pilot.js').render(s2.snapshot(), {}), /capped by 10% volume/);
  for (const [b, lab] of [['asset', 'asset cap'], ['openRisk', 'open-risk'], ['cash', 'balance'], ['pct', '7% line']]) assert.equal(P.sizingOf(CFG, 15000, 1050, 1, 96, [b]).capBound, lab);
});


// ---- "Move cash between pools" (desk PC only). Mocked HTTP only: nothing here reaches Kalshi. ----
const X = require('../server/live/kalshi-transfer');
const UUID1 = '11111111-2222-4333-8444-555555555555';
/** The REAL signed client over a mock fetch that answers balances per pool and the transfer endpoints. */
function xferFetch({ pools = { 0: 7251, 1: 703, 2: 0, 3: 0 }, post = 200, gets = ['pending', 'complete'] } = {}) {
  const reqs = []; let g = 0;
  const f = async (url, o) => { const u = new URL(url); reqs.push({ method: o.method, path: u.pathname, q: u.searchParams, body: o.body ? JSON.parse(o.body) : null, headers: o.headers });
    let st = 200, j = {};
    if (u.pathname.endsWith('/portfolio/balance')) { const xi = u.searchParams.get('exchange_index');
      j = xi == null ? { balance: Object.values(pools).reduce((a, b) => a + b, 0), balance_breakdown: Object.entries(pools).map(([k, v]) => ({ exchange_index: +k, balance: (v / 100).toFixed(4) })) } : { balance: pools[xi] }; }
    else if (o.method === 'POST' && u.pathname.endsWith('/portfolio/intra_exchange_instance_transfer')) { st = post; j = st === 200 ? { transfer_id: 'tr-1' } : { error: { code: 'x', message: 'no' } };
      if (st === 200) { const b = JSON.parse(o.body); pools[b.source_exchange_shard] -= b.amount / 100; pools[b.destination_exchange_shard] += b.amount / 100; } }
    else if (u.pathname.includes('/portfolio/intra_exchange_instance_transfers/')) j = { transfer: { transfer_id: 'tr-1', status: gets[Math.min(g++, gets.length - 1)] } };
    else if (u.pathname.endsWith('/portfolio/intra_exchange_instance_transfers')) j = { transfers: [{ transfer_id: 'tr-old', client_transfer_id: UUID1, status: 'complete' }] };
    return { ok: st === 200, status: st, headers: { get: () => null }, json: async () => j }; };
  f.reqs = reqs; f.pools = pools; return f;
}
function xpilot(fx, over = {}) {
  const dir = tmp(), slept = [];
  const p = new P.KalshiPilot({ v1: fakes().v1, v3: fakes().v3, dir, killFile: path.join(dir, 'KILL'), env: ENV_ON, fetchImpl: fx, sleep: async (ms) => { slept.push(ms); }, ...over });
  return { p, dir, slept, rows: () => fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}
const xposts = (fx) => fx.reqs.filter((r) => r.method === 'POST');

test('transfer: centicents ($1 = 10,000) and strict whole-cent dollar parsing', () => {
  assert.equal(R.centsToCenticents(7000), 700000); assert.equal(R.centsToCenticents(1), 100); assert.throws(() => R.centsToCenticents(70.5));
  assert.equal(X.parseDollars('70'), 7000); assert.equal(X.parseDollars('70.5'), 7050); assert.equal(X.parseDollars('$1,070.25'), 107025);
  for (const bad of ['70.001', '-1', '1e3', '', 'abc', '0x10']) assert.equal(X.parseDollars(bad), null, bad);
});

test('transfer: happy path prepare -> confirm sends one signed POST (event_contract, centicents, shards, UUID), polls >= 1.5 s, re-reads pools, logs rows, pilot state untouched', async () => {
  const fx = xferFetch(); const { p, slept, rows } = xpilot(fx);
  const before = p.state;
  const a = await p.transferPrepare({ amount: '70.00', from: 0, to: 2 });
  assert.equal(a.ok, true); assert.equal(a.confirm.text, 'Move $70.00 from Default (shard 0) to Crypto & Commodities (shard 2)?');
  assert.equal(xposts(fx).length, 0, 'prepare sends nothing that moves money');
  const b = await p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 7000, from: 0, to: 2 });
  assert.equal(b.ok, true, b.error); assert.equal(b.transfer.last.status, 'complete'); assert.match(b.transfer.last.text, /Moved \$70\.00 from Default \(shard 0\) to Crypto & Commodities \(shard 2\): complete/);
  const ps = xposts(fx); assert.equal(ps.length, 1); assert.equal(ps[0].path, '/trade-api/v2/portfolio/intra_exchange_instance_transfer');
  assert.deepEqual(Object.keys(ps[0].body).sort(), ['amount', 'client_transfer_id', 'destination', 'destination_exchange_shard', 'source', 'source_exchange_shard']);
  assert.equal(ps[0].body.amount, 700000); assert.equal(ps[0].body.source, 'event_contract'); assert.equal(ps[0].body.destination, 'event_contract');
  assert.equal(ps[0].body.source_exchange_shard, 0); assert.equal(ps[0].body.destination_exchange_shard, 2); assert.match(ps[0].body.client_transfer_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  assert.ok(ps[0].headers['KALSHI-ACCESS-SIGNATURE'] && ps[0].headers['KALSHI-ACCESS-KEY'] === 'trade-kid');
  assert.ok(slept.length >= 2 && slept.every((ms) => ms >= 1500), 'status polls and pool re-read spaced >= 1.5 s');
  assert.deepEqual(b.transfer.last.shards.map((s) => s.cents), [251, 703, 7000, 0]);
  assert.ok(!fx.reqs.some((r) => /target_balance_allocation|withdraw|subaccount/.test(r.path + r.q.toString())));
  const x = rows().filter((r) => /^transfer/.test(r.t)); assert.deepEqual(x.map((r) => r.t), ['transfer', 'transfer_status']);
  assert.equal(x[0].outcome, 'accepted'); assert.equal(x[0].amountCents, 7000); assert.equal(x[0].clientTransferId, ps[0].body.client_transfer_id);
  assert.equal(p.state, before); assert.equal(p.snapshot().transfer.busy, false); assert.ok(!JSON.stringify(p.snapshot()).includes(a.confirm.token), 'snapshot never carries the confirm token');
});

test('transfer: same pool, over the fresh balance, bad amount, missing/mismatched confirm all refused with no POST', async () => {
  const fx = xferFetch(); const { p } = xpilot(fx);
  assert.match((await p.transferPrepare({ amount: '5', from: 2, to: 2 })).error, /same pool/);
  assert.match((await p.transferPrepare({ amount: '72.52', from: 0, to: 2 })).error, /more than the \$72\.51 available in Default \(shard 0\)/);
  assert.match((await p.transferPrepare({ amount: '0', from: 0, to: 2 })).error, /more than \$0\.00/);
  assert.match((await p.transferPrepare({ amount: '1.005', from: 0, to: 2 })).error, /whole cents/);
  assert.match((await p.transferPrepare({ amount: '1', from: 0, to: 7 })).error, /pick a source/);
  const a = await p.transferPrepare({ amount: '10', from: 0, to: 2 }); assert.equal(a.ok, true);
  assert.match((await p.transferConfirm({ token: a.confirm.token, amountCents: 1000, from: 0, to: 2 })).error, /not confirmed/);
  assert.match((await p.transferConfirm({ confirm: true, token: 'nope', amountCents: 1000, from: 0, to: 2 })).error, /no matching transfer/);
  assert.match((await p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 100000, from: 0, to: 2 })).error, /do not match/);
  assert.match((await p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 1000, from: 0, to: 3 })).error, /do not match/);
  fx.pools[0] = 500; // cash left the pool between prepare and confirm
  assert.match((await p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 1000, from: 0, to: 2 })).error, /more than the \$5\.00 now in Default/);
  assert.equal(xposts(fx).length, 0);
});

test('transfer: an uncertain send keeps the same client_transfer_id for Retry; 409 = already taken; 403 never halts the pilot', async () => {
  const fx = xferFetch({ post: 500 }); const { p, rows } = xpilot(fx);
  const a = await p.transferPrepare({ amount: '1', from: 0, to: 2 });
  const b = await p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 100, from: 0, to: 2 });
  assert.equal(b.ok, false); assert.ok(b.retryToken); assert.match(b.error, /Retry/);
  fx.reqs.length = 0; // the retry of the same click
  const c = await p.transferConfirm({ confirm: true, token: b.retryToken, amountCents: 100, from: 0, to: 2 }); assert.equal(c.ok, false);
  const ids = rows().filter((r) => r.t === 'transfer').map((r) => r.clientTransferId); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1], 'same id on retry');
  // a fresh click gets a fresh id
  await p.transferCancel(); const d = await p.transferPrepare({ amount: '1', from: 0, to: 2 }); await p.transferConfirm({ confirm: true, token: d.confirm.token, amountCents: 100, from: 0, to: 2 });
  assert.notEqual(rows().filter((r) => r.t === 'transfer').pop().clientTransferId, ids[0]);
  // 409: Kalshi already accepted this client_transfer_id -> look it up, no new transfer
  const f9 = xferFetch({ post: 409 }); const q = xpilot(f9, { }); q.p.transfers.uuid = () => UUID1;
  const e = await q.p.transferPrepare({ amount: '1', from: 0, to: 2 }); const r9 = await q.p.transferConfirm({ confirm: true, token: e.confirm.token, amountCents: 100, from: 0, to: 2 });
  assert.equal(r9.ok, true); assert.equal(r9.transfer.last.transferId, 'tr-old');
  // 403: this key cannot move cash; the pilot is not halted
  const f3 = xferFetch({ post: 403 }); const z = xpilot(f3); const st = z.p.state;
  const g = await z.p.transferPrepare({ amount: '1', from: 0, to: 2 }); const r3 = await z.p.transferConfirm({ confirm: true, token: g.confirm.token, amountCents: 100, from: 0, to: 2 });
  assert.equal(r3.ok, false); assert.match(r3.error, /refused this key for transfers/); assert.equal(z.p.state, st); assert.notEqual(z.p.state, 'HALTED');
  assert.ok(!JSON.stringify(rows()).includes('PRIVATE KEY') && !JSON.stringify(r3).includes('PRIVATE KEY'));
});

test('transfer: one at a time (in-flight lock), 429 on status backs off, subaccount refused', async () => {
  const fx = xferFetch({ gets: ['pending'] }); let release; const gate = new Promise((r) => { release = r; }); const slept = [];
  const { p } = xpilot(fx, { sleep: async (ms) => { slept.push(ms); if (slept.length === 1) await gate; } });
  const a = await p.transferPrepare({ amount: '1', from: 0, to: 2 });
  const run = p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 100, from: 0, to: 2 });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(p.snapshot().transfer.busy, true); assert.match((await p.transferPrepare({ amount: '1', from: 0, to: 2 })).error, /already in progress/);
  release(); const r = await run; assert.equal(r.transfer.last.status, 'pending'); assert.equal(xposts(fx).length, 1);
  // 429 while polling: wait grows
  const t = new X.PoolTransfer({ getClient: () => c, write: () => {}, sleep: async (ms) => { w.push(ms); } }), w = [];
  let n = 0; const c = { getTransfer: async () => { if (n++ < 2) { const e = new Error('429'); e.status = 429; throw e; } return { transfer: { status: 'complete' } }; } };
  assert.equal(await t.poll(c, 'tr'), 'complete'); assert.ok(w[1] > 1500 && w[2] > w[1], 'backs off on 429: ' + w);
  const s = xpilot(xferFetch(), { env: { ...ENV_ON, KALSHI_TRADE_SUBACCOUNT: '3' } });
  assert.match((await s.p.transferPrepare({ amount: '1', from: 0, to: 2 })).error, /main-account only/);
  await assert.rejects(() => R.makeTradeClient({ env: { ...ENV_ON, KALSHI_TRADE_SUBACCOUNT: '3' }, fetchImpl: xferFetch() }).createTransfer({ amountCents: 100, from: 0, to: 2, clientTransferId: UUID1 }), /main-account only/);
});

test('transfer: start, arm and Test key never move cash', async () => {
  const fx = xferFetch(); const on = cfgFile(() => {}); const { p } = xpilot(fx);
  p.start(); await p.testKey(); p.stop();
  assert.ok(!fx.reqs.some((r) => /intra_exchange|target_balance/.test(r.path)), 'no transfer call on start / Test key');
  const c = fakeClient(); let moved = 0; c.createTransfer = async () => { moved++; }; const q = pilot({ client: c, file: on.file, pin: on.pin }); await q.p.arm('ARM LIVE');
  assert.equal(moved, 0, 'arming never transfers');
});

test('transfer: desk-PC routes only; the phone link and the proxy refuse them; the card hides the control off this machine', async () => {
  const fx = xferFetch(); const { p } = xpilot(fx);
  const srv = createServer({ kalshiPilot: p, routes: [] }, {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const post = (pth, body, headers = {}) => new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: pth, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (r) => { let d = ''; r.on('data', (x) => { d += x; }); r.on('end', () => res([r.statusCode, JSON.parse(d)])); }); q.end(JSON.stringify(body)); });
  try {
    for (const w of ['transfer-prepare', 'transfer-confirm', 'transfer-cancel']) assert.equal((await post('/api/live/kalshi-pilot/' + w, { amount: '1', from: 0, to: 2, confirm: true }, { 'x-forwarded-for': '100.64.1.2' }))[0], 403, w);
    const [c1, r1] = await post('/api/live/kalshi-pilot/transfer-prepare', { amount: '1', from: 0, to: 2 }); assert.equal(c1, 200); assert.ok(r1.confirm.token);
    const [c2] = await post('/api/live/kalshi-pilot/transfer-confirm', { token: r1.confirm.token, amountCents: 100, from: 0, to: 2 }); assert.equal(c2, 422, 'missing confirm:true');
    const [c3, r3] = await post('/api/live/kalshi-pilot/transfer-confirm', { confirm: true, token: r1.confirm.token, amountCents: 100, from: 0, to: 2 }); assert.equal(c3, 200, JSON.stringify(r3));
  } finally { srv.close(); }
  const all = Object.keys(proxy.POST_ROUTES);
  for (const w of ['transfer-prepare', 'transfer-confirm', 'transfer-cancel']) assert.equal(proxy.policy('POST', '/api/live/kalshi-pilot/' + w, all)[0], 403, w);
  const UI = require('../public/pilot.js'); const snap = p.snapshot();
  assert.match(UI.render(snap, { local: true }), /Move cash between pools/); assert.match(UI.render(snap, { local: true }), /Crypto &amp; Commodities \(shard 2\)/);
  assert.doesNotMatch(UI.render(snap, { local: false }), /Move cash between pools|xfer-/, 'hidden on the phone link');
  const conf = UI.render(snap, { local: true, xferConfirm: { text: 'Move $70.00 from Default (shard 0) to Crypto & Commodities (shard 2)?', from: 0, to: 2, amountCents: 7000, availableCents: 7251, token: 't' } });
  assert.match(conf, /data-pilot="xfer-confirm"/); assert.match(conf, /data-pilot="xfer-cancel"/);
});

test('repo-wide: transfer endpoints only in kalshi-rest.js; target_balance_allocation is never called anywhere', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const files = ['server', 'scripts', 'public', 'cloudflare'].filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => walk(path.join(ROOT, d)));
  const rel = (f) => path.relative(ROOT, f);
  assert.deepEqual(files.filter((f) => /['"`]\/portfolio\/intra_exchange/.test(fs.readFileSync(f, 'utf8'))).map(rel), [path.join('server', 'live', 'kalshi-rest.js')]);
  assert.deepEqual(files.filter((f) => /['"`][^'"`\n]*target_balance_allocation/.test(fs.readFileSync(f, 'utf8'))).map(rel), [], 'no code string names target_balance_allocation');
  assert.deepEqual(files.filter((f) => /createTransfer\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort(), [path.join('server', 'live', 'kalshi-rest.js'), path.join('server', 'live', 'kalshi-transfer.js')].sort());
  const t = fs.readFileSync(path.join(ROOT, 'server', 'live', 'kalshi-transfer.js'), 'utf8'); assert.doesNotMatch(t, /KALSHI_TRADE_PRIVATE|KALSHI_TRADE_KEY|require\(['"]\.\/kalshi-rest/);
});

// ---- live chart: real balance reads + ledger history -------------------------------------------------------------------------------------
const UI = require('../public/pilot.js');
const balRows = (dir) => { const f = path.join(dir, 'balances.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };

test('live chart: balance points come only from reads the pilot already makes (no extra calls), hold the real numbers, no secrets', async () => {
  let t = Date.parse('2026-11-01T18:00:00Z'); const now = () => t;
  const v = fakes(), c = fakeClient({ balance: 5000, aggregate: 12954, pv: 5650, breakdown: BD.map((x) => (x.exchange_index === 2 ? { ...x, balance: '50.0000' } : x)) });
  const { p, dir } = pilot({ v, client: c, now });
  assert.deepEqual(balRows(dir), [], 'nothing recorded before the pilot reads anything');
  v.take(TK, t); await p.signals.get(TK).run; await p.infoRun;
  const reads = c.calls.filter((x) => x === 'balance' || x === 'balance_all').length, rows = balRows(dir);
  assert.ok(rows.length >= 1 && rows.length <= reads, `${rows.length} points from ${reads} reads: never more points than real reads`);
  const sh = rows.find((r) => r.kind === 'shard'), all = rows.find((r) => r.kind === 'all');
  assert.equal(sh.exchangeIndex, 2); assert.equal(sh.cashCents, 5000); assert.equal(sh.pvCents, 5650);
  assert.deepEqual(all.shards.map((s) => s.cents), [7251, 703, 5000, 0]); assert.equal(all.cashCents, 12954); assert.equal(all.pvCents, 5650);
  // chart code adds no request of its own: snapshot + render make zero calls
  const before = c.calls.length; const S = p.snapshot(); UI.render(S, { cme: false }); UI.render(S, { cme: true }); UI.liveSpec(S); assert.equal(c.calls.length, before);
  const txt = fs.readFileSync(path.join(dir, 'balances.jsonl'), 'utf8'); assert.ok(!txt.includes('PRIVATE') && !txt.includes('trade-kid') && !txt.includes(PEM.slice(40, 80)), 'no key material in the file');
  assert.ok(!JSON.stringify(S.live).includes('trade-kid'));
});

test('live chart: same numbers within 15 min are not re-written; a change or 15 min later is; file reloads on restart', () => {
  let t = 1_000_000; const dir = tmp(); const { LiveHistory, SAME_ROW_GAP_MS } = require('../server/live/kalshi-live-history');
  const h = new LiveHistory({ dir, now: () => t });
  assert.ok(h.record('shard read', 'shard', { cents: 5000, portfolioValueCents: 0 }, 2));
  t += 20000; assert.equal(h.record('shard read', 'shard', { cents: 5000, portfolioValueCents: 0 }, 2), null, 'duplicate skipped');
  t += 20000; assert.ok(h.record('shard read', 'shard', { cents: 4650, portfolioValueCents: 350 }, 2), 'a change is written');
  t += SAME_ROW_GAP_MS; assert.ok(h.record('shard read', 'shard', { cents: 4650, portfolioValueCents: 350 }, 2), 'same numbers after 15 min are written');
  assert.equal(h.record('x', 'shard', { cents: null }, 2), null, 'no number, no point'); assert.equal(h.record('x', 'all', { shards: null }), null);
  const h2 = new LiveHistory({ dir, now: () => t }); h2.load(); assert.equal(h2.view().count, 3); assert.equal(h2.view().points[1].cashCents, 4650);
});

test('live chart: honest empty state "collecting live data" until there are 2 real reads; DISABLED shows no chart and writes no file', async () => {
  const { p, dir } = pilot({ client: fakeClient() });
  let h = UI.render(p.snapshot(), { cme: true }); assert.match(h, /collecting live data: 0 balance reads so far/); assert.ok(!/data-pilot-chart|<svg class="pl-livechart/.test(h));
  p.history.record('shard read', 'shard', { cents: 5000, portfolioValueCents: 0 }, 2);
  h = UI.render(p.snapshot(), { cme: true }); assert.match(h, /collecting live data: 1 balance read so far/);
  assert.match(h, /no mock data is ever shown/);
  const d = tmp(); const q = new P.KalshiPilot({ v1: fakes().v1, v3: fakes().v3, dir: d, killFile: path.join(d, 'KILL'), env: {}, client: fakeClient() }); q.start(); q.stop();
  assert.equal(q.state, 'DISABLED'); assert.ok(!fs.existsSync(path.join(d, 'balances.jsonl'))); assert.ok(!/Live money|collecting live data/.test(UI.render(q.snapshot(), {})));
  assert.ok(dir);
});

test('live chart: CME canvas or Classic SVG per the chart toggle; series = account value, pilot pool, other pools; fill/transfer/halt markers from the ledger', () => {
  let t = Date.parse('2026-11-01T18:00:00Z'); const { p, dir } = pilot({ client: fakeClient(), now: () => t });
  p.history.record('all pools', 'all', { shards: [{ exchangeIndex: 0, cents: 7251 }, { exchangeIndex: 1, cents: 703 }, { exchangeIndex: 2, cents: 0 }, { exchangeIndex: 3, cents: 0 }], portfolioValueCents: 0 });
  t += 60000; p.write({ t: 'transfer', amountCents: 7000, from: 0, to: 2, outcome: 'accepted' }); p.write({ t: 'transfer_status', status: 'complete' });
  p.history.record('after transfer', 'all', { shards: [{ exchangeIndex: 0, cents: 251 }, { exchangeIndex: 1, cents: 703 }, { exchangeIndex: 2, cents: 7000 }, { exchangeIndex: 3, cents: 0 }] });
  t += 60000; p.write({ t: 'order_sent', tk: TK, coid: 'c1' }); p.write({ t: 'fill', tk: TK, coid: 'c1', count: 5, priceMicros: 950000, costMicros: 4750000, feeMicros: 30000 });
  p.history.record('after order', 'shard', { cents: 6522, portfolioValueCents: 500 }, 2);
  t += 60000; p.write({ t: 'not_sent', tk: TK, coid: 'c2', error: 'HTTP 400 insufficient_balance' }); p.write({ t: 'stop', kind: 'reject', reason: 'Kalshi rejected the order (400)' });
  const S = p.snapshot(), L = S.live;
  assert.equal(L.count, 3); assert.deepEqual(L.tx.map((e) => e.kind), ['stop', 'not_sent', 'fill', 'order_sent', 'transfer_status', 'transfer'].concat(L.tx.slice(6).map((e) => e.kind)), 'newest first');
  const fill = L.tx.find((e) => e.kind === 'fill'); assert.equal(fill.amountCents, -478); assert.match(fill.text, /fill 5 @ 95\.00¢ · fee \$0\.03/);
  assert.match(L.tx.find((e) => e.kind === 'transfer').text, /transfer \$70\.00 Default \(shard 0\) → Crypto & Commodities \(shard 2\) · accepted/);
  const d = UI.liveData(S); assert.equal(d.ok, true);
  assert.deepEqual(d.series.map((x) => x.name), ['account value (all pools + open positions)', 'pilot pool cash · Crypto & Commodities (shard 2)', 'Default (shard 0) cash', 'Combos (shard 1) cash'], 'Sports at $0 throughout is left out');
  assert.deepEqual(d.series[1].pts.map((q) => q[1]), [0, 70, 65.22]);
  assert.deepEqual(d.marks.map((m) => [m.kind, m.loss]), [['transfer', false], ['fill', false], ['not_sent', true], ['stop', true]]);
  const cme = UI.render(S, { cme: true }); assert.match(cme, /<canvas class="orb orb-big pl-livechart" data-pilot-chart="1"/); assert.match(cme, /Live money/);
  const sp = UI.liveSpec(S); assert.equal(sp.series.length, 4); assert.ok(sp.series.every((x) => x.step)); assert.equal(sp.marks.length, 4);
  const cl = UI.render(S, { cme: false }); assert.match(cl, /<svg class="pl-livechart"/); assert.equal((cl.match(/<path /g) || []).length, 4); assert.ok(!cl.includes('data-pilot-chart'));
  assert.match(cl, /Transaction history/); assert.match(cl, /HALTED: Kalshi rejected the order/); assert.match(cl, /rejected \/ not sent: HTTP 400 insufficient_balance/);
  // restart: ledger replay rebuilds the list, the balances file rebuilds the chart
  const p2 = new P.KalshiPilot({ v1: fakes().v1, v3: fakes().v3, dir, killFile: path.join(dir, 'KILL'), env: ENV_ON, client: fakeClient() }); p2.start(); p2.stop();
  assert.equal(p2.snapshot().live.count, 3); assert.ok(p2.snapshot().live.tx.some((e) => e.kind === 'fill'));
});

test('live chart: a pool transfer records the pools re-read it already made (no extra call)', async () => {
  const fx = xferFetch(); const { p, dir } = xpilot(fx);
  const a = await p.transferPrepare({ amount: '70.00', from: 0, to: 2 }); const n0 = fx.reqs.length;
  await p.transferConfirm({ confirm: true, token: a.confirm.token, amountCents: 7000, from: 0, to: 2 });
  const rows = balRows(dir).filter((r) => r.src === 'after transfer'); assert.equal(rows.length, 1); assert.deepEqual(rows[0].shards.map((s) => s.cents), [251, 703, 7000, 0]);
  assert.ok(fx.reqs.length > n0); assert.ok(p.snapshot().live.tx.some((e) => e.kind === 'transfer'));
});

// ---- bankroll by pool (display only, from Kalshi's own balance reads) -------------------------------------------
test('bankroll by pool: every pool by name with its real cash, the pilot pool marked, available for pilot trades, open positions, pending deposits, total; "Kalshi balance, read at HH:MM"', async () => {
  let t = Date.parse('2026-11-01T18:07:00Z'); const now = () => t;
  const v = fakes(), c = fakeClient({ balance: 5000, aggregate: 12954, pv: 5650, breakdown: BD.map((x) => (x.exchange_index === 2 ? { ...x, balance: '50.0000' } : x)),
    deposits: [{ id: 'd1', status: 'pending', amount_cents: 5000 }, { id: 'd2', status: 'applied', amount_cents: 10000 }] });
  const { p } = pilot({ v, client: c, now }); v.take(TK, t); await p.signals.get(TK).run; await p.infoRun;
  const B = p.snapshot().money.pools;
  assert.deepEqual(B.list.map((x) => [x.exchangeIndex, x.name, x.cents, x.pilot]), [[0, 'Default', 7251, false], [1, 'Combos', 703, false], [2, 'Crypto & Commodities', 5000, true], [3, 'Sports', 0, false]]);
  assert.equal(B.pilotPool, 2); assert.equal(B.pilotPoolName, 'Crypto & Commodities'); assert.equal(B.availableForPilotCents, 5000); assert.equal(B.openPositionsCents, 5650);
  assert.equal(B.pendingDepositsCents, 5000, 'pending only (applied deposits are already in a pool)'); assert.equal(B.cashCents, 12954); assert.equal(B.totalCents, 12954 + 5650); assert.equal(B.readAt, t); assert.equal(B.allRead, true);
  const before = c.calls.length; const h = UI.render(p.snapshot(), { tz: 'America/Los_Angeles' }); assert.equal(c.calls.length, before, 'rendering makes no request');
  assert.match(h, /Bankroll by pool<\/b> <span class="dim">Kalshi balance, read at 10:07\s?AM PST<\/span>/);
  assert.match(h, POOLROW('Default', 0, '72.51')); assert.match(h, POOLROW('Combos', 1, '7.03')); assert.match(h, POOLROW('Crypto & Commodities', 2, '50.00')); assert.match(h, POOLROW('Sports', 3, '0.00'));
  assert.equal((h.match(/← pilot trades from here/g) || []).length, 1); assert.match(h, /Crypto &amp; Commodities <span class="dim">\(shard 2\)<\/span>.*?← pilot trades from here/);
  assert.match(h, /available for pilot trades<\/span> <b class="pl-poolavail">\$50\.00<\/b> <span class="dim">Crypto &amp; Commodities \(shard 2\) available cash, read at 10:07\s?AM PST · 7% per trade = \$3\.50/);
  assert.match(h, /total<\/span> <b>\$186\.04<\/b> <span class="dim">= pool cash \$129\.54 \+ open positions \$56\.50; pending deposits not included/);
  // money moved in Kalshi's app: the next once-a-minute read shows it, nothing cached or invented
  c.breakdown = BD.map((x) => (x.exchange_index === 0 ? { ...x, balance: '2.5100' } : x.exchange_index === 2 ? { ...x, balance: '120.0000' } : x)); c.aggregate = 12954; t += 61000; await p.refreshInfo();
  const B2 = p.snapshot().money.pools; assert.equal(B2.list[0].cents, 251); assert.equal(B2.list[2].cents, 12000, 'the newer all-pools read wins for the pilot pool row'); assert.equal(B2.availableForPilotCents, 5000, 'available for pilot trades is the pilot pool read (sizing), shown with its own time');
});

test('bankroll by pool: before any Kalshi read every value says "not read yet" (nothing hardcoded); DISABLED reads nothing', async () => {
  const { p, client } = pilot(); const S = p.snapshot(), h = UI.render(S, {});
  assert.ok(S.money.pools.list.every((x) => x.cents == null)); assert.equal(S.money.pools.totalCents, null); assert.equal(client.calls.length, 0);
  const blk = h.slice(h.indexOf('pl-pools'), h.indexOf('Only the pilot'));
  assert.match(blk, /Kalshi balance: not read yet/); assert.equal((blk.match(/not read yet/g) || []).length, 4 + 1 + 1 + 1 + 1 + 1, 'four pools, header, available, positions, pending, total');
  assert.ok(!/\$\d/.test(blk), 'no dollar figure until Kalshi reports one');
  const off = pilot({ env: { ...ENV_ON, LIVE_PILOT_ENABLED: 'false' } }); await off.p.refreshInfo(); await off.p.refreshBalance(); assert.equal(off.client.calls.length, 0);
});

test('bankroll by pool: display reads are spaced 1.5 s apart and from the shard read; a 429 backs off (no extra read, no halt) and shows "unknown"', async () => {
  let t = Date.parse('2026-11-01T18:00:00Z'); const now = () => t; const naps = [];
  const c = fakeClient({ balance: 5000, aggregate: 12954, pv: 5650, breakdown: BD }); const sleep = async (ms) => { naps.push([ms, c.calls.length]); t += ms; };
  const v = fakes(); const { p } = pilot({ v, client: c, now, sleep }); v.take(TK, t); await p.signals.get(TK).run; await p.infoRun;
  assert.deepEqual(c.calls, ['balance', 'deposits', 'balance_all']); assert.deepEqual(naps, [[1500, 1], [1500, 2]], '1.5 s before deposits (after the shard read) and 1.5 s before the all-pools read');
  c.depositsError = Object.assign(new Error('Kalshi 429'), { status: 429 }); t += 61000; const n = c.calls.length; await p.refreshInfo();
  assert.deepEqual(c.calls.slice(n), ['deposits'], 'a 429 skips the all-pools read'); assert.ok(p.info.backoffUntil > t);
  await p.refreshInfo(); assert.equal(c.calls.length, n + 1, 'nothing more while backing off'); assert.notEqual(p.state, 'HALTED');
  assert.equal(p.snapshot().money.pools.pendingUnknown, true); assert.match(UI.render(p.snapshot(), {}), /pending deposits<\/span> unknown \(read failed\)/);
});

test('card: HALTED on this computer shows a visible RESET PILOT box; phone link shows none; reset brings back DISARMED-SHADOW', async () => {
  const UI = require('../public/pilot.js'); const { p } = pilot(); await p.halt('HALT button pressed');
  const S = p.snapshot(); assert.equal(S.config.resetPhrase, 'RESET PILOT', 'phrase exposed read-only from the frozen config');
  const h = UI.render(S, { local: true });
  assert.match(h, /<div class="pl-reset">/); assert.ok(!/<details[^>]*>\s*<summary[^>]*>[^<]*reset/i.test(h), 'not collapsed');
  assert.match(h, /Pilot is HALTED: HALT button pressed/); assert.match(h, /data-pilot="reset-phrase"[^>]*placeholder="type RESET PILOT"/); assert.match(h, /<button type="button" data-pilot="reset">RESET<\/button>/);
  const ph = UI.render(S, { local: false });
  assert.ok(!ph.includes('reset-phrase') && !ph.includes('data-pilot="reset"'), 'no reset box on the phone link'); assert.match(ph, /Arm and reset only on the desk PC/); assert.match(ph, /data-pilot="halt"/);
  const bad = UI.render(S, { local: true, act: { what: 'reset', ok: false, text: 'Not reset: type the exact reset phrase' } });
  assert.match(bad, /<div class="pl-reset">[\s\S]*class="pl-actres neg" role="status">Not reset: type the exact reset phrase/, 'error shown inline in the card');
  assert.equal(p.reset('reset pilot').ok, false); const r = p.reset('RESET PILOT'); assert.equal(r.ok, true); assert.equal(r.state, 'DISARMED');
  const S2 = p.snapshot(); assert.equal(S2.statusChip, 'DISARMED-SHADOW');
  const after = UI.render(S2, { local: true, act: { what: 'reset', ok: true, text: 'Reset: the pilot is now DISARMED-SHADOW (no money).' } });
  assert.ok(!after.includes('reset-phrase')); assert.match(after, /pl-actres pos" role="status">Reset: the pilot is now DISARMED-SHADOW/, 'success stays visible after the box goes away');
});

test('card: DISARMED-SHADOW ARM box is open with an "type ARM LIVE" input; ARMED has no reset or arm box', async () => {
  const UI = require('../public/pilot.js'); const { p } = pilot();
  const h = UI.render(p.snapshot(), { local: true });
  assert.match(h, /<details class="pl-arm" open>/); assert.match(h, /data-pilot="phrase"[^>]*placeholder="type ARM LIVE"/); assert.ok(!h.includes('reset-phrase'));
  assert.match(UI.render(p.snapshot(), { local: true, act: { what: 'arm', ok: false, text: 'Not armed: type the exact phrase to arm' } }), /<details class="pl-arm" open>[\s\S]*pl-actres neg" role="status">Not armed: type the exact phrase to arm[\s\S]*<\/details>/);
  const ph = UI.render(p.snapshot(), { local: false }); assert.ok(!ph.includes('data-pilot="phrase"')); assert.match(ph, /Arm and reset only on the desk PC/);
  assert.equal((await p.arm('ARM LIVE')).ok, true); const A = UI.render(p.snapshot(), { local: true });
  assert.equal(p.snapshot().statusChip, 'ARMED'); assert.ok(!A.includes('reset-phrase') && !A.includes('data-pilot="reset"') && !A.includes('pl-arm"'), 'ARMED: no reset/arm box'); assert.ok(!A.includes('desk PC; this link'));
});

// ---- Task F: lagging fills, order lookup cross-check, read-only recovery (all mocked) ----
const err429 = () => Object.assign(new Error('rate limited'), { status: 429 });
const realFills = (c, id) => c.fills.filter((x) => x.order_id === id);
async function oneTrade(c, dir = tmp()) { const v = fakes(); const x = pilot({ v, client: c, dir }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run; return { x, s: x.signals.get(TK), dir, v }; }
const rows = (dir, t) => fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t === t);

test('fills lag the ack: 0 at first, then all after 2 retries -> no halt, booked exactly once', async () => {
  const c = fakeClient(); let k = 0; c.getFills = async ({ orderId }) => { c.calls.push('fills'); return { fills: k++ < 2 ? [] : realFills(c, orderId) }; };
  const { x, s, dir } = await oneTrade(c);
  assert.notEqual(x.state, 'HALTED', x.haltReason); assert.equal(s.fills.length, 1); assert.equal(s.filled, realFills(c, s.fills[0].orderId)[0].count_fp | 0);
  const lag = rows(dir, 'fills_lag'); assert.equal(lag.length, 1); assert.equal(lag[0].retries, 2);
  await x.readFills(s, s.fills[0].orderId, s.fills[0].coid); assert.equal(s.fills.length, 1, 're-read never double-books');
});

test('fills never arrive but the order lookup agrees with the ack -> accepted from order_lookup, late fills deduped', async () => {
  const c = fakeClient(); let late = false; c.getFills = async ({ orderId }) => ({ fills: late ? realFills(c, orderId) : [] });
  const { x, s } = await oneTrade(c);
  assert.notEqual(x.state, 'HALTED', x.haltReason); assert.equal(s.fills.length, 1); assert.equal(s.fills[0].source, 'order_lookup'); assert.ok(s.fills[0].synthetic);
  assert.equal(s.fills[0].feeSource, 'order_lookup fees'); assert.equal(s.fills[0].feeMicros, 300 * 100);
  const n = s.filled; late = true; await x.readFills(s, s.fills[0].orderId, s.fills[0].coid); assert.equal(s.filled, n); assert.equal(s.fills.length, 1); assert.equal(s.seen.size, 1);
  assert.equal(x.snapshot().trades[0].source, 'order_lookup');
});

test('true mismatch (fills and order lookup both disagree with the ack) -> HALT with ack/fills/lookup counts and retries', async () => {
  const c = fakeClient(); c.getFills = async () => ({ fills: [] }); c.getOrder = async (id) => ({ order: { order_id: id, status: 'canceled', fill_count_fp: '0.00' } });
  const { x } = await oneTrade(c);
  assert.equal(x.state, 'HALTED'); assert.match(x.haltReason, /unreconciled after 5 fills retries: ack says \d+ filled .*; fills say 0; order lookup says 0 filled .*canceled/);
  const r = x.snapshot().reconcile; assert.equal(r.retries, 5); assert.equal(r.fills.count, 0); assert.equal(r.orderLookup.count, 0); assert.ok(r.ack.count > 0);
});

test('a 429 during a fills retry backs off and is never a halt', async () => {
  const c = fakeClient(); let k = 0; const waits = []; c.getFills = async ({ orderId }) => { k++; if (k === 1) return { fills: [] }; if (k === 2) throw err429(); return { fills: realFills(c, orderId) }; };
  const v = fakes(); const x = pilot({ v, client: c, sleep: async (ms) => { waits.push(ms); } }).p; await x.arm('ARM LIVE'); v.take(); await x.signals.get(TK).run;
  assert.notEqual(x.state, 'HALTED', x.haltReason); assert.equal(x.signals.get(TK).fills.length, 1);
  assert.ok(waits.some((w) => w >= 1500 + 2000), 'the retry after the 429 waits the backoff on top of the 1.5 s gap');
});

/** The live incident: ack 5 filled, fills read 0, halted. Then Kalshi shows the fills and (optionally) the settlement. */
async function incident({ settled }) {
  const c = fakeClient(); let show = false; c.getFills = async ({ orderId }) => { c.calls.push('fills'); return { fills: show ? realFills(c, orderId) : [] }; };
  const og = c.getOrder; c.getOrder = async (id) => (show ? og(id) : { order: { order_id: id, status: 'resting', fill_count_fp: '0.00' } });
  const { x, s, dir } = await oneTrade(c); assert.equal(x.state, 'HALTED'); assert.equal(s.fills.length, 0);
  show = true; if (settled) c.settled = s.intents.values().next().value.ack.fillCount * 100; c.getOrder = og; return { c, x, s, dir };
}

test('recovery books the missed fill + settlement once (idempotent, twice and again after a restart), source recovered', async () => {
  const { c, x, s, dir } = await incident({ settled: true });
  const creates = () => c.calls.filter((k) => Array.isArray(k) && (k[0] === 'create' || k[0] === 'cancel')).length, c0 = creates();
  const r1 = await x.recoverTrades('test'); assert.ok(r1.ok, r1.error); assert.equal(r1.fillsBooked, 1); assert.equal(r1.settled, 1); assert.deepEqual(r1.reads, ['Get Order', 'Get Fills', 'Get Settlements']);
  assert.equal(s.fills[0].source, 'recovered'); assert.equal(s.settle.source, 'recovered'); assert.ok(s.settle.win); assert.equal(typeof s.settle.check.netCents, 'number');
  const realized = x.realizedMicros;
  const r2 = await x.recoverTrades('again'); assert.equal(r2.checked, 0); assert.equal(r2.fillsBooked, 0); assert.equal(r2.settled, 0);
  assert.equal(s.fills.length, 1); assert.equal(rows(dir, 'settle').length, 1); assert.equal(rows(dir, 'recovery').length, 1); assert.equal(x.realizedMicros, realized);
  const y = pilot({ dir, client: c }).p; await y.startupRecover; assert.equal(rows(dir, 'fill').length, 1); assert.equal(rows(dir, 'settle').length, 1); assert.equal(y.state, 'HALTED');
  assert.equal(creates(), c0, 'no order or cancel from recovery');
});

test('recovery with a market Kalshi has not settled yet books only the fill; a later run books the settlement', async () => {
  const { c, x, s, dir } = await incident({ settled: false });
  const r = await x.recoverTrades('test'); assert.equal(r.fillsBooked, 1); assert.equal(r.settled, 0); assert.equal(r.unsettled, 1); assert.equal(s.settle, null); assert.equal(rows(dir, 'settle').length, 0);
  c.settled = s.filled * 100; const r2 = await x.recoverTrades('later'); assert.equal(r2.fillsBooked, 0); assert.equal(r2.settled, 1); assert.equal(rows(dir, 'fill').length, 1);
});

test('recovery never clears a halt, never arms, never halts; errors (429) just stop the run', async () => {
  const { c, x } = await incident({ settled: true }); const reason = x.haltReason;
  c.getOrder = async () => { throw err429(); }; const r = await x.recoverTrades('rate'); assert.equal(r.ok, false); assert.match(r.error, /429/);
  assert.equal(x.state, 'HALTED'); assert.equal(x.haltReason, reason);
  const d = pilot({ client: fakeClient() }).p; assert.notEqual(d.state, 'ARMED'); const st = d.state; const r2 = await d.recoverTrades('idle'); assert.ok(r2.ok); assert.equal(r2.checked, 0); assert.equal(d.state, st);
  assert.ok(!c.calls.some((k) => Array.isArray(k) && k[0] === 'create' && k.recovery));
});

// ---- live chart: fills neutral, settles win/loss with P&L, a balance read after each settle / recovery (all mocked) ----
const { txOf } = require('../server/live/kalshi-live-history');
/** The real first trade (hp1-KXETH15M-26NOV011545-45-s1) as the live ledger has it: 2 recovered fills 4+1 @ 94c, then a WIN settle, pnl 280200 u$. */
function recoveredTrade() {
  let t = Date.parse('2026-11-01T23:45:10Z'); const { p, dir } = pilot({ client: fakeClient(), now: () => t }); const tk = 'KXETH15M-26NOV011545-45', coid = 'hp1-KXETH15M-26NOV011545-45-s1';
  const sh = (c2) => ({ shards: [{ exchangeIndex: 0, cents: 0 }, { exchangeIndex: 1, cents: 0 }, { exchangeIndex: 2, cents: c2 }, { exchangeIndex: 3, cents: 0 }], portfolioValueCents: 0 });
  p.history.record('all pools', 'all', sh(7250)); t += 5000;
  p.write({ t: 'fill', tk, coid, orderId: 'o1', fillId: 'f1', count: 4, priceMicros: 940000, costMicros: 3760000, feeMicros: 16000, source: 'recovered' });
  p.write({ t: 'fill', tk, coid, orderId: 'o1', fillId: 'f2', count: 1, priceMicros: 940000, costMicros: 940000, feeMicros: 3800, source: 'recovered' });
  t += 2000; p.history.record('after order', 'all', { ...sh(6780), portfolioValueCents: 470 }); t += 600000;
  p.write({ t: 'settle', tk, win: true, result: 'yes', contracts: 5, costMicros: 4700000, feeMicros: 19800, pnlMicros: 280200, kalshiRevenueCents: 500, source: 'recovered' });
  t += 2000; p.history.record('after recovery', 'all', sh(7278));
  return { p, dir, tk };
}

test('chart tones: a fill (buy) is neutral, never red; win settle green "WIN +$0.28"; loss settle red; flat gray; reject / halt red; transfer neutral', () => {
  const f = txOf({ t: 'fill', at: 1, tk: 'X', count: 5, priceMicros: 940000, costMicros: 4700000, feeMicros: 20000 }); assert.equal(f.tone, 'neutral'); assert.notEqual(f.tone, 'neg'); assert.equal(f.label, 'buy 5 @94c');
  const w = txOf({ t: 'settle', at: 2, tk: 'X', win: true, pnlMicros: 280200 }); assert.equal(w.tone, 'pos'); assert.equal(w.label, 'WIN +$0.28');
  const l = txOf({ t: 'settle', at: 3, tk: 'X', win: false, pnlMicros: -4719800 }); assert.equal(l.tone, 'neg'); assert.equal(l.label, 'LOSS −$4.72');
  assert.equal(txOf({ t: 'settle', at: 4, pnlMicros: 0 }).tone, 'zero');
  assert.equal(txOf({ t: 'not_sent', at: 5, error: 'HTTP 400' }).tone, 'neg'); assert.equal(txOf({ t: 'stop', at: 6, reason: 'x' }).tone, 'neg');
  assert.equal(txOf({ t: 'transfer', at: 7, amountCents: 100, from: 0, to: 2, outcome: 'accepted' }).tone, 'neutral');
});

test('chart renders the recovered first trade: buys neutral, the settle a green "WIN +$0.28" label, realized P&L in the legend, balance lines move after the settle', () => {
  const { p } = recoveredTrade(), S = p.snapshot(), d = UI.liveData(S);
  const fills = d.marks.filter((m) => m.kind === 'fill'), st = d.marks.find((m) => m.kind === 'settle');
  assert.equal(fills.length, 2); for (const m of fills) { assert.equal(m.loss, false); assert.equal(m.tone, 'neutral'); assert.notEqual(m.col, '#ff3d5a'); assert.equal(m.y, 67.8, 'y = the first balance read after the buy'); }
  assert.equal(st.label, 'WIN +$0.28'); assert.equal(st.col, '#3dffb0'); assert.equal(st.loss, false); assert.equal(st.y, 72.78, 'y = the balance read after the settle');
  assert.equal(d.realized.cents, 28); assert.equal(d.realized.wins, 1);
  const pilotLine = d.series.find((x) => /pilot pool/.test(x.name)).pts; assert.equal(pilotLine[pilotLine.length - 1][1], 72.78);
  const svg = UI.render(S, { cme: false });
  assert.match(svg, /<text [^>]*fill="#3dffb0"[^>]*>WIN \+\$0\.28<\/text>/); assert.match(svg, /<title>settle KXETH15M-26NOV011545-45: WIN \+\$0\.28<\/title>/); assert.match(svg, /<title>fill KXETH15M-26NOV011545-45: buy 4 @94c · −\$3\.78<\/title>/);
  assert.ok(!/data-tone="neg"/.test(svg), 'nothing red on a winning trade'); assert.match(svg, /realized P&amp;L \+\$0\.28 \(1W \/ 0L\)/); assert.match(svg, /buys &amp; transfers \(neutral\)/);
  assert.match(svg, /<td class="pos">\+\$0\.28<\/td>/, 'tx list: settle amount green and signed'); assert.match(svg, /<td class="">−\$3\.78<\/td>/, 'tx list: buy amount neutral');
  const cme = UI.render(S, { cme: true }); assert.match(cme, /<canvas [^>]*title="[^"]*WIN \+\$0\.28/);
  const sp = UI.liveSpec(S); assert.ok(sp.marks.some((m) => m.showLabel && m.label === 'WIN +$0.28' && m.col === '#3dffb0'));
});

test('chart: a losing settle is red and labeled with its loss', () => {
  const { p, tk } = recoveredTrade(); p.write({ t: 'settle', tk: tk + 'B', win: false, contracts: 5, pnlMicros: -4719800 });
  p.history.record('after settle', 'all', { shards: [{ exchangeIndex: 2, cents: 7278 }] });
  const m = UI.liveData(p.snapshot()).marks.find((x) => x.kind === 'settle' && x.loss); assert.equal(m.label, 'LOSS −$4.72'); assert.equal(m.col, '#ff3d5a');
  assert.match(UI.render(p.snapshot(), { cme: false }), /realized P&amp;L −\$4\.44 \(1W \/ 1L\)/);
});

test('a settle and a recovery each trigger ONE real balance read (shard + all pools) into balances.jsonl, even while HALTED; 429 backoff skips it', async () => {
  const c = fakeClient(); c.breakdown = BD.map((x) => (x.exchange_index === 2 ? { ...x, balance: '72.5000' } : x)); c.aggregate = 7250 + 7251 + 703;
  const { x, s, dir } = await oneTrade(c); await x.postRead; const n0 = balRows(dir).length;
  c.settled = s.filled * 100; c.balance += s.filled * 100; c.breakdown = BD.map((b) => (b.exchange_index === 2 ? { ...b, balance: (c.balance / 100).toFixed(4) } : b));
  const k0 = c.calls.filter((k) => k === 'balance' || k === 'balance_all').length;
  for (const f of x.v1.rowListeners || []) f({ t: 'settle', tk: TK, win: true, result: 'yes' }); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.ok(s.settle, 'settled'); await x.postRead; await x.afterEventBalance('noop');
  const after = balRows(dir).slice(n0); assert.ok(after.some((r) => r.kind === 'shard' && r.src === 'after settle ' + TK && r.cashCents === c.balance));
  assert.ok(after.some((r) => r.kind === 'all' && r.src === 'after settle ' + TK && r.shards.find((q) => q.exchangeIndex === 2).cents === c.balance));
  assert.ok(c.calls.filter((k) => k === 'balance' || k === 'balance_all').length - k0 <= 4, 'one read each, no polling loop');
  // recovery while HALTED: one read after it books
  const inc = await incident({ settled: true }); assert.equal(inc.x.state, 'HALTED'); inc.c.breakdown = BD; inc.c.balance = 4242;
  const r = await inc.x.recoverTrades('test'); assert.ok(r.balanceRead && r.balanceRead.shardCents === 4242, JSON.stringify(r.balanceRead));
  assert.ok(balRows(inc.dir).some((q) => q.src === 'after recovery' && q.kind === 'shard' && q.cashCents === 4242)); assert.equal(inc.x.state, 'HALTED');
  assert.ok(balRows(inc.dir).some((q) => q.src === 'after recovery' && q.kind === 'all'));
  // during a 429 backoff the post-event read is skipped (never a halt)
  inc.x.postBo = { backoffUntil: inc.x.now() + 60000 }; const b = await inc.x.afterEventBalance('settle'); assert.equal(b.skipped, '429 backoff'); assert.equal(inc.x.state, 'HALTED');
});
