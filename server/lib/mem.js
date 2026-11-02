'use strict';
// Memory observability + the bounded SSE writer (2026-11-01 leak fix).
//
// The /api/stream SSE route pushed a full desk snapshot (~250-400 KB of JSON) every 1.5 s with res.write() and ignored
// backpressure. A client that keeps the TCP connection open but stops reading (a sleeping laptop / phone tab, a
// proxy or tunnel holding a dead viewer, a throttled background tab) makes Node queue every frame in the socket's
// write buffer, in the JS heap, forever: ~300 KB x 40/min = ~12 MB/min, the growth seen before the 18:43 OOM.
// sseStream() skips a frame while the previous ones are still unsent and drops a client that has not drained for
// stallMs. The live client always gets the newest snapshot on the next push, so nothing it shows changes.
const MB = 2 ** 20;
const sse = { clients: 0, opened: 0, frames: 0, skipped: 0, dropped: 0 };

function sseStream(req, res, snap, { everyMs = 1500, maxBufferedBytes = 2 * MB, stallMs = 60000, now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  sse.clients++; sse.opened++;
  let iv = null, closed = false, stalledSince = null;
  const done = () => { if (closed) return; closed = true; sse.clients--; if (iv != null) clearTimer(iv); };
  const push = () => {
    if (closed || res.destroyed || res.writableEnded) return done();
    if (res.writableLength > maxBufferedBytes) {
      sse.skipped++; if (stalledSince == null) stalledSince = now();
      if (now() - stalledSince >= stallMs) { sse.dropped++; done(); try { res.destroy(); } catch { /* already gone */ } }
      return;
    }
    stalledSince = null; sse.frames++;
    res.write('data: ' + JSON.stringify(snap()) + '\n\n');
  };
  req.on('close', done); res.on('close', done); res.on('error', done);
  push(); if (!closed) iv = setTimer(push, everyMs);
  return { push, close: done };
}

const mb = (x) => Math.round((x / MB) * 10) / 10;
/** heapUsed / rss / external in MB (rounded to 0.1). */
function memInfo() { const m = process.memoryUsage(); return { heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), rssMB: mb(m.rss), externalMB: mb(m.external), arrayBuffersMB: mb(m.arrayBuffers || 0) }; }

const sz = (x) => (x == null ? null : x instanceof Map || x instanceof Set ? x.size : Array.isArray(x) ? x.length : typeof x === 'object' ? Object.keys(x).length : null);
/** Sizes of the main in-memory collections that grow with markets / ticks (null when a module is off). */
function collectionSizes(engine) {
  const e = engine || {}, rec = e.recorder || {}, k = rec.kalshi || {}, v1 = e.kalshiH2 || {}, v2 = e.kalshiH2v2 || {}, v3 = e.kalshiH2v3 || {}, p = e.kalshiPilot || {};
  const out = {
    'rec.markets': sz(k.markets), 'v1.mk': sz(v1.mk), 'v1.fills': sz(v1.fills), 'v1.signals': sz(v1.signals), 'v2.tracks': sz(v2.tracks), 'v2.rows': sz(v2.rows),
    'v3.rows': sz(v3.rows), 'v3.trades': sz(v3.trades), 'v3.live': sz(v3.live), 'pilot.signals': sz(p.signals), 'pilot.asks': sz(p.asks), 'pilot.tx': p.history ? sz(p.history.tx) : null,
    'tape': e.tape ? sz(e.tape.rows) : null, 'curve': e.ledger ? sz(e.ledger.curve) : null, 'sse.clients': sse.clients,
  };
  for (const key of Object.keys(out)) if (out[key] == null) delete out[key];
  return out;
}
/** One short desk-log line: "[mem] heap 115.2MB rss 180.4MB ext 3.1MB · rec.markets 41 · v1.mk 12 · ... · sse 1 (skipped 0, dropped 0)". */
function memLine(engine) {
  const m = memInfo(), c = collectionSizes(engine);
  return `[mem] heap ${m.heapUsedMB}MB rss ${m.rssMB}MB ext ${m.externalMB}MB · ` + Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' · ') + ` · sse skipped ${sse.skipped} dropped ${sse.dropped}`;
}
module.exports = { sseStream, sse, memInfo, memLine, collectionSizes, MB };
