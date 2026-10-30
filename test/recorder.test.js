'use strict';
// H6 Part B: market-data RECORDER. Append-only rotated capped files, timestamps, gap/pause markers, public-only network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { RecorderStore, walk } = require('../server/recorder/store');
const { publicGet, allowed, Bucket } = require('../server/recorder/public-get');
const { KalshiRecorder, normBook, normTrade } = require('../server/recorder/kalshi');
const { normPolyBook, windowStart } = require('../server/recorder/polymarket');
const { parse, median, RefPriceRecorder } = require('../server/recorder/refprice');
const { Recorder } = require('../server/recorder');
const { Watchdog } = require('../server/lib/watchdog');
const { Health } = require('../server/lib/health');
const config = require('../server/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const rows = (f) => (f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)) : fs.readFileSync(f)).toString('utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clock = (t = Date.UTC(2026, 9, 30, 12, 0, 0)) => { const c = { w: t, m: 1000 }; c.now = () => c.w; c.mono = () => c.m; c.adv = (ms, mono = ms) => { c.w += ms; c.m += mono; }; return c; };

test('store: rows get rx + mono, land under data dir per UTC day, and earlier bytes are never rewritten (append-only)', () => {
  const dir = tmp(), c = clock(); const s = new RecorderStore({ dir, now: c.now, mono: c.mono, pid: 7 });
  s.write('kalshi.book', { t: 'book', ex: null, ya: 0.95 }); s.flush();
  const f = walk(dir).find((x) => x.path.includes('kalshi.book.')); assert.ok(f, 'file created'); assert.match(f.path, /2026-10-30\/kalshi\.book\.120000-7\.jsonl$/);
  const before = fs.readFileSync(f.path, 'utf8');
  c.adv(1000); s.write('kalshi.book', { t: 'book', ya: 0.96 }); s.flush();
  const after = fs.readFileSync(f.path, 'utf8'); assert.ok(after.startsWith(before), 'prefix unchanged'); 
  const r = rows(f.path); assert.equal(r.length, 2); assert.equal(r[0].rx, Date.UTC(2026, 9, 30, 12)); assert.equal(typeof r[0].mono, 'number'); assert.equal(r[0].ya, 0.95);
  assert.equal(s.view().rows, 2); assert.equal(s.view().streams['kalshi.book'].rows, 2);
  assert.throws(() => s.write('../etc', {}), /bad stream/);
});

test('store: rotates by size and by hour; rotated files are gzipped and the raw file removed', () => {
  const dir = tmp(), c = clock(); const s = new RecorderStore({ dir, now: c.now, mono: c.mono, maxFileBytes: 200, rotateMs: 3600e3, pid: 1 });
  for (let i = 0; i < 5; i++) { s.write('ref', { t: 'ref', i, pad: 'x'.repeat(80) }); s.flush(); c.adv(1000); }
  let fs1 = walk(dir).map((x) => path.basename(x.path)).sort(); assert.ok(fs1.filter((n) => n.endsWith('.jsonl.gz')).length >= 1, 'gzipped rotated file: ' + fs1); assert.ok(s.rotations >= 1);
  const all = walk(dir).flatMap((x) => rows(x.path)); assert.deepEqual(all.map((r) => r.i).sort(), [0, 1, 2, 3, 4], 'no row lost across rotation');
  const n = walk(dir).length; c.adv(3600e3); s.write('ref', { t: 'ref', i: 9 }); s.flush(); assert.equal(walk(dir).length, n + 1, 'hourly rotation opened a new file');
  assert.ok(s.view().gzRatio > 0);
});

test('store: disk cap evicts the OLDEST closed files first, logs it, and drops+counts writes when only open files remain', () => {
  const dir = tmp(), c = clock(); const day = path.join(dir, '2026-10-01'); fs.mkdirSync(day, { recursive: true });
  for (let i = 0; i < 5; i++) { const f = path.join(day, `old.${i}.jsonl.gz`); fs.writeFileSync(f, Buffer.alloc(1000)); fs.utimesSync(f, new Date(2026, 9, 1, 0, i), new Date(2026, 9, 1, 0, i)); }
  const logs = []; const s = new RecorderStore({ dir, now: c.now, mono: c.mono, capBytes: 3000, log: (m) => logs.push(m) });
  const r = s.enforceCap(); assert.ok(r.used <= 3000 * 0.9 + 200); assert.equal(s.capped, false);
  const left = fs.readdirSync(day).sort(); assert.deepEqual(left, ['old.3.jsonl.gz', 'old.4.jsonl.gz'], 'oldest two..three evicted first: ' + left); assert.ok(s.evicted >= 3); assert.match(logs.join(), /evicted/);
  // now only an open file, bigger than the cap
  const d2 = tmp(); const s2 = new RecorderStore({ dir: d2, now: c.now, mono: c.mono, capBytes: 100 }); s2.write('x', { pad: 'y'.repeat(300) }); s2.flush(); s2.enforceCap();
  assert.equal(s2.capped, true); assert.equal(s2.write('x', { a: 1 }), false); assert.equal(s2.view().dropped, 1);
});

test('gaps: offline gap from the previous session heartbeat, vm-pause from wall-vs-mono, box-pause vs poll-gap classification, watchdog clock-jump marker', () => {
  const dir = tmp(), c = clock(); const h = new Health(); const cfg = { ...config.build({ RECORDER_DIR: dir }).recorder, kalshi: { enabled: false }, polymarket: { enabled: false }, ref: { enabled: false } };
  const r1 = new Recorder({ health: h, cfg, now: c.now, mono: c.mono, log: () => {} }); r1.start(); r1.beat(); r1.store.flush();
  // simulate a crash: no session_stop. 2 hours later a new process starts.
  r1.running = false; for (const t of r1.timers) clearInterval(t); r1.store.stop();
  c.adv(2 * 3600e3, 5); const r2 = new Recorder({ health: new Health(), cfg, now: c.now, mono: c.mono, log: () => {} }); r2.start();
  assert.equal(r2.gaps.byReason.offline, 1); const g = r2.gaps.recent[0]; assert.equal(g.stream, 'all'); assert.ok(g.ms >= 2 * 3600e3 - 10);
  r2.tick(); c.adv(90000, 1000); const pg = r2.gap('kalshi.book', 'KX-1', c.w - 90000, c.w); // the poll noticed first; tick() inside gap() sees the pause
  assert.equal(r2.gaps.byReason['vm-pause'], 1); assert.equal(pg.reason, 'box-pause');
  c.adv(1000); r2.tick(); c.adv(8000); const pg2 = r2.gap('kalshi.book', 'KX-1', c.w - 8000, c.w); assert.equal(r2.gaps.byReason.stall, 1, 'loop/VM stall (mono advanced too)'); assert.equal(pg2.reason, 'box-pause');
  for (let i = 0; i < 8; i++) { c.adv(1000); r2.tick(); } const pg3 = r2.gap('kalshi.book', 'KX-1', c.w - 7000, c.w); assert.equal(pg3.reason, 'poll-gap', 'no pause overlapped: venue/network gap');
  const before = r2.gaps.n; r2.onClockJump({ at: c.w, ms: 60000 }); assert.equal(r2.gaps.n, before + 1); assert.equal(r2.gaps.byReason['clock-jump'], 1);
  r2.stop(); const all = walk(dir).flatMap((x) => rows(x.path)); const kinds = all.filter((x) => x.t === 'gap').map((x) => x.reason);
  for (const k of ['offline', 'vm-pause', 'box-pause', 'clock-jump']) assert.ok(kinds.includes(k), k + ' written to disk');
  assert.ok(all.some((x) => x.t === 'session_stop'));
});

test('watchdog: clock jump notifies feeds that expose onClockJump', () => {
  const c = clock(); const h = new Health(); const got = []; const wd = new Watchdog({ health: h, now: c.now, mono: c.mono, log: () => {} });
  wd.watchAll({ rec: { onClockJump: (j) => got.push(j) } }); wd.w0 = c.w; wd.m0 = c.m; c.adv(120000, 1000); wd.check();
  assert.equal(got.length, 1); assert.ok(got[0].ms >= 118000);
});

test('kalshi book normalization: YES ask = 1 - best NO bid with that level size; legacy cents format too', () => {
  const b = normBook({ orderbook_fp: { yes_dollars: [['0.9300', '10'], ['0.9500', '25']], no_dollars: [['0.0200', '7'], ['0.0400', '12']] } });
  assert.equal(b.yb, 0.95); assert.equal(b.ybs, 25); assert.equal(b.ya, 0.96); assert.equal(b.yas, 12); assert.deepEqual(b.askLadder, [[0.96, 12], [0.98, 7]]);
  const l = normBook({ orderbook: { yes: [[93, 5]], no: [[3, 9]] } }); assert.equal(l.ya, 0.97); assert.equal(l.yb, 0.93);
  const e = normBook({ orderbook_fp: { yes_dollars: null, no_dollars: [] } }); assert.equal(e.ya, null);
  const t = normTrade({ trade_id: 'a', ticker: 'KX', created_time: '2026-10-30T19:00:00.123Z', yes_price_dollars: '0.9500', no_price_dollars: '0.0500', count_fp: '3.00', taker_side: 'yes' });
  assert.equal(t.ex, Date.parse('2026-10-30T19:00:00.123Z')); assert.equal(t.yp, 0.95); assert.equal(t.c, 3);
});

test('kalshi recorder (fake public API): discovery, book written only on change, trades deduped, settlement row, listeners, poll gap', async () => {
  const dir = tmp(), c = clock(Date.UTC(2026, 9, 30, 19, 5)); const h = new Health(); const store = new RecorderStore({ dir, now: c.now, mono: c.mono });
  const close = Date.UTC(2026, 9, 30, 19, 15); let book = { orderbook_fp: { yes_dollars: [['0.9400', '5']], no_dollars: [['0.0500', '20']] } }; let result = null; const urls = [];
  const get = async (u) => { urls.push(u); const p = new URL(u).pathname;
    if (p.endsWith('/markets') ) return { markets: [{ ticker: 'KXBTC15M-X', event_ticker: 'E', open_time: '2026-10-30T19:00:00Z', close_time: new Date(close).toISOString(), floor_strike: 76000, strike_type: 'greater_or_equal' }] };
    if (p.endsWith('/orderbook')) return book;
    if (p.endsWith('/markets/trades')) return { trades: [{ trade_id: 't1', ticker: 'KXBTC15M-X', created_time: '2026-10-30T19:04:59Z', yes_price_dollars: '0.95', count_fp: '2' }] };
    if (p.endsWith('/markets/KXBTC15M-X')) return { market: { status: result ? 'finalized' : 'closed', result: result || '', expiration_value: '76100', floor_strike: 76000 } };
    if (p.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1 } };
    throw new Error('unexpected ' + p); };
  const gaps = []; const k = new KalshiRecorder({ store, health: h, now: c.now, get, gap: (...a) => gaps.push(a), cfg: { series: ['KXBTC15M'], extraSeries: [], maxRps: 1000 } });
  const books = [], settles = []; k.on('book', (b) => books.push(b)); k.on('settle', (s) => settles.push(s));
  await k.discover(); await k.checkSeries(); await k.pollBooks(); await k.pollBooks(); c.adv(1000); book = { orderbook_fp: { yes_dollars: [['0.9400', '5']], no_dollars: [['0.0400', '20']] } }; await k.pollBooks();
  await k.pollTrades(); await k.pollTrades();
  c.adv(9000); await k.pollBooks(); assert.equal(gaps.length, 1, 'gap > 5 s between good book polls'); assert.equal(gaps[0][0], 'kalshi.book');
  c.w = close + 6000; await k.pollSettle(); assert.equal(settles.length, 0, 'no result yet'); result = 'yes'; await k.pollSettle(); assert.equal(settles.length, 1); assert.equal(settles[0].result, 'yes');
  store.flush(); const all = walk(dir).flatMap((x) => rows(x.path));
  assert.equal(all.filter((r) => r.t === 'book').length, 2, 'unchanged book not rewritten'); assert.equal(books.length, 4, 'every poll emitted to listeners');
  assert.equal(books[2].ya, 0.96); assert.equal(all.filter((r) => r.t === 'trade').length, 1, 'trade deduped');
  assert.ok(all.some((r) => r.t === 'market' && r.strike === 76000 && r.close === close)); assert.ok(all.some((r) => r.t === 'settle' && r.result === 'yes'));
  assert.ok(all.some((r) => r.t === 'series' && r.fee_type === 'quadratic'));
  for (const u of urls) assert.ok(allowed(u), 'only allowlisted public URLs: ' + u);
});

test('publicGet: allowlist of public market-data GETs only; trading/portfolio/auth paths and foreign hosts are refused before any network call', async () => {
  const ok = ['https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M', 'https://api.elections.kalshi.com/trade-api/v2/markets/KXBTC15M-26OCT301515-15/orderbook?depth=10',
    'https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=X', 'https://gamma-api.polymarket.com/markets?slug=a', 'https://clob.polymarket.com/book?token_id=1', 'https://data-api.polymarket.com/trades?market=0x1'];
  for (const u of ok) assert.ok(allowed(u), u);
  const bad = ['https://api.elections.kalshi.com/trade-api/v2/portfolio/orders', 'https://api.elections.kalshi.com/trade-api/v2/portfolio/balance', 'https://api.elections.kalshi.com/trade-api/v2/portfolio/positions',
    'https://api.elections.kalshi.com/trade-api/v2/orders', 'https://clob.polymarket.com/order', 'https://clob.polymarket.com/orders', 'https://clob.polymarket.com/auth/api-key', 'http://api.elections.kalshi.com/trade-api/v2/markets',
    'https://evil.example.com/trade-api/v2/markets', 'https://user:pw@api.elections.kalshi.com/trade-api/v2/markets', 'https://api.elections.kalshi.com/trade-api/v2/login', 'not a url'];
  let calls = 0; const f = async () => { calls++; return {}; };
  for (const u of bad) { assert.equal(allowed(u), false, u); await assert.rejects(publicGet(u, { fetchJsonImpl: f }), /allowlist/); }
  assert.equal(calls, 0);
  let seen; await publicGet(ok[1], { fetchJsonImpl: async (u, o) => { seen = o; return {}; } }); assert.equal(seen.method, 'GET'); assert.equal(seen.headers, undefined, 'no auth headers');
  const c = clock(); const b = new Bucket(2, c.now); assert.ok(b.take()); assert.ok(b.take()); assert.equal(b.take(), false); c.adv(500); assert.ok(b.take());
});

test('no order / auth-signing code anywhere in the recorder or the Kalshi H2 paper test (source scan, like H4)', () => {
  const dirs = ['server/recorder', 'server/kalshi-h2'].map((d) => path.join(__dirname, '..', d)).filter((d) => fs.existsSync(d));
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
  assert.ok(files.length >= 5, 'scanned ' + files.length);
  const BAD = [/KALSHI-ACCESS-(KEY|SIGNATURE|TIMESTAMP)/i, /createSign|crypto\.sign\b|privateKey|private_key|PRIVATE KEY/, /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i, /['"`]\/portfolio/, /['"`]\/orders?\b/,
    /\b(place|submit|create|cancel)Order\b/i, /POLY_(API_KEY|SECRET|PASSPHRASE)|L2_HEADER|ethers|signTypedData/i, /process\.env\.(KALSHI|POLY)/];
  for (const f of files) { const s = fs.readFileSync(f, 'utf8'); for (const re of BAD) assert.ok(!re.test(s), `${path.relative(process.cwd(), f)} matches ${re}`); }
  // the only network entry for the HTTP pollers is publicGet (no direct fetch / http module use)
  for (const f of files.filter((x) => /kalshi\.js|polymarket\.js/.test(x))) { const s = fs.readFileSync(f, 'utf8'); assert.ok(!/\bfetch\(|require\(['"]https?['"]\)/.test(s), f); }
});

test('reference prices: venue frame parsers, fresh-only median, labelled not-the-index', () => {
  assert.deepEqual(parse.coinbase({ type: 'ticker', product_id: 'BTC-USD', price: '76000.5', time: '2026-10-30T19:00:00Z', best_bid: '76000', best_ask: '76001' })[0].px, 76000.5);
  assert.equal(parse.kraken({ channel: 'trade', data: [{ symbol: 'BTC/USD', price: 76001, timestamp: '2026-10-30T19:00:00Z' }] })[0].asset, 'BTC');
  const bs = parse.bitstamp({ event: 'trade', channel: 'live_trades_ethusd', data: { price: 2228.1, microtimestamp: '1793386800123456' } })[0]; assert.equal(bs.asset, 'ETH'); assert.equal(bs.ex, 1793386800123);
  assert.equal(parse.gemini({ type: 'update', timestampms: 5, events: [{ type: 'trade', price: '94.1' }, { type: 'change' }] }, 'SOL').length, 1);
  assert.equal(parse.cryptocom({ result: { subscription: 'trade.XRP_USD', instrument_name: 'XRP_USD', data: [{ p: '1.23', t: 9 }] } })[0].asset, 'XRP');
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null);
  const c = clock(); const h = new Health(); const r = new RefPriceRecorder({ store: { write() {} }, health: h, now: c.now, cfg: { venues: [] } });
  r.take('coinbase', [{ asset: 'BTC', px: 100, ex: 1 }]); r.take('kraken', [{ asset: 'BTC', px: 102, ex: 1 }]); c.adv(11000); r.take('bitstamp', [{ asset: 'BTC', px: 200, ex: 1 }]);
  const row = r.snapshotRow('BTC'); assert.equal(row.n, 1, 'stale venues excluded'); assert.equal(row.med, 200); assert.equal(Object.keys(row.venues).length, 3, 'stale venues still shown with age');
  assert.match(h.src.get('rec.ref').note, /not Kalshi/);
});

test('polymarket: book normalization and 15m window math', () => {
  const b = normPolyBook({ timestamp: '1793386800123', hash: 'h', bids: [{ price: '0.01', size: '5' }, { price: '0.48', size: '10' }], asks: [{ price: '0.99', size: '1' }, { price: '0.52', size: '3' }] });
  assert.equal(b.bb, 0.48); assert.equal(b.ba, 0.52); assert.equal(b.ex, 1793386800123);
  assert.equal(windowStart(Date.UTC(2026, 9, 30, 19, 7, 30)), Date.UTC(2026, 9, 30, 19, 0) / 1000);
});

test('odds tap: records only LIVE odds snapshots (never mock), deduped, without any extra API call', () => {
  const dir = tmp(), c = clock(); const odds = { listeners: [], mode: 'live', quota: { remaining: 485, used: 15 } };
  const cfg = { ...config.build({ RECORDER_DIR: dir }).recorder, kalshi: { enabled: false }, polymarket: { enabled: false }, ref: { enabled: false } };
  const r = new Recorder({ health: new Health(), cfg, now: c.now, mono: c.mono, odds, log: () => {} }); r.start();
  const ev = { id: 'e1', sport: 'americanfootball_nfl', home: 'A', away: 'B', commence: 1, books: [{ k: 'dk', h: 1.9 }], simulated: false };
  for (const f of odds.listeners) { f(ev); f(ev); f({ ...ev, id: 'm1', simulated: true }); f({ ...ev, books: [{ k: 'dk', h: 1.95 }] }); }
  assert.equal(r.oddsRows, 2); assert.equal(r.snapshot().odds.credits.remaining, 485); r.stop();
  const all = walk(dir).flatMap((x) => rows(x.path)); assert.equal(all.filter((x) => x.t === 'odds').length, 2); assert.ok(!all.some((x) => x.id === 'm1'));
});

test('engine wiring: recorder mounts as a feed, constructs with no network and no files, and shows up in the snapshot + health', () => {
  const dir = path.join(tmp(), 'never-created'); const { Engine } = require('../server/engine'); const modules = require('../server/modules');
  const e = new Engine(config.build({ RECORDER_DIR: dir }), { modules }); assert.ok(e.feeds.recorder); assert.equal(fs.existsSync(dir), false, 'no files before start()');
  const s = e.snapshot(); assert.equal(s.feeds.recorder.enabled, true); assert.ok(s.health.some((x) => x.id === 'rec.kalshi.book' && x.group === 'recorder'));
  const off = new Engine(config.build({ RECORDER_ENABLED: 'false' }), { modules }); assert.equal(off.feeds.recorder, undefined);
});
