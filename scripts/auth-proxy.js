#!/usr/bin/env node
'use strict';
// HAWSE auth proxy: a zero-dependency reverse proxy in front of the running desk.
// Lets a PC or phone VIEW the single primary desk without exposing it and without
// restarting it. The desk keeps binding 127.0.0.1; the proxy is the only thing a viewer reaches.
//
//   HAWSE_ACCESS_TOKEN=<>=24 chars> node scripts/auth-proxy.js
//
// Env (names only; values are read here and never logged, echoed or sent to the client):
//   HAWSE_ACCESS_TOKEN          required, >= 24 chars, no whitespace (refuses to start otherwise)
//   HAWSE_PROXY_PORT            default 8789
//   HAWSE_PROXY_HOST            default 127.0.0.1 (put an HTTPS tunnel/terminator in front for remote use)
//   HAWSE_PROXY_UPSTREAM        default http://127.0.0.1:8788 (must be a loopback http URL)
//   HAWSE_PROXY_ALLOW_POST      default empty = READ-ONLY. Comma list from: halt, resume, reset-breaker, risk, arm
//                               Recommended phone setting: arm,halt,resume (strategy arm/disarm toggles + HALT/Resume
//                               buttons). reset-breaker and risk exist but are best left desk-only.
//   HAWSE_PROXY_INSECURE_COOKIE default off. "1" drops the cookie's Secure flag (plain-http LAN only; not recommended)
//
// Guarantees:
// - Auth on every route except /login (and POST /logout): session cookie (HttpOnly, Secure,
//   SameSite=Strict, random id, never the token) or `Authorization: Bearer <token>`;
//   constant-time compare; 5 failures per 15 min per address -> lockout (429).
// - Read-only by default: only GET/HEAD are forwarded. A POST is forwarded only if its exact
//   route is in the allowlist above. Every forwarded POST must also pass a CSRF check:
//   content-type application/json, and an Origin whose host equals Host (or, with no Origin,
//   Sec-Fetch-Site: same-origin). A Bearer client with neither header (curl, scripts) is allowed;
//   a cookie session never is. The session cookie is also SameSite=Strict.
// - /api/live-order, /api/storage/recorder-cap, lab and betting writes, and every PUT/PATCH/DELETE
//   are never forwarded, whatever the allowlist says.
// - SSE (/api/stream) streams through unbuffered; WebSocket upgrades are authenticated and piped.
// - The session cookie and Authorization header are stripped before forwarding, so the desk never sees them.
// - Logs: startup line, and lockouts (remote address only). No tokens, cookies, headers or bodies.
const http = require('http');
const net = require('net');
const path = require('path');
const { createAuth, startupCheck, isLoopback, COOKIE } = require(path.join(__dirname, '..', 'server', 'auth'));

const POST_ROUTES = { // name -> exact path matcher (the only mutating routes that may ever be forwarded)
  halt: (p) => p === '/api/halt',
  resume: (p) => p === '/api/resume',
  'reset-breaker': (p) => p === '/api/reset-breaker',
  risk: (p) => p === '/api/risk',
  arm: (p) => /^\/api\/strategy\/[\w-]+\/arm$/.test(p),
  'pilot-halt': (p) => p === '/api/live/kalshi-pilot/halt', // Stage Z: the live pilot's HALT (safe to forward: it only stops and cancels)
};
// Never forwarded, whatever HAWSE_PROXY_ALLOW_POST says: arming, disarming or resetting the real-money pilot happens on the desk machine only.
const PILOT_LOCAL_ONLY = (p) => p.startsWith('/api/live/') && p !== '/api/live/kalshi-pilot/halt';

function parseAllow(v) {
  const names = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!POST_ROUTES[n]) throw new Error(`refusing to start: HAWSE_PROXY_ALLOW_POST has unknown route "${n}" (allowed: ${Object.keys(POST_ROUTES).join(', ')})`);
  return names;
}

function parseUpstream(v) {
  let u; try { u = new URL(v || 'http://127.0.0.1:8788'); } catch (e) { throw new Error('refusing to start: HAWSE_PROXY_UPSTREAM is not a URL'); }
  if (u.protocol !== 'http:' || !isLoopback(u.hostname) || u.username || u.password || (u.pathname && u.pathname !== '/')) throw new Error('refusing to start: HAWSE_PROXY_UPSTREAM must be a plain http loopback origin, e.g. http://127.0.0.1:8788');
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: +(u.port || 80) };
}

function config(env = process.env) {
  startupCheck(env.HAWSE_ACCESS_TOKEN, 24);
  return {
    token: env.HAWSE_ACCESS_TOKEN,
    port: env.HAWSE_PROXY_PORT ? +env.HAWSE_PROXY_PORT : 8789,
    host: env.HAWSE_PROXY_HOST || '127.0.0.1',
    upstream: parseUpstream(env.HAWSE_PROXY_UPSTREAM),
    allowPost: parseAllow(env.HAWSE_PROXY_ALLOW_POST),
    secureCookie: !/^(1|true|yes)$/i.test(env.HAWSE_PROXY_INSECURE_COOKIE || ''),
  };
}

const SEC = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);

function stripCookie(h) {
  if (!h) return h;
  const kept = String(h).split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(COOKIE + '='));
  return kept.length ? kept.join('; ') : undefined;
}

function upstreamHeaders(req, up, { upgrade = false } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) { const l = k.toLowerCase(); if (HOP.has(l) || l === 'authorization' || l === 'cookie' || l === 'host') continue; h[l] = v; }
  const c = stripCookie(req.headers.cookie); if (c) h.cookie = c;
  h.host = `${up.host.includes(':') ? `[${up.host}]` : up.host}:${up.port}`;
  const xf = req.socket.remoteAddress || ''; h['x-forwarded-for'] = xf; h['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'; h['x-forwarded-host'] = req.headers.host || '';
  if (upgrade) { h.connection = 'Upgrade'; h.upgrade = req.headers.upgrade; }
  return h;
}

// CSRF / same-origin check for a forwarded POST (the same Origin-vs-Host rule the login form uses).
// -> null (ok) | [status, message]
function csrf(req, via) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return [415, 'POST through the proxy must be application/json'];
  const o = req.headers.origin, host = String(req.headers.host || '').toLowerCase(), sfs = req.headers['sec-fetch-site'];
  if (o !== undefined) {
    let h = null; try { if (o !== 'null') h = new URL(o).host.toLowerCase(); } catch (e) { h = null; }
    return h && h === host ? null : [403, 'cross-origin POST refused'];
  }
  if (sfs !== undefined) return sfs === 'same-origin' ? null : [403, 'cross-site POST refused'];
  return via === 'bearer' ? null : [403, 'POST without Origin refused for a cookie session'];
}

// Method/route policy. -> null (forward) | [status, message]
function policy(method, p, allowPost) {
  if (method === 'GET' || method === 'HEAD') return null;
  if (method === 'POST') {
    if (p === '/api/live-order') return [403, 'live orders are never forwarded (paper-only desk)'];
    if (PILOT_LOCAL_ONLY(p)) return [403, 'the live pilot can only be armed or reset on the desk machine itself; never through the proxy'];
    if (allowPost.some((n) => POST_ROUTES[n](p))) return null;
    return [403, 'read-only proxy: this POST is not on HAWSE_PROXY_ALLOW_POST'];
  }
  return [405, 'method not allowed through the proxy'];
}

function createProxy(cfg, { log = (m) => console.log(m), now } = {}) {
  const auth = createAuth({ token: cfg.token, secure: cfg.secureCookie, now });
  const up = cfg.upstream;
  const sendJson = (res, code, obj, extra = {}) => { res.writeHead(code, { ...SEC, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
  const lockLog = new Map();
  const noteLock = (req, r) => { if (r.status !== 429) return; const ip = req.socket.remoteAddress || '?'; if ((lockLog.get(ip) || 0) < Date.now() - 60e3) { lockLog.set(ip, Date.now()); log(`[auth-proxy] lockout active for ${ip}`); } };

  const server = http.createServer(async (req, res) => {
    // security headers on everything the proxy itself writes (login, refusals); added to proxied responses below
    const _wh = res.writeHead.bind(res);
    res.writeHead = (code, a, b) => { const hdrs = typeof a === 'object' && a ? a : b || {}; for (const [k, v] of Object.entries(SEC)) if (!(k in hdrs)) res.setHeader(k, v); return typeof a === 'string' ? _wh(code, a, hdrs) : _wh(code, hdrs); };
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { return sendJson(res, 400, { error: 'bad request' }); }
    try {
      if (await auth.handle(req, res, p)) { noteLock(req, { status: res.statusCode }); return; }
      const a = auth.check(req); if (!a.ok) { noteLock(req, a); return auth.deny(req, res, p, a); }
      const pol = policy(req.method, p, cfg.allowPost); if (pol) { req.resume(); return sendJson(res, pol[0], { error: pol[1] }); }
      if (req.method === 'POST') { const x = csrf(req, a.via); if (x) { req.resume(); return sendJson(res, x[0], { error: x[1] }); } }
      const pr = http.request({ host: up.host, port: up.port, method: req.method, path: req.url, headers: upstreamHeaders(req, up) }, (ur) => {
        const h = {}; for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
        if (/text\/event-stream/i.test(ur.headers['content-type'] || '')) { h['cache-control'] = 'no-store'; h['x-accel-buffering'] = 'no'; }
        res.writeHead(ur.statusCode, h); if (res.flushHeaders) res.flushHeaders();
        ur.pipe(res);
      });
      pr.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'desk unreachable' }); else res.destroy(); });
      req.on('aborted', () => pr.destroy()); res.on('close', () => pr.destroy());
      req.pipe(pr);
    } catch (e) { if (!res.headersSent) sendJson(res, 400, { error: 'bad request' }); }
  });
  server.requestTimeout = 60e3; // time to receive a request; SSE responses stay open
  server.headersTimeout = 30e3;

  const tunnels = new Set(); // upgraded sockets are not tracked by closeAllConnections(); close them ourselves
  const origClose = server.close.bind(server);
  server.close = (cb) => { for (const s of tunnels) s.destroy(); tunnels.clear(); return origClose(cb); };
  server.on('upgrade', (req, socket, head) => {
    // http.Server sockets are allowHalfOpen: without this a client FIN would leave the socket (and server.close) hanging.
    tunnels.add(socket); socket.on('close', () => tunnels.delete(socket));
    socket.on('error', () => socket.destroy()); socket.on('end', () => socket.destroy());
    const a = auth.check(req); if (!a.ok) { noteLock(req, a); return auth.refuseUpgrade(socket, a.status); }
    const o = req.headers.origin; if (o) { try { if (new URL(o).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return auth.refuseUpgrade(socket, 403); } catch (e) { return auth.refuseUpgrade(socket, 403); } }
    const us = net.connect(up.port, up.host, () => {
      const h = upstreamHeaders(req, up, { upgrade: true });
      us.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`).join('\r\n')).join('\r\n') + '\r\n\r\n');
      if (head && head.length) us.write(head);
      us.pipe(socket); socket.pipe(us);
    });
    tunnels.add(us); us.on('close', () => tunnels.delete(us));
    us.on('error', () => auth.refuseUpgrade(socket, 502)); us.on('end', () => us.destroy());
    socket.on('close', () => us.destroy()); us.on('close', () => socket.destroy());
  });
  return server;
}

if (require.main === module) {
  let cfg; try { cfg = config(); } catch (e) { console.error(e.message); process.exit(1); }
  const server = createProxy(cfg);
  server.listen(cfg.port, cfg.host, () => console.log(`[auth-proxy] http://${cfg.host}:${cfg.port} -> http://${cfg.upstream.host}:${cfg.upstream.port} · token REQUIRED · POST allowlist: ${cfg.allowPost.length ? cfg.allowPost.join(', ') : 'none (read-only)'} · cookie ${cfg.secureCookie ? 'Secure' : 'NOT Secure (insecure-cookie mode)'}`));
  const bye = () => server.close(() => process.exit(0)); process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
module.exports = { createProxy, config, policy, csrf, POST_ROUTES, PILOT_LOCAL_ONLY, parseUpstream, stripCookie };
