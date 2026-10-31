'use strict';
// scripts/auth-proxy.js: token gate + read-only reverse proxy in front of the desk.
// Uses a scratch desk (real server.js handler, engine NOT started: no network, temp files) on a
// random port, plus a tiny fake upstream for header-stripping and websocket checks.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createProxy, config, policy, csrf } = require('../scripts/auth-proxy');

const TOKEN = 'tEsT-' + 'x'.repeat(19) + '-proxy-0123456789'; // >= 24 chars, test-only
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(() => r()); });
function req(port, p, { method = 'GET', headers = {}, body, sse = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; if (sse && d.includes('\n\n')) { resolve({ status: res.statusCode, headers: res.headers, body: d }); res.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      res.on('error', () => {});
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const form = (t) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t) });

function scratchDesk() {
  const config_ = require('../server/config'); const { Engine } = require('../server/engine'); const modules = require('../server/modules'); const { createServer } = require('../server/server');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hawse-proxy-'));
  const cfg = config_.build({ CREDITS_FILE: '', ODDS_CACHE_FILE: '', BET_RULES_FILE: '', LAB_FILE: '', INBOX_STATE_FILE: '', KALSHI_H2_DIR: path.join(tmp, 'h2'), RECORDER_DIR: path.join(tmp, 'rec'), STORAGE_DATA_DIR: tmp });
  if (cfg.lab) cfg.lab.file = '';
  const engine = new Engine(cfg, { modules }); // not started: no feeds, no ledgers, no network
  return createServer(engine, config_.publicFlags(cfg));
}

test('config: refuses to start without a strong token; never echoes it', () => {
  const bad = [{}, { HAWSE_ACCESS_TOKEN: '' }, { HAWSE_ACCESS_TOKEN: 'a'.repeat(23) }, { HAWSE_ACCESS_TOKEN: 'a'.repeat(20) + ' b c d e' }];
  for (const env of bad) assert.throws(() => config(env), (e) => /refusing to start/.test(e.message) && (!env.HAWSE_ACCESS_TOKEN || !e.message.includes(env.HAWSE_ACCESS_TOKEN)));
  const c = config({ HAWSE_ACCESS_TOKEN: 'a'.repeat(24) });
  assert.deepStrictEqual([c.host, c.port, c.upstream.host, c.upstream.port, c.allowPost.length, c.secureCookie], ['127.0.0.1', 8789, '127.0.0.1', 8788, 0, true]);
  assert.throws(() => config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_ALLOW_POST: 'halt,recorder-cap' }), /unknown route "recorder-cap"/);
  assert.throws(() => config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_ALLOW_POST: 'live-order' }), /unknown route/);
  for (const u of ['http://10.0.0.5:8788', 'https://127.0.0.1:8788', 'http://user:pw@127.0.0.1:8788', 'http://example.com']) assert.throws(() => config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: u }), /loopback/);
  assert.strictEqual(config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_INSECURE_COOKIE: '1' }).secureCookie, false);
});

test('policy: read-only by default; only allowlisted POSTs; live orders never', () => {
  assert.strictEqual(policy('GET', '/api/state', []), null); assert.strictEqual(policy('HEAD', '/', []), null);
  for (const p of ['/api/halt', '/api/resume', '/api/risk', '/api/reset-breaker', '/api/strategy/x/arm', '/api/storage/recorder-cap', '/api/lab/configs', '/api/betting/x', '/api/live-order']) assert.strictEqual(policy('POST', p, [])[0], 403, p);
  const all = ['halt', 'resume', 'reset-breaker', 'risk', 'arm'];
  for (const p of ['/api/halt', '/api/resume', '/api/risk', '/api/reset-breaker', '/api/strategy/funding_arb/arm']) assert.strictEqual(policy('POST', p, all), null, p);
  for (const p of ['/api/live-order', '/api/storage/recorder-cap', '/api/lab/configs', '/api/halt/x', '/api/strategy/a/b/arm']) assert.strictEqual(policy('POST', p, all)[0], 403, p);
  for (const m of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.strictEqual(policy(m, '/api/halt', all)[0], 405);
});

test('proxy in front of a scratch desk: login, cookie, bearer, SSE, security headers, read-only', async () => {
  const desk = scratchDesk(); const dport = await listen(desk);
  const logs = []; const proxy = createProxy(config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${dport}` }), { log: (m) => logs.push(m) });
  const port = await listen(proxy);
  try {
    let r = await req(port, '/api/state'); assert.strictEqual(r.status, 401); assert.match(r.body, /auth required/);
    r = await req(port, '/', { headers: { accept: 'text/html' } }); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/login');
    assert.strictEqual((await req(port, '/app.js')).status, 401);
    assert.strictEqual((await req(port, '/api/stream', { sse: true })).status, 401);
    assert.strictEqual((await req(port, '/api/health')).status, 401);
    r = await req(port, '/login'); assert.strictEqual(r.status, 200); assert.match(r.body, /access token/); assert.ok(!r.body.includes(TOKEN));
    for (const k of ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'content-security-policy']) assert.ok(r.headers[k], k);
    r = await req(port, '/login', form('wrong-token-wrong-token-wrong')); assert.strictEqual(r.status, 401); assert.ok(!r.headers['set-cookie']);
    r = await req(port, '/login', { ...form(TOKEN), headers: { ...form(TOKEN).headers, origin: 'https://evil.example' } }); assert.strictEqual(r.status, 403); assert.ok(!r.headers['set-cookie']);
    r = await req(port, '/login', form(TOKEN)); assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.location, '/');
    const sc = r.headers['set-cookie'][0]; assert.match(sc, /^hawse_session=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=\d+$/); assert.ok(!sc.includes(TOKEN));
    const cookie = sc.split(';')[0];
    r = await req(port, '/api/state', { headers: { cookie } }); assert.strictEqual(r.status, 200); JSON.parse(r.body); assert.ok(!r.body.includes(TOKEN));
    r = await req(port, '/', { headers: { cookie, accept: 'text/html' } }); assert.strictEqual(r.status, 200); assert.match(r.headers['content-type'], /html/); assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    r = await req(port, '/app.js', { headers: { cookie } }); assert.strictEqual(r.status, 200);
    r = await req(port, '/api/stream', { headers: { cookie }, sse: true }); assert.strictEqual(r.status, 200); assert.match(r.headers['content-type'], /event-stream/); assert.match(r.body, /^data: \{/);
    r = await req(port, '/api/state', { headers: { authorization: 'Bearer ' + TOKEN } }); assert.strictEqual(r.status, 200);
    r = await req(port, '/api/state', { headers: { authorization: 'Bearer nope' } }); assert.strictEqual(r.status, 401);
    r = await req(port, '/api/state', { headers: { cookie: 'hawse_session=' + 'a'.repeat(64) } }); assert.strictEqual(r.status, 401); // forged session
    // read-only: mutating routes are refused at the proxy, even when authenticated
    for (const p of ['/api/halt', '/api/live-order', '/api/storage/recorder-cap', '/api/risk']) { r = await req(port, p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }); assert.strictEqual(r.status, 403, p); }
    assert.strictEqual((await req(port, '/api/halt', { method: 'DELETE', headers: { cookie } })).status, 405);
    r = await req(port, '/logout', { method: 'POST', headers: { cookie } }); assert.strictEqual(r.status, 303); assert.match(r.headers['set-cookie'][0], /Max-Age=0/);
    assert.strictEqual((await req(port, '/api/state', { headers: { cookie } })).status, 401);
    assert.ok(!logs.join('\n').includes(TOKEN));
  } finally { await close(proxy); await close(desk); }
});

test('allowlisted POST is forwarded (halt), others still refused', async () => {
  const desk = scratchDesk(); const dport = await listen(desk);
  const proxy = createProxy(config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${dport}`, HAWSE_PROXY_ALLOW_POST: 'halt' }), { log: () => {} });
  const port = await listen(proxy); const h = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
  try {
    let r = await req(port, '/api/halt', { method: 'POST', headers: h, body: '{}' }); assert.strictEqual(r.status, 200); assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
    r = await req(port, '/api/resume', { method: 'POST', headers: h, body: '{}' }); assert.strictEqual(r.status, 403);
  } finally { await close(proxy); await close(desk); }
});

test('rate limit: 5 failures lock the address out (429 even with the right token) until the window passes', async () => {
  let t = 1e12; const up = http.createServer((q, s) => s.end('ok')); const uport = await listen(up);
  const logs = []; const proxy = createProxy(config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${uport}` }), { log: (m) => logs.push(m), now: () => t });
  const port = await listen(proxy);
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual((await req(port, '/login', form('bad-' + i))).status, 401);
    for (let i = 0; i < 2; i++) assert.strictEqual((await req(port, '/x', { headers: { authorization: 'Bearer bad' + i } })).status, 401);
    let r = await req(port, '/login', form(TOKEN)); assert.strictEqual(r.status, 429); assert.ok(+r.headers['retry-after'] > 0); assert.ok(!r.headers['set-cookie']);
    assert.strictEqual((await req(port, '/x', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 429);
    t += 15 * 60e3 + 1;
    r = await req(port, '/x', { headers: { authorization: 'Bearer ' + TOKEN } }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body, 'ok');
    assert.ok(logs.some((m) => /lockout active for 127\.0\.0\.1/.test(m))); assert.ok(!logs.join('\n').includes(TOKEN));
  } finally { await close(proxy); await close(up); }
});

test('forwarding strips the token and session cookie; other headers, methods and bodies pass', async () => {
  let seen; const up = http.createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { seen = { m: q.method, url: q.url, h: q.headers, b }; s.writeHead(200, { 'content-type': 'application/json', 'x-up': '1' }); s.end('{"ok":true}'); }); });
  const uport = await listen(up);
  const proxy = createProxy(config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${uport}`, HAWSE_PROXY_ALLOW_POST: 'risk' }), { log: () => {} });
  const port = await listen(proxy);
  try {
    const login = await req(port, '/login', form(TOKEN)); const cookie = login.headers['set-cookie'][0].split(';')[0];
    let r = await req(port, '/api/state?x=1', { headers: { cookie: `theme=dark; ${cookie}; other=1`, authorization: 'Bearer ' + TOKEN } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['x-up'], '1'); assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(seen.url, '/api/state?x=1'); assert.strictEqual(seen.h.authorization, undefined); assert.strictEqual(seen.h.cookie, 'theme=dark; other=1');
    assert.strictEqual(seen.h.host, `127.0.0.1:${uport}`); assert.ok(!JSON.stringify(seen.h).includes(TOKEN)); assert.ok(!JSON.stringify(seen.h).includes(cookie.split('=')[1]));
    r = await req(port, '/api/risk', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: '{"dailyLossPct":3}' });
    assert.strictEqual(r.status, 200); assert.strictEqual(seen.m, 'POST'); assert.strictEqual(seen.b, '{"dailyLossPct":3}'); assert.strictEqual(seen.h.cookie, undefined);
  } finally { await close(proxy); await close(up); }
});

test('websocket upgrade: refused without auth or cross-origin; piped both ways when authorized', async () => {
  const up = http.createServer((q, s) => s.end());
  let upHdr; up.on('upgrade', (q, sock) => { upHdr = q.headers; sock.on('end', () => sock.destroy()); sock.on('error', () => {}); sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n'); sock.on('data', (d) => sock.write('echo:' + d)); });
  const uport = await listen(up);
  const proxy = createProxy(config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${uport}` }), { log: () => {} });
  const port = await listen(proxy);
  const ws = (headers) => new Promise((resolve) => {
    const net = require('net'); const s = net.connect(port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
    let d = '', sent = false; s.on('data', (c) => { d += c; if (/^HTTP\/1\.1 101/.test(d) && !sent) { sent = true; s.write('ping'); } if (d.includes('echo:ping')) { s.destroy(); resolve(d); } });
    s.on('end', () => resolve(d)); s.on('close', () => resolve(d)); s.on('error', () => resolve(d));
  });
  try {
    assert.match(await ws({}), /^HTTP\/1\.1 401/);
    assert.match(await ws({ authorization: 'Bearer ' + TOKEN, origin: 'https://evil.example' }), /^HTTP\/1\.1 403/);
    const ok = await ws({ authorization: 'Bearer ' + TOKEN, origin: `http://127.0.0.1:${port}` }); assert.match(ok, /^HTTP\/1\.1 101/); assert.match(ok, /echo:ping/);
    assert.strictEqual(upHdr.authorization, undefined); assert.strictEqual(upHdr.upgrade, 'websocket');
  } finally { await close(proxy); await close(up); }
});

test('static: token never in the client; constant-time compare; no token logging in source', () => {
  const pub = path.join(__dirname, '..', 'public'); const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(pub)) assert.ok(!fs.readFileSync(f, 'utf8').includes('HAWSE_ACCESS_TOKEN'), f);
  const a = fs.readFileSync(path.join(__dirname, '..', 'server', 'auth.js'), 'utf8'), p = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'auth-proxy.js'), 'utf8');
  assert.match(a, /timingSafeEqual/);
  for (const src of [a, p]) for (const line of src.split('\n')) if (/console\.(log|error)|log\(/.test(line)) assert.ok(!/cfg\.token|\btoken\b(?!\s*REQUIRED)/.test(line.replace(/token REQUIRED/g, '').replace(/HAWSE_ACCESS_TOKEN/g, '')), line.trim());
});

test('csrf: forwarded POSTs need JSON and a same-origin signal; cookie sessions always need one', () => {
  const R = (h) => ({ headers: { host: 'hawse-box.tail.ts.net', 'content-type': 'application/json', ...h } });
  assert.strictEqual(csrf(R({ origin: 'https://hawse-box.tail.ts.net' }), 'cookie'), null);
  assert.strictEqual(csrf(R({ 'sec-fetch-site': 'same-origin' }), 'cookie'), null);
  assert.strictEqual(csrf(R({}), 'bearer'), null); // curl/scripts with the token, no browser headers
  for (const h of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'not a url' }, { origin: 'https://hawse-box.tail.ts.net.evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, {}])
    assert.strictEqual(csrf(R(h), 'cookie')[0], 403, JSON.stringify(h));
  assert.strictEqual(csrf(R({ origin: 'https://evil.example' }), 'bearer')[0], 403); // a browser on another site can't ride a bearer either
  assert.strictEqual(csrf(R({ 'content-type': 'text/plain', origin: 'https://hawse-box.tail.ts.net' }), 'cookie')[0], 415);
  assert.strictEqual(csrf(R({ 'content-type': 'application/x-www-form-urlencoded', origin: 'https://hawse-box.tail.ts.net' }), 'cookie')[0], 415);
});

test('HAWSE_PROXY_ALLOW_POST=arm,halt,resume: dashboard buttons work with the cookie + same Origin; arm persists; everything else stays blocked', async () => {
  const config_ = require('../server/config'); const { Engine } = require('../server/engine'); const modules = require('../server/modules'); const { createServer } = require('../server/server');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hawse-proxy-arm-')); const armedFile = path.join(tmp, 'state', 'armed.json');
  const cfg = config_.build({ CREDITS_FILE: '', ODDS_CACHE_FILE: '', BET_RULES_FILE: '', LAB_FILE: '', INBOX_STATE_FILE: '', KALSHI_H2_DIR: path.join(tmp, 'h2'), RECORDER_DIR: path.join(tmp, 'rec'), STORAGE_DATA_DIR: tmp, ARMED_STATE_FILE: armedFile });
  if (cfg.lab) cfg.lab.file = '';
  const engine = new Engine(cfg, { modules }); engine.restoreArmed(); // not started (no feeds/network); just load the (missing) armed file
  const desk = createServer(engine, config_.publicFlags(cfg)); const dport = await listen(desk);
  const pcfg = config({ HAWSE_ACCESS_TOKEN: TOKEN, HAWSE_PROXY_UPSTREAM: `http://127.0.0.1:${dport}`, HAWSE_PROXY_ALLOW_POST: 'arm,halt,resume' });
  assert.deepStrictEqual([...pcfg.allowPost].sort(), ['arm', 'halt', 'resume']);
  const proxy = createProxy(pcfg, { log: () => {} }); const port = await listen(proxy);
  try {
    const login = await req(port, '/login', form(TOKEN)); const cookie = login.headers['set-cookie'][0].split(';')[0];
    const id = engine.strategies[0].id; const origin = `http://127.0.0.1:${port}`;
    const post = (p, body = '{}', h = {}) => req(port, p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin, ...h }, body });
    // what public/app.js sends: same-origin fetch, JSON body, cookie
    let r = await post(`/api/strategy/${id}/arm`, '{"armed":true}'); assert.strictEqual(r.status, 200, r.body); assert.deepStrictEqual(JSON.parse(r.body), { ok: true, persisted: true });
    assert.strictEqual(engine.strategy(id).armed, true); assert.strictEqual(JSON.parse(fs.readFileSync(armedFile, 'utf8')).armed[id], true);
    r = await post(`/api/strategy/${id}/arm`, '{"armed":false}'); assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(fs.readFileSync(armedFile, 'utf8')).armed[id], false);
    r = await post('/api/strategy/no_such_strategy/arm', '{"armed":true}'); assert.strictEqual(r.status, 404);
    r = await post('/api/halt'); assert.strictEqual(r.status, 200); assert.strictEqual(engine.gates.real.manual, true);
    r = await post('/api/resume'); assert.strictEqual(r.status, 200); assert.strictEqual(engine.gates.real.manual, false);
    // sec-fetch-site instead of Origin also counts as same-origin
    r = await req(port, '/api/halt', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' }); assert.strictEqual(r.status, 200);
    await post('/api/resume');
    // CSRF: cross-origin / no-origin / non-JSON cookie POSTs refused before reaching the desk
    for (const h of [{ origin: 'https://evil.example' }, { origin: undefined }, { 'content-type': 'text/plain' }]) {
      const hh = { cookie, 'content-type': 'application/json', origin, ...h }; if (hh.origin === undefined) delete hh.origin;
      r = await req(port, `/api/strategy/${id}/arm`, { method: 'POST', headers: hh, body: '{"armed":true}' }); assert.ok([403, 415].includes(r.status), JSON.stringify(h) + ' ' + r.status);
    }
    assert.strictEqual(engine.strategy(id).armed, false);
    // token still required
    r = await req(port, `/api/strategy/${id}/arm`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{"armed":true}' }); assert.strictEqual(r.status, 401);
    r = await req(port, `/api/strategy/${id}/arm`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie: 'hawse_session=' + 'b'.repeat(64) }, body: '{"armed":true}' }); assert.strictEqual(r.status, 401);
    // not on the allowlist (or never allowed): refused even with a valid cookie + same Origin
    for (const p of ['/api/reset-breaker', '/api/risk', '/api/storage/recorder-cap', '/api/live-order', '/api/lab/configs', '/api/betting/rules', '/api/strategy/a/b/arm']) { r = await post(p); assert.strictEqual(r.status, 403, p); }
    assert.strictEqual(engine.strategy(id).armed, false);
  } finally { await close(proxy); await close(desk); }
});
