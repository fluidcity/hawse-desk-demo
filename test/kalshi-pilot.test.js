'use strict';
// Stage Z: Kalshi LIVE pilot (v3 7%, $150). Every exchange call here is a mock: zero real network.
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
  const c = { keyId: 'trade-kid', subaccount: null, lastSkewMs: 0, calls, balance: 10000, orders: [], fills: [], fillRatio: 1,
    async getBalance() { calls.push('balance'); return { balance: c.balance }; },
    async getApiKeys() { calls.push('api_keys'); return { api_keys: [{ api_key_id: 'trade-kid', scopes: ['read', 'write::trade'] }] }; },
    async createOrder(o) { R.validateOrder(o); calls.push(['create', o]); const id = 'oid-' + (++n), f = Math.floor(o.count * c.fillRatio);
      c.orders.push({ order_id: id, client_order_id: o.clientOrderId, status: 'executed', fill_count_fp: f.toFixed(2) });
      if (f) { c.fills.push({ fill_id: 'f-' + n, order_id: id, count_fp: f.toFixed(2), yes_price_dollars: (o.priceCents / 100 - 0.01).toFixed(4), fee_cost: '0.0300', is_taker: true }); c.balance -= f * (o.priceCents - 1) + 3; }
      return { order_id: id, client_order_id: o.clientOrderId, fill_count: f.toFixed(2), remaining_count: (o.count - f).toFixed(2) }; },
    async getFills({ orderId }) { calls.push('fills'); return { fills: c.fills.filter((x) => x.order_id === orderId) }; },
    async getOrders() { calls.push('orders'); return { orders: c.orders }; },
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
function pilot({ env = ENV_ON, client = fakeClient(), dir = tmp(), v = fakes(), file, pin, now } = {}) {
  const p = new P.KalshiPilot({ v1: v.v1, v3: v.v3, dir, killFile: path.join(dir, 'KILL'), env, client, file, pin, now, sleep: async () => {} });
  p.start(); p.stop(); return { p, client, dir, v };
}

test('frozen hashes: pilot config pinned; v1/v2/v3 unchanged; pilot follows v3 7pct with daily stop OFF by default', () => {
  assert.equal(sha('config/frozen/kalshi-live-pilot.json'), P.PILOT_SHA256);
  assert.equal(sha('config/frozen/kalshi-h2-v1.json'), '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c');
  assert.equal(sha('config/frozen/kalshi-h2-v2.json'), 'ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c');
  assert.equal(sha('config/frozen/kalshi-h2-v3.json'), '5498e1cbea6c45e427876dd2971f041421ef18ad06c103dc7921898f5179ce1c');
  assert.equal(CFG.perTradePct, 0.07); assert.equal(CFG.follows.line, '7pct'); assert.equal(CFG.bankrollCents, 15000);
  assert.equal(CFG.dailyLossStopCents, null); assert.equal(CFG.shrinkToDailyBudget, false);
  assert.equal(CFG.totalLossStopCents, 15000); assert.equal(CFG.maxOpenRiskCents, 15000); assert.equal(CFG.armPhrase, 'ARM LIVE $150'); assert.equal(CFG.order.maxPriceCents, 98);
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

test('sizing: 7% of the live bankroll ($10.50 at $150), price <= ask+1c and <= 98c, asset caps, 10% of volume, $150 total open risk', () => {
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

test('DISARMED = SHADOW: each v3 take logs a would-be order (no money) and sends nothing; non-take decisions are ignored', () => {
  const v = fakes(); const { p, client } = pilot({ v });
  assert.equal(p.state, 'DISARMED'); v.take();
  v.v3.rows.set('KXETH15M-B', { sig: { tk: 'KXETH15M-B', ya: 0.95, decision: 'skip' } }); for (const f of v.v1.rowListeners) f({ t: 'signal', tk: 'KXETH15M-B' });
  assert.equal(p.shadow.length, 1); assert.equal(p.shadow[0].noMoney, true); assert.equal(p.shadow[0].contracts, 11); assert.equal(p.shadow[0].limit, 96);
  assert.equal(client.calls.length, 0); assert.equal(p.snapshot().statusChip, 'DISARMED-SHADOW');
  v.line.orders.set(TK, { filled: 7, vwap: 0.955, unfilled: 0, fee: 0.03 }); const cmp = p.snapshot().compare[0]; assert.equal(cmp.paper.filled, 7); assert.equal(cmp.shadow.contracts, 11);
});

test('arm refused without the phrase, without the flag, on a failed preflight, while HALTED; armed state is never restored on restart', async () => {
  const dir = tmp(); const { p } = pilot({ dir });
  assert.equal((await p.arm('arm live $150')).ok, false); assert.equal((await p.arm('')).ok, false); assert.equal(p.state, 'DISARMED');
  const off = pilot({ env: { ...ENV_ON, LIVE_PILOT_ENABLED: 'false' } }).p; assert.equal((await off.arm('ARM LIVE $150')).ok, false); assert.equal(off.state, 'DISABLED');
  const bad = pilot({ client: fakeClient({ async getApiKeys() { return { api_keys: [{ api_key_id: 'trade-kid', scopes: ['read'] }] }; } }) }).p;
  const r = await bad.arm('ARM LIVE $150'); assert.equal(r.ok, false); assert.match(r.error, /this key can't trade, make a read\+trade key/);
  const skew = pilot({ client: fakeClient({ lastSkewMs: 9000 }) }).p; assert.equal((await skew.arm('ARM LIVE $150')).ok, false);
  assert.equal((await p.arm('ARM LIVE $150')).ok, true); assert.equal(p.state, 'ARMED');
  const again = pilot({ dir }).p; assert.equal(again.state, 'DISARMED', 'restart comes back DISARMED');
  await again.halt('test'); assert.equal((await again.arm('ARM LIVE $150')).ok, false);
  assert.equal(pilot({ dir }).p.state, 'HALTED', 'HALTED survives a restart');
});

test('armed: IOC slices, intent persisted before send, partial fill -> next slice, real fees from fills, balance before/after; hold to settlement', async () => {
  const v = fakes(), client = fakeClient({ fillRatio: 0.5 }); const { p, dir } = pilot({ v, client });
  assert.ok((await p.arm('ARM LIVE $150')).ok); v.take(); await p.signals.get(TK).run;
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
  const v = fakes({ close: Date.now() + 120000 }), client = fakeClient(); const { p } = pilot({ v, client }); await p.arm('ARM LIVE $150'); v.take(); await p.signals.get(TK).run;
  assert.equal(client.calls.filter((c) => c[0] === 'create').length, 0);
});

test('HALT cancels the pilot\'s own resting orders (never others) and blocks; kill file halts', async () => {
  const v = fakes(), client = fakeClient(); const { p, dir } = pilot({ v, client }); await p.arm('ARM LIVE $150'); v.take(); await p.signals.get(TK).run;
  client.orders.push({ order_id: 'rest-1', client_order_id: 'hp1-' + TK + '-s9', status: 'resting' }, { order_id: 'mine-manual', client_order_id: 'bryan-1', status: 'resting' });
  await p.halt('HALT button'); assert.equal(p.state, 'HALTED');
  const cancels = client.calls.filter((c) => c[0] === 'cancel').map((c) => c[1]); assert.deepEqual(cancels, ['rest-1']);
  v.take('KXETH15M-C'); assert.equal(client.calls.filter((c) => c[0] === 'create').length, 1, 'nothing new after HALT');
  const k = pilot({ client: fakeClient() }); await k.p.arm('ARM LIVE $150'); fs.writeFileSync(path.join(k.dir, 'KILL'), ''); k.p.tick(); assert.equal(k.p.state, 'HALTED'); assert.match(k.p.haltReason, /kill file/);
  void dir;
});

test('auto-HALT: auth failure, repeated API errors, unreconciled fills, balance mismatch, exception in the order path', async () => {
  const err = (s) => Object.assign(new Error('x'), { status: s });
  let v = fakes(), c = fakeClient({ async createOrder() { throw err(401); } }), x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run; assert.equal(x.state, 'HALTED');
  v = fakes(); c = fakeClient({ async createOrder() { throw err(503); } }); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /without a clear answer/);
  v = fakes(); c = fakeClient(); c.getFills = async () => ({ fills: [] }); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /unreconciled/);
  v = fakes(); c = fakeClient({ subaccount: 3 }); const cg = c.getBalance; let k = 0; c.getBalance = async () => (k++ ? { balance: 5000 } : cg()); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /balance mismatch/);
  v = fakes(); c = fakeClient({ async createOrder() { return null; } }); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run; assert.equal(x.state, 'HALTED');
  x = pilot({ client: fakeClient() }).p; for (let i = 0; i < 3; i++) x.apiError(err(500)); assert.match(x.haltReason, /3 Kalshi API errors/);
});

test('idempotent restart: an intent sent before a crash is reconciled by client_order_id and never re-sent', async () => {
  const dir = tmp(), v = fakes(), c1 = fakeClient(); c1.getFills = () => new Promise(() => {}); // crash after the order went out
  const a = pilot({ dir, v, client: c1 }).p; await a.arm('ARM LIVE $150'); v.take(); await new Promise((r) => setImmediate(r));
  assert.equal(c1.calls.filter((c) => c[0] === 'create').length, 1);
  const rows = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); fs.writeFileSync(path.join(dir, 'ledger.jsonl'), rows.filter((r) => r.t !== 'ack' && r.t !== 'cancel').map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c2 = fakeClient(); c2.orders = c1.orders; c2.fills = c1.fills; const v2 = fakes(); const b = pilot({ dir, v: v2, client: c2 }).p; await b.startupReconcile;
  assert.equal(b.state, 'DISARMED'); assert.equal(c2.calls.filter((c) => c[0] === 'create').length, 0); assert.equal(b.signals.get(TK).filled, 7);
  assert.ok(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').includes('"t":"reconciled"'));
  await b.arm('ARM LIVE $150'); v2.take(); await new Promise((r) => setImmediate(r)); assert.equal(c2.calls.filter((c) => c[0] === 'create').length, 0, 'the same market is never traded twice');
  const d2 = tmp(); fs.writeFileSync(path.join(d2, 'ledger.jsonl'), rows.filter((r) => r.t === 'order_intent').map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c3 = new P.KalshiPilot({ dir: d2, env: {} }); c3.start(); await c3.startupReconcile; assert.equal(c3.state, 'DISABLED');
});

test('total loss stop ($150) halts permanently: reset needs the manual file AND the phrase on localhost', async () => {
  const { p, dir } = pilot(); p.write({ t: 'settle', tk: 'KXBTC15M-Y', pnlMicros: -100e6 }); p.checkStops(); assert.equal(p.state, 'DISARMED', '$100 lost is not yet the $150 stop');
  p.write({ t: 'settle', tk: 'KXBTC15M-Z', pnlMicros: -50e6 }); p.checkStops();
  assert.equal(p.state, 'HALTED'); assert.equal(p.totalStop, true);
  assert.equal(p.reset('RESET PILOT').ok, false, 'needs the reset file'); fs.writeFileSync(path.join(dir, 'RESET_TOTAL_STOP'), '');
  assert.equal(p.reset('nope').ok, false); assert.equal(p.reset('RESET PILOT').ok, true); assert.equal(p.state, 'DISARMED'); assert.ok(!fs.existsSync(path.join(dir, 'RESET_TOTAL_STOP')));
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
  const { p } = pilot({ file: on.file, pin: on.pin }); await p.arm('ARM LIVE $150'); p.write({ t: 'settle', tk: 'KXBTC15M-W', pnlMicros: -10e6 }); p.checkStops();
  assert.equal(p.state, 'HALTED'); assert.match(p.haltReason, /daily loss stop/); assert.equal((await p.arm('ARM LIVE $150')).ok, false);
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
    assert.equal((await post('/api/live/kalshi-pilot/arm', { phrase: 'ARM LIVE $150' }, { 'x-forwarded-for': '100.64.1.2' }))[0], 403);
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

test('card: HALT always visible, ARM only on this machine, "Daily stop: OFF", SHADOW rows say NO MONEY; Scoreboard LIVE chip is separate from paper', () => {
  const UI = require('../public/pilot.js'), SB = require('../public/scoreboard.js');
  const v = fakes(); const { p } = pilot({ v }); v.take(); const snap = p.snapshot();
  assert.equal(snap.title, 'LIVE · REAL MONEY · Kalshi pilot (v3 7%, $150)');
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
  await p.arm('ARM LIVE $150'); v.take(); await p.signals.get(TK).run;
  assert.equal(p.state, 'ARMED', p.haltReason); assert.equal(c.calls.filter((x) => x[0] === 'create').length, 3);
});

test('layout: the live pilot card (HALT) can be moved but never hidden, even by a saved/imported layout', () => {
  const L = require('../public/layout.js'); const D = ['kalshi-live-pilot', 'scoreboard', 'tape'];
  const s = L.normalize({ order: ['tape', 'kalshi-live-pilot', 'scoreboard'], hidden: ['kalshi-live-pilot', 'tape'] }, D);
  assert.deepEqual(s.hidden, ['tape']); assert.equal(s.order.indexOf('kalshi-live-pilot'), 1);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'); assert.match(html, /data-card-id="kalshi-live-pilot"/); assert.match(html, /<script src="pilot.js"><\/script>/);
});

test('$150 hard bankroll cap: a bigger main account still counts $150; a smaller one counts only what is there', () => {
  const big = pilot({ client: fakeClient({ balance: 40000 }) }).p; big.balanceCents = 40000; assert.equal(big.bankrollCents(), 15000, '$400 in the account -> $150 bankroll');
  assert.equal(big.plan({ tk: TK, decisionAsk: 95, limit: 96 }, 0, 1000).perTradeCents, 1050, '7% of $150 = $10.50, not 7% of $400');
  const small = pilot().p; small.balanceCents = 9000; assert.equal(small.bankrollCents(), 9000, '$90 in the account -> $90 bankroll');
  assert.equal(small.plan({ tk: TK, decisionAsk: 95, limit: 96 }, 0, 1000).perTradeCents, 630);
  big.write({ t: 'settle', tk: 'KXBTC15M-Q', pnlMicros: 20e6 }); assert.equal(big.bankrollCents(), 17000, 'realized pilot P&L moves the cap, other account money never does');
  big.write({ t: 'settle', tk: 'KXBTC15M-R', pnlMicros: -40e6 }); assert.equal(big.bankrollCents(), 13000);
});

test('main account (no subaccount): unrelated balance moves never halt; only the pilot\'s own fills are checked; preflight needs one trade of cash', async () => {
  // between the pre-slice balance and the after-slice balance Bryan's other trading moves the account by -$37.12: no halt
  let v = fakes(), c = fakeClient({ balance: 40000 }), cg = c.getBalance, k = 0; c.getBalance = async () => { const b = await cg(); return k++ >= 2 ? { balance: b.balance - 3712 } : b; };
  let x = pilot({ v, client: c }).p; assert.ok((await x.arm('ARM LIVE $150')).ok); v.take(); await x.signals.get(TK).run;
  assert.equal(x.state, 'ARMED', x.haltReason); assert.equal(x.signals.get(TK).filled, 11); assert.equal(x.snapshot().mainAccount, true);
  // a pilot fill above its own limit is still caught
  v = fakes(); c = fakeClient(); const co = c.createOrder; c.createOrder = async (o) => { const r = await co(o); c.fills[c.fills.length - 1].yes_price_dollars = '0.9900'; return r; };
  x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run; assert.match(x.haltReason, /above the 96c limit/);
  // settlement revenue that includes Bryan's own positions in the same market (more than the pilot's payout) is not a mismatch; less is
  v = fakes(); c = fakeClient(); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run;
  c.settled = 7 * 100 + 500; await x.onV1Row({ t: 'settle', tk: TK, win: true, result: 'yes' }); assert.equal(x.state, 'ARMED', x.haltReason); assert.ok(x.signals.get(TK).settle);
  // preflight: a zero balance cannot cover a trade
  x = pilot({ client: fakeClient({ balance: 0 }) }).p; const r = await x.arm('ARM LIVE $150'); assert.equal(r.ok, false); assert.match(r.error, /balance/);
  // other orders on the account are never cancelled
  v = fakes(); c = fakeClient(); x = pilot({ v, client: c }).p; await x.arm('ARM LIVE $150'); v.take(); await x.signals.get(TK).run;
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
    const { p, dir } = pilot({ v, client: c }); await p.arm('ARM LIVE $150'); const before = c.calls.length; v.take(); await p.signals.get(TK).run;
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
  for (const f of ['server/live/kalshi-pilot.js', 'server/live/kalshi-rest.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); assert.ok(!/WebSocket|wss?:\/\/|\bws-sign\b|recorder\/kalshi-ws/.test(code), f + ' must not use a websocket');
    assert.deepEqual([...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).filter((m) => !['fs', 'path', 'crypto', './kalshi-rest'].includes(m)), [], f + ' requires only fs/path/crypto/the REST client');
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
