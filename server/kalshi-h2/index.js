'use strict';
// Kalshi H2 forward PAPER test (miro, kalshi-15m-payout-sweep.md section 7). Paper ledger only.
// There is no exchange-facing code here at all: it listens to the record-only Kalshi recorder's public book and
// settlement events, decides per the FROZEN config, and appends to its own ledger. It never touches desk equity.
//
// Freeze: config/frozen/kalshi-h2-<version>.json is hashed (SHA-256 of the file bytes). The expected hash is pinned in
// FROZEN below and, separately, in test/kalshi-h2.test.js. A mismatch refuses to run. A rule change needs a NEW file,
// a new version + hash, and gets its own ledger folder, so old results are never mixed with new ones.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./stats');

const FROZEN = {
  'kalshi-h2-v1': '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c',
  'kalshi-h2-v2': 'ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c', // v2 arm (server/kalshi-h2/v2.js): a filter on v1 signals; own ledger
  'kalshi-h2-v3': '5498e1cbea6c45e427876dd2971f041421ef18ad06c103dc7921898f5179ce1c', // v3 arm (server/kalshi-h2/v3.js): v2 decisions + paper size caps; own ledgers
};
const DEFAULT_FILE = path.join(__dirname, '..', '..', 'config', 'frozen', 'kalshi-h2-v1.json');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
/** Load + verify a frozen config. Throws if the file was edited after its hash was pinned. */
function loadFrozen(file = DEFAULT_FILE, pins = FROZEN) {
  const buf = fs.readFileSync(file), hash = sha256(buf), cfg = JSON.parse(buf.toString('utf8'));
  const key = `${cfg.id}-${cfg.version}`, want = pins[key];
  if (!want) throw new Error(`frozen config ${key} has no pinned hash (new versions need a FROZEN entry)`);
  if (want !== hash) throw new Error(`frozen config ${key} was edited after the freeze (sha256 ${hash.slice(0, 12)} != pinned ${want.slice(0, 12)}); make a new version instead`);
  if (cfg.mode !== 'paper-only' || cfg.liveOrders !== false) throw new Error('frozen config must be paper-only');
  return { cfg, hash, key };
}
const assetOf = (series) => String(series).replace(/^KX/, '').replace(/15M$/, '');

class KalshiH2Paper {
  constructor({ kalshi = null, health = null, dir, file = DEFAULT_FILE, pins = FROZEN, now = Date.now, log = () => {} } = {}) {
    this.kalshi = kalshi; this.health = health; this.baseDir = dir; this.file = file; this.pins = pins; this.now = now; this.log = log;
    this.cfg = null; this.hash = null; this.key = null; this.error = null; this.running = false; this.timers = [];
    this.mk = new Map(); // tk -> per-market state
    this.signals = []; this.fills = new Map(); this.trades = []; this.skips = {}; this.flags = []; this.recent = []; this.startAt = null; this.sessions = 0;
    this.observed = { markets: 0, noTouch: 0 }; this.halted = null; this.marks = new Map(); // tk -> latest YES bid of an open paper fill (display only)
    this.rowListeners = []; // read-only observers of appended rows (the v2 arm); they cannot change v1 decisions
    if (health) health.register('paper.kalshi-h2', { label: 'Kalshi H2 forward paper test (frozen v1)', group: 'recorder', note: 'paper ledger only; decisions from recorder books; official Kalshi results', staleMs: 120000 });
  }
  get ledgerFile() { return path.join(this.baseDir, this.cfg.version, 'ledger.jsonl'); }
  start() {
    try { const f = loadFrozen(this.file, this.pins); this.cfg = f.cfg; this.hash = f.hash; this.key = f.key; } catch (e) {
      this.error = e.message; this.log('[kalshi-h2] REFUSING to run: ' + e.message); if (this.health) this.health.fail('paper.kalshi-h2', 'refused: ' + e.message); return;
    }
    if (!this.cfg.rule || !this.cfg.sizing) { // e.g. the v2 filter file: it has no entry rule of its own and runs only through server/kalshi-h2/v2.js
      this.error = `${this.key} is not an entry-rule config`; this.log('[kalshi-h2] REFUSING to run: ' + this.error); if (this.health) this.health.fail('paper.kalshi-h2', 'refused: ' + this.error); this.cfg = null; return;
    }
    fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
    this.replay();
    this.append({ t: 'session', hash: this.hash, pid: process.pid });
    if (!this.startAt) this.startAt = this.now();
    this.running = true;
    if (this.kalshi) {
      this.kalshi.on('book', (e) => this.onBook(e)); this.kalshi.on('settle', (r) => this.onSettle(r));
      this.kalshi.on('market', (m) => this.onMarket(m)); this.kalshi.on('series', (s) => this.onSeries(s));
      for (const [tk, f] of this.fills) if (!f.settled) this.kalshi.track({ ticker: tk, series_ticker: f.series, close_time: new Date(f.close).toISOString() });
    }
    const t = setInterval(() => this.tick(), 1000); if (t.unref) t.unref(); this.timers.push(t);
    if (this.health) this.health.ok('paper.kalshi-h2', 0);
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; }
  append(row) {
    const r = { at: this.now(), v: this.cfg.version, ...row };
    fs.appendFileSync(this.ledgerFile, JSON.stringify(r) + '\n');
    this.apply(r);
    for (const f of this.rowListeners) { try { f({ ...r }); } catch { /* an observer can never break v1 */ } }
    return r;
  }
  replay() {
    if (!fs.existsSync(this.ledgerFile)) return;
    for (const line of fs.readFileSync(this.ledgerFile, 'utf8').split('\n')) { if (!line.trim()) continue; try { this.apply(JSON.parse(line), true); } catch { /* torn last line: ignore */ } }
  }
  /** Fold one ledger row into memory (used live and on replay). */
  apply(r, replaying = false) {
    if (r.t === 'session') { this.sessions++; if (!this.startAt) this.startAt = r.at; if (r.hash && r.hash !== this.hash) this.flags.push({ at: r.at, reason: 'ledger row from a different config hash' }); return; }
    if (r.t === 'signal') { this.signals.push(r); this.done(r.tk); }
    if (r.t === 'fill') this.fills.set(r.tk, { ...r, settled: false });
    if (r.t === 'skip') { this.skips[r.reason] = (this.skips[r.reason] || 0) + 1; this.done(r.tk); }
    if (r.t === 'observed') { this.observed.markets++; if (r.outcome === 'no_touch') this.observed.noTouch++; this.done(r.tk); }
    if (r.t === 'settle') { const f = this.fills.get(r.tk); if (f) { f.settled = true; this.trades.push(r); } this.marks && this.marks.delete(r.tk); }
    if (r.t === 'settle_timeout') { const f = this.fills.get(r.tk); if (f) f.settled = 'timeout'; this.skips.settle_timeout = (this.skips.settle_timeout || 0) + 1; }
    if (r.t === 'flag') { this.flags.push(r); if (r.halt) this.halted = r.reason; }
    this.recent.push(r); if (this.recent.length > 40) this.recent.shift();
  }
  done(tk) { const m = this.mk.get(tk) || {}; m.decided = true; this.mk.set(tk, m); }
  onSeries(s) {
    if (!this.running || !this.cfg.rule.series.includes(s.s)) return;
    const F = this.cfg.fees;
    if (s.fee_type !== F.expectSeriesFeeType || s.fee_multiplier !== F.expectSeriesFeeMultiplier) this.haltOnce(`fee schedule changed on ${s.s}: ${s.fee_type} x${s.fee_multiplier}`);
  }
  onMarket(m) {
    if (!this.running || !this.cfg.rule.series.includes(m.series)) return;
    const T = this.cfg.ticks;
    if (m.pls && m.pls !== T.expectPriceLevelStructure) this.haltOnce(`tick structure changed on ${m.tk}: ${m.pls}`);
    if (m.ranges && JSON.stringify(m.ranges.map((x) => [x.start, x.end, x.step])) !== JSON.stringify(T.expectRanges.map((x) => [x.start, x.end, x.step]))) this.haltOnce(`tick ranges changed on ${m.tk}`);
  }
  haltOnce(reason) { if (this.halted) return; this.append({ t: 'flag', reason, halt: true, kind: 'fail-stop' }); this.log('[kalshi-h2] FAIL-STOP: ' + reason); }
  onBook(e) {
    if (!this.running) return;
    { const f = this.fills.get(e.tk); if (f && !f.settled) this.marks.set(e.tk, { yb: e.yb, ybs: e.ybs, rx: e.rx }); }
    if (this.halted) return;
    const R = this.cfg.rule; if (!R.series.includes(e.series) || e.secLeft == null) return;
    const m = this.mk.get(e.tk) || { tk: e.tk, preWindow: false, lastRx: null, broken: null };
    this.mk.set(e.tk, m);
    if (m.pending) return this.tryFill(m, e);
    if (m.decided) return;
    const prev = m.lastRx; m.lastRx = e.rx;
    if (e.secLeft > R.secondsLeftMax) { m.preWindow = true; return; }
    if (e.secLeft < R.secondsLeftMin) {
      this.append({ t: 'observed', tk: e.tk, series: e.series, outcome: m.preWindow && !m.broken ? 'no_touch' : 'no_touch_partial_coverage' }); return;
    }
    const C = this.cfg.coverage;
    if (C.requirePreWindowBook && !m.preWindow) m.broken = m.broken || 'joined_late';
    if (prev != null && e.rx - prev > C.maxBookGapMs) m.broken = m.broken || 'incomplete_coverage';
    const inBand = e.ya != null && e.ya >= R.yesAskMin && e.ya <= R.yesAskMax;
    if (!inBand) return;
    const base = { tk: e.tk, series: e.series, asset: assetOf(e.series), secLeft: e.secLeft, ya: e.ya, yas: e.yas, yb: e.yb, strike: e.strike, close: e.close, bookRx: e.rx };
    if (m.broken) { this.append({ t: 'skip', reason: m.broken, stage: 'signal', ...base }); return; }
    const sig = this.append({ t: 'signal', ...base, ladder: (e.askLadder || []).slice(0, 5) });
    m.pending = sig; m.decided = true;
  }
  /** Conservative fill: the NEXT book snapshot after the signal, within nextSnapshotMaxMs, walking the ask ladder up to the limit. */
  tryFill(m, e) {
    const sig = m.pending, F = this.cfg.fill; m.pending = null;
    const base = { tk: sig.tk, series: sig.series, asset: sig.asset, signalAsk: sig.ya, bookRx: e.rx, lagMs: e.rx - sig.bookRx };
    if (e.rx - sig.bookRx > F.nextSnapshotMaxMs) return this.append({ t: 'skip', reason: 'fill_snapshot_too_late', stage: 'fill', ...base });
    const ladder = (e.askLadder && e.askLadder.length ? e.askLadder : e.ya != null ? [[e.ya, e.yas]] : []).map(([p, q]) => [+p, +q]).filter(([p, q]) => p > 0 && q > 0).sort((a, b) => a[0] - b[0]);
    if (!ladder.length) return this.append({ t: 'skip', reason: 'no_ask', stage: 'fill', ...base });
    const limit = Math.min(F.limitCap, +(sig.ya + F.limitAboveSignalAsk).toFixed(4));
    let need = this.cfg.sizing.contracts, cost = 0;
    for (const [p, q] of ladder) { if (p > limit + 1e-9 || need <= 0) break; const take = Math.min(need, q); cost += take * p; need -= take; }
    if (need > 0) return this.append({ t: 'skip', reason: 'no_fill_within_limit', stage: 'fill', limit, nextAsk: ladder[0][0], ...base });
    const vwap = cost / this.cfg.sizing.contracts, px = +Math.max(sig.ya, vwap).toFixed(4);
    this.append({ t: 'fill', ...base, px, vwap: +vwap.toFixed(4), limit, nextAsk: ladder[0][0], nextAskSize: ladder[0][1], fee1: S.fee1(px, this.cfg.fees.rate), feeL: +S.feeLarge(px, this.cfg.fees.rate).toFixed(6), close: sig.close, paper: true });
  }
  onSettle(r) {
    if (!this.running) return; const f = this.fills.get(r.tk); if (!f || f.settled) return;
    const win = r.result === 'yes', pay = win ? 1 : 0, sig = this.signals.find((s) => s.tk === r.tk);
    const R6 = (x) => Math.round(x * 1e6) / 1e6;
    this.append({ t: 'settle', tk: r.tk, series: f.series, asset: f.asset, result: r.result, status: r.status, settledAt: r.settledAt, px: f.px, fee1: f.fee1, feeL: f.feeL, win,
      pnl1: R6(pay - f.px - f.fee1), pnlL: R6(pay - f.px - f.feeL), pnlSpec: sig ? R6(pay - sig.ya - S.fee1(sig.ya, this.cfg.fees.rate)) : null, signalAt: sig ? sig.at : f.at, yas: sig ? sig.yas : null, source: 'kalshi official result' });
  }
  tick() {
    const now = this.now(), F = this.cfg.fill;
    for (const m of this.mk.values()) if (m.pending && now - m.pending.bookRx > F.nextSnapshotMaxMs + 1000) { const sig = m.pending; m.pending = null; this.append({ t: 'skip', reason: 'fill_snapshot_too_late', stage: 'fill', tk: sig.tk, series: sig.series, asset: sig.asset, signalAsk: sig.ya, lagMs: now - sig.bookRx }); }
    for (const [tk, f] of this.fills) if (!f.settled && f.close && now > f.close + this.cfg.settlement.timeoutHours * 3600e3) this.append({ t: 'settle_timeout', tk, series: f.series });
    for (const [tk, m] of this.mk) if (m.decided && !m.pending && m.lastRx && now - m.lastRx > 2 * 3600e3) this.mk.delete(tk);
    if (!this.halted) { const st = this.stats(); for (const r of st.failStops) { this.haltOnce(r); break; } }
    if (this.health) this.health.ok('paper.kalshi-h2', 0);
  }
  stats() {
    if (!this.cfg) return null;
    const trades = this.trades.map((t) => ({ ...t, at: t.signalAt || t.at }));
    const unsettled = [...this.fills.values()].filter((f) => !f.settled).length;
    const st = S.summarize({ cfg: this.cfg, startAt: this.startAt, now: this.now(), signals: this.signals, fills: this.fills.size, trades, skips: this.skips, unsettled });
    if (this.halted && !st.failStops.includes(this.halted)) st.failStops.unshift(this.halted);
    if (st.failStops.length) st.verdict = 'FAIL-STOP';
    return st;
  }
  snapshot() {
    return { enabled: true, running: this.running, error: this.error, paper: true, label: 'PAPER · forward test · not real money', id: this.key, version: this.cfg && this.cfg.version, hash: this.hash,
      rule: this.cfg && this.cfg.rule, fill: this.cfg && this.cfg.fill && this.cfg.fill.model, startAt: this.startAt, sessions: this.sessions, observed: this.observed, halted: this.halted, flags: this.flags.slice(-5),
      pending: [...this.mk.values()].filter((m) => m.pending).length, stats: this.stats(), pnl: this.cfg ? S.livePnl({ trades: this.trades, fills: [...this.fills.values()], marks: this.marks, now: this.now(), startAt: this.startAt, rate: this.cfg.fees.rate }) : null, recent: this.recent.slice(-15).reverse() };
  }
}
module.exports = { KalshiH2Paper, loadFrozen, sha256, FROZEN, DEFAULT_FILE, assetOf };
