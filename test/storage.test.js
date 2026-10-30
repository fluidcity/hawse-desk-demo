'use strict';
// H7: Storage panel (fill bars per consumer, warn/crit thresholds) + live recorder-cap control (validated, persisted,
// logged, prunes oldest closed recorder files only, never paper ledgers or config/frozen) + localhost/same-origin guard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { StorageMonitor, localOnly, readRuntimeCap, level } = require('../server/storage');
const { RecorderStore } = require('../server/recorder/store');
const config = require('../server/config');

const GiB = 2 ** 30;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stor-'));
const fakeRec = (store) => ({ store, cfg: { capBytes: store.capBytes } });
const mon = (dataDir, store, o = {}) => new StorageMonitor({ dataDir, recorder: store ? fakeRec(store) : null, log: () => {},
  statfs: () => ({ blocks: 100 * 2 ** 18, bsize: 4096, bavail: 60 * 2 ** 18 }), mem: () => ({ rss: 300 * 2 ** 20, heapUsed: 50 * 2 ** 20 }), totalMem: () => 1 * GiB, heapLimit: () => 100 * 2 ** 20, ...o }); // 100 GiB disk, 60 free

test('default recorder cap is 12 GiB (≈ 8 weeks gzipped); RECORDER_CAP_GB still overrides', () => {
  assert.equal(config.build({}).recorder.capBytes, 12 * GiB);
  assert.equal(config.build({ RECORDER_CAP_GB: '20' }).recorder.capBytes, 20 * GiB);
  const ex = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8'); assert.match(ex, /RECORDER_CAP_GB=\s*\n|RECORDER_CAP_GB=$/m);
  assert.match(ex, /default 12/); assert.ok(config.build({}).storage.enabled);
});

test('bars: one per consumer with ok/warn/crit at 70/90 %, recorder bar against its cap', () => {
  const D = tmp(); const rec = path.join(D, 'recorder'); fs.mkdirSync(path.join(D, 'paper', 'kalshi-h2', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(D, 'paper', 'kalshi-h2', 'v1', 'ledger.jsonl'), 'x'.repeat(1000)); fs.writeFileSync(path.join(D, 'odds-cache.json'), '{}'); fs.writeFileSync(path.join(D, 'x.log'), 'y'.repeat(10));
  const st = new RecorderStore({ dir: rec, capBytes: 10000, log: () => {} }); fs.mkdirSync(path.join(rec, 'd'), { recursive: true }); fs.writeFileSync(path.join(rec, 'd', 'a.jsonl'), 'z'.repeat(7500));
  const m = mon(D, st); const v = m.measure(); const by = Object.fromEntries(v.bars.map((b) => [b.id, b]));
  assert.deepEqual(Object.keys(by), ['recorder', 'paper', 'odds', 'logs', 'data', 'disk', 'rss', 'heap']);
  assert.equal(by.recorder.used, 7500); assert.equal(by.recorder.pct, 75); assert.equal(by.recorder.level, 'warn');
  assert.equal(by.paper.used, 1000); assert.equal(by.logs.used, 10); assert.ok(by.data.used >= 8512);
  assert.equal(by.disk.pct, 40); assert.equal(by.disk.level, 'ok'); assert.equal(by.rss.level, 'ok'); assert.equal(by.heap.pct, 50);
  assert.equal(level(69.9, 70, 90), 'ok'); assert.equal(level(70, 70, 90), 'warn'); assert.equal(level(90, 70, 90), 'crit'); assert.equal(level(null, 70, 90), 'n/a');
});

test('runtime cap: validated, persisted + logged, live without restart; shrinking prunes oldest CLOSED recorder files whole, never ledgers/frozen/open file', () => {
  const D = tmp(); const rec = path.join(D, 'recorder'); const paper = path.join(D, 'paper'); const frozen = path.join(D, 'config', 'frozen');
  fs.mkdirSync(path.join(rec, '2026-10-29'), { recursive: true }); fs.mkdirSync(paper, { recursive: true }); fs.mkdirSync(frozen, { recursive: true });
  // a misconfigured recorder dir that CONTAINS the ledger + frozen config: they must still survive
  const st = new RecorderStore({ dir: D, capBytes: 12 * GiB, log: () => {}, protect: [paper, path.join(D, 'config'), path.join(D, 'runtime')] });
  const old = []; for (let i = 0; i < 4; i++) { const f = path.join(rec, '2026-10-29', `kalshi.trade.0${i}0000-1.jsonl.gz`); fs.writeFileSync(f, 'a'.repeat(300 * 2 ** 10)); const t = Date.now() / 1000 - 4000 + i * 100; fs.utimesSync(f, t, t); old.push(f); }
  const ledger = path.join(paper, 'ledger.jsonl'); fs.writeFileSync(ledger, 'L'.repeat(400 * 2 ** 10)); fs.utimesSync(ledger, 1, 1); // oldest file of all
  const fz = path.join(frozen, 'kalshi-h2-v1.json'); fs.writeFileSync(fz, '{}'); fs.utimesSync(fz, 1, 1);
  st.write('meta', { t: 'x' }); st.flush(); const openFile = [...st.openFiles()][0]; assert.ok(openFile);
  const m = mon(D, st, { minGb: 0.001, maxGb: 50 });
  for (const bad of [null, 'abc', NaN, 0.0001, 51, 1e9, {}]) { const r = m.setRecorderCap(bad); assert.equal(r.ok, false, String(bad)); }
  assert.equal(st.capBytes, 12 * GiB, 'rejected values change nothing'); assert.ok(!fs.existsSync(path.join(D, 'runtime', 'recorder-cap.json')));
  const r = m.setRecorderCap('0.001'); // ≈ 1 MiB → prune to ≤ 90 % of it
  assert.ok(r.ok, r.error); assert.equal(r.capGb, 0.001); assert.equal(r.prevGb, 12); assert.equal(st.capBytes, 0.001 * GiB, 'live on the running store');
  assert.equal(r.pruned, 3, 'oldest three closed files pruned, whole');
  assert.deepEqual(old.map((f) => fs.existsSync(f)), [false, false, false, true]);
  assert.ok(fs.existsSync(ledger), 'paper ledger never pruned'); assert.ok(fs.existsSync(fz), 'frozen config never pruned'); assert.ok(fs.existsSync(openFile), 'open file never pruned');
  assert.equal(readRuntimeCap(path.join(D, 'runtime', 'recorder-cap.json')), 0.001, 'persisted');
  const log = fs.readFileSync(path.join(D, 'runtime', 'cap-changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); assert.equal(log.length, 1); assert.equal(log[0].capGb, 0.001);
  st.flush(); const meta = fs.readFileSync(openFile, 'utf8'); assert.match(meta, /"t":"cap_change"/); assert.match(meta, /"t":"evict"/);
  for (const l of fs.readFileSync(openFile, 'utf8').trim().split('\n')) JSON.parse(l); // never partial rows
  assert.equal(m.snapshot().changes[0].pruned, 3); st.stop();
});

test('max cap = 95 % of (free disk + current recorder use); no recorder → refused', () => {
  const D = tmp(); const st = new RecorderStore({ dir: path.join(D, 'r'), capBytes: GiB, log: () => {} });
  const m = mon(D, st, { maxGb: 500 }); assert.equal(m.limits().maxGb, 57, '60 GiB free × 0.95'); assert.equal(m.setRecorderCap(58).ok, false); assert.ok(m.setRecorderCap(57).ok);
  assert.equal(mon(D, null).setRecorderCap(5).ok, false);
});

test('localOnly guard: loopback + matching Host/Origin + JSON content-type only', () => {
  const H = { host: 'localhost:8788', 'content-type': 'application/json' };
  assert.ok(localOnly('127.0.0.1', H).ok); assert.ok(localOnly('::1', H).ok); assert.ok(localOnly('::ffff:127.0.0.1', { ...H, origin: 'http://localhost:8788', 'sec-fetch-site': 'same-origin' }).ok);
  assert.equal(localOnly('10.0.0.5', H).ok, false, 'remote client');
  assert.equal(localOnly('127.0.0.1', { ...H, origin: 'http://evil.example' }).ok, false, 'cross-origin');
  assert.equal(localOnly('127.0.0.1', { ...H, 'sec-fetch-site': 'cross-site' }).ok, false);
  assert.equal(localOnly('127.0.0.1', { ...H, host: 'evil.example:8788' }).ok, false, 'DNS rebinding Host');
  assert.equal(localOnly('127.0.0.1', { ...H, 'content-type': 'text/plain' }).ok, false, 'simple-form CSRF');
});

test('HTTP: GET /api/storage + POST /api/storage/recorder-cap (localhost, JSON); cross-origin refused 403', async () => {
  const { createServer } = require('../server/server');
  const D = tmp(); const st = new RecorderStore({ dir: path.join(D, 'r'), capBytes: 12 * GiB, log: () => {} }); const storage = mon(D, st);
  const engine = { storage, snapshot: () => ({}), routes: [] }; const srv = createServer(engine, {}); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve([res.statusCode, JSON.parse(d)])); }); r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end(); });
  try {
    const [s0, v] = await req('GET', '/api/storage'); assert.equal(s0, 200); assert.equal(v.bars.length, 8);
    const [s1, j1] = await req('POST', '/api/storage/recorder-cap', { capGb: 20 }); assert.equal(s1, 200, JSON.stringify(j1)); assert.equal(st.capBytes, 20 * GiB);
    const [s2] = await req('POST', '/api/storage/recorder-cap', { capGb: 30 }, { origin: 'http://evil.example' }); assert.equal(s2, 403); assert.equal(st.capBytes, 20 * GiB);
    const [s3] = await req('POST', '/api/storage/recorder-cap', { capGb: 30 }, { 'content-type': 'text/plain' }); assert.equal(s3, 403);
    const [s4, j4] = await req('POST', '/api/storage/recorder-cap', { capGb: -1 }); assert.equal(s4, 422); assert.match(j4.error, /between/);
  } finally { srv.close(); }
});

test('modules: a persisted runtime cap wins over RECORDER_CAP_GB at startup; out-of-range file ignored', () => {
  const modules = require('../server/modules');
  const D = tmp(); fs.mkdirSync(path.join(D, 'runtime')); fs.writeFileSync(path.join(D, 'runtime', 'recorder-cap.json'), JSON.stringify({ capGb: 15 }));
  const cfg = config.build({ STORAGE_DATA_DIR: D, RECORDER_DIR: path.join(D, 'recorder'), RECORDER_KALSHI: 'false', RECORDER_POLYMARKET: 'false', RECORDER_REF: 'false', RECORDER_ODDS: 'false' });
  const { Health } = require('../server/lib/health'); const eng = { cfg, health: new Health(), feeds: {}, addFeed(n, f) { this.feeds[n] = f; return f; }, log: () => {} };
  modules.recorder(eng); modules.storage(eng); assert.equal(eng.recorder.store.capBytes, 15 * GiB); assert.equal(eng.storage.measure().bars[0].limit, 15 * GiB);
  fs.writeFileSync(path.join(D, 'runtime', 'recorder-cap.json'), JSON.stringify({ capGb: 9999 })); const eng2 = { ...eng, cfg: config.build({ STORAGE_DATA_DIR: D, RECORDER_DIR: path.join(D, 'recorder') }), feeds: {} };
  modules.recorder(eng2); assert.equal(eng2.recorder.store.capBytes, 12 * GiB);
});
