'use strict';
// Zero-dependency HTTP server: serves /public and a small JSON + SSE API.
// Binds to 127.0.0.1 by default (no auth; do not expose publicly).
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Engine } = require('./engine');
const modules = require('./modules');

const PUB = path.join(__dirname, '..', 'public');
const { localOnly } = require('./storage');
const { isLoopback } = require('./auth');
/** Pilot arm/reset gate: loopback socket, no proxy headers at all, plus the same-origin JSON checks as other local-only routes. */
function pilotLocal(req) {
  const h = req.headers || {};
  if (h['x-forwarded-for'] != null || h['x-forwarded-host'] != null || h['forwarded'] != null || h['x-real-ip'] != null) return { ok: false, why: 'forwarded requests can never arm the live pilot' };
  if (!isLoopback(String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''))) return { ok: false, why: 'not loopback' };
  return localOnly(req.socket.remoteAddress, h);
}
const { resolveStatic } = require('./static');

async function labRoute(lab, req, p, url, body) {
  if (!lab) return [404, { error: 'lab module disabled' }];
  let m; const G = req.method === 'GET', P = req.method === 'POST';
  if (G && p === '/api/lab') return [200, lab.list()];
  if ((m = p.match(/^\/api\/lab\/configs\/([a-z0-9-]+)(?:\/(export|duplicate|backtest|run|delete))?$/))) {
    const [, id, act] = m, v = url.searchParams.get('v') || undefined;
    if (G && !act) { const c = lab.get(id, v); return c ? [200, { config: c, versions: lab.db.configs[id].map((x) => ({ version: x.version, status: x.status, savedAt: x.savedAt })) }] : [404, { error: 'not found' }]; }
    if (G && act === 'export') { const c = lab.exportJson(id, v); return c ? [200, c] : [404, { error: 'not found' }]; }
    if (!P) return [405, { error: 'method' }];
    const b = await body(req);
    if (act === 'duplicate') return [200, lab.duplicate(id, b.version)];
    if (act === 'backtest') return [200, await lab.backtest(id, b.version, { limit: Math.min(1500, +b.limit || 1000) })];
    if (act === 'run') return [200, b.on === false ? lab.stopRun(id) : lab.startRun(id, b.version)];
    if (act === 'delete') return [200, lab.remove(id)];
  }
  if (P && p === '/api/lab/configs') { const b = await body(req); const r = b.fromTemplate ? lab.fromTemplate(b.fromTemplate) : lab.save(b.config || {}); return [r.ok ? 200 : 422, r]; }
  if (P && p === '/api/lab/import') { const b = await body(req); const r = lab.importAny(b); return [r.ok ? 200 : 422, r]; }
  return null;
}

function createServer(engine, flags) {
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e5) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, mode: 'paper', uptimeSec: Math.round(process.uptime()) });
      if (p === '/api/state' && req.method === 'GET') return send(res, 200, engine.snapshot(flags));
      if (p === '/api/explain' && req.method === 'GET') return send(res, 200, { strategies: engine.explainAll() });
      if (p === '/api/providers' && req.method === 'GET') return send(res, 200, engine.providers.list());
      if (p === '/api/storage' && req.method === 'GET') return engine.storage ? send(res, 200, engine.storage.snapshot()) : send(res, 404, { error: 'storage panel off' });
      if (p === '/api/storage/recorder-cap' && req.method === 'POST') { // H7: same-origin + localhost only; validated; persisted to data/runtime (gitignored)
        const g = localOnly(req.socket.remoteAddress, req.headers); if (!g.ok) return send(res, 403, { ok: false, error: 'refused: ' + g.why });
        if (!engine.storage) return send(res, 404, { ok: false, error: 'storage panel off' });
        const b = await body(req); const r = engine.storage.setRecorderCap(b.capGb, { by: 'ui' }); return send(res, r.ok ? 200 : 422, r);
      }
      if (p === '/schema/strategy.schema.json') { res.writeHead(200, { 'content-type': 'application/json' }); return fs.createReadStream(path.join(__dirname, '..', 'schema', 'strategy.schema.json')).pipe(res); }
      if (p.startsWith('/api/live/kalshi-pilot/')) { // Stage Z. halt: forwardable. arm/disarm/reset/test-key/transfer-*: this machine only, never through the proxy.
        const pl = engine.kalshiPilot; if (!pl) return send(res, 404, { ok: false, error: 'pilot not loaded' });
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
        const what = p.slice('/api/live/kalshi-pilot/'.length);
        if (what === 'halt') { const r = await pl.halt('HALT button'); return send(res, 200, r); }
        if (!['arm', 'disarm', 'reset', 'test-key', 'transfer-prepare', 'transfer-confirm', 'transfer-cancel'].includes(what)) return send(res, 404, { ok: false, error: 'not found' });
        const g = pilotLocal(req); if (!g.ok) return send(res, 403, { ok: false, error: 'refused: ' + g.why });
        const b = await body(req);
        if (what === 'test-key') { const r = await pl.testKey(); return send(res, 200, { ok: r.ok, keyTest: pl.snapshot().keyTest }); } // signed GETs only, no orders
        if (what.startsWith('transfer-')) { // Move cash between Bryan's own pools: desk PC only, two steps, never automatic
          const r = what === 'transfer-prepare' ? await pl.transferPrepare(b) : what === 'transfer-confirm' ? await pl.transferConfirm(b) : pl.transferCancel();
          return send(res, r.ok ? 200 : 422, r);
        }
        const r = what === 'arm' ? await pl.arm(b.phrase) : what === 'disarm' ? pl.disarm() : pl.reset(b.phrase);
        return send(res, r.ok ? 200 : 403, r);
      }
      for (const r of engine.routes || []) if (p.startsWith(r.prefix)) { // module-owned routes (e.g. server/betting/routes.js)
        const x = await r.handle(req.method, p, () => body(req)); if (!x) continue;
        if (Array.isArray(x)) return send(res, x[0], x[1]);
        res.writeHead(x.status, { 'content-type': x.type, 'cache-control': 'no-store', ...(x.filename ? { 'content-disposition': `attachment; filename="${x.filename}"` } : {}) }); return res.end(x.body);
      }
      if (p.startsWith('/api/lab')) { const r = await labRoute(engine.lab, req, p, url, body); if (r) return send(res, r[0], r[1]); }
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const push = () => res.write('data: ' + JSON.stringify(engine.snapshot(flags)) + '\n\n');
        push(); const iv = setInterval(push, 1500); req.on('close', () => clearInterval(iv)); return;
      }
      if (req.method === 'POST' && p.startsWith('/api/')) {
        const b = await body(req);
        let m;
        if ((m = p.match(/^\/api\/strategy\/([\w-]+)\/arm$/))) { if (!engine.strategy(m[1])) return send(res, 404, { ok: false, error: 'unknown strategy' }); const r = engine.arm(m[1], b.armed !== false); return send(res, 200, { ok: true, persisted: r.persisted }); }
        if (p === '/api/risk') { engine.setRisk({ dailyLossPct: b.dailyLossPct, maxDrawdownPct: b.maxDrawdownPct }); return send(res, 200, { ok: true }); }
        if (p === '/api/halt') { engine.halt(); if (engine.kalshiPilot && engine.kalshiPilot.state === 'ARMED') await engine.kalshiPilot.halt('desk HALT'); return send(res, 200, { ok: true }); }
        if (p === '/api/resume') { engine.resume(); return send(res, 200, { ok: true }); }
        if (p === '/api/reset-breaker') { engine.resetBreaker(); return send(res, 200, { ok: true }); }
        if (p === '/api/live-order') { try { engine.placeLiveOrder(); } catch (e) { return send(res, 403, { ok: false, error: e.message }); } }
        return send(res, 404, { error: 'not found' });
      }
      // static (boundary rules in server/static.js)
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const r = resolveStatic(PUB, p);
      if (r.status !== 200) return send(res, r.status, { error: r.status === 400 ? 'bad request' : 'not found' });
      res.writeHead(200, { 'content-type': r.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(r.file).pipe(res);
    } catch (e) { send(res, 400, { error: e.message }); } // API validation errors only; static never throws (server/static.js)
  });
}

if (require.main === module) {
  config.loadDotEnv();
  const cfg = config.build();
  const engine = new Engine(cfg, { modules });
  engine.start();
  const server = createServer(engine, config.publicFlags(cfg));
  server.listen(cfg.port, cfg.host, () => console.log(`HAWSE paper desk on http://${cfg.host}:${cfg.port}  (PAPER ONLY)`));
  const bye = () => { engine.stop(); server.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
module.exports = { createServer, pilotLocal };
