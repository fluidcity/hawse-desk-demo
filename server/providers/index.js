'use strict';
// Loads the registry, starts adapters, and derives a client-safe status view.
const path = require('path');
const ENTRIES = require('./registry');

const isSet = (env, name) => env[name] !== undefined && String(env[name]).trim() !== '';
const matches = (id, pat) => (pat.endsWith('*') ? id.startsWith(pat.slice(0, -1)) : id === pat);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Pure: derive the public status for one entry (tested). Never returns env values. */
function describe(entry, env, healthRows, adapterInfo) {
  const vars = (entry.env || []).map((e) => ({ name: e.name, required: !!e.required, set: isSet(env, e.name) }));
  const req = vars.filter((v) => v.required);
  const keyOk = entry.keyless || !req.length || (entry.anyOf ? req.some((v) => v.set) : req.every((v) => v.set));
  const rows = healthRows.filter((h) => (entry.health || []).some((p) => matches(h.id, p)));
  let status;
  if (entry.placeholder) status = keyOk ? 'not implemented' : 'missing key';
  else if (!keyOk) status = rows.some((r) => r.status === 'mock') ? 'mocked (missing key)' : 'missing key';
  else if (rows.some((r) => r.status === 'live')) status = 'live';
  else if (rows.some((r) => r.status === 'stale')) status = 'stale';
  else if (rows.some((r) => r.status === 'mock')) status = 'mocked';
  else if (rows.some((r) => r.status === 'down')) status = 'down';
  else if (rows.some((r) => r.status === 'blocked')) status = 'blocked';
  else status = rows.length ? 'pending' : 'idle';
  const live = rows.filter((r) => r.status === 'live' && r.latencyMs != null);
  return {
    id: entry.id, name: entry.name, category: entry.category, status, keyless: !!entry.keyless, placeholder: !!entry.placeholder,
    latencyMs: keyOk && !entry.placeholder ? median(live.map((r) => r.latencyMs)) : null,
    feeds: (keyOk ? rows : rows.filter((r) => r.status === 'mock')).map((r) => ({ id: r.id, status: r.status, transport: r.transport, latencyMs: r.latencyMs, ageMs: r.ageMs })),
    env: vars, connect: { envVars: (entry.env || []).filter((e) => e.required).map((e) => e.name), anyOf: !!entry.anyOf, signup: entry.signup },
    unlocks: entry.unlocks || [], fallback: entry.fallback || null, extra: adapterInfo || null,
  };
}

class Providers {
  constructor(engine, { env = process.env, entries = ENTRIES } = {}) {
    this.engine = engine; this.env = env; this.entries = entries; this.adapters = {};
    for (const e of entries) {
      if (!e.adapter || e.placeholder) continue;
      const mod = require(path.join(__dirname, 'adapters', e.adapter));
      const feed = mod.create({ env, health: engine.health, engine, entry: e });
      if (feed) { this.adapters[e.id] = feed; engine.addFeed('provider.' + e.id, feed); }
    }
  }
  list() {
    const rows = this.engine.health.list();
    return this.entries.map((e) => { // adapter feeds, or a host feed named by entry.feed (e.g. whale.solana credit view)
      const f = this.adapters[e.id] || (e.feed && this.engine.feeds[e.feed]);
      return describe(e, this.env, rows, f && f.publicInfo ? f.publicInfo() : null); });
  }
}
module.exports = { Providers, describe, ENTRIES };
