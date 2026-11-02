'use strict';
// H7: THE ONLY Kalshi signing code in this repo. Its single job is the WebSocket handshake of the READ-ONLY market-data
// recorder (server/recorder/kalshi-ws.js). Kalshi's WebSocket needs an authenticated handshake even for public
// market-data channels (docs.kalshi.com → Quick Start: WebSockets).
//
// Scope, enforced by test/kalshi-ws.test.js:
//   * It signs one fixed string: <ms timestamp> + 'GET' + '/trade-api/ws/v2'. The method and path are constants, not
//     parameters, so it cannot sign any REST request (orders, portfolio, transfers...).
//   * No network code here: no fetch, no http(s), no WebSocket.
//   * The key is read from env server-side (KALSHI_API_KEY_ID plus KALSHI_PRIVATE_KEY_PATH or KALSHI_PRIVATE_KEY_PEM),
//     parsed once into a KeyObject, and kept only inside this closure. It is never logged, returned or written anywhere.
//   * Use a READ-ONLY key ("Read all data" only, "Full access" unticked): docs/kalshi-api-key.md. Even a leaked
//     read-only key cannot trade or move money.
// Ed25519 keys sign the message directly. RSA keys use RSA-PSS with SHA-256, MGF1-SHA-256 and salt = digest length.
const crypto = require('crypto');
const fs = require('fs');

const WS_PATH = '/trade-api/ws/v2';
const WS_METHOD = 'GET';
const WS_HOSTS = ['external-api-ws.kalshi.com', 'api.elections.kalshi.com', 'external-api-ws.demo.kalshi.co', 'demo-api.kalshi.co'];

/**
 * Normalize a PEM that went through an env var or a web form. Accepts real newlines (LF or CRLF), literal "\\n",
 * or a single line where the newlines became spaces or vanished: the header and footer are kept and the base64 body
 * is re-wrapped at 64 columns. Pure; never logs. Returns the input unchanged when it has no PEM armor.
 */
function normalizePem(raw) {
  const s = String(raw == null ? '' : raw).replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n').trim();
  const m = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----$/.exec(s);
  if (!m) return s;
  const head = [], body = []; // RFC 1421 headers (Proc-Type, DEK-Info) only exist in encrypted legacy keys; keep them verbatim
  for (const line of m[2].split('\n').map((x) => x.trim()).filter(Boolean)) (/^[A-Za-z-]+:/.test(line) ? head : body).push(line);
  const b64 = body.join('').replace(/\s+/g, '');
  const wrapped = b64.match(/.{1,64}/g) || [];
  return [`-----BEGIN ${m[1]}-----`, ...head, ...(head.length ? [''] : []), ...wrapped, `-----END ${m[1]}-----`, ''].join('\n');
}

/** Whether the env names the key (presence only; the values are never read here). */
function wsAuthConfigured(env = process.env) { return !!(env.KALSHI_API_KEY_ID && (env.KALSHI_PRIVATE_KEY_PATH || env.KALSHI_PRIVATE_KEY_PEM)); }

/** The Kalshi WebSocket URL is the only URL these headers may be sent to. */
function isKalshiWsUrl(u) { try { const x = new URL(u); return x.protocol === 'wss:' && WS_HOSTS.includes(x.hostname) && x.pathname === WS_PATH && !x.username && !x.password && !x.search; } catch { return false; } }

/**
 * Returns a function () => handshake headers, or null when no key is configured.
 * Throws a generic error (no key material in the message) if the key cannot be parsed.
 */
function makeWsAuth(env = process.env, now = () => Date.now()) {
  if (!wsAuthConfigured(env)) return null;
  const keyId = String(env.KALSHI_API_KEY_ID).trim();
  let key;
  try {
    const pem = env.KALSHI_PRIVATE_KEY_PEM ? normalizePem(env.KALSHI_PRIVATE_KEY_PEM) : normalizePem(fs.readFileSync(env.KALSHI_PRIVATE_KEY_PATH, 'utf8'));
    key = crypto.createPrivateKey(pem);
  } catch { throw new Error('Kalshi WS auth: the private key could not be read or parsed (check KALSHI_PRIVATE_KEY_PATH / KALSHI_PRIVATE_KEY_PEM)'); }
  const type = key.asymmetricKeyType;
  if (type !== 'ed25519' && type !== 'rsa') throw new Error('Kalshi WS auth: unsupported key type (use Ed25519 or RSA)');
  return function wsHandshakeHeaders() {
    const ts = String(now());
    const msg = Buffer.from(ts + WS_METHOD + WS_PATH, 'utf8');
    const sig = type === 'ed25519' ? crypto.sign(null, msg, key)
      : crypto.sign('sha256', msg, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
    return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'), 'KALSHI-ACCESS-TIMESTAMP': ts };
  };
}

module.exports = { makeWsAuth, wsAuthConfigured, isKalshiWsUrl, normalizePem, WS_PATH, WS_METHOD, WS_HOSTS };
