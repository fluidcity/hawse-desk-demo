'use strict';
// Example adapter: Pyth Hermes price stream (SSE). Since 2026-08-26 Hermes requires a Pyth API key
// (Authorization: Bearer), so without PYTH_API_KEY this adapter stays idle and the registry shows 'missing key'. Implements the adapter interface:
//   create({ env, health, engine, entry }) -> { start(), stop(), snapshot(), publicInfo() } | null
// It registers its own health row ('pyth.hermes'), which the registry entry lists under `health`.
const FEEDS = { // Pyth price-feed ids (Crypto.X/USD), from hermes.pyth.network/v2/price_feeds
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};
const parse = (p) => ({ px: +p.price.price * 10 ** p.price.expo, conf: +p.price.conf * 10 ** p.price.expo, publishMs: p.price.publish_time * 1000 });

function create({ env, health, engine }) {
  const key = env.PYTH_API_KEY || '';
  const base = (env.PYTH_HERMES_URL || 'https://hermes.pyth.network').replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + key };
  const byId = Object.fromEntries(Object.entries(FEEDS).map(([s, id]) => [id, s]));
  const qs = Object.values(FEEDS).map((id) => 'ids[]=' + id).join('&');
  health.register('pyth.hermes', { label: 'Pyth Hermes price stream', group: 'oracle', transport: 'sse', staleMs: 30000, note: key ? 'oracle cross-check; latency = publish_time → box' : 'idle: set PYTH_API_KEY (Hermes requires a key)' });
  const prices = {}; let ctrl = null, timer = null, stopped = false, mode = 'sse';
  const ingest = (list) => { for (const p of list || []) { const s = byId[p.id]; if (!s) continue; prices[s] = parse(p); health.ok('pyth.hermes', Math.max(0, Date.now() - prices[s].publishMs)); } };
  async function stream() {
    ctrl = new AbortController();
    try {
      const r = await fetch(`${base}/v2/updates/price/stream?${qs}&parsed=true`, { signal: ctrl.signal, headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      mode = 'sse'; health.setTransport && health.setTransport('pyth.hermes', 'sse'); let buf = '';
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith('data:')) { try { ingest(JSON.parse(line.slice(5)).parsed); } catch {} } }
      }
      throw new Error('stream ended');
    } catch (e) { if (stopped) return; health.fail('pyth.hermes', 'stream: ' + e.message); poll(); setTimeout(() => !stopped && stream(), 15000); }
  }
  async function poll() { // REST fallback, labelled
    mode = 'rest'; health.setTransport && health.setTransport('pyth.hermes', 'rest');
    try { const r = await fetch(`${base}/v2/updates/price/latest?${qs}&parsed=true`, { signal: AbortSignal.timeout(8000), headers }); if (!r.ok) throw new Error('HTTP ' + r.status); ingest((await r.json()).parsed); } catch (e) { health.fail('pyth.hermes', e.message); }
  }
  return {
    start() { if (!key) return; stopped = false; stream(); timer = setInterval(() => { if (mode === 'rest') poll(); }, 5000); },
    stop() { stopped = true; clearInterval(timer); ctrl && ctrl.abort(); },
    oracle: (s) => prices[s] || null,
    snapshot: () => ({ mode, prices }),
    publicInfo() {
      const out = { transport: mode, checks: [] };
      for (const [s, p] of Object.entries(prices)) { const q = engine.quote(s); out.checks.push({ symbol: s, pyth: p.px, conf: p.conf, venue: q ? q.venue : null, devBps: q ? ((q.mark - p.px) / p.px) * 1e4 : null }); }
      return out;
    },
  };
}
module.exports = { create, FEEDS };
