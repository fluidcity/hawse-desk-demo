'use strict';
// Kalshi H2 v3 arm (config/frozen/kalshi-h2-v3.json): v2's frozen entry/skip decisions PLUS size caps. PAPER ONLY.
//
// v3 never decides anything about entry. It trades exactly the v1 signals that v2 marked 'take', on the same next book
// snapshot v1 fills on, and takes the official result from v1's settle row. What v3 adds is SIZE: contracts per trade
// from min(X% of the line's paper balance, per-asset $ cap, optional overall $ cap, 10% of entry-minute volume, cash),
// filled against the recorded YES ask ladder. Two sizing lines (3% and 7%) each keep their own ledger and balance.
//
// There is no exchange-facing code here: no HTTP, no auth, no order call of any kind. It reads recorder events and
// recorded files, and appends to its own ledgers under <dir>/v3/. v1 and v2 are not changed by this arm.
const fs = require('fs');
const path = require('path');
const { loadFrozen, FROZEN, assetOf } = require('./index');
const S = require('./stats');
const A = require('./v2-audit');
const { readRecorded, fisherOneSided } = require('./v2');

const V3_FILE = path.join(__dirname, '..', '..', 'config', 'frozen', 'kalshi-h2-v3.json');
const MIN = 60000, MARKET_MS = 15 * MIN, EPS = 1e-9;
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** YES asks best-first from a recorder 'book' event or a recorded book row (YES ask = 1 - NO bid). */
function askLadderOf(b) {
  const L = b && b.askLadder && b.askLadder.length ? b.askLadder : b && Array.isArray(b.no) ? b.no.map(([p, q]) => [Math.round((1 - p) * 1e4) / 1e4, q]) : b && b.ya != null && b.yas ? [[b.ya, b.yas]] : [];
  return L.map(([p, q]) => [+p, +q]).filter(([p, q]) => p > 0 && p < 1 && q > 0).sort((a, b) => a[0] - b[0]);
}
/** Kalshi taker fee for ONE order: roundup_to_cent(rate * sum C_i * P_i * (1 - P_i)) over its fill levels. */
function feeOrder(levels, rate = 0.07) {
  const raw = levels.reduce((s, [p, q]) => s + q * p * (1 - p), 0) * rate;
  return raw <= 0 ? 0 : Math.ceil(raw * 100 - 1e-7) / 100;
}
/** Visible depth at or below a limit price (contracts and dollars), plus the best level. */
function depthAt(ladder, limit) {
  let q = 0, d = 0; for (const [p, s] of ladder) { if (p > limit + EPS) break; q += s; d += s * p; }
  return { contracts: r2(q), dollars: r2(d), bestAsk: ladder.length ? ladder[0][0] : null, bestSize: ladder.length ? ladder[0][1] : null, levels: ladder.length };
}
/**
 * Paper size for one v3 order. All caps are converted to whole contracts at the decision-time ask; the smallest wins.
 * vol = contracts traded in the participation window (null = unknown -> no trade). Pure.
 */
function sizeOrder({ cfg, asset, ask, balance, cash, vol, pct }) {
  const Z = cfg.sizing, floor = (x) => Math.max(0, Math.floor(x + EPS));
  const requested = balance * pct, caps = {};
  caps.pct = floor(requested / ask);
  const ac = Z.perAssetDollarCap[asset]; caps.asset = ac != null ? floor(ac / ask) : 0; // an asset with no cap is not traded
  if (Z.overallDollarCap != null) caps.overall = floor(Z.overallDollarCap / ask);
  caps.participation = vol == null ? null : floor(Z.participation.share * vol);
  caps.cash = floor(Math.max(0, cash) / (ask + 0.01 + 0.25 * cfg.fees.rate)); // the fill may cost up to 1c more than the decision ask, plus at most the fee
  if (vol == null) return { requestedDollars: r2(requested), caps, contracts: 0, bound: ['unknown_volume'] };
  const vals = Object.entries(caps).filter(([, v]) => v != null), min = Math.min(...vals.map(([, v]) => v));
  return { requestedDollars: r2(requested), caps, contracts: min, bound: vals.filter(([, v]) => v === min).map(([k]) => k) };
}
/**
 * Fill model: walk the ask ladder best-first and fill only levels at or below limit = min(cap, decisionAsk + 1c).
 * Whatever the visible depth cannot fill is LEFT UNFILLED (logged). A stress price for that remainder (the worst visible
 * level + 1c, flagged) is reported for display only and never enters the balance. Pure.
 */
function fillLadder({ ladder, ask, want, F }) {
  const limit = Math.min(F.limitCap, r4(ask + F.limitAboveSignalAsk));
  const levels = []; let need = want, cost = 0;
  for (const [p, q] of ladder) { if (p > limit + EPS || need <= 0) break; const take = Math.min(need, Math.floor(q + EPS)); if (take <= 0) continue; levels.push([p, take]); cost += take * p; need -= take; }
  const filled = want - need, vwap = filled ? cost / filled : null, worst = ladder.length ? ladder[ladder.length - 1][0] : null;
  const stressPx = need > 0 && worst != null ? Math.min(F.limitCap, r4(worst + 0.01)) : null;
  return { limit, levels, filled, unfilled: need, cost: r6(cost), vwap: r6(vwap), slippageCents: vwap == null ? null : r4((vwap - ask) * 100),
    worstVisible: worst, stressPx, flags: need > 0 ? (stressPx != null ? ['remainder_unfilled', 'remainder_priced_worst_plus_1c'] : ['remainder_unfilled', 'no_visible_depth']) : [] };
}
/** Sample the visible depth at the limit every sampleEveryMs for windowMs after t0, from book states [[rx, ladder]] (latest at or before each point). */
function refillSeries(states, t0, limit, R) {
  const out = []; let i = 0, cur = null;
  const s = [...states].sort((a, b) => a[0] - b[0]);
  for (let dt = 0; dt <= R.windowMs; dt += R.sampleEveryMs) {
    while (i < s.length && s[i][0] <= t0 + dt) cur = s[i++][1];
    out.push(cur ? { s: dt / 1000, ...(({ contracts, dollars, bestAsk }) => ({ contracts, dollars, bestAsk }))(depthAt(cur, limit)) } : { s: dt / 1000, contracts: null, dollars: null, bestAsk: null });
  }
  return out;
}
function maxDrawdown(curve, start) { let peak = start, dd = 0; for (const p of curve) { peak = Math.max(peak, p.balance); dd = Math.max(dd, peak > 0 ? (peak - p.balance) / peak : 0); } return r4(dd); }

/** One sizing line: its own ledger, balance and open positions. */
class Line {
  constructor(spec, dir) { this.spec = spec; this.id = spec.id; this.file = path.join(dir, spec.id, 'ledger.jsonl'); this.balance = spec.startBalance; this.orders = new Map(); this.settles = new Map(); this.curve = []; }
  get reserved() { let s = 0; for (const [tk, o] of this.orders) if (!this.settles.has(tk) && !o.released && o.filled > 0) s += o.cost + o.fee; return s; }
  apply(r) {
    if (r.t === 'order') this.orders.set(r.tk, r);
    if (r.t === 'release') { const o = this.orders.get(r.tk); if (o) o.released = true; }
    if (r.t === 'settle' && !this.settles.has(r.tk)) { this.settles.set(r.tk, r); this.balance = r6(this.balance + r.pnl); this.curve.push({ at: r.settledAt || r.at, tk: r.tk, pnl: r.pnl, balance: this.balance }); }
  }
}

class KalshiH2V3 {
  constructor({ v1, v2, kalshi = null, health = null, dir, recorderDir = null, file = V3_FILE, pins = FROZEN, now = Date.now, log = () => {} } = {}) {
    Object.assign(this, { v1, v2, kalshi, health, baseDir: dir, recorderDir, file, pins, now, log });
    this.cfg = null; this.hash = null; this.key = null; this.error = null; this.running = false; this.timers = [];
    this.rows = new Map(); this.lines = []; this.recent = []; this.sessions = 0; this.startAt = null; this.backfill = null; this.verdict = null;
    this.trades = new Map(); this.tradeFeed = false; this.live = new Map(); // tk -> { sigLadder, awaitRx, refill }
    if (health) health.register('paper.kalshi-h2-v3', { label: 'Kalshi H2 v3 arm (v2 decisions + size caps)', group: 'recorder', note: 'paper only; sized fills on recorded ask ladders; UNPROVEN', staleMs: 120000 });
  }
  get dir() { return path.join(this.baseDir, this.cfg.version); }
  get ledgerFile() { return path.join(this.dir, 'ledger.jsonl'); }
  refuse(msg) { this.error = msg; this.log('[kalshi-h2-v3] REFUSING to run: ' + msg); if (this.health) this.health.fail('paper.kalshi-h2-v3', 'refused: ' + msg); }
  start() {
    try { const f = loadFrozen(this.file, this.pins); this.cfg = f.cfg; this.hash = f.hash; this.key = f.key; } catch (e) { return this.refuse(e.message); }
    if (this.cfg.version !== 'v3' || !this.cfg.sizing || !this.cfg.base || !this.cfg.base.v2) { const k = this.key; this.cfg = null; return this.refuse(`${k} is not a v3 sizing config`); }
    if (!this.v1 || !this.v1.cfg || !this.v1.running) return this.refuse('v1 is not running; v3 sizes v1 signals');
    if (!this.v2 || !this.v2.cfg || !this.v2.running) return this.refuse('v2 is not running; v3 trades only v2 take decisions');
    if (this.v1.hash !== this.cfg.base.v1.sha256) return this.refuse(`v1 hash ${String(this.v1.hash).slice(0, 12)} is not the v1 hash this v3 file was frozen on`);
    if (this.v2.hash !== this.cfg.base.v2.sha256) return this.refuse(`v2 hash ${String(this.v2.hash).slice(0, 12)} is not the v2 hash this v3 file was frozen on`);
    this.lines = this.cfg.sizing.lines.map((s) => new Line(s, this.dir));
    for (const L of this.lines) fs.mkdirSync(path.dirname(L.file), { recursive: true });
    this.replay();
    this.append({ t: 'session', hash: this.hash, base: { v1: this.v1.hash, v2: this.v2.hash }, pid: process.pid });
    if (!this.startAt) this.startAt = this.now();
    this.running = true;
    if (this.kalshi) {
      this.kalshi.on('book', (e) => { try { this.onBook(e); } catch (err) { this.log('[kalshi-h2-v3] ' + err.message); } });
      try { this.kalshi.on('trade', (t) => this.onTrade(t)); this.tradeFeed = true; } catch { this.tradeFeed = false; } // older recorder: no live trades -> volume unknown
    }
    try { this.reconcile(); } catch (e) { this.log('[kalshi-h2-v3] reconcile failed: ' + e.message); }
    if (this.v1.rowListeners) this.v1.rowListeners.push((r) => { try { this.onV1Row(r); } catch (e) { this.log('[kalshi-h2-v3] ' + e.message); } });
    this.checkVerdict();
    const t = setInterval(() => this.tick(), 5000); if (t.unref) t.unref(); this.timers.push(t);
    if (this.health) this.health.ok('paper.kalshi-h2-v3', 0);
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; }
  write(file, row) { const r = { at: this.now(), v: this.cfg.version, ...row }; fs.appendFileSync(file, JSON.stringify(r) + '\n'); return r; }
  append(row) { const r = this.write(this.ledgerFile, row); this.apply(r); return r; }
  appendLine(L, row) { const r = this.write(L.file, { line: L.id, ...row }); L.apply(r); this.recent.push(r); if (this.recent.length > 40) this.recent.shift(); return r; }
  replay() {
    const read = (f, fn) => { if (!fs.existsSync(f)) return; for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { fn(JSON.parse(l)); } catch { /* torn last line */ } } };
    read(this.ledgerFile, (r) => this.apply(r));
    for (const L of this.lines) read(L.file, (r) => L.apply(r));
  }
  apply(r) {
    if (r.t === 'session') { this.sessions++; if (!this.startAt) this.startAt = r.at; return; }
    if (r.t === 'verdict') { if (!this.verdict) this.verdict = r; return; } // first look only
    if (r.t === 'signal' && !this.rows.has(r.tk)) this.rows.set(r.tk, { sig: r });
    const x = this.rows.get(r.tk);
    if (x && ['book', 'nofill', 'refill', 'settle', 'settle_timeout'].includes(r.t) && !x[r.t]) x[r.t] = r;
    this.recent.push(r); if (this.recent.length > 40) this.recent.shift();
  }
  onTrade(t) {
    if (!t || !t.tk || !(t.c > 0) || t.ex == null) return;
    let L = this.trades.get(t.tk); if (!L) { L = { list: [], ids: new Set() }; this.trades.set(t.tk, L); }
    if (t.id && L.ids.has(t.id)) return; if (t.id) L.ids.add(t.id); L.list.push([+t.ex, +t.c]);
  }
  /** Contracts traded in the participation window ending at the signal book (exchange time). */
  volumeAt(tk, at, { trades = this.trades, known = this.tradeFeed } = {}) {
    if (!known) return { vol: null, nTrades: null, known: false, source: 'no trade feed' };
    const L = trades.get(tk), W = this.cfg.sizing.participation.windowMs; let v = 0, n = 0;
    for (const [ex, c] of (L && L.list) || []) if (ex > at - W && ex <= at) { v += c; n++; }
    return { vol: r2(v), nTrades: n, known: true };
  }
  onBook(e) {
    if (!this.running || !e || !e.tk) return; const s = this.live.get(e.tk); if (!s) return;
    const ladder = askLadderOf(e);
    if (s.sigRx === e.rx) s.sigLadder = ladder;
    if (s.awaitRx != null && e.rx === s.awaitRx) { s.awaitRx = null; this.doFill(e.tk, ladder, e.rx, { states: [[e.rx, ladder]], v1Fill: s.v1Fill }); }
    if (s.refill) { s.refill.states.push([e.rx, ladder]); if (e.rx >= s.refill.t0 + this.cfg.refill.windowMs) this.finishRefill(e.tk); }
  }
  /** Fold one v1 ledger row in (live, and from reconcile() with recorded books). Idempotent per market. */
  onV1Row(r, bf = null) {
    if (!this.running || r.v !== this.v1.cfg.version) return;
    const x = this.rows.get(r.tk);
    if (r.t === 'signal') {
      if (x && x.sig) return;
      const v2 = this.v2.rows.get(r.tk), d = v2 && v2.sig ? v2.sig.decision : 'unknown';
      this.append({ t: 'signal', tk: r.tk, series: r.series, asset: r.asset || assetOf(r.series), bookRx: r.bookRx, secLeft: r.secLeft, ya: r.ya, yas: r.yas, close: r.close, decision: d,
        v2Decided: !!(v2 && v2.sig), maxEarlierAsk: v2 && v2.sig ? v2.sig.maxEarlierAsk : null, backfill: bf ? true : undefined, paper: true });
      if (!bf) this.live.set(r.tk, { sigRx: r.bookRx, sigLadder: (r.ladder || []).map(([p, q]) => [+p, +q]), awaitRx: null, refill: null });
      return;
    }
    if (!x || !x.sig) return;
    if (r.t === 'fill' && !x.book) {
      if (x.sig.decision !== 'take') return this.append({ t: 'book', tk: r.tk, traded: false, reason: 'v2 ' + x.sig.decision, fillRx: r.bookRx });
      if (bf) return this.doFill(r.tk, bf.ladderAt(r.tk, r.bookRx), r.bookRx, { bf, v1Fill: r });
      const s = this.live.get(r.tk); if (s) { s.awaitRx = r.bookRx; s.v1Fill = r; }
      return;
    }
    if (r.t === 'skip' && r.stage === 'fill' && !x.nofill && !x.book) { this.live.delete(r.tk); return this.append({ t: 'nofill', tk: r.tk, reason: 'v1 ' + r.reason, decision: x.sig.decision }); }
    if (r.t === 'settle' && !x.settle) {
      this.append({ t: 'settle', tk: r.tk, result: r.result, win: r.win, settledAt: r.settledAt, pnl1: r.pnl1, source: 'kalshi official result (via v1)' });
      for (const L of this.lines) {
        const o = L.orders.get(r.tk); if (!o || o.filled <= 0 || L.settles.has(r.tk) || o.released) continue;
        const pnl = r6((r.win ? o.filled : 0) - o.cost - o.fee), stress = o.stress ? r6((r.win ? o.stress.contracts : 0) - o.stress.cost - o.stress.fee) : null;
        this.appendLine(L, { t: 'settle', tk: r.tk, win: r.win, result: r.result, settledAt: r.settledAt, contracts: o.filled, cost: o.cost, fee: o.fee, pnl, perContractCents: r4((pnl / o.filled) * 100),
          stressPnl: stress != null ? r6(pnl + stress) : null, balanceAfter: r6(L.balance + pnl) });
      }
      return this.checkVerdict();
    }
    if (r.t === 'settle_timeout' && !x.settle_timeout && !x.settle) {
      this.append({ t: 'settle_timeout', tk: r.tk });
      for (const L of this.lines) { const o = L.orders.get(r.tk); if (o && !L.settles.has(r.tk) && !o.released) this.appendLine(L, { t: 'release', tk: r.tk, reason: 'v1 settle_timeout; reserve released, no P&L booked' }); }
    }
  }
  /** Size and fill one v2 'take' signal on the fill snapshot, for every sizing line. */
  doFill(tk, ladder, fillRx, { bf = null, v1Fill = null, states = null } = {}) {
    const x = this.rows.get(tk); if (!x || x.book) return; const sig = x.sig, s = this.live.get(tk);
    const F = this.v1.cfg.fill, vol = bf ? bf.volumeAt(tk, sig.bookRx) : this.volumeAt(tk, sig.bookRx);
    const sigLadder = bf ? bf.ladderAt(tk, sig.bookRx) : s ? s.sigLadder : null, limit = Math.min(F.limitCap, r4(sig.ya + F.limitAboveSignalAsk));
    if (!ladder) { this.append({ t: 'book', tk, traded: false, reason: 'book_unknown', note: 'no recorded book covers the fill snapshot; not traded, not assumed', fillRx, backfill: !!bf || undefined }); return; }
    const b = this.append({ t: 'book', tk, traded: true, fillRx, lagMs: fillRx - sig.bookRx, decisionAsk: sig.ya, limit,
      depthAtSignal: sigLadder ? depthAt(sigLadder, limit) : null, signalLadder: sigLadder, fillLadder: ladder, depthAtFill: depthAt(ladder, limit),
      vol60: vol.vol, nTrades: vol.nTrades, volKnown: vol.known, volSource: bf ? 'recorded kalshi.trade' : vol.source || 'live kalshi trades', backfill: !!bf || undefined,
      v1Fill: v1Fill ? { px: v1Fill.px, vwap: v1Fill.vwap, nextAsk: v1Fill.nextAsk } : undefined });
    for (const L of this.lines) {
      if (L.orders.has(tk)) continue;
      const cash = L.balance - L.reserved, z = sizeOrder({ cfg: this.cfg, asset: sig.asset, ask: sig.ya, balance: L.balance, cash, vol: vol.vol, pct: L.spec.pctOfBalance });
      const f = fillLadder({ ladder, ask: sig.ya, want: z.contracts, F }), fee = feeOrder(f.levels, this.cfg.fees.rate);
      const stress = f.unfilled > 0 && f.stressPx != null ? { contracts: f.unfilled, px: f.stressPx, cost: r6(f.unfilled * f.stressPx), fee: feeOrder([[f.stressPx, f.unfilled]], this.cfg.fees.rate), flag: 'remainder_priced_worst_plus_1c' } : null;
      this.appendLine(L, { t: 'order', tk, asset: sig.asset, paper: true, balanceBefore: L.balance, cash: r2(cash), requestedDollars: z.requestedDollars, caps: z.caps, bound: z.bound, requested: z.contracts,
        filled: f.filled, unfilled: f.unfilled, levels: f.levels, cost: f.cost, vwap: f.vwap, decisionAsk: sig.ya, limit: f.limit, slippageCents: f.slippageCents, fee,
        dollars: r2(f.cost), flags: f.flags, stress, fillRx, backfill: !!bf || undefined });
    }
    const R = this.cfg.refill;
    if (bf) { const st = bf.statesBetween(tk, fillRx, fillRx + R.windowMs); this.append({ t: 'refill', tk, t0: fillRx, limit, samples: st ? refillSeries(st, fillRx, limit, R) : null, source: st ? 'recorded kalshi.book (REST depth 10)' : 'unknown: no recorded books', vol60Final: vol.vol }); }
    else if (s) s.refill = { t0: fillRx, limit, states: states || [[fillRx, ladder]] };
    return b;
  }
  finishRefill(tk) {
    const s = this.live.get(tk); if (!s || !s.refill) return; const x = this.rows.get(tk); const R = this.cfg.refill, rf = s.refill; s.refill = null; this.live.delete(tk);
    if (!x || x.refill) return;
    const vol = this.volumeAt(tk, x.sig.bookRx); // recount once late trade prints have arrived (audit only; the size was set at fill time)
    this.append({ t: 'refill', tk, t0: rf.t0, limit: rf.limit, samples: refillSeries(rf.states, rf.t0, rf.limit, R), source: 'live recorder books (REST depth 10)', vol60Final: vol.vol, partial: this.now() < rf.t0 + R.windowMs || undefined });
  }
  /**
   * At start: walk the whole v1 ledger in order. v1 signals with no v3 row are sized and filled from RECORDED books
   * and trades (honest backfill: when no recorded book or trade coverage exists it is logged unknown, never assumed).
   * v1/v2 settlements are folded in, so each line's balance compounds in signal order.
   */
  reconcile() {
    const v1rows = []; try { for (const l of fs.readFileSync(this.v1.ledgerFile, 'utf8').split('\n')) { if (!l.trim()) continue; try { v1rows.push(JSON.parse(l)); } catch { /* torn */ } } } catch { /* none */ }
    const need = v1rows.filter((r) => r.t === 'signal' && r.v === this.v1.cfg.version && !this.rows.has(r.tk));
    const want = new Set(need.map((r) => r.tk)), days = new Set(); for (const r of need) { days.add(dayOf(r.bookRx - MIN)); days.add(dayOf(r.bookRx)); days.add(dayOf(r.bookRx + 2 * MIN)); }
    const books = new Map(), trades = new Map(), gaps = new Map(), tradeDays = new Set(); let info = { files: 0, bytes: 0, truncated: false };
    if (this.recorderDir && want.size) {
      const D = [...days].sort();
      const a = readRecorded(this.recorderDir, D, 'kalshi.book', (b) => { if (b.t !== 'book' || !want.has(b.tk)) return; const L = books.get(b.tk) || []; L.push([b.rx, askLadderOf(b)]); books.set(b.tk, L); });
      const t = readRecorded(this.recorderDir, D, 'kalshi.trade', (x, name) => { tradeDays.add(name); if (x.t !== 'trade' || !want.has(x.tk) || !(x.c > 0)) return; let L = trades.get(x.tk); if (!L) { L = { list: [], ids: new Set() }; trades.set(x.tk, L); } if (x.id && L.ids.has(x.id)) return; if (x.id) L.ids.add(x.id); L.list.push([+x.ex, +x.c]); });
      readRecorded(this.recorderDir, D, 'gaps', (g) => { if (g.t !== 'gap' || !want.has(g.key)) return; const k = g.stream + '|' + g.key; const L = gaps.get(k) || []; L.push([g.from, g.to]); gaps.set(k, L); });
      info = { files: a.files + t.files, bytes: a.bytes + t.bytes, truncated: a.truncated || t.truncated };
      for (const L of books.values()) L.sort((p, q) => p[0] - q[0]);
    }
    const gapIn = (stream, tk, from, to) => (gaps.get(stream + '|' + tk) || []).some(([f, t]) => f <= to && t >= from);
    const bf = {
      // book rows are written only when the book changes, so the state at time T is the latest row at or before T
      ladderAt: (tk, T) => { const L = books.get(tk); if (!L) return null; let best = null; for (const [rx, lad] of L) { if (rx > T + 50) break; best = [rx, lad]; } return best && !gapIn('kalshi.book', tk, best[0], T) ? best[1] : null; },
      statesBetween: (tk, a, b) => { const L = books.get(tk); if (!L || gapIn('kalshi.book', tk, a, b)) return null; const s = L.filter(([rx]) => rx > a - 1 && rx <= b); const at = bf.ladderAt(tk, a); return at ? [[a, at], ...s] : null; },
      volumeAt: (tk, T) => { const W = this.cfg.sizing.participation.windowMs; if (!tradeDays.size || gapIn('kalshi.trade', tk, T - W, T)) return { vol: null, nTrades: null, known: false };
        return this.volumeAt(tk, T, { trades, known: true }); },
    };
    for (const r of v1rows) this.onV1Row(r, want.has(r.tk) ? bf : null);
    this.backfill = { at: this.now(), v1Signals: v1rows.filter((r) => r.t === 'signal').length, needed: need.length, ...info, note: 'sized from recorded REST books (depth 10) and recorded public trades; unknowns are logged, never assumed' };
    if (need.length) this.log(`[kalshi-h2-v3] backfilled ${need.length} v1 signal(s) from recorded books (${info.files} files)`);
  }
  tick() {
    const now = this.now(), W = this.cfg.refill.windowMs;
    for (const [tk, s] of this.live) { if (s.refill && now > s.refill.t0 + W + 5000) this.finishRefill(tk); else if (!s.refill && s.awaitRx == null && now - s.sigRx > 30 * MIN) this.live.delete(tk); }
    for (const [tk, L] of this.trades) { L.list = L.list.filter(([ex]) => ex > now - 2 * MARKET_MS); if (!L.list.length) this.trades.delete(tk); }
    if (this.health) this.health.ok('paper.kalshi-h2-v3', 0);
  }
  ordered() { return [...this.rows.values()].filter((x) => x.sig).sort((a, b) => a.sig.bookRx - b.sig.bookRx); }
  /** Pass gate (same as v2): the first look at minV1Signals settled known-decision signals; kept net = v3 first line per contract. */
  gate() {
    const P = this.cfg.pass, fl = A.firstLook(this.v2.ordered(), P, fisherOneSided); if (!fl) return null;
    const L = this.lines[0], cohort = this.ordered().filter((x) => x.sig.bookRx <= fl.lastBookRx && x.sig.decision === 'take');
    let pnl = 0, c = 0; for (const x of cohort) { const s = L.settles.get(x.sig.tk); if (s) { pnl += s.pnl; c += s.contracts; } }
    return { n: fl.n, lastBookRx: fl.lastBookRx, fisherP: fl.fisherP, keptLossRate: fl.keptLossRate, skippedLossRate: fl.skippedLossRate, line: L.id, keptContracts: c, keptNetCentsPerContract: c ? r6((pnl / c) * 100) : null };
  }
  checkVerdict() {
    if (!this.running || this.verdict) return; const g = this.gate(); if (!g) return; const P = this.cfg.pass;
    const fisherMet = g.fisherP != null && g.fisherP < P.alpha && g.skippedLossRate > g.keptLossRate, keptPos = g.keptNetCentsPerContract != null && g.keptNetCentsPerContract > P.keptMeanNetGtCents;
    this.append({ t: 'verdict', ...g, met: fisherMet && keptPos, status: fisherMet && keptPos ? 'met' : 'not met', note: 'first look at the pre-registered gate; never recomputed' });
  }
  lineStats(L) {
    const orders = [...L.orders.values()], traded = orders.filter((o) => o.filled > 0), settled = [...L.settles.values()];
    const sized = orders.filter((o) => !(o.bound || []).includes('unknown_volume')), capCount = {}; for (const o of orders) for (const b of o.bound || []) capCount[b] = (capCount[b] || 0) + 1;
    const req = orders.reduce((s, o) => s + o.requested, 0), fil = orders.reduce((s, o) => s + o.filled, 0);
    const byAsset = {}; for (const o of orders) { const a = byAsset[o.asset] = byAsset[o.asset] || { orders: 0, traded: 0, dollars: 0, requested: 0, filled: 0, slip: [], capBound: 0 }; a.orders++; a.requested += o.requested; a.filled += o.filled; if (o.filled > 0) { a.traded++; a.dollars += o.cost; a.slip.push(o.slippageCents); } if (!(o.bound || []).includes('pct')) a.capBound++; }
    for (const a of Object.values(byAsset)) { a.avgDollars = a.traded ? r2(a.dollars / a.traded) : null; a.fillRate = a.requested ? r4(a.filled / a.requested) : null; a.avgSlippageCents = a.slip.length ? r4(S.mean(a.slip)) : null; a.capBoundShare = a.orders ? r4(a.capBound / a.orders) : null; delete a.slip; a.dollars = r2(a.dollars); }
    const wins = settled.filter((s) => s.win).length, pnl = settled.reduce((s, x) => s + x.pnl, 0), sc = settled.reduce((s, x) => s + x.contracts, 0);
    return { id: L.id, pct: L.spec.pctOfBalance, start: L.spec.startBalance, balance: r2(L.balance), reserved: r2(L.reserved), orders: orders.length, traded: traded.length, zeroSize: orders.length - traded.length,
      avgDollars: traded.length ? r2(traded.reduce((s, o) => s + o.cost, 0) / traded.length) : null, capBound: capCount, capBoundShare: sized.length ? r4(sized.filter((o) => !(o.bound || []).includes('pct')).length / sized.length) : null, unknownVolume: orders.length - sized.length,
      avgSlippageCents: traded.length ? r4(S.mean(traded.map((o) => o.slippageCents))) : null, fillRate: req ? r4(fil / req) : null, fullFillShare: orders.length ? r4(orders.filter((o) => o.requested > 0 && o.unfilled === 0).length / orders.length) : null,
      unfilledContracts: orders.reduce((s, o) => s + o.unfilled, 0), fees: r2(traded.reduce((s, o) => s + o.fee, 0)), settled: settled.length, wins, losses: settled.length - wins, winRate: S.wilson(wins, settled.length),
      pnl: r2(pnl), netCentsPerContract: sc ? r4((pnl / sc) * 100) : null, stressPnl: r2(settled.reduce((s, x) => s + (x.stressPnl != null ? x.stressPnl : x.pnl), 0)), maxDrawdown: maxDrawdown(L.curve, L.spec.startBalance),
      curve: [{ at: this.startAt, balance: L.spec.startBalance }, ...L.curve.map((p) => ({ at: p.at, balance: r2(p.balance), tk: p.tk }))].slice(-400), byAsset, open: traded.filter((o) => !L.settles.has(o.tk) && !o.released).length };
  }
  /** v1 / v2 / v3 on the same signals (v1 and v2 trade 1 contract; v3 is sized). */
  compare() {
    const rows = this.ordered(), v1 = [], v2 = [];
    for (const x of rows) { const s = x.settle; if (!s || s.pnl1 == null) continue; v1.push(s); if (x.sig.decision === 'take') v2.push(s); }
    const g = (a) => ({ n: a.length, wins: a.filter((s) => s.win).length, netCentsPerContract: a.length ? r4(S.mean(a.map((s) => s.pnl1)) * 100) : null, totalDollars: r2(a.reduce((s, x) => s + x.pnl1, 0)) });
    const lines = this.lines.map((L) => { const st = [...L.settles.values()], c = st.reduce((s, x) => s + x.contracts, 0), p = st.reduce((s, x) => s + x.pnl, 0); return { id: L.id, n: st.length, wins: st.filter((s) => s.win).length, contracts: c, netCentsPerContract: c ? r4((p / c) * 100) : null, totalDollars: r2(p) }; });
    const table = rows.slice(-25).reverse().map((x) => ({ tk: x.sig.tk, asset: x.sig.asset, at: x.sig.bookRx, ya: x.sig.ya, decision: x.sig.decision, result: x.settle ? x.settle.result : x.nofill ? 'no fill' : null, v1Cents: x.settle && x.settle.pnl1 != null ? r4(x.settle.pnl1 * 100) : null,
      v3: this.lines.map((L) => { const o = L.orders.get(x.sig.tk), s = L.settles.get(x.sig.tk); return o ? { id: L.id, requested: o.requested, filled: o.filled, dollars: o.dollars, bound: o.bound, slippageCents: o.slippageCents, fee: o.fee, pnl: s ? s.pnl : null, backfill: !!o.backfill } : { id: L.id, reason: x.book ? x.book.reason || null : null }; }) }));
    return { v1: g(v1), v2: g(v2), v3: lines, table, note: 'same signals: v1 = every filled v1 signal (1 contract); v2 = v2 take (1 contract, v1 fill); v3 = v2 take, sized and filled on the recorded ladder' };
  }
  /** Capacity check: what the paper fills show vs the backtest's assumptions (display only). */
  capacity() {
    const B = this.cfg.backtestReference, books = this.ordered().map((x) => x.book).filter((b) => b && b.traded);
    const med = (a) => { const s = a.filter((v) => v != null).sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const byAsset = {}; for (const x of this.ordered()) { const b = x.book; if (!b || !b.traded) continue; const a = byAsset[x.sig.asset] = byAsset[x.sig.asset] || { n: 0, w1: [], best: [], vol: [] }; a.n++; a.w1.push(b.depthAtFill && b.depthAtFill.dollars); a.best.push(b.depthAtFill && b.depthAtFill.bestAsk != null ? r2(b.depthAtFill.bestAsk * b.depthAtFill.bestSize) : null); a.vol.push(b.vol60); }
    for (const [k, a] of Object.entries(byAsset)) byAsset[k] = { n: a.n, medianDollarsWithin1c: med(a.w1), medianDollarsAtBestAsk: med(a.best), medianVol60: med(a.vol), backtestWithin1c: B.medianDollarsWithin1c[k] || null, backtestBestAsk: B.medianDollarsAtBestAsk[k] || null };
    const band = (asset, d) => (d == null ? null : asset === 'BTC' ? (d <= 5000 ? 'fillable' : d <= 8000 ? 'questionable' : 'fiction') : d <= 300 ? 'fillable' : d <= 1000 ? 'questionable' : 'fiction');
    const lines = this.lines.map((L) => { const s = this.lineStats(L), bands = {}; for (const o of L.orders.values()) if (o.filled > 0) { const b = band(o.asset, o.cost); bands[b] = (bands[b] || 0) + 1; }
      const ref = L.spec.pctOfBalance === 0.03 ? B.sim3pctCap10 : L.spec.pctOfBalance === 0.07 ? B.sim7pctCap10 : null;
      return { id: L.id, fillRate: s.fillRate, fullFillShare: s.fullFillShare, avgSlippageCents: s.avgSlippageCents, avgDollars: s.avgDollars, capBoundShare: s.capBoundShare, bands, byAsset: s.byAsset, backtest: ref }; });
    const refill = this.ordered().map((x) => x.refill).filter((r) => r && r.samples);
    const refillAt = (sec) => med(refill.map((r) => { const p = r.samples.find((q) => q.s === sec); return p ? p.dollars : null; }));
    return { books: books.length, byAsset, lines, refill: { n: refill.length, medianDollarsAt0s: refillAt(0), medianDollarsAt30s: refillAt(30), medianDollarsAt60s: refillAt(60) }, reference: B,
      note: 'observed on paper fills from the recorder\'s REST books (10 levels) and public trades; the backtest used entry-candle volume and 16 real books' };
  }
  stats() {
    if (!this.cfg) return null; const P = this.cfg.pass, g = this.gate(), FL = this.verdict || g;
    const have = this.v2 ? this.v2.ordered().filter((x) => x.settle && x.sig.decision !== 'unknown').length : 0;
    const fisherMet = FL ? FL.fisherP != null && FL.fisherP < P.alpha && FL.skippedLossRate > FL.keptLossRate : false, keptPos = FL ? FL.keptNetCentsPerContract != null && FL.keptNetCentsPerContract > P.keptMeanNetGtCents : false;
    const status = !FL ? 'pending' : fisherMet && keptPos ? 'met' : 'not met';
    const parts = [
      { key: 'n', label: `>= ${P.minV1Signals.toLocaleString()} settled v1 signals with a known v2 decision (first look only)`, value: have, status: FL ? 'met' : 'pending' },
      { key: 'fisher', label: `skipped lose more often than kept (one-sided Fisher p < ${P.alpha}; same as v2)`, value: FL ? FL.fisherP : null, status: !FL ? 'pending' : fisherMet ? 'met' : 'not met' },
      { key: 'kept', label: `v3 ${this.lines[0] ? this.lines[0].id : ''} kept trades positive per contract after the per-order fee`, value: FL ? FL.keptNetCentsPerContract : null, status: !FL ? 'pending' : keptPos ? 'met' : 'not met' },
    ];
    const by = { take: 0, skip: 0, unknown: 0 }; for (const x of this.ordered()) by[x.sig.decision] = (by[x.sig.decision] || 0) + 1;
    return { signals: this.rows.size, decisions: by, backfilled: this.ordered().filter((x) => x.sig.backfill).length, bookUnknown: this.ordered().filter((x) => x.book && x.book.reason === 'book_unknown').length,
      lines: this.lines.map((L) => this.lineStats(L)), compare: this.compare(), capacity: this.capacity(),
      passTest: { status, label: status === 'pending' ? 'UNPROVEN' : status === 'met' ? 'PASS (pre-registered test met)' : 'RETIRED (pre-registered test not met)', parts, firstLook: this.verdict ? { ...this.verdict, persisted: true } : g ? { ...g, persisted: false } : null, need: P.minV1Signals, have, progress: r6(Math.min(1, have / P.minV1Signals)) } };
  }
  snapshot() {
    return { enabled: true, running: this.running, error: this.error, paper: true, label: 'PAPER · v3 sizing · UNPROVEN · not real money', id: this.key, name: this.cfg && this.cfg.name, version: this.cfg && this.cfg.version, hash: this.hash,
      base: this.cfg && this.cfg.base, sizing: this.cfg && { lines: this.cfg.sizing.lines, perAssetDollarCap: this.cfg.sizing.perAssetDollarCap, overallDollarCap: this.cfg.sizing.overallDollarCap, participation: this.cfg.sizing.participation.share, perAssetCapStatus: this.cfg.sizing.perAssetCapStatus },
      pass: this.cfg && this.cfg.pass, tradeFeed: this.tradeFeed, startAt: this.startAt, sessions: this.sessions, backfill: this.backfill, stats: this.stats(), recent: this.recent.slice(-10).reverse() };
  }
}
module.exports = { KalshiH2V3, sizeOrder, fillLadder, feeOrder, depthAt, askLadderOf, refillSeries, maxDrawdown, V3_FILE };
