'use strict';
// Event tape with per-(strategy, reason) throttling for skip logs (counts are always kept).
class Tape {
  constructor(max = 400) { this.max = max; this.rows = []; this.skips = new Map(); this.seq = 0; }
  push(row) {
    const r = { id: ++this.seq, t: Date.now(), kind: 'info', ...row };
    this.rows.unshift(r); if (this.rows.length > this.max) this.rows.pop();
    return r;
  }
  skip(strategy, reason, { throttleMs = 60000, detail = '' } = {}) {
    const key = strategy + '|' + reason;
    const s = this.skips.get(key) || { strategy, reason, count: 0, last: 0 };
    s.count++; const now = Date.now();
    const emit = now - s.last >= throttleMs; if (emit) s.last = now;
    this.skips.set(key, s);
    if (emit) this.push({ kind: 'skip', strategy, msg: reason + (detail ? ' · ' + detail : '') });
    return s.count;
  }
  skipCounts(strategy) {
    return [...this.skips.values()].filter((s) => s.strategy === strategy).sort((a, b) => b.count - a.count).slice(0, 6).map(({ reason, count }) => ({ reason, count }));
  }
}
module.exports = { Tape };
