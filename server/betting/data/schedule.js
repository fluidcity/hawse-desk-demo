'use strict';
// The Odds API credit plan (verified against the-odds-api.com/liveapi/guides/v4, 2026-10-29):
//   /odds cost = markets × regions; with bookmakers= every 10 books count as 1 region. /sports and /events are free.
//   /scores costs 1, or 2 with daysFrom. Free "Starter" plan = 500 credits/month.
// Instead of polling every N seconds (old default: 3 sports × 3 markets every 15 min ≈ 864 credits/day), the feed takes
// odds SNAPSHOTS at fixed minutes before each game start (default T-360, T-60, T-10), merging nearby times into one call per
// sport, under a monthly budget guard with daily pacing. Self-contained (no imports from the rest of HAWSE).
const fs = require('fs');
const path = require('path');

const monthKey = (t) => { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const daysLeftInMonth = (t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1; };

/** Credits for one /odds call. */
function oddsCost({ markets, regions, bookmakers }) {
  const r = bookmakers && bookmakers.length ? Math.ceil(bookmakers.length / 10) : Math.max(1, (regions || []).length);
  return Math.max(1, (markets || []).length) * r;
}

/**
 * Pure: plan snapshot calls from a slate of upcoming events. Each (event, offset) target time is grouped with any
 * target times up to mergeMin later (same sport) and executed at the EARLIEST time of the group, so a snapshot is never
 * taken after a game starts. A group is "closing" if it contains the smallest offset (used for the closing line / CLV).
 * @returns [{ sport, at, eventIds, offsets, closing, latestCommence }]
 */
function planSnapshots(slate, { offsetsMin, mergeMin = 15, now, horizonMs = 36 * 3.6e6, graceMs = 5 * 60e3 }) {
  const minOff = Math.min(...offsetsMin); const bySport = new Map();
  for (const ev of slate) {
    if (!(ev.commence > now) || ev.commence - now > horizonMs + Math.max(...offsetsMin) * 60e3) continue;
    for (const off of offsetsMin) { const at = ev.commence - off * 60e3; if (at < now - graceMs || at >= ev.commence) continue;
      if (!bySport.has(ev.sport)) bySport.set(ev.sport, []); bySport.get(ev.sport).push({ at, id: ev.id, off, commence: ev.commence }); }
  }
  const out = [];
  for (const [sport, ts] of bySport) {
    ts.sort((a, b) => a.at - b.at); let g = null;
    for (const t of ts) {
      if (g && t.at - g.at <= mergeMin * 60e3) { g.eventIds.add(t.id); g.offsets.add(t.off); g.latestCommence = Math.max(g.latestCommence, t.commence); continue; }
      g = { sport, at: t.at, eventIds: new Set([t.id]), offsets: new Set([t.off]), latestCommence: t.commence }; out.push(g);
    }
  }
  return out.map((g) => ({ ...g, eventIds: [...g.eventIds], offsets: [...g.offsets].sort((a, b) => b - a), closing: g.offsets.has(minOff), key: g.sport + '@' + Math.round(g.at / 60e3) }))
    .sort((a, b) => a.at - b.at);
}

/** Monthly budget with daily pacing; also respects the provider-reported remaining quota. */
class OddsBudget {
  constructor({ monthlyBudget = 450, closingOnlyBelowPct = 15, file = '', now = () => Date.now() }) {
    this.monthly = monthlyBudget; this.closingOnlyBelowPct = closingOnlyBelowPct; this.file = file; this.now = now;
    this.s = { month: monthKey(now()), used: 0, byDay: {}, byKind: {}, refused: 0 }; this.api = null; this.load();
  }
  load() { if (!this.file) return; try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')).theoddsapi; if (s && s.month === this.s.month) this.s = { ...this.s, ...s }; } catch {} }
  save() { if (!this.file) return; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); let all = {}; try { all = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {} all.theoddsapi = this.s; fs.writeFileSync(this.file, JSON.stringify(all, null, 2)); } catch {} }
  roll() { const m = monthKey(this.now()); if (m !== this.s.month) { this.s = { month: m, used: 0, byDay: {}, byKind: {}, refused: 0 }; this.save(); } }
  /** Feed the x-requests-remaining / x-requests-used headers in. */
  setApiQuota(q) { this.api = q; }
  remaining() { this.roll(); const local = Math.max(0, this.monthly - this.s.used); return this.api && Number.isFinite(this.api.remaining) ? Math.min(local, this.api.remaining) : local; }
  dailyAllowance() { return this.remaining() / daysLeftInMonth(this.now()); }
  spentToday() { return this.s.byDay[dayKey(this.now())] || 0; }
  /** Throttle to closing-only snapshots when < closingOnlyBelowPct of the budget (or of the provider quota) is left. */
  closingOnly() {
    const localPct = this.monthly ? (100 * Math.max(0, this.monthly - this.s.used)) / this.monthly : 0;
    const a = this.api; const apiPct = a && Number.isFinite(a.remaining) && Number.isFinite(a.used) && a.remaining + a.used > 0 ? (100 * a.remaining) / (a.remaining + a.used) : 100;
    return Math.min(localPct, apiPct) < this.closingOnlyBelowPct;
  }
  /** Decide whether a call may run. kind: 'closing' | 'snapshot' | 'scores'. Returns { ok, reason }. */
  check(cost, kind) {
    if (cost > this.remaining()) return { ok: false, reason: `budget exhausted (${this.s.used}/${this.monthly} used${this.api ? `, API reports ${this.api.remaining} left` : ''})` };
    if (kind === 'closing') return { ok: true };
    if (this.closingOnly()) return { ok: false, reason: `under ${this.closingOnlyBelowPct}% of credits left → closing snapshots only` };
    if (kind === 'snapshot' && this.spentToday() + cost > Math.max(cost, this.dailyAllowance())) return { ok: false, reason: `daily pacing: ${this.spentToday()} spent today, allowance ${this.dailyAllowance().toFixed(1)}` };
    return { ok: true };
  }
  spend(cost, kind) { this.roll(); this.s.used += cost; const d = dayKey(this.now()); this.s.byDay[d] = (this.s.byDay[d] || 0) + cost; this.s.byKind[kind] = (this.s.byKind[kind] || 0) + cost; this.save(); }
  refuse() { this.s.refused++; }
  view() { this.roll(); return { month: this.s.month, budget: this.monthly, used: this.s.used, remaining: this.remaining(), spentToday: this.spentToday(), dailyAllowance: +this.dailyAllowance().toFixed(1), closingOnly: this.closingOnly(), refused: this.s.refused, byKind: { ...this.s.byKind } }; }
}

/** Rough monthly estimate for the configured schedule (used in mock mode and as a sanity number). */
function estimateMonthly({ sports, markets, regions, bookmakers, offsetsMin, startClustersPerDay = 2.5, scoresPerDay = 2, scoresCost = 2 }) {
  const per = oddsCost({ markets, regions, bookmakers });
  return Math.round(sports.length * (offsetsMin.length * startClustersPerDay * per + scoresPerDay * scoresCost) * 30);
}

module.exports = { oddsCost, planSnapshots, OddsBudget, estimateMonthly, monthKey, dayKey, daysLeftInMonth };
