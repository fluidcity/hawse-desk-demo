'use strict';
// H7 Stage G: optional Kalshi WebSocket market data with a READ-ONLY key. The single signing helper is narrowly scoped
// (WS handshake only); the recorder sends only subscribe/update_subscription for public market-data channels.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('../server/kalshi-auth/ws-sign');
const { KalshiWsRecorder, checkOutgoing } = require('../server/recorder/kalshi-ws');
const { Health } = require('../server/lib/health');
const config = require('../server/config');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kws-'));
const walkJs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkJs(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const MSG = (ts) => Buffer.from(ts + 'GET' + '/trade-api/ws/v2');

test('ws-sign: Ed25519 + RSA-PSS handshake headers verify over <ts>GET/trade-api/ws/v2; key via path or PEM env; absent → null', () => {
  const ed = crypto.generateKeyPairSync('ed25519'); const dir = tmp(); const f = path.join(dir, 'k.pem');
  fs.writeFileSync(f, ed.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const h = ws.makeWsAuth({ KALSHI_API_KEY_ID: 'kid-1', KALSHI_PRIVATE_KEY_PATH: f }, () => 1793386800123)();
  assert.deepEqual(Object.keys(h).sort(), ['KALSHI-ACCESS-KEY', 'KALSHI-ACCESS-SIGNATURE', 'KALSHI-ACCESS-TIMESTAMP']);
  assert.equal(h['KALSHI-ACCESS-KEY'], 'kid-1'); assert.equal(h['KALSHI-ACCESS-TIMESTAMP'], '1793386800123');
  assert.ok(crypto.verify(null, MSG('1793386800123'), ed.publicKey, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).replace(/\n/g, '\\n'); // one-line env form
  const r = ws.makeWsAuth({ KALSHI_API_KEY_ID: 'kid-2', KALSHI_PRIVATE_KEY_PEM: pem }, () => 42)();
  assert.ok(crypto.verify('sha256', MSG('42'), { key: rsa.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(r['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  assert.equal(ws.makeWsAuth({}), null); assert.equal(ws.makeWsAuth({ KALSHI_API_KEY_ID: 'x' }), null); assert.equal(ws.wsAuthConfigured({ KALSHI_PRIVATE_KEY_PEM: 'x' }), false);
  const bad = 'not-a-key-SECRETVALUE';
  assert.throws(() => ws.makeWsAuth({ KALSHI_API_KEY_ID: 'x', KALSHI_PRIVATE_KEY_PEM: bad }), (e) => /could not be read or parsed/.test(e.message) && !e.message.includes(bad));
  const sign = ws.makeWsAuth({ KALSHI_API_KEY_ID: 'kid-1', KALSHI_PRIVATE_KEY_PATH: f }); assert.equal(sign.length, 0, 'the header function takes no method/path argument');
});

test('ws-sign is the ONLY signing code in the repo, and it cannot sign or send anything but the WS handshake', () => {
  const files = [...walkJs(path.join(ROOT, 'server')), ...walkJs(path.join(ROOT, 'public'))];
  const SIGN = /crypto\.sign\s*\(|createSign|KALSHI-ACCESS-(KEY|SIGNATURE|TIMESTAMP)/;
  const hits = files.filter((f) => SIGN.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, [path.join('server', 'kalshi-auth', 'ws-sign.js')]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'server', 'kalshi-auth')), ['ws-sign.js'], 'nothing else lives next to the signer');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'kalshi-auth', 'ws-sign.js'), 'utf8');
  for (const re of [/\bfetch\s*\(/, /require\(['"](https?|net|tls|ws)['"]\)/, /new\s+WebSocket/, /['"`]\/portfolio/, /['"`]\/orders?\b/, /['"](POST|PUT|DELETE|PATCH)['"]/, /console\.|log\(/, /writeFile|appendFile/]) assert.ok(!re.test(src), 'ws-sign.js matches ' + re);
  assert.equal(ws.WS_PATH, '/trade-api/ws/v2'); assert.equal(ws.WS_METHOD, 'GET');
  assert.deepEqual(Object.keys(ws).sort(), ['WS_HOSTS', 'WS_METHOD', 'WS_PATH', 'isKalshiWsUrl', 'makeWsAuth', 'wsAuthConfigured']);
  assert.ok(ws.isKalshiWsUrl('wss://api.elections.kalshi.com/trade-api/ws/v2')); assert.ok(ws.isKalshiWsUrl('wss://external-api-ws.kalshi.com/trade-api/ws/v2'));
  for (const u of ['wss://evil.example.com/trade-api/ws/v2', 'ws://api.elections.kalshi.com/trade-api/ws/v2', 'wss://api.elections.kalshi.com/trade-api/v2/portfolio/orders', 'https://api.elections.kalshi.com/trade-api/ws/v2', 'wss://u:p@api.elections.kalshi.com/trade-api/ws/v2']) assert.equal(ws.isKalshiWsUrl(u), false, u);
  // no key material or key env names in the browser bundle
  for (const f of walkJs(path.join(ROOT, 'public'))) assert.ok(!/KALSHI_PRIVATE_KEY|BEGIN [A-Z ]*PRIVATE KEY/.test(fs.readFileSync(f, 'utf8')), f);
  // the recorder side never touches env or keys itself
  const rec = fs.readFileSync(path.join(ROOT, 'server', 'recorder', 'kalshi-ws.js'), 'utf8'); assert.ok(!/process\.env|privateKey|PRIVATE KEY|readFile|\bfetch\(/.test(rec));
});

test('outgoing frames: only subscribe/update_subscription for orderbook_delta, trade, cfbenchmarks_value; private channels and other commands refused', () => {
  assert.ok(checkOutgoing({ cmd: 'subscribe', params: { channels: ['orderbook_delta'], market_tickers: ['A'] } }));
  assert.ok(checkOutgoing({ cmd: 'subscribe', params: { channels: ['trade'] } })); assert.ok(checkOutgoing({ cmd: 'subscribe', params: { channels: ['cfbenchmarks_value'], index_ids: ['BRTI'] } }));
  assert.ok(checkOutgoing({ cmd: 'update_subscription', params: { sid: 1, action: 'add_markets' } }));
  for (const ch of ['fill', 'market_positions', 'user_orders', 'order_group_updates', 'communications', 'ticker_v2_private']) assert.throws(() => checkOutgoing({ cmd: 'subscribe', params: { channels: ['trade', ch] } }), /channel not allowed/, ch);
  for (const cmd of ['create_order', 'cancel', 'unsubscribe_all', undefined]) assert.throws(() => checkOutgoing({ cmd, params: {} }), /command not allowed/);
  assert.throws(() => checkOutgoing({ cmd: 'update_subscription', params: { action: 'amend' } }), /action not allowed/);
  assert.throws(() => checkOutgoing({ cmd: 'subscribe', params: { channels: [] } }), /channel not allowed/);
});

class FakeWS { constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; FakeWS.last = this; FakeWS.n++; } send(s) { this.sent.push(JSON.parse(s)); } close() {} }
FakeWS.n = 0;

test('KalshiWsRecorder (fake socket): handshake headers per connect, subscribes live markets, records snapshot/delta/trade/CF rows, seq gap → gap row + resnapshot, new 15m market → add_markets', () => {
  const h = new Health(); const out = []; const gaps = []; let live = [{ tk: 'KXBTC15M-A' }, { tk: 'KXETH15M-A' }];
  const store = { write: (s, r) => out.push({ s, ...r }) }; let headerCalls = 0;
  const auth = () => { headerCalls++; return { 'X-Handshake': 'h' + headerCalls }; };
  const r = new KalshiWsRecorder({ store, health: h, auth, kalshi: { live: () => live }, gap: (...a) => gaps.push(a), cfg: { cfIndex: true, indexIds: ['BRTI'] }, WebSocketImpl: FakeWS, log: () => {} });
  r.start(); const s = FakeWS.last; assert.equal(s.url, 'wss://api.elections.kalshi.com/trade-api/ws/v2'); assert.deepEqual(s.opts.headers, { 'X-Handshake': 'h1' });
  s.onopen();
  assert.deepEqual(s.sent.map((f) => [f.cmd, f.params.channels.join()]), [['subscribe', 'orderbook_delta'], ['subscribe', 'trade'], ['subscribe', 'cfbenchmarks_value']]);
  assert.deepEqual(s.sent[0].params.market_tickers, ['KXBTC15M-A', 'KXETH15M-A']);
  const rx = (o) => s.onmessage({ data: JSON.stringify(o) });
  rx({ type: 'subscribed', id: 1, msg: { channel: 'orderbook_delta', sid: 7 } }); rx({ type: 'subscribed', id: 2, msg: { channel: 'trade', sid: 8 } });
  rx({ type: 'orderbook_snapshot', sid: 7, seq: 1, msg: { market_ticker: 'KXBTC15M-A', clock: 10, yes_dollars_fp: [['0.4500', '120.00']], no_dollars_fp: [['0.5300', '5.00']] } });
  rx({ type: 'orderbook_delta', sid: 7, seq: 2, msg: { market_ticker: 'KXBTC15M-A', clock: 11, price_dollars: '0.4500', delta_fp: '-20.00', side: 'yes', ts_ms: 1793386800500 } });
  rx({ type: 'trade', sid: 8, seq: 1, msg: { trade_id: 't1', market_ticker: 'KXBTC15M-A', yes_price_dollars: '0.46', no_price_dollars: '0.54', count_fp: '3.00', taker_side: 'yes', is_block_trade: false, ts_ms: 1793386800600 } });
  rx({ type: 'cfbenchmarks_value', sid: 9, seq: 1, msg: { index_id: 'BRTI', received_at: 5, data: '{"type":"value","id":"BRTI","time":1793386800000,"value":"76000.12"}', avg_60s_data: { value: '76001.00', window_size: 59 } } });
  const by = (t) => out.filter((x) => x.t === t);
  assert.deepEqual(by('snap')[0].yes, [[0.45, 120]]); assert.equal(by('delta')[0].d, -20); assert.equal(by('delta')[0].ex, 1793386800500);
  assert.equal(by('trade')[0].n, 3); assert.equal(by('trade')[0].s, 'kalshi.ws.trade'); assert.equal(by('cf')[0].v, 76000.12); assert.equal(by('cf')[0].avg60, 76001);
  rx({ type: 'orderbook_delta', sid: 7, seq: 5, msg: { market_ticker: 'KXBTC15M-A', price_dollars: '0.44', delta_fp: '1', side: 'no' } }); // seq 3, 4 missing
  assert.equal(r.n.seqGaps, 1); assert.equal(gaps[0][3 + 1], 'ws-seq-gap'); const last = s.sent[s.sent.length - 1]; assert.equal(last.params.action, 'get_snapshot'); assert.equal(last.params.sid, 7);
  s.readyState = 1; live = [{ tk: 'KXBTC15M-A' }, { tk: 'KXBTC15M-B' }]; r.sync();
  const adds = s.sent.filter((f) => f.params.action === 'add_markets'); assert.deepEqual(adds.map((f) => f.params.sid), [7, 8]); assert.deepEqual(adds[0].params.market_tickers, ['KXBTC15M-B']);
  const dels = s.sent.filter((f) => f.params.action === 'delete_markets'); assert.deepEqual(dels[0].params.market_tickers, ['KXETH15M-A']);
  for (const f of s.sent) checkOutgoing(f); // every frame actually sent passes the allowlist
  rx({ type: 'error', id: 3, msg: { code: 9, msg: 'Authentication required' } }); assert.equal(r.n.errors, 1); assert.equal(r.errCodes['9'], 1); assert.equal(out.filter((x) => x.t === 'ws_error')[0].code, 9);
  r.client.restart('test'); assert.deepEqual(FakeWS.last.opts.headers, { 'X-Handshake': 'h2' }, 'fresh timestamped headers on every connect');
  r.stop();
});

test('disabled by default; enabled without a key → explained health row and no socket; non-Kalshi URL refused', () => {
  assert.equal(config.build({}).recorder.kalshiWs.enabled, false);
  const saved = {}; for (const k of ['KALSHI_API_KEY_ID', 'KALSHI_PRIVATE_KEY_PATH', 'KALSHI_PRIVATE_KEY_PEM']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const { Engine } = require('../server/engine'); const modules = require('../server/modules');
    const e = new Engine(config.build({ KALSHI_WS: 'true', RECORDER_DIR: path.join(tmp(), 'x') }), { modules });
    const kws = e.recorder.kws; assert.ok(kws); assert.match(kws.problem, /no Kalshi key/); const n0 = FakeWS.n; kws.WebSocketImpl = FakeWS; kws.start(); assert.equal(FakeWS.n, n0, 'no socket opened'); assert.deepEqual(kws.watchSpec(), []);
    assert.equal(e.snapshot().feeds.recorder.kalshiWs.problem, kws.problem);
  } finally { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; }
  const r = new KalshiWsRecorder({ store: { write() {} }, health: new Health(), auth: () => ({}), cfg: { url: 'wss://evil.example.com/trade-api/ws/v2' }, WebSocketImpl: FakeWS });
  assert.match(r.problem, /not a Kalshi WebSocket URL/); const n1 = FakeWS.n; r.start(); assert.equal(FakeWS.n, n1);
});
