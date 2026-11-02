'use strict';
// H1: closing-line value. Pure. The close is the last ANCHOR (Pinnacle) snapshot taken ≤ closeWithinMin before commence.
//   clvPct    = d_taken / d_closeFair − 1, where d_closeFair is the anchor's no-vig closing price for our side
//   beatClose = d_taken > the same book's own closing price for our side
// summarize() gives mean CLV with a bootstrap 95% CI and the batch-1 pass/fail verdict (CLV is the primary metric).
const A = require('./anchor');

/** CLV record for one bet from the closing snapshot `cl` ({...event, capturedAt}). */
function clvFor(bet, cl, { anchor = 'pinnacle', method = 'power', closeWithinMin = 10 } = {}) {
  if (!cl) return { clvPct: null, note: 'no closing snapshot' };
  const leadMin = (bet.commence - cl.capturedAt) / 60e3, line = A.lineOf(cl, bet.market, bet.name, bet.point);
  const fair = A.pinnacleFair(cl, bet.market, line, { anchor, method, now: cl.capturedAt }), sel = A.selectionFair(fair, bet.name, bet.point);
  const own = (cl.books || []).find((b) => b.key === bet.book), ownMk = own && own.markets && own.markets[bet.market];
  const ownQ = ownMk && ownMk.find((o) => o.name === bet.name && (bet.market === 'h2h' || o.point === bet.point));
  const out = { closeAt: cl.capturedAt, closeLeadMin: +leadMin.toFixed(1), closeOk: leadMin >= 0 && leadMin <= closeWithinMin, dCloseSoft: ownQ ? ownQ.dec : null,
    beatClose: ownQ ? bet.dec > ownQ.dec : null, anchor };
  if (!sel) return { ...out, dCloseFair: null, clvPct: null, note: `${anchor} had no closing price at ${bet.market === 'h2h' ? 'this market' : 'line ' + bet.point}` };
  return { ...out, dCloseFair: sel.fairDec, clvPct: (bet.dec / sel.fairDec - 1) * 100, note: out.closeOk ? null : `approximate close: captured ${leadMin.toFixed(0)} min before start (> ${closeWithinMin})` };
}

/** Seeded PRNG so the CI is reproducible for the same data. */
function lcg(seed = 7) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
/** Bootstrap 95% CI of the mean. */
function bootstrapCI(xs, { iters = 2000, seed = 7 } = {}) {
  if (xs.length < 2) return null; const r = lcg(seed), n = xs.length, means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) { let s = 0; for (let j = 0; j < n; j++) s += xs[(r() * n) | 0]; means[i] = s / n; }
  means.sort(); return [means[Math.floor(0.025 * iters)], means[Math.ceil(0.975 * iters) - 1]];
}
const PLAN = Object.freeze({ minBets: 300, passMeanPct: 1.0, passBeatPct: 52, failAfter: 300, straddleFailAfter: 600, roiVerdictAfter: 1500 });

/** Verdict per batch-1 H1 paper-test plan. */
function verdict(n, mean, ci, beatPct) {
  if (n < PLAN.minBets) return { status: 'collecting', text: `${n}/${PLAN.minBets} bets with a valid close; no verdict before ${PLAN.minBets}` };
  if (mean >= PLAN.passMeanPct && ci && ci[0] > 0 && beatPct >= PLAN.passBeatPct) return { status: 'pass', text: `mean CLV ${mean.toFixed(2)}% ≥ ${PLAN.passMeanPct}%, CI > 0, beat close ${beatPct.toFixed(0)}% ≥ ${PLAN.passBeatPct}%` };
  if (mean <= 0 || (n >= PLAN.straddleFailAfter && ci && ci[0] <= 0 && ci[1] >= 0)) return { status: 'fail', text: mean <= 0 ? `mean CLV ${mean.toFixed(2)}% ≤ 0 after ${n} bets` : `CI straddles 0 after ${n} bets` };
  return { status: 'inconclusive', text: 'pass criteria not met yet; keep collecting' };
}

/** Scoreboard over bets that have a CLV record. Only closes within the window count (approximate ones reported apart). */
function summarize(bets, opts = {}) {
  const withClv = bets.filter((b) => b.clv && b.clv.clvPct != null), valid = withClv.filter((b) => b.clv.closeOk), xs = valid.map((b) => b.clv.clvPct);
  const n = xs.length, mean = n ? xs.reduce((a, b) => a + b, 0) / n : null, ci = bootstrapCI(xs, opts);
  const bc = valid.filter((b) => b.clv.beatClose != null), beatClosePct = bc.length ? (100 * bc.filter((b) => b.clv.beatClose).length) / bc.length : null;
  const beatFairPct = n ? (100 * xs.filter((x) => x > 0).length) / n : null;
  const group = (key) => { const o = {}; for (const b of valid) { const k = b[key] || '?'; (o[k] = o[k] || []).push(b.clv.clvPct); } return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length }])); };
  const settled = bets.filter((b) => b.status === 'settled'), staked = settled.reduce((a, b) => a + b.stake, 0), pnl = settled.reduce((a, b) => a + (b.pnl || 0), 0);
  const ages = valid.filter((b) => b.priceAgeSec != null); const fresh = ages.filter((b) => b.priceAgeSec <= 180), old = ages.filter((b) => b.priceAgeSec > 180);
  const m = (a) => (a.length ? a.reduce((s, b) => s + b.clv.clvPct, 0) / a.length : null);
  return { n, mean, ci95: ci, beatClosePct, beatFairPct, approx: withClv.length - n, bySport: group('sport'), byBook: group('book'), byMarket: group('market'),
    roi: { settled: settled.length, staked, pnl, roiPct: staked ? (100 * pnl) / staked : null, note: `ROI is secondary; not used for pass/fail before ${PLAN.roiVerdictAfter} bets` },
    priceAge: { freshN: fresh.length, freshMean: m(fresh), oldN: old.length, oldMean: m(old), note: 'edge decay: CLV for bets whose price was ≤ 3 min vs > 3 min old when taken' },
    verdict: verdict(n, mean ?? 0, ci, beatClosePct ?? beatFairPct ?? 0), plan: PLAN };
}

module.exports = { clvFor, summarize, bootstrapCI, verdict, PLAN };
