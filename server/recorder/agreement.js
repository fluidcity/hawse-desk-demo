'use strict';
// miro add-on (H7): how often does our rebuilt BRTI-style index call the same 15m outcome as Kalshi's OFFICIAL result?
// Research and display only. It decides nothing and feeds no strategy.
//   * The 1 s ref median (refprice.js, 6 free venues) is sampled per asset into a ~20 min ring.
//   * When the optional Kalshi WS cfbenchmarks_value feed is on, the real CF RTI is sampled the same way as a second
//     source (a sanity check: it should agree ~100%).
//   * On each official Kalshi settle row for a crypto 15m market, the 60 s simple average over [close-60s, close) is
//     compared with the official strike (floor_strike, which is the open-side average): ours = avg >= strike ? yes : no.
//     The diff vs Kalshi's expiration_value (the official close-side average) is kept in bps.
//   * Coverage must be >= minSamples of the 60 seconds. Otherwise the market counts as 'insufficient', never as agree or disagree.
// Counts are since desk start. Every comparison is also written to the 'agree' stream on disk.
const { wilson } = require('../kalshi-h2/stats');

const CF_ASSET = { BRTI: 'BTC', ETHUSD_RTI: 'ETH', SOLUSD_RTI: 'SOL', XRPUSD_RTI: 'XRP' };
const assetOfSeries = (s) => { const m = /^KX(BTC|ETH|SOL|XRP)15M$/.exec(String(s || '')); return m ? m[1] : null; };
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);

class IndexAgreement {
  constructor({ store = null, cfg = {} } = {}) {
    this.c = { windowMs: 60000, minSamples: 50, keepMs: 20 * 60000, target: 0.995, minSettled: 200, ...cfg };
    this.store = store; this.rings = {}; this.stats = {}; this.recent = []; this.seen = new Set();
  }
  sample(src, asset, at, v) {
    if (!asset || !(v > 0) || !Number.isFinite(at)) return; const k = src + ':' + asset; const r = (this.rings[k] = this.rings[k] || []);
    r.push([at, v]); const cut = at - this.c.keepMs; let i = 0; while (i < r.length && r[i][0] < cut) i++; if (i) r.splice(0, i);
  }
  onRef(row, at) { if (row && row.med != null) this.sample('ref', row.asset, at, row.med); }
  onCf(row, at) { if (row) this.sample('cf', CF_ASSET[row.id], at, row.v); }
  /** 60 s simple average of per-second buckets in [close - windowMs, close). Returns {avg, n} (n = seconds covered). */
  avg(src, asset, close) {
    const r = this.rings[src + ':' + asset] || [], from = close - this.c.windowMs, sec = new Map();
    for (const [t, v] of r) if (t >= from && t < close) sec.set(Math.floor(t / 1000), v); // last value in each second
    const xs = [...sec.values()]; return { n: xs.length, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null };
  }
  onSettle(row) {
    const asset = assetOfSeries(row && row.s); if (!asset || !row.close || row.strike == null || !/^(yes|no)$/.test(row.result) || this.seen.has(row.tk)) return null;
    this.seen.add(row.tk); const out = [];
    for (const src of ['ref', 'cf']) {
      if (!this.rings[src + ':' + asset] && src === 'cf') continue;
      const { n, avg } = this.avg(src, asset, row.close); const s = (this.stats[src] = this.stats[src] || { compared: 0, agree: 0, insufficient: 0, perAsset: {} });
      const pa = (s.perAsset[asset] = s.perAsset[asset] || { compared: 0, agree: 0 });
      if (n < this.c.minSamples) { s.insufficient++; out.push({ t: 'agree', src, tk: row.tk, asset, n, status: 'insufficient' }); continue; }
      const ours = avg >= row.strike ? 'yes' : 'no', agree = ours === row.result; s.compared++; pa.compared++; if (agree) { s.agree++; pa.agree++; }
      out.push({ t: 'agree', src, tk: row.tk, asset, n, avg: r6(avg), strike: row.strike, value: row.value, diffBps: row.value ? r6(((avg - row.value) / row.value) * 1e4) : null, ours, official: row.result, agree });
    }
    for (const r of out) { if (this.store) this.store.write('agree', r); this.recent.unshift(r); } this.recent = this.recent.slice(0, 10);
    return out;
  }
  view() {
    const src = {}; for (const [k, s] of Object.entries(this.stats)) {
      const rate = s.compared ? s.agree / s.compared : null, ci = wilson(s.agree, s.compared);
      const status = s.compared < this.c.minSettled ? 'pending' : rate > this.c.target ? 'met' : 'not met';
      src[k] = { ...s, rate: r6(rate), ci95: ci ? { lo: ci.lo, hi: ci.hi } : null, status };
    }
    return { target: this.c.target, minSettled: this.c.minSettled, minSamples: this.c.minSamples, sources: src, recent: this.recent,
      note: `60 s average before close vs the official strike, crypto 15m only, since desk start. 'pending' until ${this.c.minSettled} settled markets are compared.` };
  }
}
module.exports = { IndexAgreement, assetOfSeries, CF_ASSET };
