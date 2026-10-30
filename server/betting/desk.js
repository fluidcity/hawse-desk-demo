'use strict';
// RuleDesk: the rules → signals → slips workflow. Depends only on files inside server/betting/ and on an odds feed
// object exposing { mode, simulated, upcoming(ms) }. It can run without the HAWSE engine (see test/betting-rules.test.js).
const fs = require('fs');
const path = require('path');
const { SignalTypeRegistry } = require('./rules/registry');
const { validateRule, scan } = require('./rules/engine');
const { RULES: TEMPLATES } = require('./rules/templates');
const { textToRule } = require('./rules/text');
const { SignalBook } = require('./signals');
const { LineHistory } = require('./data/lines');
const { MockStatsProvider, NullStatsProvider } = require('./data/stats');
const { buildSlip, slipText } = require('./slip');
const { VENUES } = require('./venues');
const { clone } = require('./util');

const RULE_SCHEMAS = ['hawse.betRule/1', 'hawse.betRules/1', 'hawse.signalTypes/1'];

class RuleDesk {
  constructor({ cfg, feed, now = Date.now, file, onSignal, stats } = {}) {
    this.c = cfg; this.r = cfg.rules || {}; this.feed = feed; this.now = now; this.onSignal = onSignal;
    this.file = file !== undefined ? file : this.r.file;
    this.reg = new SignalTypeRegistry(); this.lines = new LineHistory();
    this.stats = stats || (this.r.statsMock === false ? new NullStatsProvider() : new MockStatsProvider({ now }));
    this.signals = new SignalBook({ max: this.r.maxSignals || 300, now, onRaise: (s) => this.onSignal && this.onSignal(s) });
    this.rules = new Map(); this.lastScan = null; this.load();
  }
  // ---- persistence (data/ is gitignored; '' file = memory only) ----
  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (d.signalTypes) this.reg.importPack(d.signalTypes); for (const r of d.rules || []) { const v = validateRule(this.reg, r); if (v.ok) this.rules.set(v.rule.id, { ...v.rule, version: r.version || 1, updatedAt: r.updatedAt }); } this.signals.load(d.signals); }
    catch { fs.renameSync(this.file, this.file + '.bad-' + Date.now()); }
  }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ rules: [...this.rules.values()], signalTypes: this.reg.exportPack(), signals: this.signals.list().slice(0, 200) }, null, 1)); fs.renameSync(tmp, this.file);
  }
  // ---- rules CRUD ----
  listRules() { return [...this.rules.values()]; }
  getRule(id) { return this.rules.get(id) || null; }
  saveRule(input, { id } = {}) {
    const existing = id ? this.rules.get(id) : null; if (id && !existing) return { ok: false, errors: ['rule not found'] };
    const v = validateRule(this.reg, input, { existing }); if (!v.ok) return v;
    let rid = v.rule.id; if (!existing) { let n = 2; while (this.rules.has(rid)) rid = `${v.rule.id}-${n++}`; }
    const rule = { ...v.rule, id: rid, version: existing ? existing.version + 1 : 1, updatedAt: new Date(this.now()).toISOString() };
    this.rules.set(rid, rule); this.persist(); return { ok: true, rule, warnings: v.warnings };
  }
  setEnabled(id, on) { const r = this.rules.get(id); if (!r) return { ok: false, errors: ['rule not found'] }; r.enabled = !!on; this.persist(); return { ok: true, rule: r }; }
  deleteRule(id) { const ok = this.rules.delete(id); if (ok) this.persist(); return { ok }; }
  fromTemplate(i) { const t = TEMPLATES[+i]; return t ? this.saveRule(clone(t)) : { ok: false, errors: ['no such template'] }; }
  exportRule(id) { const r = this.rules.get(id); if (!r) return null; const { version, updatedAt, ...rest } = r; return { ...rest, exportedVersion: version }; }
  /** One import entry point for JSON (rule, rule list, signal-type pack) or plain text (→ draft rule). */
  importAny({ json, text } = {}) {
    if (text != null && json == null) { const t = textToRule(text); if (!t.ok) return { ok: false, errors: [t.error], mapped: t.mapped, unmapped: t.unmapped, warnings: t.warnings }; const s = this.saveRule(t.rule); return { ...s, kind: 'bet_rule', mapped: t.mapped, unmapped: t.unmapped, warnings: [...(t.warnings || []), ...(s.warnings || []), 'imported as a DRAFT (disabled); review the conditions, then enable it'] }; }
    let o = json; if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return { ok: false, errors: ['invalid JSON: ' + e.message] }; } }
    if (o && o.schema === 'hawse.signalTypes/1') { const r = this.reg.importPack(o); if (r.added.length) this.persist(); return { ...r, kind: 'signal_types' }; }
    const list = o && o.schema === 'hawse.betRules/1' ? o.rules : Array.isArray(o) ? o : [o];
    if (o && o.schema === 'hawse.betRules/1' && o.signalTypes) { const r = this.reg.importPack(o.signalTypes); if (!r.ok) return { ok: false, kind: 'bet_rules', errors: r.errors }; }
    const out = list.map((r) => this.saveRule({ enabled: false, ...r, enabled: r && r.enabled === true ? true : false, source: { type: (r && r.source && r.source.type) || 'import-json', note: r && r.source && r.source.note } }));
    return { ok: out.every((x) => x.ok), kind: 'bet_rule', rules: out.filter((x) => x.ok).map((x) => x.rule), errors: out.flatMap((x) => x.errors || []), warnings: out.flatMap((x) => x.warnings || []) };
  }
  /** Hook for the host strategy-lab import path (lab.importAny delegates JSON with these schemas). */
  importer() { return { id: 'betting', canImport: (o) => !!o && RULE_SCHEMAS.includes(o.schema), importJson: (o) => this.importAny({ json: o }), importText: (t) => this.importAny({ text: t }) }; }
  // ---- scanning ----
  scanOnce() {
    const now = this.now(), events = this.feed.upcoming(0);
    for (const ev of events) this.lines.observe(ev, now, this.c.fairMethod);
    const drafts = scan(this.reg, this.listRules(), events, { now, lines: this.lines, stats: this.stats, method: this.c.fairMethod, oddsSimulated: !!this.feed.simulated });
    const raised = this.signals.ingest(drafts, Object.fromEntries(this.rules)); this.lastScan = { at: now, events: events.length, drafts: drafts.length, raised: raised.length };
    if (raised.length) this.persist();
    return raised;
  }
  start() { this.stop(); this.iv = setInterval(() => { try { this.scanOnce(); } catch (e) { this.lastScan = { at: this.now(), error: e.message }; } }, this.r.scanMs || 5000); }
  stop() { clearInterval(this.iv); }
  // ---- signals + slips ----
  setStatus(id, status) { const s = this.signals.setStatus(id, status); if (s) this.persist(); return s; }
  slip(id) { const s = this.signals.get(id); if (!s) return null; const slip = buildSlip(s, { bankrollUsd: this.r.slipBankrollUsd || 1000, kellyFraction: this.c.kellyFraction, maxStakePct: this.c.maxStakePct, now: this.now() }); return { slip, text: slipText(slip) }; }
  venues() { return Object.values(VENUES).map((v) => v.describe()); }
  templates() { return TEMPLATES; }
  snapshot() {
    const sig = this.signals.list();
    return { mode: this.feed.mode, oddsSimulated: !!this.feed.simulated, stats: { mode: this.stats.mode, label: this.stats.label, simulated: !!this.stats.simulated }, lastScan: this.lastScan,
      rules: this.listRules().map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, version: r.version, match: r.match, conditions: r.conditions, source: r.source, description: r.description, signals: sig.filter((s) => s.ruleId === r.id).length })),
      signals: sig.slice(0, 80), counts: this.signals.counts(), customTypes: this.reg.list().filter((t) => !t.builtin).length, builtinTypes: this.reg.list().filter((t) => t.builtin).length, venues: this.venues() };
  }
}
module.exports = { RuleDesk, RULE_SCHEMAS };
