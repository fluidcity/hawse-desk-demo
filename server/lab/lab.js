'use strict';
// Strategy lab: versioned configs (save / duplicate / export / import), backtests on public OKX history, and
// forward paper runs side by side. Lab results live in their own books and are NEVER blended into the desk's
// equity curve or attribution. Persistence: data/lab/strategies.json (gitignored).
const fs = require('fs');
const path = require('path');
const { validate } = require('./validate');
const bt = require('./backtest');
const T = require('./templates');
const { textToConfig } = require('./text-import');
const data = require('./data');

const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => String(s || 'strategy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'strategy';
const LAB_ONLY = ['id', 'version', 'status', 'source', 'lastBacktest', 'createdAt', 'savedAt'];

class Lab {
  constructor({ file, health, fetchHistory = data.history, now = () => Date.now() } = {}) {
    this.file = file; this.health = health; this.fetchHistory = fetchHistory; this.now = now; this.db = { configs: {}, runs: {} };
    if (health) health.register('lab.okx', { label: 'Lab history (OKX candles + funding)', group: 'candles', note: 'on demand for backtests & forward runs', staleMs: 3600e3 });
    if (file && fs.existsSync(file)) { try { this.db = { configs: {}, runs: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* corrupt file: start empty, keep the old one */ fs.renameSync(file, file + '.bad-' + Date.now()); } }
    this.results = {};
  }
  persist() { if (!this.file) return; fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1)); fs.renameSync(tmp, this.file); }
  check(cfg) {
    const strip = clone(cfg); for (const k of LAB_ONLY) delete strip[k];
    const v = validate(strip);
    const se = v.ok ? bt.semanticErrors(strip) : [];
    return { ok: v.ok && !se.length, errors: [...v.errors, ...se] };
  }
  latest(id) { const vs = this.db.configs[id]; return vs && vs[vs.length - 1]; }
  get(id, version) { const vs = this.db.configs[id]; if (!vs) return null; return version ? vs.find((c) => c.version === +version) : vs[vs.length - 1]; }
  /** Save a config: new id → v1; existing id → next version. Any edit resets status to 'unverified'. */
  save(cfg, { source } = {}) {
    const c = clone(cfg); const v = this.check(c); if (!v.ok) return { ok: false, errors: v.errors };
    let id = c.id && this.db.configs[c.id] ? c.id : null;
    if (!id) { id = slug(c.name); let n = 2; while (this.db.configs[id]) id = slug(c.name).slice(0, 32) + '-' + n++; }
    const prev = this.latest(id), version = prev ? prev.version + 1 : 1;
    const rec = { ...c, schemaVersion: 1, id, version, status: 'unverified', source: source || c.source || (prev && prev.source) || { type: 'user' }, savedAt: this.now(), lastBacktest: undefined };
    delete rec.lastBacktest; (this.db.configs[id] = this.db.configs[id] || []).push(rec); this.persist();
    return { ok: true, config: rec };
  }
  duplicate(id, version) { const c = this.get(id, version); if (!c) return { ok: false, errors: ['not found'] }; const d = clone(c); delete d.id; d.name = ('Copy of ' + c.name).slice(0, 80); return this.save(d, { source: { type: 'user', note: `duplicated from ${id}@v${c.version}` } }); }
  fromTemplate(tid) { const t = T.get(tid); if (!t) return { ok: false, errors: ['unknown template'] }; const c = clone(t); delete c.id; return this.save(c, { source: { type: 'template', note: t.id } }); }
  remove(id) { if (!this.db.configs[id]) return { ok: false }; delete this.db.configs[id]; delete this.db.runs[id]; this.persist(); return { ok: true }; }
  exportJson(id, version) { const c = this.get(id, version); if (!c) return null; const out = clone(c); delete out.lastBacktest; delete out.savedAt; return out; }
  /** Import JSON (object or string) or plain text. Always stored as 'unverified'; imported performance is dropped. */
  importAny({ json, text }) {
    if (text != null && json == null) {
      const r = textToConfig(text); if (!r.ok) return { ok: false, errors: [r.error], mapped: r.mapped, unmapped: r.unmapped };
      const s = this.save(r.config, { source: r.config.source }); return { ...s, mapped: r.mapped, unmapped: r.unmapped, warnings: r.warnings };
    }
    let obj = json; if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return { ok: false, errors: ['invalid JSON: ' + e.message] }; } }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['expected one strategy object'] };
    const dropped = ['performance', 'backtest', 'lastBacktest', 'results', 'pnl', 'winRate', 'returns'].filter((k) => k in obj);
    const c = clone(obj); for (const k of [...LAB_ONLY, ...dropped]) delete c[k];
    const notes = []; if (!('schemaVersion' in c)) { c.schemaVersion = 1; notes.push('schemaVersion missing; assumed 1'); }
    const s = this.save(c, { source: { type: 'import-json', note: obj.source && obj.source.note ? String(obj.source.note).slice(0, 400) : undefined } });
    return { ...s, warnings: [...notes, ...(dropped.length ? [`ignored fields (imports carry no performance): ${dropped.join(', ')}`] : [])] };
  }
  async backtest(id, version, { limit = 1000 } = {}) {
    const c = this.get(id, version); if (!c) return { ok: false, errors: ['not found'] };
    if (bt.isBetting(c.kind)) { const r = bt.run(c, {}); r.at = this.now(); return { ok: true, result: r, config: c }; } // stays unverified
    const d = await this.fetchHistory(c, { limit, health: this.health });
    const r = bt.run(c, d); r.source = d.source; if (d.fundingError) r.notes.push(d.fundingError); r.at = this.now(); r.simulated = false;
    if (r.supported) { c.status = 'backtested'; c.lastBacktest = { at: r.at, version: c.version, trades: r.trades, returnPct: r.returnPct, maxDrawdownPct: r.maxDrawdownPct, buyHoldPct: r.buyHoldPct, from: r.from, to: r.to, bars: r.bars }; this.persist(); }
    return { ok: true, result: r, config: c };
  }
  startRun(id, version) { const c = this.get(id, version); if (!c) return { ok: false, errors: ['not found'] };
    if (bt.isBetting(c.kind)) return { ok: false, errors: ['Betting configs are evaluated by the desk\'s live paper betting strategies (Sports +EV / spread signal / arb), which use the server betting settings (BET_* env vars). Per-config side-by-side betting runs are not implemented yet.'] }; this.db.runs[id] = { id, version: c.version, startedAt: this.now() }; this.persist(); this.refreshRun(id).catch(() => {}); return { ok: true }; }
  stopRun(id) { delete this.db.runs[id]; delete this.results[id]; this.persist(); return { ok: true }; }
  /** Forward paper run = the same replay engine applied to fresh closed bars, entries only after startedAt. */
  async refreshRun(id) {
    const run = this.db.runs[id]; const c = run && this.get(id, run.version); if (!c) return;
    const d = await this.fetchHistory(c, { limit: 300, health: this.health });
    const idx = d.bars.findIndex((b) => b.t >= run.startedAt); const r = bt.run(c, d, { entryFrom: idx < 0 ? d.bars.length : idx });
    this.results[id] = { ...r, source: d.source, updatedAt: this.now(), startedAt: run.startedAt, version: run.version };
  }
  start() { this.timer = setInterval(() => { for (const id of Object.keys(this.db.runs)) this.refreshRun(id).catch(() => {}); }, 60000); for (const id of Object.keys(this.db.runs)) this.refreshRun(id).catch(() => {}); }
  stop() { clearInterval(this.timer); }
  list() {
    const configs = Object.values(this.db.configs).map((vs) => { const c = vs[vs.length - 1]; return { id: c.id, name: c.name, kind: c.kind, version: c.version, versions: vs.map((v) => ({ version: v.version, status: v.status, savedAt: v.savedAt })), status: c.status, source: c.source, market: c.market, lastBacktest: c.lastBacktest || null, running: !!this.db.runs[c.id] }; });
    const runs = Object.values(this.db.runs).map((r) => { const x = this.results[r.id]; const c = this.get(r.id, r.version) || {}; return { id: r.id, name: c.name, version: r.version, startedAt: r.startedAt, status: c.status,
      result: x ? { supported: x.supported, reason: x.reason, trades: x.trades, netUsd: x.netUsd, returnPct: x.returnPct, maxDrawdownPct: x.maxDrawdownPct, feesUsd: x.feesUsd, updatedAt: x.updatedAt, source: x.source, equity: (x.equity || []).filter((e) => e.t >= r.startedAt) } : null }; });
    return { templates: T.TEMPLATES, configs, runs, schema: '/schema/strategy.schema.json' };
  }
}
module.exports = { Lab };
