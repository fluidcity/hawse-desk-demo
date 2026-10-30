'use strict';
// The ONLY network door the recorder has: unauthenticated HTTP GET against an allowlist of PUBLIC market-data paths.
// No POST/DELETE, no auth headers, no request signing, no key material: Kalshi trading/portfolio endpoints
// (/portfolio/*, orders, positions, balance) and Polymarket order endpoints (/order, /orders, auth) are not reachable
// through here by construction, and test/recorder.test.js scans the recorder source to keep it that way.
const { fetchJson } = require('../lib/net');

const ALLOW = [
  { hosts: ['api.elections.kalshi.com', 'external-api.kalshi.com'], paths: [
    /^\/trade-api\/v2\/markets$/, /^\/trade-api\/v2\/markets\/trades$/, /^\/trade-api\/v2\/markets\/[A-Za-z0-9._-]+$/,
    /^\/trade-api\/v2\/markets\/[A-Za-z0-9._-]+\/orderbook$/, /^\/trade-api\/v2\/series\/[A-Za-z0-9._-]+$/, /^\/trade-api\/v2\/exchange\/status$/] },
  { hosts: ['gamma-api.polymarket.com'], paths: [/^\/markets$/, /^\/events$/] },
  { hosts: ['clob.polymarket.com'], paths: [/^\/book$/] },
  { hosts: ['data-api.polymarket.com'], paths: [/^\/trades$/] },
];
function allowed(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const rule = ALLOW.find((r) => r.hosts.includes(u.hostname)); if (!rule) return false;
  if (/portfolio|order(?!book)|balance|position|login|auth|api[-_]?key/i.test(u.pathname)) return false; // belt and braces
  return rule.paths.some((re) => re.test(u.pathname));
}

/** Token bucket: at most `rps` requests per second per bucket. take() is false when over budget (caller skips that poll). */
class Bucket {
  constructor(rps, now = () => Date.now()) { this.rps = rps; this.tokens = rps; this.t = now(); this.now = now; this.skipped = 0; this.used = 0; }
  take() { const n = this.now(); this.tokens = Math.min(this.rps, this.tokens + ((n - this.t) / 1000) * this.rps); this.t = n; if (this.tokens < 1) { this.skipped++; return false; } this.tokens -= 1; this.used++; return true; }
}

/** GET a public JSON document. Throws (and never calls the network) for anything off the allowlist. */
function publicGet(url, { health, id, timeoutMs = 6000, fetchJsonImpl = fetchJson } = {}) {
  if (!allowed(url)) return Promise.reject(new Error('recorder: URL not on the public market-data allowlist'));
  return fetchJsonImpl(url, { method: 'GET', timeoutMs, health, id });
}
module.exports = { publicGet, allowed, Bucket, ALLOW };
