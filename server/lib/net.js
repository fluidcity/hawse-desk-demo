'use strict';
// Minimal JSON fetch with timeout that reports into the health registry.
async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 8000, health, id } = {}) {
  const t0 = Date.now();
  try {
    const res = await withTimeout(fetch(url, {
      method, headers: { accept: 'application/json', 'user-agent': 'hawse-paper-desk/2.0', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    }), timeoutMs + 1000);
    const text = await withTimeout(res.text(), timeoutMs + 1000);
    if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); e.status = res.status; e.geoBlocked = isGeoBlock(res.status, text); throw e; }
    const json = JSON.parse(text);
    if (health && id) health.ok(id, Date.now() - t0);
    return json;
  } catch (e) {
    if (health && id) { if (e.geoBlocked && health.blocked) health.blocked(id, e.status, redact(e.message || e)); else health.fail(id, redact(e.message || e)); }
    throw e;
  }
}
/** True when an HTTP error is a jurisdiction block of THIS host (not an outage): Binance answers 451 "restricted location",
 *  Bybit's CloudFront answers 403 "configured to block access from your country". */
function isGeoBlock(status, text = '') {
  if (status === 451) return true;
  return status === 403 && /block access from your country|restricted location|not available in your (country|region)|geo.?block/i.test(String(text));
}
// Never let an API key embedded in a URL leak into logs/health.
const redact = (s) => String(s).replace(/(api-key|apikey|key)=([^&\s]+)/gi, '$1=***').replace(/\/v[23]\/[A-Za-z0-9_-]{16,}/g, '/v2/***');
/** Belt and braces on top of AbortSignal.timeout: settle within ms even if the underlying promise ignores the signal. */
function withTimeout(p, ms, what = 'request') {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error(`${what} timed out after ${ms}ms`); e.code = 'ETIMEDOUT'; rej(e); }, ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { fetchJson, redact, sleep, withTimeout, isGeoBlock };
