'use strict';
// Signal book: raised by the scanner, reviewed by the user. Status: new → reviewed | dismissed | slipped (a slip was
// printed/exported). Signals expire at game start. Nothing here stakes or books money.
const STATUSES = ['new', 'reviewed', 'dismissed', 'slipped'];

class SignalBook {
  constructor({ max = 300, now = Date.now, onRaise } = {}) { this.list_ = []; this.seq = 0; this.max = max; this.now = now; this.onRaise = onRaise; }
  /** Merge scanner drafts. Existing open signal → refresh price; dismissed/expired within cooldown → stay quiet. */
  ingest(drafts, rulesById = {}) {
    const now = this.now(), raised = [];
    for (const d of drafts) {
      const prev = this.list_.find((s) => s.key === d.key && s.commence === d.commence);
      if (prev) {
        if (prev.status === 'dismissed' || prev.expired) continue;
        Object.assign(prev, { book: d.book, dec: d.dec, point: d.point, label: d.label, fairProb: d.fairProb, fairBooks: d.fairBooks, evPct: d.evPct, matched: d.matched, simulated: d.simulated || prev.simulated, simReasons: [...new Set([...prev.simReasons, ...d.simReasons])], updatedAt: now });
        continue;
      }
      const cool = ((rulesById[d.ruleId] && rulesById[d.ruleId].cooldownMin) ?? 30) * 60e3;
      const recent = this.list_.find((s) => s.ruleId === d.ruleId && s.eventId === d.eventId && s.market === d.market && s.name === d.name && now - s.createdAt < cool);
      if (recent) continue;
      const s = { id: 'sig-' + (++this.seq).toString(36) + '-' + now.toString(36).slice(-4), ...d, status: 'new', createdAt: now, updatedAt: now, expired: false, firstDec: d.dec };
      this.list_.unshift(s); raised.push(s); if (this.onRaise) this.onRaise(s);
    }
    for (const s of this.list_) if (!s.expired && s.commence <= now) s.expired = true;
    if (this.list_.length > this.max) this.list_.length = this.max;
    return raised;
  }
  get(id) { return this.list_.find((s) => s.id === id) || null; }
  setStatus(id, status) { const s = this.get(id); if (!s || !STATUSES.includes(status)) return null; s.status = status; s.updatedAt = this.now(); return s; }
  list({ status } = {}) { return status ? this.list_.filter((s) => s.status === status) : this.list_.slice(); }
  counts() { const c = { new: 0, reviewed: 0, dismissed: 0, slipped: 0, open: 0 }; for (const s of this.list_) { c[s.status]++; if (!s.expired) c.open++; } return c; }
  load(arr) { if (Array.isArray(arr)) { this.list_ = arr.slice(0, this.max); this.seq = this.list_.length; } }
}
module.exports = { SignalBook, STATUSES };
