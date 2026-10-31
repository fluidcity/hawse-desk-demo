'use strict';
// Kalshi H2 v2 arm: AUDIT layer (display and logging only). Nothing in this file changes a v2 decision: the decision is
// decide() in v2.js, exactly as config/frozen/kalshi-h2-v2.json defines it. This file adds what miro's autopsy
// (hawse-research/kalshi-15m-loss-autopsy.md section 5) asks to be logged and shown, plus a "miro-exact" SHADOW of the feature
// computed the way his backtest did (as-of YES ask at each minute boundary, two-sided valid quotes only), so any disagreement
// with the frozen definition is visible. A shadow disagreement is evidence for a v4 (v3 is the sizing arm with v2's decisions), never a reason to re-decide.
const S = require('./stats');

const MIN = 60000, MARKET_MS = 15 * MIN;
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const minuteOf = (t) => Math.floor(t / MIN);
/** miro's minutes-left label of the 1-minute candle that contains the signal (his entries are m 6..10). */
const entryMinute = (sig) => Math.round((sig.close - (minuteOf(sig.bookRx) + 1) * MIN) / MIN);
const monthOf = (open) => new Date(open).toISOString().slice(0, 7);
/** Kalshi taker fee per ORDER of C contracts at price P: roundup_to_cent(0.07 * C * P * (1 - P)). */
const feeOrder = (C, P, rate = 0.07) => Math.ceil(rate * C * P * (1 - P) * 100 - 1e-9) / 100;

/**
 * miro-exact shadow of max_earlier_ask. Checkpoints = the minute boundaries open+1m .. start of the signal's minute
 * (miro's m = 14 .. entry_m+1; the entry minute is never included). Value at a checkpoint = the LAST recorded book before
 * the boundary (as-of close; nothing intra-minute), counted only if bid > 0, ask < 1 and ask > bid (kalshi_study.py filter).
 * A book carried across a minute with no recorded row is used only if the recorder was provably watching: next row from
 * the same recorder session and no recorded outage (gap row) in between; live rows (1 s poll) carry at most liveCarryMs.
 */
function miroShadow(tr, sig, { thr = 0.87, gaps = [], liveCarryMs = 5000 } = {}) {
  const M = minuteOf(sig.bookRx), open = tr ? tr.open : sig.close - MARKET_MS, m0 = minuteOf(open), entryM = entryMinute(sig);
  const rows = tr && tr.rows ? [...tr.rows].sort((a, b) => a.rx - b.rx) : [];
  let observed = 0, quoted = 0, valid = 0, max = null, last = null, i = 0; const earlierAsks = [];
  for (let k = m0 + 1; k <= M; k++) {
    const b = k * MIN; while (i < rows.length && rows[i].rx < b) i++;
    const L = i > 0 ? rows[i - 1] : null, m = Math.round((sig.close - b) / MIN); last = null;
    if (!L || L.rx < open) continue;
    let ok = L.rx >= b - MIN;
    if (!ok) { const N = rows[i]; ok = !!N && N.sess === L.sess && (L.sess === 'live' ? N.rx - L.rx <= liveCarryMs : !gaps.some((g) => g.from < N.rx && g.to > L.rx)); }
    if (!ok) continue;
    observed++; if (L.ya != null) quoted++;
    const isValid = L.ya != null && L.yb != null && L.yb > 0 && L.ya < 1 && L.ya > L.yb;
    earlierAsks.push([m, L.ya == null ? null : r6(+L.ya), isValid ? 1 : 0]);
    if (isValid) { valid++; max = max == null ? +L.ya : Math.max(max, +L.ya); last = +L.ya; }
  }
  const expected = 14 - entryM, miroDecision = max == null || max >= thr - 1e-9 ? 'take' : 'skip';
  return { entryM, minutesLeft: sig.secLeft == null ? null : r6(sig.secLeft / 60), month: monthOf(open), expectedEarlier: expected,
    nEarlierObserved: observed, nEarlierQuotes: quoted, nEarlierValid: valid, partialHistory: observed < expected,
    miroMaxEarlierAsk: max == null ? null : r6(max), miroDask1: last == null || sig.ya == null ? null : r6(sig.ya - last), miroDecision, earlierAsks };
}
const watchFlags = (s, W) => ({ thinCushion: s.dBps != null && s.dBps < W.dBpsBelow, jumped: s.dask1 != null && s.dask1 > W.dask1AboveDollars });

// Backtest reference lines (miro, kalshi-15m-loss-autopsy.md section 5). Display only; never used in a decision.
const BACKTEST_REF = {
  source: 'hawse-research/kalshi-15m-loss-autopsy.md section 5 (Dec 2025 - Oct 2026 1-minute candles)',
  skipRate: 0.18, skippedLossRate: 0.063, keptLossRate: 0.030, keptWinRate: 0.970, v1WinRate: 0.964,
  oosEvCents: { v1: 0.54, v2: 1.04 }, v2Flat2cOosEvCents: 0.04, v2InSampleEvCents: -0.45,
};
const CAVEATS = [
  'Jun-Oct 2026 was already seen when v1 was picked, so the v2 out-of-sample number is not clean out-of-sample.',
  'Backtest spot features (d_bps) were Coinbase 1-minute proxies; live d_bps uses the desk 1 s reference median.',
  'Fills and depth at 93-98c were untested in the backtest (candles carry top of book only).',
  'Do NOT retune 0.87: any change to the threshold or the feature is a new frozen file (v4; v3 is the sizing arm and keeps these decisions), with its own forward test.',
];

const view = (x) => ({ ...(x.annot || {}), ...x.sig }); // the frozen decision always comes from the signal row
const won = (x) => (x.settle ? !!x.settle.win : null);
const ev = (a, f) => (a.length ? r6((a.reduce((s, x) => s + f(x), 0) / a.length) * 100) : null);
const models = {
  actual: (x) => x.settle.pnl1,
  flat1: (x) => (x.settle.win ? 1 : 0) - x.settle.px - 0.01,
  flat2: (x) => (x.settle.win ? 1 : 0) - x.settle.px - 0.02,
};
const evAll = (a) => ({ actual: ev(a, models.actual), flat1: ev(a, models.flat1), flat2: ev(a, models.flat2) });
function grp(a) { const n = a.length, L = a.filter((x) => !x.settle.win).length; return { n, losses: L, lossRate: n ? r6(L / n) : null, lossCi: S.wilson(L, n), ev: evAll(a) }; }

/** Pass test on one cohort of settled known-decision rows. */
function passOn(cohort, P, fisher) {
  const K = cohort.filter((x) => x.sig.decision === 'take'), Sk = cohort.filter((x) => x.sig.decision === 'skip');
  const gk = grp(K), gs = grp(Sk), p = fisher({ keptLoss: gk.losses, keptN: gk.n, skipLoss: gs.losses, skipN: gs.n });
  const fisherMet = p != null && p < P.alpha && gs.lossRate > gk.lossRate, keptPos = gk.ev.actual != null && gk.ev.actual > P.keptMeanNetGtCents;
  return { n: cohort.length, kept: gk, skipped: gs, fisherP: p, fisherMet, keptPositive: keptPos, met: fisherMet && keptPos };
}
/** First look: the first minV1Signals settled known-decision signals in SIGNAL order. Later signals never change it. */
function firstLook(rows, P, fisher) {
  const known = rows.filter((x) => x.settle && x.sig.decision !== 'unknown').sort((a, b) => a.sig.bookRx - b.sig.bookRx);
  if (known.length < P.minV1Signals) return null;
  const cohort = known.slice(0, P.minV1Signals), all = passOn(cohort, P, fisher), np = passOn(cohort.filter((x) => !view(x).partialHistory), P, fisher);
  return { n: cohort.length, firstTk: cohort[0].sig.tk, lastTk: cohort[cohort.length - 1].sig.tk, lastBookRx: cohort[cohort.length - 1].sig.bookRx,
    met: all.met, fisherP: all.fisherP, keptLossRate: all.kept.lossRate, skippedLossRate: all.skipped.lossRate, keptEvCents: all.kept.ev, keptN: all.kept.n, skippedN: all.skipped.n,
    withoutPartialHistory: { n: np.n, met: np.met, fisherP: np.fisherP, keptEvCents: np.kept.ev, keptLossRate: np.kept.lossRate, skippedLossRate: np.skipped.lossRate } };
}
function downsample(a, max = 240) { if (a.length <= max) return a; const out = [], step = (a.length - 1) / (max - 1); for (let i = 0; i < max; i++) out.push(a[Math.round(i * step)]); return out; }

/** Everything the audit adds to the v2 card. rows: [{ sig, annot, fill, nofill, settle, sv }] in signal order. Pure. */
function auditSummary({ cfg, rows, verdict = null, weekStart = null, fisher }) {
  const P = cfg.pass, W = cfg.watchOnly, V = rows.map(view);
  const settled = rows.filter((x) => x.settle), known = settled.filter((x) => x.sig.decision !== 'unknown');
  const K = known.filter((x) => x.sig.decision === 'take'), Sk = known.filter((x) => x.sig.decision === 'skip');
  // running Fisher p and kept EV (3 fee models) vs signal count, in signal order (display only)
  const ord = [...known].sort((a, b) => a.sig.bookRx - b.sig.bookRx), run = []; const acc = { kL: 0, kN: 0, sL: 0, sN: 0, a: 0, f1: 0, f2: 0 };
  for (const x of ord) {
    if (x.sig.decision === 'take') { acc.kN++; acc.kL += x.settle.win ? 0 : 1; acc.a += models.actual(x); acc.f1 += models.flat1(x); acc.f2 += models.flat2(x); } else { acc.sN++; acc.sL += x.settle.win ? 0 : 1; }
    run.push({ n: acc.kN + acc.sN, p: fisher({ keptLoss: acc.kL, keptN: acc.kN, skipLoss: acc.sL, skipN: acc.sN }),
      actual: acc.kN ? r6((acc.a / acc.kN) * 100) : null, flat1: acc.kN ? r6((acc.f1 / acc.kN) * 100) : null, flat2: acc.kN ? r6((acc.f2 / acc.kN) * 100) : null });
  }
  // equity curves (cumulative cents, settle order): v1 = every filled v1 signal; v2-kept; skipped = HYPOTHETICAL (not traded by v2)
  const curve = (a) => { let c = 0; return downsample([...a].sort((p, q) => (p.settle.settledAt || p.settle.at) - (q.settle.settledAt || q.settle.at)).map((x) => { c += x.settle.pnl1; return [x.settle.settledAt || x.settle.at, r6(c * 100)]; })); };
  const split = (keyOf) => { const o = {}; for (const x of known) { const k = keyOf(x); if (k == null) continue; (o[k] = o[k] || { take: [], skip: [] })[x.sig.decision].push(x); } return Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, { kept: grp(v.take), skipped: grp(v.skip) }])); };
  const wk = (x) => (weekStart == null ? null : 1 + Math.floor((x.sig.bookRx - weekStart) / (7 * 86400e3)));
  const fl = firstLook(rows, P, fisher), interim = passOn(known, P, fisher), interimNp = passOn(known.filter((x) => !view(x).partialHistory), P, fisher);
  const feeMismatch = rows.filter((x) => x.fill && x.fill.px != null && x.fill.fee1 != null && Math.abs(feeOrder(x.fill.size || 1, x.fill.px) - x.fill.fee1) > 1e-9).length;
  const sized = V.filter((s) => s.askDepth != null), sizedK = V.filter((s) => s.askDepth != null && s.decision === 'take');
  const withShadow = V.filter((s) => s.miroDecision != null), dis = withShadow.filter((s) => s.decision !== 'unknown' && s.miroDecision !== s.decision);
  const sb = rows.map((x) => x.sv && x.sv.settleBps).filter((v) => v != null);
  const nofillOutcomes = rows.filter((x) => x.nofill && x.sv && x.sv.result).map((x) => ({ tk: x.sig.tk, decision: x.sig.decision, result: x.sv.result }));
  return {
    firstLook: verdict ? { ...verdict, persisted: true } : fl ? { ...fl, persisted: false } : null,
    interim: { note: 'display only; only the first look at the gate counts', all: { n: interim.n, fisherP: interim.fisherP, keptEvCents: interim.kept.ev, met: interim.met },
      withoutPartialHistory: { n: interimNp.n, fisherP: interimNp.fisherP, keptEvCents: interimNp.kept.ev, keptLossRate: interimNp.kept.lossRate, skippedLossRate: interimNp.skipped.lossRate, met: interimNp.met } },
    feeModels: { formula: 'per order: roundup_to_cent(0.07 * C * P * (1 - P)); C = contracts in the paper fill', kept: evAll(K), skipped: evAll(Sk), v1: evAll(settled), feeMismatch },
    depth: { atLeast: 10, measured: sized.length, share: sized.length ? r6(sized.filter((s) => s.askDepth >= 10).length / sized.length) : null, keptShare: sizedK.length ? r6(sizedK.filter((s) => s.askDepth >= 10).length / sizedK.length) : null },
    byAsset: split((x) => x.sig.asset || null), byMonth: split((x) => view(x).month || null), byWeek: split(wk),
    running: downsample(run), equity: { v1: curve(settled), kept: curve(K), skippedHypothetical: curve(Sk) },
    shadow: { compared: withShadow.length, disagree: dis.length, disagreeTk: dis.slice(-10).map((s) => s.tk), partialHistory: V.filter((s) => s.partialHistory).length,
      note: 'miro-exact shadow: as-of YES ask at each minute boundary, valid two-sided quotes only; display only' },
    watch: { thinCushion: V.filter((s) => watchFlags(s, W).thinCushion).length, jumped: V.filter((s) => watchFlags(s, W).jumped).length },
    settleBps: { n: sb.length, min: sb.length ? Math.min(...sb) : null, median: sb.length ? [...sb].sort((a, b) => a - b)[Math.floor(sb.length / 2)] : null },
    nofillOutcomes: { n: nofillOutcomes.length, recent: nofillOutcomes.slice(-5) },
    reference: BACKTEST_REF, caveats: CAVEATS,
  };
}
module.exports = { miroShadow, watchFlags, entryMinute, monthOf, feeOrder, firstLook, passOn, auditSummary, BACKTEST_REF, CAVEATS, view };
