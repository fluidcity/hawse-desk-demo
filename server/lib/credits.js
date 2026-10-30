'use strict';
// Monthly API-credit budget guard (pure accounting + optional JSON persistence under data/, which is gitignored).
// Used for metered providers (Helius). It counts the credits THIS process spends using the provider's documented
// per-call price. It does not read the provider's own meter, so the provider dashboard is still the source of truth.
const fs = require('fs');
const path = require('path');

const monthKey = (t) => { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const daysInMonth = (t) => { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };

class CreditBudget {
  /**
   * @param {object} o
   * @param {string} o.provider   id used as the persistence key
   * @param {number} o.budget     hard cap of credits this app may spend per calendar month (UTC)
   * @param {number} [o.planCredits] the plan's monthly allowance (display only)
   * @param {string} [o.file]     JSON file for persistence ('' or null = memory only)
   */
  constructor({ provider, budget, dailyBudget = null, pauseAtPct = 90, planCredits = null, file = '', now = () => Date.now() }) {
    this.provider = provider; this.budget = Math.max(0, +budget || 0); this.planCredits = planCredits; this.file = file || ''; this.now = now;
    this.dailyBudget = dailyBudget == null ? null : Math.max(0, +dailyBudget || 0); this.pauseAtPct = pauseAtPct;
    this.state = { month: monthKey(now()), used: 0, calls: 0, refused: 0, byKind: {}, byDay: {} };
    this.load();
  }
  load() {
    if (!this.file) return;
    try { const all = JSON.parse(fs.readFileSync(this.file, 'utf8')); const s = all[this.provider]; if (s && s.month === this.state.month) this.state = { ...this.state, ...s }; } catch { /* first run */ }
  }
  save() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); let all = {}; try { all = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
      all[this.provider] = this.state; fs.writeFileSync(this.file, JSON.stringify(all, null, 2)); } catch { /* persistence is best effort */ }
  }
  roll() { const m = monthKey(this.now()); if (m !== this.state.month) { this.state = { month: m, used: 0, calls: 0, refused: 0, byKind: {}, byDay: {} }; this.save(); } }
  today() { return new Date(this.now()).toISOString().slice(0, 10); }
  usedToday() { this.roll(); return (this.state.byDay || {})[this.today()] || 0; }
  remaining() { this.roll(); const m = Math.max(0, this.budget - this.state.used); return this.dailyBudget == null ? m : Math.min(m, Math.max(0, this.dailyBudget - this.usedToday())); }
  /** Auto-pause threshold: true once today's (or this month's) spend reaches pauseAtPct of its hard cap. */
  paused() {
    const d = this.dailyBudget != null && this.dailyBudget > 0 ? (100 * this.usedToday()) / this.dailyBudget : this.dailyBudget === 0 ? 100 : 0;
    const m = this.budget ? (100 * this.state.used) / this.budget : 100; return Math.max(d, m) >= this.pauseAtPct;
  }
  /** True if `cost` more credits fit under the hard caps (daily + monthly) and we are not auto-paused. Does not spend. */
  canSpend(cost) { return !this.paused() && cost <= this.remaining(); }
  /** Reserve-and-record before a paid call. Returns false (and counts a refusal) when the cap would be exceeded. */
  trySpend(cost, kind = 'call') {
    if (!this.canSpend(cost)) { this.state.refused++; return false; }
    this.addDay(cost); this.state.used += cost; this.state.calls++; this.state.byKind[kind] = (this.state.byKind[kind] || 0) + cost; this.save(); return true;
  }
  /** Record credits charged by the provider that we could not refuse (e.g. webhook deliveries: 1 credit each, charged even if our endpoint fails). */
  addDay(cost) { const d = this.today(); const b = (this.state.byDay = this.state.byDay || {}); b[d] = (b[d] || 0) + cost; for (const k of Object.keys(b)) if (k < d.slice(0, 8) + '00' && Object.keys(b).length > 40) delete b[k]; }
  record(cost, kind) { this.roll(); this.addDay(cost); this.state.used += cost; this.state.byKind[kind] = (this.state.byKind[kind] || 0) + cost; this.save(); }
  view(extra = {}) {
    this.roll();
    return { provider: this.provider, month: this.state.month, budget: this.budget, planCredits: this.planCredits, used: this.state.used, remaining: this.remaining(),
      calls: this.state.calls, refused: this.state.refused, byKind: { ...this.state.byKind }, overBudget: this.state.used >= this.budget || (this.dailyBudget != null && this.usedToday() >= this.dailyBudget),
      dailyBudget: this.dailyBudget, usedToday: this.usedToday(), pauseAtPct: this.pauseAtPct, paused: this.paused(), ...extra };
  }
}
module.exports = { CreditBudget, monthKey, daysInMonth };
