'use strict';
// Honest statistics for the Kalshi H2 forward paper test. Pure functions, no IO.
// Nothing here tunes anything: thresholds come from the frozen config only.

const fee1 = (p, rate = 0.07) => Math.ceil(rate * p * (1 - p) * 100 - 1e-9) / 100; // 1-contract order, cent-rounded up
const feeLarge = (p, rate = 0.07) => rate * p * (1 - p); // amortized large-order fee per contract
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** Wilson score interval for a binomial proportion. */
function wilson(k, n, z = 1.959964) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p: r6(p), lo: r6((c - h) / d), hi: r6((c + h) / d) };
}
/** Seeded PRNG so the bootstrap CI is reproducible. */
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Day-block bootstrap of the pooled mean: resample whole UTC days with replacement. Needs >= 2 days. */
function bootstrapByDay(rows, { reps = 2000, seed = 1, ci = 0.95, key = 'pnl1' } = {}) {
  const byDay = new Map(); for (const r of rows) { const d = new Date(r.at).toISOString().slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r[key]); }
  const days = [...byDay.values()]; if (days.length < 2) return { days: days.length, lo: null, hi: null, note: 'needs at least 2 days' };
  const rnd = mulberry32(seed), out = [];
  for (let b = 0; b < reps; b++) { let s = 0, n = 0; for (let i = 0; i < days.length; i++) { const d = days[Math.floor(rnd() * days.length)]; for (const x of d) { s += x; n++; } } out.push(s / n); }
  out.sort((x, y) => x - y); const a = (1 - ci) / 2;
  return { days: days.length, lo: r6(out[Math.floor(a * reps)]), hi: r6(out[Math.min(reps - 1, Math.ceil((1 - a) * reps) - 1)]) };
}
function normalCi(a, z = 1.959964) { const m = mean(a), s = sd(a); if (m == null || s == null) return null; const h = (z * s) / Math.sqrt(a.length); return { lo: r6(m - h), hi: r6(m + h) }; }
const WEEK = 7 * 86400e3;

/**
 * Summarize the ledger state.
 *  signals: [{tk, asset, at, ya, yas}] valid signals (full coverage)
 *  trades:  [{tk, asset, at (signal time), px, win, pnl1, pnlL, pnlSpec, yas}] settled fills (P&L in DOLLARS per contract)
 */
function summarize({ cfg, startAt, now, signals, fills, trades, skips, unsettled }) {
  const T = cfg.targets, P = cfg.pass, F = cfg.failStop;
  const nSig = signals.length, n = trades.length, wins = trades.filter((t) => t.win).length;
  const c = (x) => (x == null ? null : r6(x * 100)); // dollars -> cents
  const p1 = trades.map((t) => t.pnl1), pL = trades.map((t) => t.pnlL), pS = trades.map((t) => t.pnlSpec);
  const boot = bootstrapByDay(trades, { reps: cfg.stats.bootstrapReps, seed: cfg.stats.bootstrapSeed, ci: cfg.stats.ci, key: 'pnl1' });
  const nci = normalCi(p1);
  const weeksElapsed = startAt ? (now - startAt) / WEEK : 0;
  const wk = (t) => Math.floor((t.at - startAt) / WEEK);
  const weeks = []; for (const t of trades) { const w = wk(t); weeks[w] = weeks[w] || { week: w + 1, n: 0, pnl: 0 }; weeks[w].n++; weeks[w].pnl += t.pnl1; }
  const weekList = weeks.filter(Boolean).map((w) => ({ ...w, pnlCents: c(w.pnl), complete: (w.week) * WEEK <= now - startAt }));
  // Per-week table over EVERY test week so far (weeks with no trades included), by signal time. Feeds miro's 6-of-8 criterion.
  const curWeek = startAt ? Math.floor(Math.max(0, now - startAt) / WEEK) : -1, weekTable = [];
  for (let w = 0; w <= curWeek; w++) {
    const tw = trades.filter((t) => wk(t) === w), sw = signals.filter((x) => Math.floor((x.at - startAt) / WEEK) === w), wn = tw.filter((t) => t.win).length, net = tw.reduce((a, t) => a + t.pnl1, 0);
    weekTable.push({ week: w + 1, from: startAt + w * WEEK, signals: sw.length, settled: tw.length, wins: wn, winRate: tw.length ? r6(wn / tw.length) : null, netCents: c(net), complete: (w + 1) * WEEK <= now - startAt, positive: tw.length > 0 && net > 0 });
  }
  const assets = {}; for (const t of trades) { const a = (assets[t.asset] = assets[t.asset] || { n: 0, wins: 0, pnl: 0 }); a.n++; a.wins += t.win ? 1 : 0; a.pnl += t.pnl1; }
  for (const a of Object.values(assets)) { a.meanCents = c(a.pnl / a.n); a.pnlCents = c(a.pnl); delete a.pnl; }
  const sized = signals.filter((s) => s.yas != null), deep = sized.filter((s) => s.yas >= P.askSizeAtLeast).length;
  // rolling 4 complete weeks: loss per 100 signals (cents)
  let worst4 = null; const full = weekList.filter((w) => w.complete);
  for (let i = 0; (i + 4) * WEEK <= now - startAt; i++) {
    const ws = [0, 1, 2, 3].map((k) => weeks[i + k]).filter(Boolean), nn = ws.reduce((x, w) => x + w.n, 0); if (!nn) continue;
    const loss = (-ws.reduce((x, w) => x + w.pnl, 0) / nn) * 100 * 100; worst4 = worst4 == null ? loss : Math.max(worst4, loss);
  }
  // shadow 1%-of-bankroll curve (reporting only), in settle order
  let bank = cfg.sizing.shadowBankroll.start, peak = bank, mdd = 0;
  for (const t of [...trades].sort((x, y) => (x.settledAt || x.at) - (y.settledAt || y.at))) { const stake = bank * cfg.sizing.shadowBankroll.fractionPerSignal, cost = t.px + t.fee1; bank += stake * (t.pnl1 / cost); peak = Math.max(peak, bank); mdd = Math.max(mdd, (peak - bank) / peak); }
  const implied = mean(trades.map((t) => t.px));
  const m1 = mean(p1), mL = mean(pL);
  const enough = weeksElapsed >= T.minWeeks && nSig >= T.minSignals;
  const criteria = {
    meanOneLotPositive: m1 != null && m1 > P.meanPnlOneLotFeeGt,
    bootstrapLowerPositive: boot.lo != null && boot.lo > P.meanPnlOneLotFeeDayBootstrapCi95LowerGt,
    largeOrderMeanAtLeast08c: mL != null && mL * 100 >= P.meanPnlLargeOrderFeeGteCents,
    positiveWeeks: full.slice(0, 8).filter((w) => w.pnl > 0).length >= P.positiveWeeksMinOf8,
    positiveAssets: Object.values(assets).filter((a) => a.meanCents > 0).length >= P.positiveAssetsMinOf3,
    askDepth: sized.length > 0 && deep / sized.length >= P.askSizeShareMin,
  };
  // miro's pass criteria, shown honestly (DISPLAY ONLY: thresholds come from the frozen config; the verdict above is unchanged).
  // 'pending' = cannot be decided yet; 'met' / 'not met' = decided. Weeks are counted by week number, so a complete week
  // with no settled trades counts as not positive.
  const completeWeeks = Math.min(8, Math.floor(weeksElapsed)), posWeeks = weekTable.filter((w) => w.complete && w.week <= 8 && w.positive).length;
  const needW = P.positiveWeeksMinOf8, askShare = sized.length ? deep / sized.length : null;
  const miro = [
    { key: 'meanNetOneLot', label: 'mean net per contract after 1-contract fee > 0', value: c(m1), unit: '¢', target: '> 0', so: `${n} settled`,
      status: !enough ? 'pending' : m1 != null && m1 > P.meanPnlOneLotFeeGt ? 'met' : 'not met' },
    { key: 'positiveWeeks', label: `>= ${needW} of 8 weeks positive`, value: posWeeks, unit: ` of ${completeWeeks} complete`, target: `>= ${needW} of 8`, so: `${8 - completeWeeks} week(s) still to come`,
      status: posWeeks >= needW ? 'met' : completeWeeks - posWeeks > 8 - needW ? 'not met' : 'pending' },
    { key: 'askDepth', label: `>= ${P.askSizeAtLeast} contracts at the ask in >= ${Math.round(P.askSizeShareMin * 100)}% of signals`, value: askShare == null ? null : r6(askShare), unit: 'share', target: `>= ${P.askSizeShareMin}`,
      so: `${sized.length} signals with ask size logged (best-ask size at signal time)`, status: !enough || !sized.length ? 'pending' : askShare >= P.askSizeShareMin ? 'met' : 'not met' },
  ];
  const failStops = [];
  if (nSig >= F.meanLteZeroAfterSignals && m1 != null && m1 <= 0) failStops.push(`mean <= 0 after ${F.meanLteZeroAfterSignals} signals`);
  if (worst4 != null && worst4 > F.rolling4WeekLossPer100SignalsGtCents) failStops.push(`rolling 4 weeks lost ${worst4.toFixed(1)}c per 100 signals (> ${F.rolling4WeekLossPer100SignalsGtCents})`);
  return {
    signals: nSig, fills: fills, settled: n, unsettled, skips,
    wins, losses: n - wins, winRate: wilson(wins, n), impliedProb: r6(implied), edgeVsImpliedPts: implied == null || !n ? null : r6((wins / n - implied) * 100),
    meanPnlCents: { oneLotFee: c(m1), largeOrderFee: c(mL), atSignalAskShadow: c(mean(pS)) },
    totalPnlCents: { oneLotFee: c(p1.reduce((s, x) => s + x, 0)), largeOrderFee: c(pL.reduce((s, x) => s + x, 0)) },
    ci95Cents: { dayBootstrap: { days: boot.days, lo: c(boot.lo), hi: c(boot.hi), note: boot.note || null }, normal: nci ? { lo: c(nci.lo), hi: c(nci.hi) } : null },
    perAsset: assets, weeks: weekList, weekTable, worstRolling4WeekLossPer100Cents: worst4 == null ? null : r6(worst4),
    askSize: { measured: sized.length, atLeast: P.askSizeAtLeast, share: sized.length ? r6(deep / sized.length) : null },
    shadowBankroll: { multiple: r6(bank), maxDrawdown: r6(mdd), note: 'reporting only, 1% of bankroll per signal' },
    progress: { signals: nSig, targetSignals: T.minSignals, signalPct: r6(Math.min(1, nSig / T.minSignals)), weeks: r6(weeksElapsed), targetWeeks: T.minWeeks },
    criteria, miro, enough, failStops,
    verdict: failStops.length ? 'FAIL-STOP' : !enough ? 'UNVERIFIED — not enough data' : Object.values(criteria).every(Boolean) ? 'PASS (all criteria met)' : 'FAIL (criteria not met)',
  };
}
/**
 * Live P&L view for the dashboard (DISPLAY ONLY, paper fills only; decides nothing).
 *  realized: settled paper fills, 1-lot fee, by settle time: cumulative curve plus today / this test week / total.
 *  unrealized: open (unsettled) paper fills marked to the latest YES bid, net of the entry fee AND the 1-lot exit fee you
 *  would pay selling at that bid. Kept apart from realized and never added into it.
 *  dayStartMs(now) gives the start of "today" (the desk passes box-local midnight).
 */
function livePnl({ trades = [], fills = [], marks = new Map(), now, startAt, rate = 0.07, dayStartMs = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); } }) {
  const c = (x) => (x == null ? null : r6(x * 100));
  const settled = [...trades].map((t) => ({ ...t, sAt: t.settledAt || t.at })).sort((a, b) => a.sAt - b.sAt);
  let cum = 0; const curve = settled.map((t) => { cum += t.pnl1; return { at: t.sAt, tk: t.tk, pnlCents: c(t.pnl1), cumCents: c(cum) }; });
  const day0 = dayStartMs(now), week0 = startAt ? startAt + Math.floor(Math.max(0, now - startAt) / WEEK) * WEEK : null;
  const sum = (f) => c(settled.filter(f).reduce((a, t) => a + t.pnl1, 0));
  const open = fills.filter((f) => !f.settled).map((f) => {
    const m = marks.get(f.tk) || null, bid = m && m.yb != null ? +m.yb : null;
    const un = bid == null ? null : bid - f.px - f.fee1 - (bid > 0 ? fee1(bid, rate) : 0);
    return { tk: f.tk, asset: f.asset, entryAt: f.at, px: f.px, fee1: f.fee1, close: f.close || null, mark: bid, markSize: m ? m.ybs : null, markAt: m ? m.rx : null, markAgeMs: m ? now - m.rx : null, unrealizedCents: c(un) };
  });
  const unAll = open.filter((o) => o.unrealizedCents != null);
  return {
    source: 'paper fills only (frozen v1 ledger); 1-contract fee', curve,
    realizedCents: { today: sum((t) => t.sAt >= day0), thisWeek: week0 == null ? null : sum((t) => t.sAt >= week0), total: c(cum), n: settled.length },
    unrealized: { open, totalCents: unAll.length ? r6(unAll.reduce((a, o) => a + o.unrealizedCents, 0)) : null, unmarked: open.length - unAll.length,
      note: 'mark to the latest YES bid, net of the entry fee and the exit fee of selling at that bid; not realized, not in the totals' },
  };
}
module.exports = { livePnl, fee1, feeLarge, wilson, bootstrapByDay, normalCi, mulberry32, summarize, mean };
