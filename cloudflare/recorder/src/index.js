// HAWSE always-on recorder: SKELETON, NOT DEPLOYED (H7). Paper/research only.
// One Durable Object ("main") wakes on an alarm about every POLL_MS (cron is 1-minute granularity, too coarse). Each
// wake GETs Kalshi's PUBLIC REST order books for the live 15m markets, buffers JSONL rows, and every FLUSH_MS writes one
// gzipped object to R2: rec/<UTC day>/<series>.<HHMMSS>.jsonl.gz. The box pulls those objects with a read-only R2 token.
// Rows match the box recorder's kalshi.book shape, plus src:'cf', so the two streams can be merged or compared.
// Safety: getPublic() only issues GET requests to the Kalshi host, only on /markets paths. No order, portfolio or
// auth code exists here, and no Kalshi key is used.

const ALLOWED_PATH = /^\/trade-api\/v2\/markets(\/[A-Z0-9._-]+\/orderbook)?$/;

export function getPublic(base, path, query, fetchImpl = fetch) {
  const u = new URL(base.replace(/\/$/, '') + path);
  if (u.protocol !== 'https:' || !/(^|\.)kalshi\.com$/.test(u.hostname) || !ALLOWED_PATH.test(u.pathname)) throw new Error('refused: not a public Kalshi market-data path');
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  return fetchImpl(u.toString(), { method: 'GET', headers: { accept: 'application/json' } });
}

/** Same normalization as the box recorder: best-first [price, qty] levels; YES ask = 1 - best NO bid. */
export function normBook(j) {
  const ob = (j && (j.orderbook_fp || j.orderbook)) || {};
  const cents = !j.orderbook_fp && !!j.orderbook;
  const lv = (a) => (Array.isArray(a) ? a : []).map(([p, q]) => [cents ? +p / 100 : +p, +q]).filter(([p, q]) => p > 0 && q >= 0).sort((a, b) => b[0] - a[0]);
  const yes = lv(ob.yes_dollars || ob.yes), no = lv(ob.no_dollars || ob.no);
  return { yes, no, yb: yes[0] ? yes[0][0] : null, ybs: yes[0] ? yes[0][1] : null, ya: no[0] ? +(1 - no[0][0]).toFixed(4) : null, yas: no[0] ? no[0][1] : null };
}

export async function gzipLines(rows) {
  const body = new Blob([rows.map((r) => JSON.stringify(r)).join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

export class Recorder {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx; this.env = env; this.http = deps.fetch || ((...a) => fetch(...a)); this.now = deps.now || (() => Date.now());
    this.c = { base: env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2', series: String(env.SERIES || 'KXBTC15M').split(',').map((s) => s.trim()).filter(Boolean),
      pollMs: num(env.POLL_MS, 1000), discoverMs: num(env.DISCOVER_MS, 60000), flushMs: num(env.FLUSH_MS, 60000), depth: num(env.DEPTH, 10) };
    this.buf = []; this.markets = []; this.lastDiscover = 0; this.lastFlush = this.now(); this.n = { polls: 0, rows: 0, errors: 0, s429: 0, flushes: 0 };
    // In-memory state is lost when the object is evicted. Record that as an explicit gap instead of silently resuming.
    this.buf.push({ t: 'gap', reason: 'do-start', rx: this.now(), src: 'cf' });
  }
  async running() { return (await this.ctx.storage.get('running')) === true; }
  async fetch(req) { // reached only through the Worker below, after it checks the bearer token
    const p = new URL(req.url).pathname;
    if (p === '/start') { await this.ctx.storage.put('running', true); await this.ctx.storage.setAlarm(this.now() + 100); return Response.json({ ok: true }); }
    if (p === '/stop') { await this.ctx.storage.put('running', false); await this.ctx.storage.deleteAlarm(); await this.flush(true); return Response.json({ ok: true }); }
    return Response.json({ running: await this.running(), markets: this.markets.map((m) => m.tk), buffered: this.buf.length, ...this.n, cfg: this.c });
  }
  async discover() {
    const out = [];
    for (const s of this.c.series) {
      const r = await getPublic(this.c.base, '/markets', { series_ticker: s, status: 'open', limit: 20 }, this.http);
      if (r.status === 429) { this.n.s429++; continue; } if (!r.ok) { this.n.errors++; continue; }
      const j = await r.json(); for (const m of j.markets || []) out.push({ tk: m.ticker, series: s, close: Date.parse(m.close_time) || null, strike: m.floor_strike ?? null });
    }
    this.markets = out.filter((m) => !m.close || m.close + 2000 > this.now()); this.lastDiscover = this.now();
  }
  async poll() {
    const t0 = this.now(); this.n.polls++;
    if (t0 - this.lastDiscover >= this.c.discoverMs || !this.markets.length) await this.discover();
    await Promise.all(this.markets.map(async (m) => {
      try {
        const r = await getPublic(this.c.base, `/markets/${m.tk}/orderbook`, { depth: this.c.depth }, this.http);
        if (r.status === 429) { this.n.s429++; this.buf.push({ t: 'gap', reason: 'http-429', key: m.tk, rx: this.now(), src: 'cf' }); return; } // Kalshi sends no Retry-After; skip this tick
        if (!r.ok) { this.n.errors++; return; }
        const b = normBook(await r.json()); this.buf.push({ t: 'book', s: 'kalshi.book', series: m.series, tk: m.tk, strike: m.strike, rx: this.now(), lat: this.now() - t0, src: 'cf', ...b }); this.n.rows++;
      } catch { this.n.errors++; }
    }));
  }
  async flush(force = false) {
    if (!this.buf.length || (!force && this.now() - this.lastFlush < this.c.flushMs)) return null;
    const rows = this.buf; this.buf = []; this.lastFlush = this.now();
    const d = new Date(rows[0].rx).toISOString(); const key = `rec/${d.slice(0, 10)}/kalshi.book.${d.slice(11, 19).replace(/:/g, '')}-cf.jsonl.gz`;
    await this.env.BUCKET.put(key, await gzipLines(rows), { httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' }, customMetadata: { rows: String(rows.length) } });
    this.n.flushes++; return key;
  }
  async alarm() {
    if (!(await this.running())) return;
    // Schedule the next wake first, so a thrown poll does not stop the loop. Alarms are at-least-once; poll() is idempotent enough (duplicate rows carry rx).
    const next = Math.ceil((this.now() + 1) / this.c.pollMs) * this.c.pollMs; await this.ctx.storage.setAlarm(next);
    try { await this.poll(); } catch { this.n.errors++; }
    await this.flush();
  }
}

export default {
  async fetch(req, env) {
    const auth = req.headers.get('authorization') || '';
    if (!env.STATUS_TOKEN || auth !== 'Bearer ' + env.STATUS_TOKEN) return new Response('unauthorized', { status: 401 });
    const p = new URL(req.url).pathname;
    if (!['/status', '/start', '/stop'].includes(p)) return new Response('not found', { status: 404 });
    if (p !== '/status' && req.method !== 'POST') return new Response('method not allowed', { status: 405 }); // control of the recorder only; nothing reaches Kalshi from here
    const stub = env.RECORDER.get(env.RECORDER.idFromName('main'), { locationHint: 'enam' }) // US East, near Kalshi;
    return stub.fetch(req);
  },
};
