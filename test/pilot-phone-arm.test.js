'use strict';
// Arm / reset / disarm the live pilot from Bryan's phone over the tailnet: tailscale serve -> auth proxy (signs) -> desk (verifies).
// Every exchange call is a mock; the signing key is a throwaway per test. Zero real network beyond 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const P = require('../server/live/kalshi-pilot');
const L = require('../server/lib/pilot-link');
const proxyMod = require('../scripts/auth-proxy');
const { createServer, pilotGate } = require('../server/server');
const UI = require('../public/pilot');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const PEM = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV_ON = { LIVE_PILOT_ENABLED: 'true', KALSHI_TRADE_KEY_ID: 'trade-kid', KALSHI_TRADE_PRIVATE_KEY_PEM: PEM };
const TOKEN = 'pHoNe-' + 'y'.repeat(19) + '-proxy-0123456789';
const KEY = crypto.randomBytes(32).toString('hex');
const LOGIN = 'bryan@example.com';

function fakeClient() {
  const calls = [];
  const c = { keyId: 'trade-kid', subaccount: null, lastSkewMs: 0, calls, balance: 10000, failBalance: false,
    async getBalance(o = {}) { calls.push(o.exchangeIndex == null ? 'balance_all' : 'balance'); if (c.failBalance) throw new Error('HTTP 503'); return { balance: c.balance, portfolio_value: 0 }; },
    async getDeposits() { return { deposits: [] }; },
    async getApiKeys() { return { api_keys: [{ api_key_id: 'trade-kid', scopes: ['read', 'write::trade'] }] }; },
    async getOrders() { return { orders: [] }; }, async getFills() { return { fills: [] }; }, async getSettlements() { return { settlements: [] }; },
    async createOrder() { throw new Error('no orders in these tests'); }, async cancelOrder() { throw new Error('no cancels'); } };
  return c;
}
function pilot({ now } = {}) {
  const dir = tmp(), client = fakeClient();
  const v1 = { rowListeners: [] }, v3 = { rows: new Map(), lines: [{ id: '3pct', orders: new Map() }, { id: '7pct', orders: new Map() }], volumeAt: () => ({ vol: 1000, known: true }) };
  const p = new P.KalshiPilot({ v1, v3, dir, killFile: path.join(dir, 'KILL'), env: ENV_ON, client, now, sleep: async () => {} });
  p.start(); p.stop(); return { p, client, dir };
}
const rows = (p) => fs.readFileSync(p.ledgerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(() => r()); });
function call(port, p, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? (method === 'POST' ? '{}' : '') : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { j = d; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
/** Headers exactly as the proxy would set them for a phone request. */
const signed = (url, body, { key = KEY, login = LOGIN, allow = ['pilot-arm', 'pilot-reset', 'pilot-disarm'], now = Date.now(), method = 'POST' } = {}) =>
  L.signHeaders(key, { method, url, login, allow, body: typeof body === 'string' ? body : JSON.stringify(body), now });

// ---------------------------------------------------------------------------------------------------------------------------
test('link signing: valid signature verifies; every tamper / replay / stale / non-loopback / non-JSON case is refused', () => {
  let t = 1_800_000_000_000; const v = L.createVerifier({ key: KEY, now: () => t });
  const body = JSON.stringify({ phrase: 'ARM LIVE' }), url = '/api/live/kalshi-pilot/arm';
  const rq = (h, remote = '127.0.0.1', ct = 'application/json') => ({ method: 'POST', url, socket: { remoteAddress: remote }, headers: { 'content-type': ct, ...h } });
  const h = signed(url, body, { now: t });
  for (const k of Object.values(h)) assert.ok(!String(k).includes(KEY), 'the key never appears in a header');
  const ok = v(rq(h), body); assert.equal(ok.ok, true, ok.why); assert.equal(ok.login, LOGIN); assert.deepEqual(ok.allow, ['pilot-arm', 'pilot-reset', 'pilot-disarm']);
  assert.match(v(rq(h), body).why, /replay/, 'same nonce twice');
  const fresh = () => signed(url, body, { now: t });
  assert.match(v(rq(fresh()), JSON.stringify({ phrase: 'ARM LIVE', x: 1 })).why, /body/);
  assert.match(v({ ...rq(fresh()), url: '/api/live/kalshi-pilot/transfer-confirm' }, body).why, /signature/);
  assert.match(v({ ...rq(fresh()), method: 'PUT' }, body).why, /signature/);
  assert.match(v(rq(fresh(), '100.64.1.2'), body).why, /loopback/);
  assert.match(v(rq(fresh(), '::ffff:192.168.1.9'), body).why, /loopback/);
  assert.match(v(rq(fresh(), '127.0.0.1', 'text/plain'), body).why, /application\/json/);
  assert.match(v(rq({ ...fresh(), [L.HDR.login]: Buffer.from('mallory@evil.com').toString('base64url') }), body).why, /signature/, 'swapped login');
  assert.match(v(rq({ ...fresh(), [L.HDR.allow]: 'pilot-arm,pilot-reset,pilot-disarm,transfer' }), body).why, /signature/, 'widened allow');
  assert.match(v(rq({ ...fresh(), [L.HDR.sig]: 'ab'.repeat(32) }), body).why, /signature/, 'forged sig');
  assert.match(v(rq(signed(url, body, { key: crypto.randomBytes(32).toString('hex'), now: t })), body).why, /signature/, 'wrong key');
  assert.match(v(rq(signed(url, body, { now: t - 31_000 })), body).why, /stale|time/);
  assert.match(v(rq(signed(url, body, { now: t + 31_000 })), body).why, /stale|time/);
  for (const k of Object.values(L.HDR)) { const x = fresh(); delete x[k]; assert.equal(v(rq(x), body).ok, false, 'missing ' + k); }
  assert.match(v(rq({}), body).why, /missing/);
  assert.match(L.createVerifier({ key: null, now: () => t })(rq(fresh()), body).why, /key/, 'no key on the desk -> refuse');
  // nonce memory is bounded and forgets after the window
  const v2 = L.createVerifier({ key: KEY, now: () => t }); for (let i = 0; i < 3000; i++) v2(rq(fresh()), body); assert.ok(v2.nonceCount() <= 2048);
  t += 61_000; v2(rq(fresh()), body); assert.ok(v2.nonceCount() <= 2);
});

test('link key: auto-generated per desk start, 0600, re-read by the proxy; env override wins; never logged', () => {
  const d = tmp(), file = path.join(d, 'runtime', 'pilot-link.key'), logs = [];
  const k1 = L.ensureKey({ env: {}, file, log: (m) => logs.push(m) });
  assert.match(k1, /^[0-9a-f]{64}$/); assert.equal(fs.readFileSync(file, 'utf8').trim(), k1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(L.readKey({ env: {}, file }), k1);
  const k2 = L.ensureKey({ env: {}, file, log: (m) => logs.push(m) }); assert.notEqual(k2, k1, 'new key every start'); assert.equal(L.readKey({ env: {}, file }), k2);
  assert.ok(!logs.join('\n').includes(k1) && !logs.join('\n').includes(k2), 'key never logged');
  const E = 'e'.repeat(64); assert.equal(L.ensureKey({ env: { HAWSE_PILOT_LINK_KEY: E }, file: path.join(d, 'x.key') }), E); assert.equal(L.readKey({ env: { HAWSE_PILOT_LINK_KEY: E }, file: path.join(d, 'none') }), E);
  assert.throws(() => L.ensureKey({ env: { HAWSE_PILOT_LINK_KEY: 'short' }, file }), /at least 32/);
  assert.equal(L.readKey({ env: {}, file: path.join(d, 'missing.key') }), null);
  assert.ok(L.KEY_FILE.includes(path.join('data', 'runtime')), 'under data/ (gitignored)');
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').some((l) => /^\/?data\/?$/.test(l.trim())), '/data is gitignored');
});

test('desk gate: PC path unchanged; signed phone requests only for arm-check/arm/reset/disarm; forged or direct requests refused', () => {
  const v = L.createVerifier({ key: KEY });
  const rq = (url, h = {}, remote = '127.0.0.1') => ({ method: 'POST', url, socket: { remoteAddress: remote }, headers: { host: '127.0.0.1:8788', 'content-type': 'application/json', ...h } });
  const g = (url, h, remote, raw = '{}') => pilotGate(rq(url, h, remote), raw, v);
  assert.deepEqual(g('/api/live/kalshi-pilot/arm'), { ok: true, source: 'pc' });
  assert.equal(g('/api/live/kalshi-pilot/arm', {}, '100.64.1.2').ok, false);
  assert.equal(g('/api/live/kalshi-pilot/arm', { 'x-forwarded-for': '100.64.1.2' }).ok, false, 'forwarded, unsigned');
  assert.equal(g('/api/live/kalshi-pilot/arm', { 'tailscale-user-login': LOGIN }).ok, false, 'tailscale header alone is not enough');
  assert.equal(g('/api/live/kalshi-pilot/arm', { 'x-forwarded-for': '100.64.1.2', 'tailscale-user-login': LOGIN, [L.HDR.sig]: 'ab'.repeat(32) }).ok, false, 'forged signature');
  for (const w of ['arm-check', 'arm', 'reset', 'disarm']) {
    const url = '/api/live/kalshi-pilot/' + w, r = g(url, { 'x-forwarded-for': '100.64.1.2', ...signed(url, '{}') });
    assert.deepEqual([r.ok, r.source, r.login], [true, 'phone', LOGIN], w);
  }
  for (const w of ['transfer-prepare', 'transfer-confirm', 'transfer-cancel', 'test-key', 'recover']) {
    const url = '/api/live/kalshi-pilot/' + w; assert.equal(g(url, { 'x-forwarded-for': '100.64.1.2', ...signed(url, '{}') }).ok, false, w + ' stays PC-only even when validly signed');
  }
  const url = '/api/live/kalshi-pilot/reset';
  assert.equal(g(url, { 'x-forwarded-for': '1.2.3.4', ...signed(url, '{}', { allow: ['pilot-arm'] }) }).ok, false, 'reset not in the signed allowlist');
  assert.equal(g(url, { 'x-forwarded-for': '1.2.3.4', ...signed(url, '{}') }, '100.64.1.2').ok, false, 'signed but non-loopback peer');
});

test('pilot: arm-check reads shard 2 fresh; phone arm needs a recent check + the phrase; src logged on arm/disarm/reset; never restored', async () => {
  let t = Date.now(); const { p, client, dir } = pilot({ now: () => t });
  const phone = { source: 'phone', login: LOGIN };
  assert.equal((await p.arm('ARM LIVE', phone)).ok, false, 'phone arm without a confirm step');
  assert.match((await p.arm('ARM LIVE', { ...phone, checkId: 'nope' })).error, /confirm|check/i);
  const n0 = client.calls.filter((c) => c === 'balance').length;
  const c = await p.armCheck(phone);
  assert.equal(c.ok, true, c.error); assert.equal(client.calls.filter((x) => x === 'balance').length, n0 + 1, 'fresh shard read at confirm time');
  assert.equal(c.balanceCents, 10000); assert.equal(c.exchangeIndex, 2); assert.equal(c.readAt, t); assert.equal(c.perTradeCents, 700, '7% of shard 2 cash');
  assert.match(c.sizing, /7%/); assert.match(c.sizing, /10%/); assert.match(c.source, /phone over Tailscale/); assert.match(c.checkId, /^[0-9a-f]{32}$/);
  assert.equal((await p.arm('arm live', { ...phone, checkId: c.checkId })).ok, false, 'phrase still exact'); assert.equal(p.state, 'DISARMED');
  t += 121_000; assert.match((await p.arm('ARM LIVE', { ...phone, checkId: c.checkId })).error, /expired|again/i, 'confirm step goes stale after 2 min');
  const c2 = await p.armCheck(phone); const n1 = client.calls.filter((x) => x === 'balance').length;
  const a = await p.arm('ARM LIVE', { ...phone, checkId: c2.checkId }); assert.equal(a.ok, true, a.error); assert.equal(p.state, 'ARMED');
  assert.ok(client.calls.filter((x) => x === 'balance').length > n1, 'arm still runs its own fresh preflight read');
  const ar = rows(p).filter((r) => r.t === 'arm').pop(); assert.equal(ar.source, 'phone'); assert.equal(ar.login, LOGIN);
  assert.ok(!JSON.stringify(rows(p)).includes(KEY) && !JSON.stringify(rows(p)).includes(PEM.slice(40, 80)), 'no secrets in the ledger');
  const s = p.snapshot(); assert.deepEqual([s.control.armed.source, s.control.armed.login, s.control.armed.at], ['phone', LOGIN, t]);
  assert.equal((await p.arm('ARM LIVE', { ...phone, checkId: c2.checkId })).ok, true, 'already armed is a no-op ok');
  p.disarm(phone); assert.equal(rows(p).filter((r) => r.t === 'disarm').pop().source, 'phone'); assert.equal(p.snapshot().control.armed, null); assert.equal(p.snapshot().control.last.t, 'disarm');
  // HALTED needs RESET PILOT first, from either source
  await p.halt('test'); assert.equal(p.state, 'HALTED');
  assert.match((await p.armCheck(phone)).error, /RESET PILOT|halted/i);
  assert.equal(p.reset('reset pilot', phone).ok, false);
  assert.equal(p.reset('RESET PILOT', phone).ok, true); const rr = rows(p).filter((r) => r.t === 'reset').pop(); assert.deepEqual([rr.source, rr.login], ['phone', LOGIN]);
  // PC path unchanged: no confirm step required, logged as pc
  const pc = await p.arm('ARM LIVE'); assert.equal(pc.ok, true, pc.error); assert.equal(rows(p).filter((r) => r.t === 'arm').pop().source, 'pc');
  // restart: armed state is NOT restored; last control is shown as history only
  const p2 = new P.KalshiPilot({ v1: { rowListeners: [] }, v3: { rows: new Map(), lines: [{ id: '7pct', orders: new Map() }], volumeAt: () => ({ vol: 1, known: true }) }, dir, killFile: path.join(dir, 'KILL'), env: ENV_ON, client: fakeClient(), now: () => t, sleep: async () => {} });
  p2.start(); p2.stop(); assert.equal(p2.state, 'DISARMED'); assert.equal(p2.snapshot().control.armed, null); assert.equal(p2.snapshot().control.last.source, 'pc');
});

test('pilot: arm-check refuses $0, unreadable, disabled, killed; check is single-use', async () => {
  const { p, client, dir } = pilot();
  client.balance = 0; assert.match((await p.armCheck({ source: 'phone' })).error, /\$0/);
  client.balance = 5000; client.failBalance = true; assert.match((await p.armCheck({ source: 'phone' })).error, /unreadable|could not read/i);
  client.failBalance = false; const c = await p.armCheck({ source: 'phone', login: LOGIN }); assert.equal(c.ok, true);
  client.balance = 0; assert.equal((await p.arm('ARM LIVE', { source: 'phone', checkId: c.checkId })).ok, false, 'arm re-reads: $0 at arm time still refuses');
  client.balance = 5000; assert.match((await p.arm('ARM LIVE', { source: 'phone', checkId: c.checkId })).error, /confirm|check/i, 'a check id works once');
  fs.writeFileSync(path.join(dir, 'KILL'), ''); assert.equal((await p.armCheck({ source: 'phone' })).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------------------
async function rig({ allow = 'pilot-halt,pilot-arm,pilot-reset,pilot-disarm', logins, linkKey = () => KEY, deskKey = KEY } = {}) {
  const { p, client } = pilot();
  const desk = createServer({ kalshiPilot: p, routes: [] }, {}, { linkKey: deskKey }); const dport = await listen(desk);
  const env = { HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${dport}`, HAWSE_PROXY_ALLOW_POST: allow }; if (logins) env.HAWSE_PROXY_PILOT_LOGINS = logins;
  const logs = []; const px = proxyMod.createProxy(proxyMod.config(env), { log: (m) => logs.push(m), linkKey }); const pport = await listen(px);
  const ts = { authorization: 'Bearer ' + TOKEN, 'tailscale-user-login': LOGIN, 'tailscale-user-name': 'Bryan', origin: `http://127.0.0.1:${pport}` };
  return { p, client, desk, px, dport, pport, ts, logs, done: async () => { await close(px); await close(desk); } };
}

test('proxy -> desk end-to-end: phone (tailscale identity + token) can check, arm, disarm, reset; source shown on the card', async () => {
  const r = await rig(); const A = '/api/live/kalshi-pilot/';
  try {
    const link = await call(r.pport, A + 'link', { method: 'GET', headers: r.ts }); assert.equal(link.status, 200);
    assert.deepEqual([link.body.source, link.body.login], ['phone', LOGIN]); assert.deepEqual(link.body.can.sort(), ['arm', 'disarm', 'reset']);
    const c = await call(r.pport, A + 'arm-check', { headers: r.ts }); assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.balanceCents, 10000);
    const a = await call(r.pport, A + 'arm', { headers: r.ts, body: { phrase: 'ARM LIVE', checkId: c.body.checkId } }); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(r.p.state, 'ARMED');
    assert.deepEqual([r.p.snapshot().control.armed.source, r.p.snapshot().control.armed.login], ['phone', LOGIN]);
    assert.equal((await call(r.pport, A + 'disarm', { headers: r.ts })).status, 200); assert.equal(r.p.state, 'DISARMED');
    assert.equal((await call(r.pport, A + 'halt', { headers: r.ts })).status, 200); assert.equal(r.p.state, 'HALTED', 'halt still forwardable');
    assert.equal((await call(r.pport, A + 'reset', { headers: r.ts, body: { phrase: 'RESET PILOT' } })).status, 200); assert.equal(r.p.state, 'DISARMED');
    assert.equal(rows(r.p).filter((x) => x.t === 'reset').pop().source, 'phone');
    const all = r.logs.join('\n'); assert.ok(!all.includes(KEY) && !all.includes(TOKEN), 'no key / token in proxy logs');
    for (const v of [link, c, a]) assert.ok(!JSON.stringify(v.body).includes(KEY), 'no key to the client');
  } finally { await r.done(); }
});

test('proxy -> desk: forged / missing identity, funnel, no token, non-JSON, wrong login, missing key, PC-only routes are all refused', async () => {
  const r = await rig({ logins: LOGIN + ',other@example.com' }); const A = '/api/live/kalshi-pilot/';
  const st = async (what, headers, body, x = {}) => (await call(r.pport, A + what, { headers, body, ...x })).status;
  try {
    const { authorization, ...noTok } = r.ts;
    assert.equal(await st('arm-check', noTok), 401, 'no token');
    assert.equal(await st('arm-check', { ...r.ts, authorization: 'Bearer ' + 'z'.repeat(40) }), 401, 'bad token');
    const { 'tailscale-user-login': _l, ...noTs } = r.ts;
    assert.equal(await st('arm-check', noTs), 403, 'no tailscale identity (e.g. Funnel or tagged node)');
    assert.equal(await st('arm-check', { ...r.ts, 'tailscale-user-login': '' }), 403, 'empty identity');
    assert.equal(await st('arm-check', { ...r.ts, 'tailscale-funnel-request': '?1' }), 403, 'funnel');
    assert.equal(await st('arm-check', { ...r.ts, 'tailscale-user-login': 'mallory@example.com' }), 403, 'not in HAWSE_PROXY_PILOT_LOGINS');
    assert.equal(await st('arm-check', { ...r.ts, 'content-type': 'text/plain' }, '{}'), 415, 'non-JSON replay');
    assert.equal(await st('arm-check', { ...r.ts, origin: 'https://evil.example' }), 403, 'cross-origin');
    // client-supplied signing headers are stripped: a forged / replayed signature never reaches the desk
    const forged = signed(A + 'arm', JSON.stringify({ phrase: 'ARM LIVE' }));
    assert.equal(await st('arm', { ...noTs, ...forged }, { phrase: 'ARM LIVE' }), 403);
    for (const w of ['transfer-prepare', 'transfer-confirm', 'transfer-cancel', 'test-key', 'recover']) assert.equal(await st(w, r.ts), 403, w + ' stays PC-only');
    assert.equal(r.p.state, 'DISARMED');
    // direct to the desk with forged phone headers (bypassing the proxy): refused
    const d = await call(r.dport, A + 'arm', { headers: { 'x-forwarded-for': '100.64.1.2', 'tailscale-user-login': LOGIN, ...signed(A + 'arm', '{"phrase":"x"}') }, body: { phrase: 'ARM LIVE' } });
    assert.equal(d.status, 403, 'body does not match the signature');
    assert.equal(r.p.state, 'DISARMED');
  } finally { await r.done(); }
  const nk = await rig({ linkKey: () => null });
  try { assert.equal((await call(nk.pport, A + 'arm-check', { headers: nk.ts })).status, 503, 'desk key missing -> 503, nothing forwarded'); } finally { await nk.done(); }
  const off = await rig({ allow: 'pilot-halt' });
  try {
    assert.equal((await call(off.pport, A + 'arm-check', { headers: off.ts })).status, 403, 'not opted in via HAWSE_PROXY_ALLOW_POST');
    const link = await call(off.pport, A + 'link', { method: 'GET', headers: off.ts }); assert.deepEqual(link.body.can, []);
  } finally { await off.done(); }
  const wrongKey = await rig({ linkKey: () => 'f'.repeat(64) });
  try { assert.equal((await call(wrongKey.pport, A + 'arm-check', { headers: wrongKey.ts })).status, 403, 'proxy key != desk key'); } finally { await wrongKey.done(); }
});

test('proxy unit: phone eligibility needs a loopback peer (tailscale serve) and a Tailscale login; policy unchanged without it', () => {
  const cfg = proxyMod.config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_ALLOW_POST: 'pilot-arm,pilot-reset,pilot-disarm' });
  const rq = (remote, h) => ({ socket: { remoteAddress: remote }, headers: h });
  assert.equal(proxyMod.phoneIdentity(rq('127.0.0.1', { 'tailscale-user-login': LOGIN }), cfg).ok, true);
  assert.match(proxyMod.phoneIdentity(rq('192.168.1.20', { 'tailscale-user-login': LOGIN }), cfg).why, /loopback/);
  assert.match(proxyMod.phoneIdentity(rq('127.0.0.1', {}), cfg).why, /Tailscale/);
  assert.match(proxyMod.phoneIdentity(rq('127.0.0.1', { 'tailscale-user-login': LOGIN, 'tailscale-funnel-request': '?1' }), cfg).why, /Funnel/);
  for (const w of ['arm', 'arm-check', 'reset', 'disarm']) {
    assert.equal(proxyMod.policy('POST', '/api/live/kalshi-pilot/' + w, cfg.allowPost)[0], 403, w + ' without phone identity');
    assert.equal(proxyMod.policy('POST', '/api/live/kalshi-pilot/' + w, cfg.allowPost, { phone: true }), null, w + ' with phone identity');
    assert.equal(proxyMod.policy('POST', '/api/live/kalshi-pilot/' + w, ['pilot-halt'], { phone: true })[0], 403, w + ' not opted in');
  }
  for (const w of ['transfer-prepare', 'test-key', 'recover', 'anything']) assert.equal(proxyMod.policy('POST', '/api/live/kalshi-pilot/' + w, Object.keys(proxyMod.POST_ROUTES), { phone: true })[0], 403, w);
  assert.equal(proxyMod.config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_PILOT_LOGINS: ' A@x.com , b@y.com ' }).pilotLogins.join(), 'a@x.com,b@y.com');
});

test('phone UI: confirm step shows shard 2 cash + read time, next trade size, sizing rules, source; phrase box only after the check', () => {
  const snap = { statusChip: 'DISARMED-SHADOW', state: 'DISARMED', enabled: true, config: { armPhrase: 'ARM LIVE', resetPhrase: 'RESET PILOT', balanceExchangeIndex: 2, perTradePct: 0.07 }, money: {}, control: { armed: null, last: null } };
  const link = { source: 'phone', login: LOGIN, can: ['arm', 'reset', 'disarm'] };
  let h = UI.render(snap, { local: false, link });
  assert.match(h, /data-pilot="arm-check"/); assert.ok(!/data-pilot="phrase"/.test(h), 'no phrase box before the fresh read'); assert.ok(!/data-pilot="xfer-/.test(h) && !/data-pilot="test-key"/.test(h), 'transfers / test key not on the phone');
  const at = new Date(2026, 10, 1, 14, 5).getTime();
  h = UI.render(snap, { local: false, link, armCheck: { ok: true, checkId: 'c'.repeat(32), balanceCents: 12345, readAt: at, exchangeIndex: 2, perTradeCents: 864, sizing: '7% of shard 2 cash; at most 10% of visible volume', source: 'from phone over Tailscale (bryan@example.com)' }, now: at + 5000 });
  assert.match(h, /\$123\.45/); assert.match(h, /14:05/); assert.match(h, /\$8\.64/); assert.match(h, /10% of visible volume/); assert.match(h, /from phone over Tailscale/);
  assert.match(h, /data-pilot="phrase"/); assert.match(h, /data-pilot="arm-phone"/); assert.match(h, /pl-phone/);
  h = UI.render(snap, { local: false, link, armCheck: { ok: true, checkId: 'c'.repeat(32), balanceCents: 12345, readAt: at, perTradeCents: 864, sizing: 'x', source: 'from phone over Tailscale' }, now: at + 121_000 });
  assert.ok(!/data-pilot="phrase"/.test(h), 'stale read: no phrase box'); assert.match(h, /older than 2 min|check again/i);
  h = UI.render(snap, { local: false, link, armCheck: { ok: false, error: 'shard 2 cash is $0' } }); assert.match(h, /shard 2 cash is \$0/); assert.ok(!/data-pilot="phrase"/.test(h));
  h = UI.render({ ...snap, statusChip: 'ARMED', state: 'ARMED', control: { armed: { source: 'phone', login: LOGIN, at } } }, { local: false, link });
  assert.match(h, /armed from phone at 14:05/); assert.match(h, /data-pilot="disarm"/);
  h = UI.render({ ...snap, statusChip: 'HALTED', state: 'HALTED' }, { local: false, link }); assert.match(h, /data-pilot="reset-phrase"/);
  h = UI.render(snap, { local: false }); assert.match(h, /this link can HALT only/, 'no phone link -> halt only, as before');
  h = UI.render(snap, { local: true }); assert.match(h, /data-pilot="arm"/); assert.ok(!/arm-check/.test(h), 'PC flow unchanged');
  const css = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
  assert.match(css, /\.pl-phone[^{]*\{[^}]*min-height:\s*(4[4-9]|[5-9]\d)px/, 'large tap targets (>= 44px)'); assert.match(css, /\.pl-phone[^{]*\{[^}]*overflow-wrap:\s*anywhere/, 'no horizontal scroll');
});

test('frozen configs untouched by this feature', () => {
  assert.equal(sha('config/frozen/kalshi-live-pilot.json'), P.PILOT_SHA256);
  assert.ok(P.PILOT_SHA256.startsWith('a7d67ee9'));
  assert.ok(sha('config/frozen/kalshi-h2-v1.json').startsWith('2f0053c4')); assert.ok(sha('config/frozen/kalshi-h2-v2.json').startsWith('ee5185f8')); assert.ok(sha('config/frozen/kalshi-h2-v3.json').startsWith('5498e1cb'));
});

test('history: arm / disarm / reset rows say where they came from (login, never a token)', () => {
  const { txOf } = require('../server/live/kalshi-live-history');
  assert.match(txOf({ t: 'arm', at: 1, balanceCents: 12345, source: 'phone', login: 'bryan@example.com' }).text, /ARMED .* · from phone \(bryan@example\.com\)$/);
  assert.match(txOf({ t: 'disarm', at: 1, source: 'phone', login: 'bryan@example.com' }).text, /from phone/);
  assert.match(txOf({ t: 'reset', at: 1, source: 'pc' }).text, /reset after halt · from desk PC/);
  assert.strictEqual(txOf({ t: 'reset', at: 1 }).text, 'reset after halt', 'old rows unchanged');
});
