'use strict';
// Synthetic memory load (run with --expose-gc by test/memory-bounded.test.js). No network beyond 127.0.0.1, no real APIs.
// Prints one JSON line: heap before/after (MB, after forced GC) + collection sizes.
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net'); const http = require('http');
const { sseStream, sse } = require('../../server/lib/mem');
const MB = 2 ** 20; const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed / MB; };
const mode = process.argv[2]; const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };

async function sseScenario(bounded, pushes) {
  const snap = 'x'.repeat(300 * 1024); // ~ a real desk snapshot
  let tick = null; const fire = () => tick && tick();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (bounded) sseStream(req, res, () => ({ s: snap }), { stallMs: 1e12, setTimer: (f) => { tick = f; return 1; }, clearTimer: () => { tick = null; } });
    else { const push = () => res.write('data: ' + JSON.stringify({ s: snap }) + '\n\n'); push(); tick = push; } // the pre-fix route
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = net.connect(srv.address().port, '127.0.0.1'); c.on('error', () => {});
  await new Promise((r) => c.on('connect', r)); c.write('GET /api/stream HTTP/1.1\r\nHost: x\r\n\r\n'); c.pause(); // stalled viewer: never reads
  while (!tick) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 20; i++) { fire(); await new Promise((r) => setImmediate(r)); } // let the kernel buffers fill first
  const h0 = heap();
  for (let i = 0; i < pushes; i++) { fire(); if (i % 20 === 0) await new Promise((r) => setImmediate(r)); }
  const h1 = heap(); c.destroy(); srv.close();
  out({ mode, pushes, simulatedMinutes: Math.round(pushes * 1.5 / 60), heap0: h0, heap1: h1, growthMB: h1 - h0, frames: sse.frames, skipped: sse.skipped });
}

function rolloverScenario(hours) {
  const { KalshiH2Paper } = require('../../server/kalshi-h2'); const { KalshiPilot } = require('../../server/live/kalshi-pilot'); const { KalshiRecorder } = require('../../server/recorder/kalshi');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memload-')); let t = Date.parse('2026-11-02T00:00:00Z'); const now = () => t;
  const L = { book: [], settle: [], market: [], series: [], trade: [] };
  const k = { on(x, f) { L[x].push(f); }, track() {}, emit(x, e) { for (const f of L[x]) f(e); } };
  const v1 = new KalshiH2Paper({ kalshi: k, dir: path.join(dir, 'h2'), now }); v1.start(); v1.stop(); v1.running = true;
  const pilot = new KalshiPilot({ v1, kalshi: k, dir: path.join(dir, 'pilot'), killFile: path.join(dir, 'KILL'), env: {}, now, fetchImpl: () => { throw new Error('no network in tests'); } });
  pilot.asks = new Map(); k.on('book', (e) => pilot.onAskBook(e)); // what start() wires when the pilot is enabled
  const rec = new KalshiRecorder({ store: { write() {} }, health: { register() {} }, now, get: async () => null, log: () => {} });
  const series = ['KXBTC15M', 'KXETH15M', 'KXSOL15M']; const W = 15 * 60e3; const peaks = { mk: 0, asks: 0, markets: 0 };
  let h0 = null; const t0 = t;
  for (let w = 0; t < t0 + hours * 3600e3; w++) {
    const open = t0 + w * W, close = open + W;
    for (const s of series) {
      const tk = `${s}-W${w}`; rec.track({ ticker: tk, series_ticker: s, open_time: new Date(open).toISOString(), close_time: new Date(close).toISOString() });
      const st = rec.markets.get(tk); for (let i = 0; i < 300; i++) { st.seen.add(tk + ':' + i); st.seenQ.push(tk + ':' + i); } // trade ids
      if (w % 2) { st.kind = 'extra-dropped'; } // half look like dropped sports/extra markets: they never settle
    }
    for (let sec = 900; sec >= 0; sec -= 30) { // a book every 30 s per market, never in the v1 band (no signals: decision logic untouched)
      t = close - sec * 1000;
      for (const s of series) k.emit('book', { tk: `${s}-W${w}`, series: s, rx: t, sent: t - 50, close, secLeft: sec, strike: 1, ya: 0.5, yas: 10, yb: 0.49, ybs: 10, askLadder: [[0.5, 10]] });
    }
    t = close + 6000; for (const st of rec.markets.values()) if (st.close <= t && st.kind !== 'extra-dropped') st.settled = true;
    rec.pollSettle(); v1.tick(); pilot.tick();
    peaks.mk = Math.max(peaks.mk, v1.mk.size); peaks.asks = Math.max(peaks.asks, pilot.asks.size); peaks.markets = Math.max(peaks.markets, rec.markets.size);
    if (w === 4 * 4) h0 = heap(); // after 4 h warm-up
  }
  const h1 = heap();
  out({ mode, hours, rollovers: hours * 4 * series.length, heap0: h0, heap1: h1, growthMB: h1 - h0, sizes: { mk: v1.mk.size, asks: pilot.asks.size, markets: rec.markets.size }, peaks });
}
if (mode === 'sse-bounded') sseScenario(true, +process.argv[3] || 3000);
else if (mode === 'sse-legacy') sseScenario(false, +process.argv[3] || 400);
else if (mode === 'rollover') rolloverScenario(+process.argv[3] || 72);
