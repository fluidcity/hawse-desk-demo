'use strict';
/**
 * Phone link for the live pilot: the auth proxy (scripts/auth-proxy.js) signs phone requests that came in through
 * `tailscale serve` with a Tailscale identity; the desk (server/server.js) verifies them. The shared HMAC key is generated
 * fresh at every desk start and written to data/runtime/pilot-link.key (0600, gitignored); the proxy re-reads it. It is never
 * logged and never sent to a browser. Any process running as Bryan's Windows user can already arm through localhost:8788,
 * so a key file readable by that same user grants nothing new.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.join(__dirname, '..', '..', 'data', 'runtime', 'pilot-link.key');
const PREFIX = 'x-hawse-link-';
const HDR = { v: PREFIX + 'v', ts: PREFIX + 'ts', nonce: PREFIX + 'nonce', login: PREFIX + 'login', allow: PREFIX + 'allow', body: PREFIX + 'body', sig: PREFIX + 'sig' };
/** Proxy allowlist name -> desk pilot actions it covers. Transfers, Test key and Recover are deliberately absent (PC only). */
const PHONE_ROUTES = { 'pilot-arm': ['arm-check', 'arm'], 'pilot-reset': ['reset'], 'pilot-disarm': ['disarm'] };
const PILOT_PREFIX = '/api/live/kalshi-pilot/';
const WINDOW_MS = 30_000, NONCE_MAX = 2048;

const routeOf = (what) => Object.keys(PHONE_ROUTES).find((k) => PHONE_ROUTES[k].includes(what)) || null;
const isLoopback = (a) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(a || ''));
const sha256 = (s) => crypto.createHash('sha256').update(s == null ? '' : s).digest('hex');
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
const validKey = (k) => typeof k === 'string' && k.length >= 32;

function envKey(env) {
  const k = env && env.HAWSE_PILOT_LINK_KEY; if (k == null || k === '') return null;
  if (!validKey(String(k).trim())) throw new Error('HAWSE_PILOT_LINK_KEY must be at least 32 characters');
  return String(k).trim();
}
/** Desk start: env override, else a fresh random key written atomically with mode 0600. Logs the file path only. */
function ensureKey({ env = process.env, file = KEY_FILE, log = () => {} } = {}) {
  const e = envKey(env); if (e) { log('[pilot-link] signing key from HAWSE_PILOT_LINK_KEY'); return e; }
  const k = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpf = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpf, k + '\n', { mode: 0o600 }); try { fs.chmodSync(tmpf, 0o600); } catch { /* windows */ }
  fs.renameSync(tmpf, file);
  log(`[pilot-link] new per-start signing key written to ${file}`);
  return k;
}
/** Proxy: re-read on demand (the desk rotates it on every start). null when absent. */
function readKey({ env = process.env, file = KEY_FILE } = {}) {
  const e = envKey(env); if (e) return e;
  try { const k = fs.readFileSync(file, 'utf8').trim(); return validKey(k) ? k : null; } catch { return null; }
}
const canonical = (f) => ['hawse-link-v1', String(f.method).toUpperCase(), f.url, f.ts, f.nonce, f.login, f.allow, f.body].join('\n');
const mac = (key, f) => crypto.createHmac('sha256', key).update(canonical(f)).digest('hex');

/** Headers the proxy adds to a phone request. `body` is the exact raw body string forwarded. */
function signHeaders(key, { method, url, login, allow = [], body = '', now = Date.now() }) {
  const f = { method, url, ts: String(now), nonce: crypto.randomBytes(16).toString('hex'), login: b64(login), allow: [].concat(allow).join(','), body: sha256(body) };
  return { [HDR.v]: '1', [HDR.ts]: f.ts, [HDR.nonce]: f.nonce, [HDR.login]: f.login, [HDR.allow]: f.allow, [HDR.body]: f.body, [HDR.sig]: mac(key, f) };
}
/** Remove every client-supplied x-hawse-link-* header (any case). Mutates and returns h. */
function stripLinkHeaders(h) { for (const k of Object.keys(h)) if (k.toLowerCase().startsWith(PREFIX)) delete h[k]; return h; }
const hasLinkHeaders = (h) => Object.keys(h || {}).some((k) => k.toLowerCase().startsWith(PREFIX));

/** Desk side. verify(req, rawBody) -> { ok:true, login, allow } | { ok:false, why }. Nonces remembered for 2x the window, bounded. */
function createVerifier({ key, now = Date.now, windowMs = WINDOW_MS } = {}) {
  const seen = new Map();
  const prune = (t) => { for (const [n, at] of seen) if (t - at > 2 * windowMs) seen.delete(n); while (seen.size > NONCE_MAX) seen.delete(seen.keys().next().value); };
  const verify = (req, raw) => {
    const t = now(); prune(t);
    const k = typeof key === 'function' ? key() : key; if (!validKey(k)) return { ok: false, why: 'phone link not available (no signing key on the desk)' };
    const peer = req.socket && req.socket.remoteAddress; if (!isLoopback(peer)) return { ok: false, why: 'phone requests must arrive from the auth proxy over loopback' };
    const h = req.headers || {};
    for (const n of Object.values(HDR)) if (h[n] == null || h[n] === '') return { ok: false, why: 'missing signed phone headers' };
    if (h[HDR.v] !== '1') return { ok: false, why: 'unknown link version' };
    if (!/^application\/json\b/i.test(String(h['content-type'] || '')) && String(req.method).toUpperCase() !== 'GET') return { ok: false, why: 'content-type must be application/json' };
    const ts = Number(h[HDR.ts]); if (!Number.isFinite(ts) || Math.abs(t - ts) > windowMs) return { ok: false, why: 'stale or future timestamp' };
    if (!/^[0-9a-f]{32}$/.test(h[HDR.nonce])) return { ok: false, why: 'bad nonce' };
    if (sha256(raw) !== h[HDR.body]) return { ok: false, why: 'body does not match the signature' };
    const want = Buffer.from(mac(k, { method: req.method, url: req.url, ts: h[HDR.ts], nonce: h[HDR.nonce], login: h[HDR.login], allow: h[HDR.allow], body: h[HDR.body] }), 'hex');
    const got = Buffer.from(/^[0-9a-f]{64}$/.test(h[HDR.sig]) ? h[HDR.sig] : '', 'hex');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'bad signature' };
    if (seen.has(h[HDR.nonce])) return { ok: false, why: 'replayed request (nonce already used)' };
    seen.set(h[HDR.nonce], t); prune(t);
    const login = unb64(h[HDR.login]); if (!login) return { ok: false, why: 'no Tailscale login' };
    return { ok: true, login, allow: String(h[HDR.allow]).split(',').filter(Boolean) };
  };
  verify.nonceCount = () => seen.size;
  return verify;
}
module.exports = { KEY_FILE, HDR, PREFIX, PHONE_ROUTES, PILOT_PREFIX, WINDOW_MS, routeOf, isLoopback, ensureKey, readKey, signHeaders, stripLinkHeaders, hasLinkHeaders, createVerifier, sha256 };
