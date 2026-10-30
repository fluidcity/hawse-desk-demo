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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

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
      if (p === '/api/state' && req.method === 'GET') return send(res, 200, engine.snapshot(flags));
      if (p === '/api/providers' && req.method === 'GET') return send(res, 200, engine.providers.list());
      if (p === '/schema/strategy.schema.json') { res.writeHead(200, { 'content-type': 'application/json' }); return fs.createReadStream(path.join(__dirname, '..', 'schema', 'strategy.schema.json')).pipe(res); }
      if (p.startsWith('/api/lab')) { const r = await labRoute(engine.lab, req, p, url, body); if (r) return send(res, r[0], r[1]); }
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const push = () => res.write('data: ' + JSON.stringify(engine.snapshot(flags)) + '\n\n');
        push(); const iv = setInterval(push, 1500); req.on('close', () => clearInterval(iv)); return;
      }
      if (req.method === 'POST' && p.startsWith('/api/')) {
        const b = await body(req);
        let m;
        if ((m = p.match(/^\/api\/strategy\/([\w-]+)\/arm$/))) { engine.arm(m[1], b.armed !== false); return send(res, 200, { ok: true }); }
        if (p === '/api/risk') { engine.setRisk({ dailyLossPct: b.dailyLossPct, maxDrawdownPct: b.maxDrawdownPct }); return send(res, 200, { ok: true }); }
        if (p === '/api/halt') { engine.halt(); return send(res, 200, { ok: true }); }
        if (p === '/api/resume') { engine.resume(); return send(res, 200, { ok: true }); }
        if (p === '/api/reset-breaker') { engine.resetBreaker(); return send(res, 200, { ok: true }); }
        if (p === '/api/live-order') { try { engine.placeLiveOrder(); } catch (e) { return send(res, 403, { ok: false, error: e.message }); } }
        return send(res, 404, { error: 'not found' });
      }
      // static
      let file = path.normalize(path.join(PUB, decodeURIComponent(p === '/' ? '/index.html' : p)));
      if (!file.startsWith(PUB)) return send(res, 403, { error: 'forbidden' });
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { send(res, 400, { error: e.message }); }
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
module.exports = { createServer };
