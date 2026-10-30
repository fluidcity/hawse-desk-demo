'use strict';
// H6 market-data RECORDER hub. RECORD ONLY: no strategy, no orders, no auth. Everything it writes goes to append-only,
// rotated, disk-capped JSONL files under data/recorder/ (gitignored), see store.js.
// Time and gaps:
//   * every row has rx (local wall-clock ms at receive/write) and mono (monotonic ms); venue rows add ex (exchange ts) when the venue sends one.
//   * meta stream: session_start / session_stop, and a heartbeat row every 10 s.
//   * on start, the last heartbeat left by the previous process gives an explicit 'offline' gap (desk down or box asleep).
//   * a 1 s internal tick compares wall-clock vs monotonic time: wall far ahead of mono => 'vm-pause' (this box is a VM
//     that is paused between sessions); both far behind schedule => 'stall' (event loop blocked or the VM froze with mono running).
//     The H5.1 watchdog's clock-jump detection also feeds in (onClockJump) as a 'clock-jump' marker.
//   * per-stream 'poll-gap' rows when a polled stream (book/trades) went longer than its gap threshold without a good
//     response; a poll-gap overlapping a known pause is labelled 'box-pause' instead.
// All gap rows go to the 'gaps' stream and are counted in the status panel. Nothing is backfilled or interpolated.
const { performance } = require('perf_hooks');
const { RecorderStore } = require('./store');
const { KalshiRecorder } = require('./kalshi');
const { PolymarketRecorder } = require('./polymarket');
const { RefPriceRecorder } = require('./refprice');

class Recorder {
  constructor({ health, cfg, now = () => Date.now(), mono = () => performance.now(), log = (m) => console.log(m), odds = null, deps = {} }) {
    Object.assign(this, { health, cfg, now, mono, log, odds });
    this.store = deps.store || new RecorderStore({ dir: cfg.dir, capBytes: cfg.capBytes, maxFileBytes: cfg.maxFileBytes, rotateMs: cfg.rotateMs, now, mono, log });
    const gap = (stream, key, from, to, reason) => this.gap(stream, key, from, to, reason);
    this.kalshi = cfg.kalshi && cfg.kalshi.enabled ? deps.kalshi || new KalshiRecorder({ store: this.store, health, cfg: cfg.kalshi, gap, now, log }) : null;
    this.poly = cfg.polymarket && cfg.polymarket.enabled ? deps.poly || new PolymarketRecorder({ store: this.store, health, cfg: cfg.polymarket, gap, now, log }) : null;
    this.ref = cfg.ref && cfg.ref.enabled ? deps.ref || new RefPriceRecorder({ store: this.store, health, cfg: cfg.ref, now, log }) : null;
    this.gaps = { n: 0, byReason: {}, recent: [] }; this.pauses = []; this.timers = []; this.running = false; this.startedAt = null; this.oddsRows = 0; this.oddsSeen = new Map();
    health.register('rec.store', { label: 'Recorder · disk writer', group: 'recorder', note: `append-only JSONL under data/recorder · hourly/${Math.round(cfg.maxFileBytes / 2 ** 20)} MiB rotation + gzip · cap ${(cfg.capBytes / 2 ** 30).toFixed(1)} GiB (oldest files evicted)`, staleMs: 15000 });
    if (cfg.odds && cfg.odds.enabled) health.register('rec.odds', { label: 'Recorder · sports odds (The Odds API tap)', group: 'recorder', note: 'records the betting feed’s own live snapshots; zero extra API credits; nothing recorded from MOCK odds', staleMs: 24 * 3600e3 });
  }
  gap(stream, key, from, to, reason) {
    this.tick(); // classify against a pause detected right now, before the poll that noticed the gap
    if (!reason) reason = this.pauses.some((p) => p.from < to && p.to > from) ? 'box-pause' : 'poll-gap';
    const row = { t: 'gap', stream, key, from, to, ms: Math.max(0, to - from), reason };
    this.store.write('gaps', row); this.gaps.n++; this.gaps.byReason[reason] = (this.gaps.byReason[reason] || 0) + 1;
    this.gaps.recent.unshift(row); this.gaps.recent = this.gaps.recent.slice(0, 12); return row;
  }
  pause(from, to, reason, extra = {}) { this.pauses.push({ from, to }); this.pauses = this.pauses.slice(-50); return this.gap('all', reason, from, to, reason, extra); }
  /** 1 s heartbeat: wall vs monotonic. Idempotent (only measures since the previous call). */
  tick() {
    const w = this.now(), m = this.mono(); if (this.w0 == null) { this.w0 = w; this.m0 = m; return; }
    const dw = w - this.w0, dm = m - this.m0; const w0 = this.w0; this.w0 = w; this.m0 = m;
    if (dw - dm > 5000) this.pause(w0, w, 'vm-pause');
    else if (dm > 5000) this.pause(w0, w, 'stall');
  }
  onClockJump(j) { if (!this.running) return; const row = { t: 'gap', stream: 'all', key: 'watchdog', from: j.at - j.ms, to: j.at, ms: j.ms, reason: 'clock-jump' }; this.store.write('gaps', row); this.gaps.n++; this.gaps.byReason['clock-jump'] = (this.gaps.byReason['clock-jump'] || 0) + 1; this.gaps.recent.unshift(row); this.gaps.recent = this.gaps.recent.slice(0, 12); }
  start() {
    if (this.running) return; this.running = true; this.startedAt = this.now();
    this.store.start();
    const prev = this.store.lastMetaRow();
    this.store.write('meta', { t: 'session_start', pid: process.pid, node: process.version, streams: { kalshi: !!this.kalshi, polymarket: !!this.poly, ref: !!this.ref, odds: !!(this.cfg.odds && this.cfg.odds.enabled) }, capBytes: this.cfg.capBytes });
    if (prev && prev.rx && this.startedAt - prev.rx > 5000) this.pause(prev.rx, this.startedAt, 'offline', { prev: prev.t });
    for (const x of [this.kalshi, this.poly, this.ref]) if (x) x.start();
    this.tapOdds();
    const t1 = setInterval(() => this.tick(), 1000); const t2 = setInterval(() => this.beat(), 10000);
    for (const t of [t1, t2]) { if (t.unref) t.unref(); this.timers.push(t); }
  }
  beat() { this.store.write('meta', { t: 'heartbeat', rows: this.store.rows }); const v = this.store.view(); if (v.capped) this.health.fail('rec.store', `disk cap reached: ${v.dropped} rows dropped`); else if (v.errors && v.lastError) this.health.fail('rec.store', 'write error: ' + v.lastError); else this.health.ok('rec.store', null); }
  stop() { if (!this.running) return; for (const t of this.timers) clearInterval(t); this.timers = []; for (const x of [this.kalshi, this.poly, this.ref]) if (x) x.stop(); this.store.write('meta', { t: 'session_stop', rows: this.store.rows }); this.store.stop(); this.running = false; }
  tapOdds() {
    const f = this.odds; if (!f || !(this.cfg.odds && this.cfg.odds.enabled) || !Array.isArray(f.listeners)) return;
    f.listeners.push((ev) => {
      if (ev.simulated) return; const key = JSON.stringify(ev.books || []); if (this.oddsSeen.get(ev.id) === key) return; this.oddsSeen.set(ev.id, key);
      if (this.oddsSeen.size > 5000) this.oddsSeen.delete(this.oddsSeen.keys().next().value);
      this.store.write('odds', { t: 'odds', id: ev.id, sport: ev.sport, home: ev.home, away: ev.away, commence: ev.commence, books: ev.books }); this.oddsRows++; this.health.ok('rec.odds', null);
    });
  }
  watchSpec() { return [].concat(...[this.kalshi, this.poly, this.ref].filter(Boolean).map((x) => x.watchSpec())); }
  projection() {
    const up = this.startedAt ? (this.now() - this.startedAt) / 1000 : 0; const v = this.store.view();
    if (up < 60) return null; const rawPerDay = (v.bytes / up) * 86400; const ratio = v.gzRatio || 0.12; // gzip ratio measured on rotated files once one exists; 0.12 is an assumption until then
    return { rawBytesPerDay: Math.round(rawPerDay), gzBytesPerDay: Math.round(rawPerDay * ratio), gzRatio: ratio, gzRatioMeasured: !!v.gzRatio, rowsPerDay: Math.round((v.rows / up) * 86400), daysToCap: rawPerDay ? +(this.cfg.capBytes / (rawPerDay * ratio)).toFixed(1) : null, basisSec: Math.round(up) };
  }
  snapshot() {
    const o = this.odds; const oddsMode = o ? o.mode : 'absent';
    return { enabled: true, running: this.running, startedAt: this.startedAt, store: this.store.view(), projection: this.projection(), gaps: this.gaps,
      kalshi: this.kalshi ? this.kalshi.view() : null, poly: this.poly ? this.poly.view() : null, ref: this.ref ? this.ref.view() : null,
      odds: { enabled: !!(this.cfg.odds && this.cfg.odds.enabled), feedMode: oddsMode, rows: this.oddsRows, credits: o && o.quota ? { remaining: o.quota.remaining, used: o.quota.used } : null,
        note: oddsMode === 'mock' ? 'betting feed is on MOCK odds: nothing recorded (mock is never written as real data)' : 'records the betting feed’s live snapshots (no extra credits; budget guard unchanged)' } };
  }
}
module.exports = { Recorder };
