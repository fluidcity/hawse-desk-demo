'use strict';
// Minimal JSON fetch with timeout that reports into the health registry.
async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 8000, health, id } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method, headers: { accept: 'application/json', 'user-agent': 'hawse-paper-desk/2.0', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    const json = JSON.parse(text);
    if (health && id) health.ok(id, Date.now() - t0);
    return json;
  } catch (e) {
    if (health && id) health.fail(id, redact(e.message || e));
    throw e;
  }
}
// Never let an API key embedded in a URL leak into logs/health.
const redact = (s) => String(s).replace(/(api-key|apikey|key)=([^&\s]+)/gi, '$1=***').replace(/\/v[23]\/[A-Za-z0-9_-]{16,}/g, '/v2/***');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { fetchJson, redact, sleep };
