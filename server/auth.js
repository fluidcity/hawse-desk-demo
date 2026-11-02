'use strict';
// Access-token gate (HAWSE_ACCESS_TOKEN), used by scripts/auth-proxy.js in front of the desk.
// - The token is read server-side from env only. It is never logged, echoed, put in a
//   cookie, or sent to the browser. A successful login gets a random session id instead.
// - Accepted credentials: the session cookie (HttpOnly, SameSite=Strict) or
//   `Authorization: Bearer <token>`. Token comparison is constant-time (sha256 + timingSafeEqual).
// - Failed attempts are rate limited per remote address; a locked address gets 429 even
//   with the right token until the window passes.
const crypto = require('crypto');

const COOKIE = 'hawse_session';
const MIN_TOKEN_LEN = 24;

function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h === '::ffff:127.0.0.1';
}

// Startup policy: a token is always required. Throws with a message that never includes the token.
function startupCheck(token, minLen = MIN_TOKEN_LEN) {
  const t = token == null ? '' : String(token);
  if (!t) throw new Error('refusing to start: HAWSE_ACCESS_TOKEN is not set');
  if (/\s/.test(t)) throw new Error('refusing to start: HAWSE_ACCESS_TOKEN must not contain whitespace');
  if (t.length < minLen) throw new Error(`refusing to start: HAWSE_ACCESS_TOKEN must be at least ${minLen} characters`);
  return { required: true };
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b)); // fixed-length digests: constant-time, no length leak

function parseCookies(h) {
  const o = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}

const LOGIN_HTML = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HAWSE desk · sign in</title><style>body{background:#0b0e13;color:#d7dde6;font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
form{background:#121821;border:1px solid #233;padding:24px;border-radius:8px;width:300px}input{width:100%;box-sizing:border-box;padding:8px;margin:8px 0;background:#0b0e13;color:#d7dde6;border:1px solid #345;border-radius:4px}
button{width:100%;padding:8px;background:#1f6f4a;color:#fff;border:0;border-radius:4px;cursor:pointer}.m{color:#ff6b6b;min-height:1.2em}.d{color:#7a8594;font-size:12px}</style></head>
<body><form method="post" action="/login" autocomplete="off"><b>HAWSE paper desk</b><div class="d">PAPER ONLY · access token required</div>
<input type="password" name="token" placeholder="access token" autofocus required><div class="m">${msg || ''}</div><button type="submit">Sign in</button></form></body></html>`;

function createAuth({ token, secure = true, now = Date.now, maxFails = 5, windowMs = 15 * 60e3, sessionMs = 7 * 24 * 3600e3, maxSessions = 1000 } = {}) {
  const required = !!token;
  const sessions = new Map(); // id -> expiry
  const fails = new Map(); // remote -> { n, first }
  const remoteOf = (req) => String((req.socket && req.socket.remoteAddress) || '?');
  const locked = (ip) => { const f = fails.get(ip); if (!f) return 0; if (now() - f.first > windowMs) { fails.delete(ip); return 0; } return f.n >= maxFails ? Math.ceil((f.first + windowMs - now()) / 1000) : 0; };
  const fail = (ip) => { const f = fails.get(ip); if (!f || now() - f.first > windowMs) fails.set(ip, { n: 1, first: now() }); else f.n++; if (fails.size > 10000) fails.clear(); };
  const sessionOk = (id) => { if (!id || !/^[a-f0-9]{64}$/.test(id)) return false; const e = sessions.get(id); if (!e) return false; if (e < now()) { sessions.delete(id); return false; } return true; };
  const newSession = () => {
    if (sessions.size >= maxSessions) { for (const [k, e] of sessions) if (e < now()) sessions.delete(k); if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value); }
    const id = crypto.randomBytes(32).toString('hex'); sessions.set(id, now() + sessionMs); return id;
  };
  const cookie = (id, maxAge) => `${COOKIE}=${id}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=${maxAge}`;

  // -> { ok } | { ok:false, status, retryAfter? }
  function check(req) {
    if (!required) return { ok: true };
    if (sessionOk(parseCookies(req.headers.cookie)[COOKIE])) return { ok: true, via: 'cookie' };
    const a = req.headers.authorization;
    if (a) {
      const ip = remoteOf(req), wait = locked(ip);
      if (wait) return { ok: false, status: 429, retryAfter: wait };
      const m = /^Bearer\s+(\S+)$/i.exec(a);
      if (m && safeEqual(m[1], token)) return { ok: true, via: 'bearer' };
      fail(ip); return { ok: false, status: 401 };
    }
    return { ok: false, status: 401 };
  }

  const readForm = (req) => new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 4096) { d = ''; req.destroy(); } });
    req.on('end', () => {
      try { if (/json/i.test(req.headers['content-type'] || '')) return resolve(String(JSON.parse(d || '{}').token || '')); } catch (e) { return resolve(''); }
      resolve(new URLSearchParams(d).get('token') || '');
    });
    req.on('error', () => resolve(''));
  });

  const page = (res, code, msg, extra = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...extra }); res.end(LOGIN_HTML(msg)); };

  // Handles /login and /logout. Returns true when it answered the request.
  async function handle(req, res, p) {
    if (p === '/logout' && req.method === 'POST') {
      const id = parseCookies(req.headers.cookie)[COOKIE]; if (id) sessions.delete(id);
      res.writeHead(303, { location: required ? '/login' : '/', 'set-cookie': cookie('', 0), 'cache-control': 'no-store' }); res.end(); return true;
    }
    if (p !== '/login') return false;
    if (!required) { res.writeHead(303, { location: '/' }); res.end(); return true; }
    if (req.method === 'GET' || req.method === 'HEAD') { page(res, 200, ''); return true; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return true; }
    const o = req.headers.origin; let xo = false; if (o && o !== 'null') { try { xo = new URL(o).host.toLowerCase() !== String(req.headers.host || '').toLowerCase(); } catch (e) { xo = true; } }
    if (xo || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) { await readForm(req); page(res, 403, 'Cross-site sign-in refused.'); return true; }
    const ip = remoteOf(req), wait = locked(ip);
    if (wait) { await readForm(req); page(res, 429, 'Too many failed attempts. Try again later.', { 'retry-after': String(wait) }); return true; }
    const t = await readForm(req);
    if (!t || !safeEqual(t, token)) { fail(ip); page(res, 401, 'Wrong access token.'); return true; }
    fails.delete(ip);
    res.writeHead(303, { location: '/', 'set-cookie': cookie(newSession(), Math.floor(sessionMs / 1000)), 'cache-control': 'no-store' }); res.end(); return true;
  }

  // Unauthenticated response for a protected route: JSON for /api (and SSE), redirect for pages.
  function deny(req, res, p, r) {
    const h = { 'cache-control': 'no-store', ...(r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}) };
    if (p.startsWith('/api/') || p.startsWith('/schema/') || req.method !== 'GET' || !/text\/html/.test(req.headers.accept || '')) {
      res.writeHead(r.status, { 'content-type': 'application/json', ...h }); return res.end(JSON.stringify({ error: r.status === 429 ? 'too many failed attempts' : 'auth required', login: '/login' }));
    }
    res.writeHead(302, { location: '/login', ...h }); res.end();
  }

  // Raw refusal on an HTTP upgrade (websocket) socket.
  function refuseUpgrade(socket, code) {
    const txt = { 401: 'Unauthorized', 403: 'Forbidden', 429: 'Too Many Requests', 502: 'Bad Gateway' }[code] || 'Error';
    try { socket.end(`HTTP/1.1 ${code} ${txt}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); } catch (e) { socket.destroy(); }
  }

  return { required, check, handle, deny, refuseUpgrade, _sessions: sessions };
}

module.exports = { createAuth, startupCheck, isLoopback, COOKIE, MIN_TOKEN_LEN };
