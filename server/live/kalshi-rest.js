'use strict';
// Kalshi LIVE PILOT signed REST client. THIS FILE IS THE ONLY CODE IN THE REPO THAT NAMES A KALSHI ORDER OR PORTFOLIO
// ENDPOINT (enforced by test/kalshi-ws.test.js and test/kalshi-pilot.test.js). It is used only by server/live/kalshi-pilot.js.
//
// Keys (process env only, see resolveTradeKey): a dedicated KALSHI_TRADE_KEY_ID + KALSHI_TRADE_PRIVATE_KEY_PEM pair when both are set,
// otherwise the desk's existing KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PEM. Only server/live/kalshi-pilot.js uses this client, and it only
// calls createOrder when LIVE_PILOT_ENABLED === 'true' AND the pilot is ARMED. REST over HTTPS only: no websocket in the order path.
// Key material is never logged, returned, or put in an error message.
//
// API reference (docs.kalshi.com, read 2026-11-01):
// - Create Order V2: POST /trade-api/v2/portfolio/events/orders, body { ticker, side: 'bid' (= buy YES), count: "N.00",
//   price: "0.9500" (fixed-point dollars), time_in_force: 'immediate_or_cancel', self_trade_prevention_type, client_order_id,
//   subaccount? }. 201 -> { order_id, client_order_id, fill_count, remaining_count, average_fill_price, average_fee_paid, ts_ms }.
//   The legacy POST /portfolio/orders (action/side/yes_price in cents) is deprecated (no earlier than 2026-05-06), so V2 is used.
//   DOC UNCERTAINTY: the docs do not say whether client_order_id is deduplicated server-side; the pilot never re-sends an
//   intent after a restart, so it does not rely on that. count is sent as a 2-decimal string per the V2 example.
// - Cancel Order V2: DELETE /portfolio/events/orders/{order_id}?market_ticker=..  (Cancel-all exists but is NOT used: it would also cancel orders the pilot did not place.)
// - GET /portfolio/balance (balance in cents), /portfolio/fills (fee_cost dollars string, count_fp, yes_price_dollars),
//   /portfolio/orders?ticker= (client_order_id in each order), /portfolio/settlements?ticker= (revenue cents, fee_cost), /api_keys (scopes).
// - Signing: base64(sign(timestampMs + METHOD + '/trade-api/v2' + path-without-query)). Ed25519 signs the bytes directly;
//   RSA keys use RSA-PSS SHA-256, MGF1-SHA256, salt length = digest length. Key type is taken from the parsed key.
const crypto = require('crypto');

const HOST = 'https://external-api.kalshi.com'; // production (api.elections.kalshi.com is documented as equivalent)
const PREFIX = '/trade-api/v2';
const SERIES = ['KXBTC15M', 'KXETH15M', 'KXSOL15M'];
const MAX_PRICE_CENTS = 98;
const EP = Object.freeze({
  balance: '/portfolio/balance', fills: '/portfolio/fills', orders: '/portfolio/orders', settlements: '/portfolio/settlements',
  createOrder: '/portfolio/events/orders', cancelOrder: (id) => '/portfolio/events/orders/' + encodeURIComponent(id),
  apiKeys: '/api_keys',
});

class KalshiHttpError extends Error { constructor(status, code, msg) { super(`kalshi ${status}${code ? ' ' + code : ''}: ${msg || 'request failed'}`); this.status = status; this.code = code || null; } }

function normalizePem(v) { const s = String(v || '').trim().replace(/\\n/g, '\n'); return s.replace(/(-----BEGIN [A-Z ]+-----)\s*/, '$1\n').replace(/\s*(-----END [A-Z ]+-----)/, '\n$1'); }
/**
 * Which key signs pilot requests. Process env only; the key is never changed, printed, logged or returned.
 * 1. KALSHI_TRADE_KEY_ID + KALSHI_TRADE_PRIVATE_KEY_PEM, when BOTH are set (explicit override): 'dedicated trade key'.
 * 2. Otherwise the desk's existing KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PEM (or its KALSHI_PRIVATE_KEY_PATH file, as the desk's WS signer reads it): 'existing desk key'.
 * Returns { found, source, keyId?, key?, error? }. keyId/key are only for the signer inside this file and never serialised;
 * `error` never contains key contents.
 */
function resolveTradeKey({ env = process.env, readFile = require('fs').readFileSync } = {}) {
  const v = (n) => String(env[n] || '').trim();
  let keyId, pem, source;
  if (v('KALSHI_TRADE_KEY_ID') && v('KALSHI_TRADE_PRIVATE_KEY_PEM')) { keyId = v('KALSHI_TRADE_KEY_ID'); pem = v('KALSHI_TRADE_PRIVATE_KEY_PEM'); source = 'dedicated trade key'; }
  else if (v('KALSHI_API_KEY_ID') && (v('KALSHI_PRIVATE_KEY_PEM') || v('KALSHI_PRIVATE_KEY_PATH'))) { // same vars and order as the desk's own WS signer
    keyId = v('KALSHI_API_KEY_ID'); source = 'existing desk key';
    if (v('KALSHI_PRIVATE_KEY_PEM')) pem = v('KALSHI_PRIVATE_KEY_PEM');
    else { try { pem = readFile(v('KALSHI_PRIVATE_KEY_PATH'), 'utf8'); } catch { return { found: false, source, error: 'existing desk key file (KALSHI_PRIVATE_KEY_PATH) could not be read' }; } }
  }
  else return { found: false, source: null, error: 'no Kalshi key set (neither the desk key nor a dedicated trade key)' };
  let key; try { key = crypto.createPrivateKey(normalizePem(pem)); } catch { return { found: false, source, error: source + ' is set but is not a readable PEM private key (contents not shown)' }; }
  if (key.type !== 'private' || !['ed25519', 'rsa'].includes(key.asymmetricKeyType)) return { found: false, source, error: source + ' must be an Ed25519 or RSA private key' };
  return { found: true, source, keyId, key };
}
/** Presence only (never values): key source + set/not set, and the flags. */
function tradeEnvPresence(env = process.env) {
  const k = resolveTradeKey({ env });
  return { keySource: k.source, keySet: k.found, subaccount: !!String(env.KALSHI_TRADE_SUBACCOUNT || '').trim(), enabledFlag: env.LIVE_PILOT_ENABLED === 'true' };
}
/** Parse "0.123456" style dollar strings to integer micro-dollars, exactly (no floats). */
function dollarsToMicros(s) {
  if (s == null || s === '') return null; const m = /^(-)?(\d+)(?:\.(\d{0,6})\d*)?$/.exec(String(s).trim()); if (!m) return null;
  const v = Number(m[2]) * 1e6 + Number(((m[3] || '') + '000000').slice(0, 6)); return m[1] ? -v : v;
}
function countToInt(s) { const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
const centsToPrice = (c) => (c / 100).toFixed(4);

/** Validate a pilot order before it can be signed: the three series, YES BUY only, integer contracts, 1..98 cents, IOC. */
function validateOrder(o) {
  if (!o || typeof o.ticker !== 'string' || !SERIES.some((s) => o.ticker.startsWith(s + '-'))) throw new Error('refused: ticker outside KXBTC15M/KXETH15M/KXSOL15M');
  if (o.side !== 'yes' || o.action !== 'buy') throw new Error('refused: the pilot only buys YES');
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > 100000) throw new Error('refused: count must be a positive integer');
  if (!Number.isInteger(o.priceCents) || o.priceCents < 1 || o.priceCents > MAX_PRICE_CENTS) throw new Error('refused: limit price must be 1..98 cents');
  if (typeof o.clientOrderId !== 'string' || !/^[\w-]{8,64}$/.test(o.clientOrderId)) throw new Error('refused: client_order_id missing or malformed');
  return true;
}

/** Build the signed client, or null when either trade key env var is absent. fetchImpl is injectable (tests never touch the network). */
function makeTradeClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, host = HOST } = {}) {
  const k = resolveTradeKey({ env });
  if (!k.found && k.source == null) return null; // nothing configured
  if (!k.found) throw new Error(k.error);
  const key = k.key, keyId = k.keyId, ed = key.asymmetricKeyType === 'ed25519';
  const sub = (env.KALSHI_TRADE_SUBACCOUNT || '').trim(); const subaccount = sub === '' ? null : Number(sub);
  if (subaccount != null && !(Number.isInteger(subaccount) && subaccount >= 0 && subaccount <= 63)) throw new Error('KALSHI_TRADE_SUBACCOUNT must be an integer 0..63');
  const sign = (msg) => (ed ? crypto.sign(null, Buffer.from(msg), key) : crypto.sign('sha256', Buffer.from(msg), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })).toString('base64');
  const c = { keyId, keySource: k.source, subaccount, lastSkewMs: null, calls: 0 };
  async function call(method, p, { query = null, body = null } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : '';
    const ts = String(now()), full = PREFIX + p;
    const headers = { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sign(ts + method + full), accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    c.calls++;
    const r = await fetchImpl(host + full + (qs === '?' ? '' : qs), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const d = r.headers && r.headers.get ? r.headers.get('date') : null; if (d && Date.parse(d)) c.lastSkewMs = now() - Date.parse(d); // Date has 1 s resolution
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (!r.ok) { const e = j && (j.error || j); throw new KalshiHttpError(r.status, e && e.code, e && (e.message || e.msg)); }
    return j || {};
  }
  const subQ = () => (subaccount != null ? { subaccount } : {});
  Object.assign(c, {
    getBalance: () => call('GET', EP.balance, { query: subQ() }),
    getApiKeys: () => call('GET', EP.apiKeys),
    getOrders: (ticker) => call('GET', EP.orders, { query: { ticker, ...subQ() } }),
    getFills: ({ ticker, orderId } = {}) => call('GET', EP.fills, { query: { ticker, order_id: orderId, ...subQ() } }),
    getSettlements: (ticker) => call('GET', EP.settlements, { query: { ticker, ...subQ() } }),
    cancelOrder: (orderId, ticker) => call('DELETE', EP.cancelOrder(orderId), { query: { market_ticker: ticker, ...subQ() } }),
    /** One IOC limit buy of YES. Validated again here, whatever the caller checked. */
    async createOrder(o) {
      validateOrder(o);
      const body = { ticker: o.ticker, side: 'bid', count: o.count.toFixed(2), price: centsToPrice(o.priceCents), time_in_force: 'immediate_or_cancel',
        self_trade_prevention_type: 'taker_at_cross', client_order_id: o.clientOrderId };
      if (subaccount != null) body.subaccount = subaccount;
      return call('POST', EP.createOrder, { body });
    },
  });
  return c;
}

module.exports = { makeTradeClient, tradeEnvPresence, resolveTradeKey, validateOrder, dollarsToMicros, countToInt, centsToPrice, KalshiHttpError, SERIES, MAX_PRICE_CENTS, PREFIX, HOST };
