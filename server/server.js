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

/** Inbound webhooks (e.g. POST /hooks/helius). Authenticated by the hook's own handler; ACK first, process after (Helius wants 200 within 1 s). */
function hookRoute(engine, req, res, p) {
  const hook = engine.hooks && engine.hooks[p];
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (!hook) return send(404, { error: 'not found' });
  const chunks = []; let n = 0, tooBig = false;
  req.on('data', (c) => { n += c.length; if (n > hook.maxBody) { tooBig = true; req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (tooBig) return send(413, { error: 'body too large' });
    const r = hook.handle({ method: req.method, headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
    send(r.status, r.body);
    if (r.status === 200 && r.txs.length) setImmediate(() => { try { hook.process(r); } catch (e) { engine.tape && engine.tape.push({ kind: 'error', msg: 'webhook processing error: ' + e.message }); } });
  });
}

/** Hooks-only listener (HOOKS_PORT): serves ONLY /hooks/*, so a tunnel can expose it without exposing the unauthenticated desk. */
function createHooksServer(engine) {
  return http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/hooks/')) return hookRoute(engine, req, res, p);
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
  });
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
    if (p.startsWith('/hooks/')) return hookRoute(engine, req, res, p);
    try {
      if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, mode: 'paper', uptimeSec: Math.round(process.uptime()) });
      if (p === '/api/state' && req.method === 'GET') return send(res, 200, engine.snapshot(flags));
      if (p === '/api/explain' && req.method === 'GET') return send(res, 200, { strategies: engine.explainAll() });
      if (p === '/api/providers' && req.method === 'GET') return send(res, 200, engine.providers.list());
      if (p === '/schema/strategy.schema.json') { res.writeHead(200, { 'content-type': 'application/json' }); return fs.createReadStream(path.join(__dirname, '..', 'schema', 'strategy.schema.json')).pipe(res); }
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
        if ((m = p.match(/^\/api\/strategy\/([\w-]+)\/arm$/))) { engine.arm(m[1], b.armed !== false); return send(res, 200, { ok: true }); }
        if (p === '/api/risk') { engine.setRisk({ dailyLossPct: b.dailyLossPct, maxDrawdownPct: b.maxDrawdownPct }); return send(res, 200, { ok: true }); }
        if (p === '/api/halt') { engine.halt(); return send(res, 200, { ok: true }); }
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
  const hooks = cfg.hooks.port ? createHooksServer(engine) : null;
  if (hooks) hooks.listen(cfg.hooks.port, cfg.hooks.host, () => console.log(`webhook receiver (hooks only) on http://${cfg.hooks.host}:${cfg.hooks.port}/hooks/*`));
  const bye = () => { engine.stop(); server.close(); hooks && hooks.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
module.exports = { createServer, createHooksServer };
