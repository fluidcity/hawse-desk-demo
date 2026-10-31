'use strict';
// Kalshi H2 v2 arm: miro's frozen "no-jump" hypothesis fav93_98_v2_nojump (hawse-research/kalshi-15m-loss-autopsy.md
// section 5). PAPER ONLY; there is no exchange-facing code here.
//
// v2 = v1 entry PLUS one pre-entry condition: skip when the max of the per-minute YES-ask closes over all EARLIER minutes of
// the same market (open -> the minute before the signal's minute) is below 0.87. No earlier quote -> take (as in the backtest).
// v2 never decides entries on its own. It listens to the v1 ledger: every v1 signal gets a v2 row with max_earlier_ask and the
// v2 decision (take / skip / unknown), and v1's paper fill and official settlement are copied one-to-one, so v1 and v2 are
// compared on the SAME signals. v1's config, hash, ledger and rules are untouched.
//
// Freeze: config/frozen/kalshi-h2-v2.json is hash-pinned in index.js FROZEN (and test/kalshi-h2-v2.test.js); v2 also
// refuses to run unless v1 is running with the exact v1 hash the v2 file names. Own ledger: <dir>/v2/ledger.jsonl.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadFrozen, FROZEN, assetOf } = require('./index');
const S = require('./stats');

const V2_FILE = path.join(__dirname, '..', '..', 'config', 'frozen', 'kalshi-h2-v2.json');
const MIN = 60000, MARKET_MS = 15 * MIN;
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const minuteOf = (t) => Math.floor(t / MIN);

/** Per-market minute tracker: minute -> { n books, close = last non-null YES ask in that minute }. */
function newTrack(open) { return { open, firstRx: null, lastRx: null, mins: new Map(), src: new Set() }; }
function ingest(tr, row, src) {
  if (row.rx < tr.open) return;
  const k = minuteOf(row.rx); let b = tr.mins.get(k); if (!b) { b = { n: 0, close: null, at: null }; tr.mins.set(k, b); }
  b.n++; if (row.ya != null && Number.isFinite(+row.ya) && (b.at == null || row.rx >= b.at)) { b.close = +row.ya; b.at = row.rx; }
  if (tr.firstRx == null || row.rx < tr.firstRx) tr.firstRx = row.rx; if (tr.lastRx == null || row.rx > tr.lastRx) tr.lastRx = row.rx; if (src) tr.src.add(src);
}
/**
 * The frozen v2 feature + decision for one v1 signal. Pure.
 *  full coverage = at least one recorded book in EVERY minute from the market's open minute to the minute before the signal.
 */
function decide(tr, sig, F) {
  const M = minuteOf(sig.bookRx), open = tr ? tr.open : sig.close - MARKET_MS, m0 = minuteOf(open);
  let max = null, quoted = 0, seen = 0; const missing = [];
  for (let k = m0; k < M; k++) { const b = tr && tr.mins.get(k); if (!b) { missing.push(k); continue; } seen++; if (b.close != null) { quoted++; max = max == null ? b.close : Math.max(max, b.close); } }
  const full = !!tr && missing.length === 0 && M > m0, pm = tr && tr.mins.get(M - 1), prev = pm && pm.close != null ? pm.close : null;
  const thr = F.skipIfBelow; let decision, why;
  if (max != null && max >= thr - 1e-9) { decision = 'take'; why = full ? `max earlier ask ${max} >= ${thr}` : `max earlier ask ${max} >= ${thr} on partial books (more history can only raise it)`; }
  else if (!full) { decision = 'unknown'; why = !tr || !seen ? 'no recorded books for the earlier minutes' : `books missing for ${missing.length} of ${M - m0} earlier minute(s)`; }
  else if (max == null) { decision = F.noEarlierQuote === 'take' ? 'take' : 'skip'; why = 'no earlier YES-ask quote: take (as in the backtest)'; }
  else { decision = 'skip'; why = `max earlier ask ${max} < ${thr}`; }
  return { maxEarlierAsk: max, earlierMinutes: M - m0, minutesWithBooks: seen, minutesQuoted: quoted, coverage: full ? 'full' : seen ? 'partial' : 'none',
    prevMinuteAsk: prev, dask1: prev == null || sig.ya == null ? null : r6(sig.ya - prev), decision, v2Skip: decision === 'skip' ? true : decision === 'take' ? false : null, why };
}

/** log of n! table for the Fisher test. */
const LF = [0]; function lf(n) { for (let i = LF.length; i <= n; i++) LF[i] = LF[i - 1] + Math.log(i); return LF[n]; }
/**
 * One-sided Fisher exact test. H1: the skipped group loses MORE often than the kept group.
 * p = P(X >= skippedLosses), X ~ Hypergeometric(total N, total losses K, draws = skipped n).
 */
function fisherOneSided({ keptLoss, keptN, skipLoss, skipN }) {
  const N = keptN + skipN, K = keptLoss + skipLoss, n = skipN; if (!keptN || !skipN) return null;
  const lc = (a, b) => lf(a) - lf(b) - lf(a - b); let p = 0;
  for (let x = skipLoss; x <= Math.min(K, n); x++) p += Math.exp(lc(K, x) + lc(N - K, n - x) - lc(N, n));
  return Math.min(1, r6(p));
}

/** Summary for the v2 card. rows: [{ sig, fill, settle }] one per v1 signal, in signal order. Pure. */
function summarizeV2({ cfg, rows, now }) {
  const P = cfg.pass, W = cfg.watchOnly, c = (x) => (x == null ? null : r6(x * 100)), mean = S.mean;
  const by = { take: 0, skip: 0, unknown: 0 }; for (const r of rows) by[r.sig.decision] = (by[r.sig.decision] || 0) + 1;
  const settled = rows.filter((r) => r.settle);
  const grp = (d) => settled.filter((r) => r.sig.decision === d);
  const kept = grp('take'), skipped = grp('skip'), unknown = grp('unknown');
  const loss = (a) => a.filter((r) => !r.settle.win).length;
  const g = (a) => ({ n: a.length, wins: a.length - loss(a), losses: loss(a), lossRate: a.length ? r6(loss(a) / a.length) : null, lossCi: S.wilson(loss(a), a.length),
    meanNetCents: c(mean(a.map((r) => r.settle.pnl1))), totalNetCents: c(a.reduce((s, r) => s + r.settle.pnl1, 0)), meanNetLargeCents: c(mean(a.map((r) => r.settle.pnlL))) });
  const K = g(kept), Sk = g(skipped), all = g(settled.filter((r) => r.sig.decision !== 'unknown'));
  const p = fisherOneSided({ keptLoss: K.losses, keptN: K.n, skipLoss: Sk.losses, skipN: Sk.n });
  const known = kept.length + skipped.length, gate = known >= P.minV1Signals;
  let cum = 0; const curve = [...kept].sort((a, b) => (a.settle.settledAt || a.settle.at) - (b.settle.settledAt || b.settle.at))
    .map((r) => { cum += r.settle.pnl1; return { at: r.settle.settledAt || r.settle.at, tk: r.sig.tk, pnlCents: c(r.settle.pnl1), cumCents: c(cum) }; });
  const fisherMet = p != null && p < P.alpha && Sk.lossRate > K.lossRate, keptPos = K.meanNetCents != null && K.meanNetCents > P.keptMeanNetGtCents;
  const parts = [
    { key: 'n', label: `>= ${P.minV1Signals.toLocaleString()} settled v1 signals with a known v2 decision`, value: known, status: gate ? 'met' : 'pending' },
    { key: 'fisher', label: `skipped lose more often than kept (one-sided Fisher p < ${P.alpha})`, value: p, status: !gate ? 'pending' : fisherMet ? 'met' : 'not met' },
    { key: 'kept', label: 'kept trades positive after the fee charged', value: K.meanNetCents, status: !gate ? 'pending' : keptPos ? 'met' : 'not met' },
  ];
  const status = !gate ? 'pending' : fisherMet && keptPos ? 'met' : 'not met';
  const taken = rows.filter((r) => r.sig.decision === 'take' && r.fill).length;
  return {
    v1Signals: rows.length, decisions: by, backfilled: rows.filter((r) => r.sig.backfill).length, settled: settled.length, unknownSettled: unknown.length,
    v2: { taken, settled: K.n, wins: K.wins, losses: K.losses, winRate: S.wilson(K.wins, K.n), meanNetCents: K.meanNetCents, totalNetCents: K.totalNetCents, meanNetLargeCents: K.meanNetLargeCents, open: rows.filter((r) => r.sig.decision === 'take' && r.fill && !r.settle).length },
    kept: K, skipped: Sk, v1Known: all, fisherP: p, curve,
    watch: { dBpsBelow: rows.filter((r) => r.sig.dBps != null && r.sig.dBps < W.dBpsBelow).length, dask1Above: rows.filter((r) => r.sig.dask1 != null && r.sig.dask1 > W.dask1AboveDollars).length, note: W.note },
    passTest: { status, label: status === 'pending' ? 'UNPROVEN' : status === 'met' ? 'PASS (pre-registered test met)' : 'RETIRED (pre-registered test not met)', parts, progress: r6(Math.min(1, known / P.minV1Signals)), need: P.minV1Signals, have: known },
  };
}

/** Read recorded rows of one stream prefix ("kalshi.book", "ref") for the given UTC days. Gzip only when the file says so. */
function readRecorded(dir, days, prefix, keep, { maxBytes = 512 * 2 ** 20, sinceMtime = 0 } = {}) {
  let bytes = 0, files = 0;
  for (const d of days) {
    const dd = path.join(dir, d); let names = []; try { names = fs.readdirSync(dd); } catch { continue; }
    for (const n of names.filter((x) => x.startsWith(prefix + '.') && /\.jsonl(\.gz)?$/.test(x)).sort()) {
      const f = path.join(dd, n); let st; try { st = fs.statSync(f); } catch { continue; } if (st.mtimeMs < sinceMtime) continue;
      bytes += st.size; if (bytes > maxBytes) return { files, bytes, truncated: true };
      let buf = fs.readFileSync(f); if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { try { buf = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { continue; } } }
      files++;
      for (const line of buf.toString('utf8').split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; } keep(r); }
    }
  }
  return { files, bytes, truncated: false };
}
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

class KalshiH2V2 {
  constructor({ v1, kalshi = null, ref = null, health = null, dir, recorderDir = null, file = V2_FILE, pins = FROZEN, now = Date.now, log = () => {} } = {}) {
    Object.assign(this, { v1, kalshi, ref, health, baseDir: dir, recorderDir, file, pins, now, log });
    this.cfg = null; this.hash = null; this.key = null; this.error = null; this.running = false; this.timers = [];
    this.tracks = new Map(); this.rows = new Map(); this.recent = []; this.sessions = 0; this.startAt = null; this.backfill = null;
    if (health) health.register('paper.kalshi-h2-v2', { label: 'Kalshi H2 v2 arm (frozen no-jump filter on v1 signals)', group: 'recorder', note: 'paper only; filters v1 signals, reuses v1 fills and official results; UNPROVEN', staleMs: 120000 });
  }
  get ledgerFile() { return path.join(this.baseDir, this.cfg.version, 'ledger.jsonl'); }
  refuse(msg) { this.error = msg; this.log('[kalshi-h2-v2] REFUSING to run: ' + msg); if (this.health) this.health.fail('paper.kalshi-h2-v2', 'refused: ' + msg); }
  start() {
    try { const f = loadFrozen(this.file, this.pins); this.cfg = f.cfg; this.hash = f.hash; this.key = f.key; } catch (e) { return this.refuse(e.message); }
    if (this.cfg.version === 'v1') return this.refuse('v2 arm loaded a v1 file');
    if (!this.v1 || !this.v1.cfg || !this.v1.running) return this.refuse('v1 is not running; v2 only filters v1 signals');
    if (this.v1.hash !== this.cfg.base.sha256) return this.refuse(`v1 hash ${String(this.v1.hash).slice(0, 12)} is not the v1 hash this v2 file was frozen on (${this.cfg.base.sha256.slice(0, 12)})`);
    fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
    this.replay();
    this.append({ t: 'session', hash: this.hash, base: this.v1.hash, pid: process.pid });
    if (!this.startAt) this.startAt = this.now();
    this.running = true;
    try { this.reconcile(); } catch (e) { this.log('[kalshi-h2-v2] reconcile failed: ' + e.message); }
    if (this.kalshi) this.kalshi.on('book', (e) => this.onBook(e));
    if (this.v1.rowListeners) this.v1.rowListeners.push((r) => { try { this.onV1Row(r); } catch (e) { this.log('[kalshi-h2-v2] ' + e.message); } });
    const t = setInterval(() => this.tick(), 30000); if (t.unref) t.unref(); this.timers.push(t);
    if (this.health) this.health.ok('paper.kalshi-h2-v2', 0);
  }
  stop() { this.running = false; for (const t of this.timers) clearInterval(t); this.timers = []; }
  append(row) { const r = { at: this.now(), v: this.cfg.version, ...row }; fs.appendFileSync(this.ledgerFile, JSON.stringify(r) + '\n'); this.apply(r); return r; }
  replay() {
    if (!fs.existsSync(this.ledgerFile)) return;
    for (const line of fs.readFileSync(this.ledgerFile, 'utf8').split('\n')) { if (!line.trim()) continue; try { this.apply(JSON.parse(line)); } catch { /* torn last line */ } }
  }
  apply(r) {
    if (r.t === 'session') { this.sessions++; if (!this.startAt) this.startAt = r.at; return; }
    if (r.t === 'signal' && !this.rows.has(r.tk)) this.rows.set(r.tk, { sig: r });
    const x = this.rows.get(r.tk);
    if (x && r.t === 'fill') x.fill = r; if (x && r.t === 'nofill') x.nofill = r; if (x && r.t === 'settle') x.settle = r; if (x && r.t === 'settle_timeout') x.timeout = r;
    this.recent.push(r); if (this.recent.length > 40) this.recent.shift();
  }
  track(tk, open) { let tr = this.tracks.get(tk); if (!tr) { tr = newTrack(open); this.tracks.set(tk, tr); } return tr; }
  onBook(e) {
    if (!this.running || !this.cfg || !this.v1.cfg.rule.series.includes(e.series)) return;
    const open = e.open != null ? +e.open : e.close != null ? e.close - MARKET_MS : null; if (open == null) return;
    ingest(this.track(e.tk, open), e, 'live');
  }
  refPx(asset) { const L = this.ref && this.ref.latest && this.ref.latest[asset]; return L && L.med > 0 ? L.med : null; }
  /** Fold one v1 ledger row into the v2 ledger. Idempotent (used live and when reconciling at start). */
  onV1Row(r, { refAt = null, backfill = false } = {}) {
    if (!this.running || r.v !== this.v1.cfg.version) return;
    const x = this.rows.get(r.tk);
    if (r.t === 'signal') {
      if (x && x.sig) return;
      const d = decide(this.tracks.get(r.tk) || null, r, this.cfg.filter), ref = refAt ? refAt(r) : { px: this.refPx(r.asset || assetOf(r.series)), src: 'live 1 s reference median' };
      const tr = this.tracks.get(r.tk), src = tr ? [...tr.src].sort().join('+') : 'none';
      return this.append({ t: 'signal', tk: r.tk, series: r.series, asset: r.asset, v1At: r.at, bookRx: r.bookRx, secLeft: r.secLeft, ya: r.ya, askDepth: r.yas, yb: r.yb, strike: r.strike, close: r.close,
        ...d, refPx: ref.px, dBps: ref.px && r.strike ? r6(Math.log(ref.px / r.strike) * 1e4) : null, refSrc: ref.px ? ref.src : null, books: src, backfill: backfill || undefined, paper: true });
    }
    if (!x || !x.sig) return;
    const base = { tk: r.tk, series: r.series || x.sig.series, asset: x.sig.asset, decision: x.sig.decision, v2Trade: x.sig.decision === 'take' };
    if (r.t === 'fill' && !x.fill) return this.append({ t: 'fill', ...base, px: r.px, size: this.v1.cfg.sizing.contracts, vwap: r.vwap, nextAsk: r.nextAsk, nextAskSize: r.nextAskSize, lagMs: r.lagMs, fee1: r.fee1, feeL: r.feeL, close: r.close, v1At: r.at, paper: true });
    if (r.t === 'skip' && r.stage === 'fill' && !x.nofill && !x.fill) return this.append({ t: 'nofill', ...base, reason: r.reason, v1At: r.at });
    if (r.t === 'settle' && !x.settle) return this.append({ t: 'settle', ...base, result: r.result, win: r.win, px: r.px, fee1: r.fee1, feeL: r.feeL, pnl1: r.pnl1, pnlL: r.pnlL, settledAt: r.settledAt, signalAt: r.signalAt, v1At: r.at, source: 'kalshi official result (via v1)' });
    if (r.t === 'settle_timeout' && !x.timeout && !x.settle) return this.append({ t: 'settle_timeout', ...base, v1At: r.at });
  }
  /**
   * At start: walk the whole v1 ledger. v1 signals with no v2 row get their feature from the RECORDED books (honest
   * backfill: only when every earlier minute has a recorded book; otherwise the decision is 'unknown'); fills and
   * settlements are copied. Also seeds the minute trackers of markets open right now from today's recorded books.
   */
  reconcile() {
    const v1rows = []; try { for (const l of fs.readFileSync(this.v1.ledgerFile, 'utf8').split('\n')) { if (!l.trim()) continue; try { v1rows.push(JSON.parse(l)); } catch { /* torn */ } } } catch { /* no v1 ledger yet */ }
    const need = v1rows.filter((r) => r.t === 'signal' && r.v === this.v1.cfg.version && !this.rows.has(r.tk)); // decided once; never re-decided
    const now = this.now(), want = new Map(need.map((r) => [r.tk, r])), days = new Set([dayOf(now), dayOf(now - MARKET_MS)]);
    for (const r of need) { days.add(dayOf(r.close - MARKET_MS)); days.add(dayOf(r.bookRx)); }
    const refs = {}; const series = new Set(this.v1.cfg.rule.series), assets = new Set(need.map((r) => r.asset));
    let info = { files: 0, bytes: 0, truncated: false, rows: 0 };
    if (this.recorderDir) {
      const a = readRecorded(this.recorderDir, [...days].sort(), 'kalshi.book', (b) => {
        if (b.t !== 'book' || !series.has(b.s)) return; const w = want.get(b.tk);
        const live = b.rx > now - MARKET_MS - MIN; if (!w && !live) return; if (w && b.rx >= w.bookRx && !live) return;
        const close = w ? w.close : b.secLeft != null ? Math.round((b.rx + b.secLeft * 1000) / MARKET_MS) * MARKET_MS : null; if (close == null) return;
        const tr = this.track(b.tk, close - MARKET_MS); ingest(tr, b, 'recorded'); info.rows++;
      });
      const f = need.length ? readRecorded(this.recorderDir, [...days].sort(), 'ref', (x) => { if (x.t !== 'ref' || !assets.has(x.asset) || !(x.med > 0)) return; (refs[x.asset] = refs[x.asset] || []).push([x.rx, x.med]); }) : { files: 0, bytes: 0 };
      info = { ...info, files: a.files + f.files, bytes: a.bytes + f.bytes, truncated: a.truncated || f.truncated };
      for (const k of Object.keys(refs)) refs[k].sort((p, q) => p[0] - q[0]);
    }
    const refAt = (r) => { const L = refs[r.asset] || []; let best = null; for (const [t, px] of L) { if (t > r.bookRx) break; best = [t, px]; } return best && r.bookRx - best[0] <= 5000 ? { px: best[1], src: 'recorded 1 s reference median' } : { px: null, src: null }; };
    for (const r of v1rows) this.onV1Row(r, want.has(r.tk) ? { refAt, backfill: true } : {});
    // markets that were backfilled are done; drop their trackers (live ones stay)
    for (const tk of want.keys()) { const tr = this.tracks.get(tk); if (tr && tr.open + MARKET_MS < now) this.tracks.delete(tk); }
    this.backfill = { at: now, v1Signals: v1rows.filter((r) => r.t === 'signal').length, needed: need.length, ...info };
    if (need.length) this.log(`[kalshi-h2-v2] reconciled ${need.length} v1 signal(s) from recorded books (${info.files} files)`);
  }
  tick() {
    const now = this.now(); for (const [tk, tr] of this.tracks) if (tr.open + MARKET_MS + 3600e3 < now) this.tracks.delete(tk);
    if (this.health) this.health.ok('paper.kalshi-h2-v2', 0);
  }
  ordered() { return [...this.rows.values()].filter((x) => x.sig).sort((a, b) => a.sig.bookRx - b.sig.bookRx); }
  stats() { return this.cfg ? summarizeV2({ cfg: this.cfg, rows: this.ordered(), now: this.now() }) : null; }
  snapshot() {
    return { enabled: true, running: this.running, error: this.error, paper: true, label: 'PAPER · v2 hypothesis · UNPROVEN · not real money', id: this.key, name: this.cfg && this.cfg.name, version: this.cfg && this.cfg.version, hash: this.hash,
      base: this.cfg && this.cfg.base, filter: this.cfg && { skipIfBelow: this.cfg.filter.skipIfBelow, feature: this.cfg.filter.feature, noEarlierQuote: this.cfg.filter.noEarlierQuote }, pass: this.cfg && this.cfg.pass,
      startAt: this.startAt, sessions: this.sessions, backfill: this.backfill, stats: this.stats(),
      signals: this.ordered().slice(-12).reverse().map((x) => ({ tk: x.sig.tk, at: x.sig.bookRx, ya: x.sig.ya, maxEarlierAsk: x.sig.maxEarlierAsk, dask1: x.sig.dask1, dBps: x.sig.dBps, askDepth: x.sig.askDepth, decision: x.sig.decision, coverage: x.sig.coverage, why: x.sig.why, backfill: !!x.sig.backfill,
        px: x.fill ? x.fill.px : null, fee1: x.fill ? x.fill.fee1 : null, result: x.settle ? x.settle.result : x.nofill ? 'no fill' : null, pnlCents: x.settle ? r6(x.settle.pnl1 * 100) : null })),
      recent: this.recent.slice(-10).reverse() };
  }
}
module.exports = { KalshiH2V2, decide, ingest, newTrack, fisherOneSided, summarizeV2, readRecorded, V2_FILE };
