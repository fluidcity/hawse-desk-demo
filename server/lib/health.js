'use strict';
// Data-source health registry: live vs mock vs down, latency, last update.
class Health {
  constructor() { this.src = new Map(); }
  register(id, { label, group, kind = 'live', note = '' }) {
    if (!this.src.has(id)) this.src.set(id, { id, label, group, kind, note, status: 'pending', latencyMs: null, lastOk: null, lastErr: null, error: null, okCount: 0, errCount: 0 });
    return this.src.get(id);
  }
  setKind(id, kind, note) { const s = this.src.get(id); if (s) { s.kind = kind; if (note !== undefined) s.note = note; } }
  ok(id, latencyMs) { const s = this.src.get(id); if (!s) return; s.status = s.kind === 'mock' ? 'mock' : 'live'; s.latencyMs = latencyMs; s.lastOk = Date.now(); s.okCount++; s.error = null; }
  fail(id, err) { const s = this.src.get(id); if (!s) return; s.status = 'down'; s.lastErr = Date.now(); s.errCount++; s.error = String(err && err.message || err).slice(0, 160); }
  isFresh(id, maxAgeMs) { const s = this.src.get(id); return !!(s && s.lastOk && Date.now() - s.lastOk < maxAgeMs && s.status !== 'down'); }
  list() { return [...this.src.values()].map((s) => ({ ...s, ageMs: s.lastOk ? Date.now() - s.lastOk : null })); }
}
module.exports = { Health };
