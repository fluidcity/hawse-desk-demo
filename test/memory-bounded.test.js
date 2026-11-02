'use strict';
// Memory: the 2026-11-01 OOM (heap ~4 GB after 5.4 h, ~12 MB/min). Child processes run with --expose-gc so heap numbers
// are measured after a forced GC; all feeds are mocked; the only socket is 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { sseStream, sse, memInfo, memLine } = require('../server/lib/mem');
const run = (...a) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures', 'mem-load.js'), ...a.map(String)], { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());

test('memory: the pre-fix SSE route leaks into a stalled client (~12 MB per simulated minute), reproducing the OOM rate', () => {
  const r = run('sse-legacy', 400); // 400 pushes = 10 min at 1.5 s
  assert.ok(r.growthMB > 80, `expected the old route to grow, got ${r.growthMB.toFixed(1)} MB`);
});

test('memory: bounded SSE keeps the heap flat for 75 simulated minutes of a stalled client', () => {
  const r = run('sse-bounded', 3000);
  assert.ok(r.growthMB < 10, `heap grew ${r.growthMB.toFixed(1)} MB`);
  assert.ok(r.skipped > 2900, 'frames are skipped while the client is not reading');
});

test('memory: 72 h of 15-minute rollovers (864 markets) keep per-market maps and the heap bounded', () => {
  const r = run('rollover', 72);
  assert.ok(r.peaks.markets <= 60, `recorder markets peaked at ${r.peaks.markets}`);
  assert.ok(r.peaks.asks <= 20, `pilot asks peaked at ${r.peaks.asks}`);
  assert.ok(r.peaks.mk <= 40, `v1 mk peaked at ${r.peaks.mk}`);
  assert.ok(r.growthMB < 5, `heap grew ${r.growthMB.toFixed(1)} MB after warm-up`);
});

function fakeRes() {
  const h = {}; return { writableLength: 0, destroyed: false, writableEnded: false, writes: 0, on(k, f) { h[k] = f; }, fire(k) { h[k] && h[k](); }, write() { this.writes++; this.writableLength += 1000; return false; }, destroy() { this.destroyed = true; } };
}
test('SSE: skips while buffered, resumes when drained, drops a client stalled past stallMs, and clears its timer', () => {
  let t = 0, tick = null, cleared = 0; const req = fakeRes(), res = fakeRes(); const c0 = sse.clients;
  sseStream(req, res, () => ({ a: 1 }), { maxBufferedBytes: 1500, stallMs: 10000, now: () => t, setTimer: (f) => { tick = f; return 7; }, clearTimer: () => cleared++ });
  assert.equal(res.writes, 1); assert.equal(sse.clients, c0 + 1);
  tick(); assert.equal(res.writes, 2); tick(); assert.equal(res.writes, 2, 'over the cap: skipped');
  res.writableLength = 0; tick(); assert.equal(res.writes, 3, 'drained: resumes with the newest snapshot');
  res.writableLength = 1e6; tick(); t = 9999; tick(); assert.equal(res.destroyed, false); t = 10001; tick();
  assert.equal(res.destroyed, true); assert.equal(cleared, 1); assert.equal(sse.clients, c0);
  req.fire('close'); res.fire('error'); assert.equal(cleared, 1); assert.equal(sse.clients, c0, 'cleanup runs once');
});

test('observability: memInfo + one short [mem] log line with collection sizes; snapshot/health expose heapUsedMB', () => {
  const m = memInfo(); assert.ok(m.heapUsedMB > 0 && m.rssMB > 0);
  const line = memLine({ kalshiPilot: { asks: new Map([['a', 1]]) }, tape: { rows: [1, 2] } });
  assert.match(line, /^\[mem\] heap [\d.]+MB rss [\d.]+MB .*pilot\.asks 1 .*tape 2 .*sse\.clients \d+/); assert.ok(line.length < 400);
  const fs = require('fs'); assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'engine.js'), 'utf8'), /mem: \{ \.\.\.memInfo\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8'), /heapUsedMB: memInfo\(\)\.heapUsedMB/);
});
