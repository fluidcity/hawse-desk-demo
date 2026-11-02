'use strict';
// HTTP routes for the betting desk, host-agnostic: handle(method, path, readBody) → [status, json] | { status, type, body, filename } | null.
const { VenueLinkDisabledError, VENUES, METHODS } = require('./venues');

function routes(desk) {
  return async function handle(method, p, readBody) {
    const G = method === 'GET', P = method === 'POST'; let m;
    if (G && p === '/api/betting') return [200, { ...desk.snapshot(), rulesFull: desk.listRules() }];
    if (G && p === '/api/betting/registry') return [200, { types: desk.reg.describe() }];
    if (G && p === '/api/betting/templates') return [200, desk.templates()];
    if (G && p === '/api/betting/signal-types/export') return [200, desk.reg.exportPack()];
    if (G && p === '/api/betting/venues') return [200, desk.venues()];
    if (P && p === '/api/betting/rules') { const b = await readBody(); const r = b.fromTemplate != null ? desk.fromTemplate(b.fromTemplate) : desk.saveRule(b.rule || {}); return [r.ok ? 200 : 422, r]; }
    if (P && p === '/api/betting/import') { const b = await readBody(); const r = desk.importAny(b); return [r.ok ? 200 : 422, r]; }
    if (P && p === '/api/betting/scan') return [200, { raised: desk.scanOnce().length, lastScan: desk.lastScan }];
    if ((m = p.match(/^\/api\/betting\/rules\/([a-z0-9-]+)(?:\/(enable|delete|export))?$/))) {
      const [, id, act] = m;
      if (G && act === 'export') { const r = desk.exportRule(id); return r ? { status: 200, type: 'application/json', body: JSON.stringify(r, null, 2), filename: `${id}.json` } : [404, { error: 'not found' }]; }
      if (G && !act) { const r = desk.getRule(id); return r ? [200, r] : [404, { error: 'not found' }]; }
      if (P) { const b = await readBody(); const r = act === 'enable' ? desk.setEnabled(id, b.on !== false) : act === 'delete' ? desk.deleteRule(id) : desk.saveRule(b.rule || {}, { id }); return [r.ok ? 200 : 422, r]; }
    }
    if ((m = p.match(/^\/api\/betting\/signals\/([a-z0-9-]+)\/(status|slip|slip\.txt|slip\.json)$/))) {
      const [, id, act] = m;
      if (P && act === 'status') { const b = await readBody(); const s = desk.setStatus(id, b.status); return s ? [200, { ok: true, signal: s }] : [422, { ok: false, errors: ['unknown signal or status'] }]; }
      if (G) { const x = desk.slip(id); if (!x) return [404, { error: 'not found' }];
        if (act === 'slip.txt') return { status: 200, type: 'text/plain; charset=utf-8', body: x.text, filename: `${x.slip.id}.txt` };
        if (act === 'slip.json') return { status: 200, type: 'application/json', body: JSON.stringify(x.slip, null, 2), filename: `${x.slip.id}.json` };
        return [200, x]; }
    }
    if (P && (m = p.match(/^\/api\/betting\/venues\/(kalshi|polymarket)\/(\w+)$/))) { // always refuses: the venue link is disabled
      const v = VENUES[m[1]]; if (!METHODS.includes(m[2])) return [404, { error: 'unknown method' }];
      try { v[m[2]](); return [500, { error: 'venue adapter unexpectedly did not refuse' }]; } catch (e) { if (e instanceof VenueLinkDisabledError) return [403, { ok: false, code: e.code, error: e.message }]; throw e; }
    }
    return p.startsWith('/api/betting') ? [404, { error: 'unknown betting route' }] : null;
  };
}
module.exports = { routes };
