'use strict';
// H7 Stage L: desk-side Cloudflare recorder client (status + pull sync), the sync CLI, and the Storage panel 'cf' bar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { CfRecorderRemote } = require('../server/recorder/cf-remote');
const { StorageMonitor } = require('../server/storage');
const { main } = require('../scripts/cf-recorder-sync');

const TOKEN = 'tok-' + 'x'.repeat(40);
function remote(over = {}) {
  const c = { t: Date.UTC(2026, 9, 30, 22, 30), calls: [] };
  const chunks = [1, 2, 3].map((id) => ({ id, t0: c.t - (4 - id) * 60000, t1: c.t - (3 - id) * 60000, rows: 10 * id, data: zlib.gzipSync(Buffer.from(`{"s":"kalshi.book","id":${id}}\n`)) }));
  const st = () => ({ running: true, lastWriteAt: c.t - 20000, stale: false, stored: { chunks: 3, rows: 60, bytes: 1234 }, alarms: 900, restarts: 1, gaps: 2, recentGaps: [{ reason: 'poll-gap' }],
    http: { 'api.elections.kalshi.com': { req: 1000, s429: 3, share429: 0.003 }, 'clob.polymarket.com': { req: 400, s429: 0, share429: 0 } }, cfg: { maxBytes: 2 ** 31, retainDays: 14 }, kalshi: [{ tk: 'KXBTC15M-X' }], ...over });
  const fetchImpl = async (u, o) => { c.calls.push({ u, auth: o.headers.authorization, method: o.method }); const url = new URL(u);
    if (o.headers.authorization !== 'Bearer ' + TOKEN) return new Response('unauthorized', { status: 401 });
    if (url.pathname === '/status') return Response.json(st());
    if (url.pathname === '/pull/list') { const a = +url.searchParams.get('after'); return Response.json({ chunks: chunks.filter((x) => x.id > a).map(({ data, ...m }) => ({ ...m, bytes: data.length, streams: {} })) }); }
    if (url.pathname === '/pull/chunk') { const ch = chunks.find((x) => x.id === +url.searchParams.get('id')); return new Response(c.corrupt ? ch.data.subarray(1) : ch.data); }
    return new Response('nf', { status: 404 }); };
  return { c, chunks, fetchImpl, now: () => c.t };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-'));
const healthFake = () => { const h = { reg: {}, oks: 0, fails: [] }; h.register = (id, o) => { h.reg[id] = o; }; h.ok = () => h.oks++; h.fail = (id, e) => h.fails.push(e); return h; };

test('cf remote: status is LIVE with a fresh write, token sent only as a bearer header and never in the snapshot', async () => {
  const R = remote(), H = healthFake(); const r = new CfRecorderRemote({ url: 'https://hawse-recorder.example.workers.dev/', token: TOKEN, dir: tmp(), health: H, fetchImpl: R.fetchImpl, now: R.now });
  assert.equal(r.view().state, 'pending'); assert.equal(r.view().stale, true, 'no status yet is not LIVE');
  await r.status(); const v = r.view();
  assert.equal(v.state, 'live'); assert.equal(v.stale, false); assert.equal(v.lastWriteAgeS, 20); assert.equal(v.s429, 3); assert.equal(v.req, 1400); assert.equal(v.share429, +(3 / 1400).toFixed(5));
  assert.equal(v.host, 'hawse-recorder.example.workers.dev'); assert.equal(H.oks, 1); assert.ok(H.reg['rec.cf']);
  assert.ok(R.c.calls.every((x) => x.method === 'GET' && x.u.startsWith('https://hawse-recorder.example.workers.dev/status')));
  assert.ok(!JSON.stringify(r.snapshot()).includes(TOKEN) && !JSON.stringify(r).includes(TOKEN), 'token never serialized');
});

test('cf remote: STALE when the remote write is old, the remote is stopped, or the desk cannot reach it', async () => {
  for (const [over, re] of [[{ lastWriteAt: Date.UTC(2026, 9, 30, 22, 30) - 400000 }, /last write 400s ago/], [{ running: false }, /stopped/], [{ lastWriteAt: null }, /no chunk/], [{ stale: true, lastWriteAt: Date.UTC(2026, 9, 30, 22, 30) - 200000 }, /last write/]]) {
    const R = remote(over), H = healthFake(); const r = new CfRecorderRemote({ url: 'https://h.example', token: TOKEN, dir: tmp(), health: H, fetchImpl: R.fetchImpl, now: R.now });
    await r.status(); const v = r.view(); assert.equal(v.state, 'stale', JSON.stringify(over)); assert.match(v.staleReason, re); assert.equal(H.fails.length, 1);
  }
  const R = remote(); const r = new CfRecorderRemote({ url: 'https://h.example', token: TOKEN, dir: tmp(), fetchImpl: R.fetchImpl, now: R.now, statusMs: 60000 });
  await r.status(); assert.equal(r.view().state, 'live'); R.c.t += 181000; assert.equal(r.view().state, 'stale'); assert.match(r.view().staleReason, /could not reach/);
  const bad = new CfRecorderRemote({ url: 'https://h.example', token: 'wrong-token-wrong-token', dir: tmp(), fetchImpl: R.fetchImpl, now: R.now });
  await assert.rejects(bad.status(), /HTTP 401/); assert.equal(bad.view().state, 'down'); assert.equal(bad.view().stale, true);
  const off = new CfRecorderRemote({ url: '', token: '', dir: tmp() }); assert.equal(off.view().state, 'off'); assert.equal(await off.status(), null);
  assert.equal(new CfRecorderRemote({ url: 'http://plain.example', token: TOKEN, dir: tmp() }).configured, false, 'https only');
});

test('cf remote: sync downloads new chunks once, resumes from sync-state.json, and refuses a truncated chunk', async () => {
  const R = remote(), dir = tmp(); const r = new CfRecorderRemote({ url: 'https://h.example', token: TOKEN, dir, fetchImpl: R.fetchImpl, now: R.now });
  const s = await r.sync(); assert.equal(s.fetched, 3); assert.equal(s.lastId, 3);
  const f = path.join(dir, '2026-10-30', '000000002-cf.jsonl.gz'); assert.ok(fs.existsSync(f)); assert.match(zlib.gunzipSync(fs.readFileSync(f)).toString(), /"id":2/);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf8')); assert.equal(st.lastId, 3); assert.equal(st.files, 3); assert.equal(st.rows, 60);
  const n = R.c.calls.length; const r2 = new CfRecorderRemote({ url: 'https://h.example', token: TOKEN, dir, fetchImpl: R.fetchImpl, now: R.now });
  assert.equal((await r2.sync()).fetched, 0); assert.equal(R.c.calls.length, n + 1, 'resume: one list call, no chunk refetch');
  R.chunks.push({ id: 4, t0: R.c.t, t1: R.c.t, rows: 5, data: zlib.gzipSync(Buffer.from('{"s":"gap"}\n')) }); R.c.corrupt = true;
  await assert.rejects(r2.sync(), /chunk 4: .* expected/); assert.equal(r2.state.lastId, 3, 'a bad chunk is not marked synced'); assert.ok(!fs.readdirSync(path.join(dir, '2026-10-30')).some((x) => x.startsWith('000000004')));
});

test('cf remote: sync CLI prints counts only (never the token) and exits 2 when not configured', async () => {
  const R = remote(), dir = tmp(), out = []; R.c.t = Date.now(); const realFetch = global.fetch; global.fetch = R.fetchImpl;
  try { const code = await main([], { CF_RECORDER_URL: 'https://h.example', CF_RECORDER_READ_TOKEN: TOKEN, CF_RECORDER_DIR: dir }, (s) => out.push(s)); assert.equal(code, 0, 'LIVE → exit 0'); }
  finally { global.fetch = realFetch; }
  assert.match(out.join('\n'), /sync: fetched 3 chunk/); assert.ok(!out.join('\n').includes(TOKEN));
  const o2 = []; assert.equal(await main([], {}, (s) => o2.push(s)), 2); assert.match(o2[0], /not configured/);
});

test('cf remote: Storage panel gets a Cloudflare bar vs the remote cap; STALE turns it amber', async () => {
  const R = remote(); const r = new CfRecorderRemote({ url: 'https://h.example', token: TOKEN, dir: tmp(), fetchImpl: R.fetchImpl, now: R.now }); await r.status();
  const dataDir = tmp(); const S = new StorageMonitor({ dataDir, cf: r, statfs: () => ({ blocks: 1000, bsize: 4096, bavail: 500 }) });
  let b = S.measure().bars.find((x) => x.id === 'cf'); assert.equal(b.used, 1234); assert.equal(b.limit, 2 ** 31); assert.equal(b.level, 'ok'); assert.match(b.note, /^LIVE/); assert.equal(b.cf.state, 'live');
  R.c.t += 400000; b = S.measure().bars.find((x) => x.id === 'cf'); assert.equal(b.level, 'warn'); assert.match(b.note, /^STALE/);
  assert.ok(!new StorageMonitor({ dataDir, statfs: () => ({ blocks: 1, bsize: 1, bavail: 1 }) }).measure().bars.some((x) => x.id === 'cf'), 'no bar when not configured');
});
