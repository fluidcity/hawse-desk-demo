'use strict';
// Funding-carry v2 helpers (pure, tested): persistence counting, APR/liquidity/basis math, the realized-vs-expected
// scoreboard with the batch-1 H2 pass/fail rules, and a not-booked "shadow" book used for the naive-v1 control.
const H = 3600e3, DAY = 24 * H;

// Paper-test plan (batch-1 §3 H2). Read by summarize() AND the explainer/UI.
const PLAN = Object.freeze({ minClosed: 30, minDays: 21, passRatio: 0.6, passApr: 8, maxPairLossPct: 0.5, maxDdPct: 1.5, failRatio: 0.3, failApr: 3 });

/** Number of trailing elements satisfying pred (the "consecutive observations" count). */
function trailing(xs, pred) { let n = 0; for (let i = xs.length - 1; i >= 0 && pred(xs[i]); i--) n++; return n; }
const persistCount = (series) => trailing(series || [], (x) => x > 0);
const flipCount = (series) => trailing(series || [], (x) => x <= 0);
const persistOk = (series, n) => persistCount(series) >= n;
/** Predicted next-funding spread must keep the same (positive) sign. null/undefined = no forecast = fail closed. */
const predictedOk = (predictedSpreadH) => typeof predictedSpreadH === 'number' && predictedSpreadH > 0;
/** Annualized net % on GROSS notional (both legs = legs × per-leg notional). */
function netAprPct({ net, notional, holdH, legs = 2 }) { return notional > 0 && holdH > 0 ? (net / (legs * notional)) * (8760 / holdH) * 100 : 0; }
/** Liquidity rule: dayNtlVlm × frac ≥ 2 × leg notional, else shrink the leg. Venues without a volume figure don't cap. */
function liquidityCap(notional, rows, frac = 0.0005) {
  let n = notional; for (const r of rows) if (r && r.dayNtlVlm > 0) n = Math.min(n, (r.dayNtlVlm * frac) / 2);
  return Math.max(0, n);
}
/** Signed basis of the SHORT leg over the LONG leg in bps. Rising = against a short-rich/long-cheap position. */
const signedBasisBps = (shortMark, longMark) => ((shortMark - longMark) / ((shortMark + longMark) / 2)) * 1e4;
/** Expected net $ pro-rated to the actual hold: gross funding/hour × held hours − round-trip costs fixed at entry. */
const expectedAtHeld = (exp, heldH) => exp.grossPerH * heldH - exp.costs;

/** Realized-vs-expected scoreboard over closed records [{openedAt, closedAt, notional, realized, expected$, byStop, mode}]. */
function summarize(closed, { sleeve, now = Date.now(), plan = PLAN } = {}) {
  const xs = [...(closed || [])].sort((a, b) => a.closedAt - b.closedAt);
  const n = xs.length, first = n ? Math.min(...xs.map((x) => x.openedAt)) : null;
  const real = xs.reduce((a, x) => a + x.realized, 0), exp = xs.reduce((a, x) => a + x.expected, 0);
  const capH = xs.reduce((a, x) => a + 2 * x.notional * Math.max(1 / 60, (x.closedAt - x.openedAt) / H), 0);
  let cum = 0, peak = 0, dd = 0; for (const x of xs) { cum += x.realized; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const worst = n ? Math.min(0, ...xs.map((x) => x.realized)) : 0;
  const m = {
    n, realized: real, expected: exp, ratio: exp > 0 ? real / exp : null, netApr: capH > 0 ? (real / capH) * 8760 * 100 : null,
    maxDdPct: sleeve > 0 ? (dd / sleeve) * 100 : null, worstLossPct: sleeve > 0 ? (-worst / sleeve) * 100 : null,
    stopPct: n ? (xs.filter((x) => x.byStop).length / n) * 100 : null, days: first ? (now - first) / DAY : 0,
    realizedNetBps: n ? xs.reduce((a, x) => a + x.realizedNetBps, 0) / n : null, expectedNetBps: n ? xs.reduce((a, x) => a + x.expectedNetBps, 0) / n : null,
    byMode: { 'perp-perp': xs.filter((x) => x.mode === 'perp-perp').length, carry: xs.filter((x) => x.mode === 'carry').length },
  };
  const enough = n >= plan.minClosed && m.days >= plan.minDays;
  const fail = (m.ratio != null && m.ratio < plan.failRatio) || (m.netApr != null && m.netApr < plan.failApr);
  const pass = m.ratio != null && m.ratio >= plan.passRatio && m.netApr >= plan.passApr && m.worstLossPct <= plan.maxPairLossPct && m.maxDdPct < plan.maxDdPct;
  m.verdict = !enough ? 'collecting' : fail ? 'fail' : pass ? 'pass' : 'inconclusive';
  m.progress = `${n}/${plan.minClosed} closed · ${m.days.toFixed(1)}/${plan.minDays} days`;
  return m;
}

/**
 * Not-booked shadow book on the SAME real quotes. Funding is accrued continuously from each perp leg's current hourly rate
 * (an approximation of discrete settlement), price P&L from marks, and costs (fees + slippage) charged at entry and exit.
 * Never touches the ledger: used for the naive-v1 control and the matching v2 shadow so the two are scored identically.
 */
class ShadowBook {
  constructor(label) { this.label = label; this.positions = []; this.closed = []; }
  holds(symbol) { return this.positions.some((p) => p.symbol === symbol); }
  open(p) { this.positions.push({ funding: 0, lastT: p.openedAt, ...p }); }
  /** quote(leg) -> {mark, hourly?} or null (stale). */
  mark(now, quote) {
    for (const p of this.positions) {
      const dtH = Math.max(0, (now - p.lastT) / H); p.lastT = now;
      for (const l of p.legs) { const q = quote(p, l); if (!q) continue; l.mark = q.mark; if (l.kind === 'perp' && typeof q.hourly === 'number') p.funding += (l.side === 'short' ? 1 : -1) * q.hourly * l.qty * q.mark * dtH; }
    }
  }
  close(p, now, why, { exitCost = 0, byStop = false } = {}) {
    const price = p.legs.reduce((a, l) => a + (l.side === 'long' ? 1 : -1) * ((l.mark ?? l.entry) - l.entry) * l.qty, 0);
    const realized = price + p.funding - p.entryCost - exitCost, heldH = (now - p.openedAt) / H;
    const expected = expectedAtHeld(p.exp, heldH);
    const rec = { symbol: p.symbol, mode: p.mode, openedAt: p.openedAt, closedAt: now, notional: p.notional, realized, expected, byStop, why,
      realizedNetBps: (realized / p.notional) * 1e4, expectedNetBps: p.expectedNetBps, funding: p.funding, price };
    this.closed.push(rec); if (this.closed.length > 500) this.closed.shift();
    this.positions = this.positions.filter((x) => x !== p); return rec;
  }
}

module.exports = { PLAN, trailing, persistCount, flipCount, persistOk, predictedOk, netAprPct, liquidityCap, signedBasisBps, expectedAtHeld, summarize, ShadowBook };
