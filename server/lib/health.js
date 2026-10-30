'use strict';
// Data-source health registry: live vs mock vs down, latency, last update.
class Health {
  constructor() { this.src = new Map(); }
  register(id, { label, group, kind = 'live', note = '', transport = 'rest', staleMs = 120000 }) {
    if (!this.src.has(id)) this.src.set(id, { id, label, group, kind, note, transport, staleMs, status: 'pending', latencyMs: null, lastOk: null, lastErr: null, error: null, okCount: 0, errCount: 0 });
    return this.src.get(id);
  }
  setKind(id, kind, note) { const s = this.src.get(id); if (s) { s.kind = kind; if (note !== undefined) s.note = note; } }
  ok(id, latencyMs) { const s = this.src.get(id); if (!s) return; s.status = s.kind === 'mock' ? 'mock' : 'live'; s.latencyMs = latencyMs; s.lastOk = Date.now(); s.okCount++; s.error = null; }
  fail(id, err) { const s = this.src.get(id); if (!s) return; s.status = 'down'; s.lastErr = Date.now(); s.errCount++; s.error = String(err && err.message || err).slice(0, 160); }
  isFresh(id, maxAgeMs) { const s = this.src.get(id); return !!(s && s.lastOk && Date.now() - s.lastOk < maxAgeMs && s.status !== 'down'); }
  /** status: live | mock | stale (no update within staleMs) | down | pending */
  list(now = Date.now()) {
    return [...this.src.values()].map((s) => {
      const ageMs = s.lastOk ? now - s.lastOk : null;
      const status = (s.status === 'live' || s.status === 'mock') && ageMs != null && ageMs > s.staleMs ? 'stale' : s.status;
      return { ...s, status, ageMs };
    });
  }
  setTransport(id, t) { const s = this.src.get(id); if (s) s.transport = t; }
  get(id) { return this.list().find((s) => s.id === id) || null; }
}
module.exports = { Health };
