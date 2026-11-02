'use strict';
// Line history: remembers the first-seen and latest consensus for every selection so rules can ask "did the line move?".
// Consensus per selection = no-vig median fair probability (h2h) and the most-quoted point (spreads/totals).
const S = require('../scanner');
const M = require('../math');

/** Most-quoted point of a market from one selection's perspective (spreads: that team's line; totals: the total). */
function consensusPoint(ev, market, name) {
  if (market === 'h2h') return null;
  const pts = []; for (const b of ev.books) for (const g of S.bookMarkets(ev, b, [market])) pts.push(g.line);
  if (!pts.length) return null;
  const cnt = {}; for (const p of pts) cnt[p] = (cnt[p] || 0) + 1; const top = Math.max(...Object.values(cnt));
  const home = M.median(Object.keys(cnt).filter((k) => cnt[k] === top).map(Number));
  return market === 'spreads' ? (name === ev.home ? home : -home) : home;
}

class LineHistory {
  constructor({ maxEvents = 400 } = {}) { this.m = new Map(); this.maxEvents = maxEvents; }
  key(evId, market, name) { return `${evId}|${market}|${name}`; }
  /** Record the current consensus of every selection of an event. */
  observe(ev, now = Date.now(), method = 'multiplicative') {
    const seen = new Set();
    for (const q of S.quotes(ev)) {
      const k = this.key(ev.id, q.market, q.name); if (seen.has(k)) continue; seen.add(k);
      const pt = consensusPoint(ev, q.market, q.name);
      const f = S.fairProb(ev, q.market, q.name, q.market === 'h2h' ? null : pt, { method });
      const snap = { t: now, point: pt, prob: f ? f.prob : null };
      const h = this.m.get(k); if (!h) this.m.set(k, { first: snap, last: snap }); else h.last = snap;
    }
    if (this.m.size > this.maxEvents * 12) for (const k of [...this.m.keys()].slice(0, this.m.size - this.maxEvents * 12)) this.m.delete(k);
  }
  get(evId, market, name) { return this.m.get(this.key(evId, market, name)) || null; }
  /**
   * Movement since first seen, signed so that POSITIVE = the market moved TOWARD this selection (it got more expensive):
   * h2h: fair prob up (pp); spreads: the selection gives more / gets fewer points; totals: Over → total up, Under → total down.
   */
  move(evId, market, name) {
    const h = this.get(evId, market, name); if (!h) return null;
    const probPp = h.first.prob != null && h.last.prob != null ? (h.last.prob - h.first.prob) * 100 : null;
    let points = null;
    if (h.first.point != null && h.last.point != null) { const d = h.last.point - h.first.point; points = market === 'spreads' ? -d : market === 'totals' ? (name === 'Under' ? -d : d) : null; }
    return { probPp, points, since: h.first.t, first: h.first, last: h.last };
  }
}

module.exports = { LineHistory, consensusPoint };
