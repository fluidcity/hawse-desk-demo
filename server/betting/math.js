'use strict';
// Pure sports-betting math. Decimal odds throughout (2.00 = even money, stake included in the payout).
// Nothing here fetches data or places bets.

/** American → decimal: +150 → 2.5, −200 → 1.5. */
function americanToDecimal(a) { if (!Number.isFinite(a) || a === 0 || (a > -100 && a < 100)) throw new RangeError('invalid American odds'); return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
/** Decimal → American (rounded). */
function decimalToAmerican(d) { if (!(d > 1)) throw new RangeError('decimal odds must be > 1'); return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
const implied = (d) => 1 / d;

/**
 * Remove the bookmaker margin ("vig") from one market's prices.
 * method 'multiplicative' (default): p_i = (1/d_i) / Σ(1/d_j) (simple and common).
 * method 'power': find k with Σ(1/d_i)^k = 1, which shifts more of the margin onto longshots.
 * Returns { probs, fair (decimal odds), overround } where overround is Σ(1/d) − 1 (0.045 means 4.5% hold).
 */
function noVig(decs, method = 'multiplicative') {
  if (!Array.isArray(decs) || decs.length < 2 || decs.some((d) => !(d > 1))) throw new RangeError('need ≥2 decimal prices > 1');
  const imp = decs.map(implied), sum = imp.reduce((a, b) => a + b, 0);
  let probs;
  if (method === 'power') {
    let lo = 0.5, hi = 3; for (let i = 0; i < 100; i++) { const k = (lo + hi) / 2, s = imp.reduce((a, p) => a + p ** k, 0); if (s > 1) lo = k; else hi = k; }
    const k = (lo + hi) / 2; probs = imp.map((p) => p ** k); const s = probs.reduce((a, b) => a + b, 0); probs = probs.map((p) => p / s);
  } else probs = imp.map((p) => p / sum);
  return { probs, fair: probs.map((p) => 1 / p), overround: sum - 1 };
}

/** Expected value per 1 unit staked at decimal odds d with true win probability p (ignores pushes). */
const ev = (p, d) => p * (d - 1) - (1 - p);

/**
 * Kelly stake as a fraction of bankroll. full = (b·p − q) / b with b = d − 1.
 * stakePct = min(full × fraction, maxPct), never negative. Fractional Kelly (e.g. 0.25) is the norm
 * because p is an estimate; full Kelly on a noisy estimate overbets.
 */
function kelly(p, d, { fraction = 0.25, maxPct = 0.02 } = {}) {
  const b = d - 1; if (!(b > 0) || !(p > 0 && p < 1)) return { full: 0, stakePct: 0 };
  const full = Math.max(0, (b * p - (1 - p)) / b);
  return { full, stakePct: Math.max(0, Math.min(full * fraction, maxPct)) };
}

/**
 * Arbitrage across books: given the BEST decimal price for each mutually exclusive outcome of one market
 * (all outcomes covered, same line), an arb exists when Σ 1/d < 1. Stakes are split so every outcome returns
 * the same payout. Returns null when there is no arb.
 */
function arb(bestDecs, totalStake = 100) {
  if (!Array.isArray(bestDecs) || bestDecs.length < 2 || bestDecs.some((d) => !(d > 1))) return null;
  const s = bestDecs.reduce((a, d) => a + 1 / d, 0); if (s >= 1) return null;
  const stakes = bestDecs.map((d) => (totalStake * (1 / d)) / s), payout = totalStake / s;
  return { sumImplied: s, marginPct: (1 / s - 1) * 100, stakes, payout, profit: payout - totalStake };
}

/**
 * Middle on spreads/totals: two opposite sides at DIFFERENT lines whose winning regions overlap.
 *   totals: over at L and under at H with H > L → both win when L < total < H.
 *   spreads: side A at line a and side B at line b (lines from each side's view, e.g. home +3.5 / away −2.5)
 *            → window width a + b > 0 → both win when the margin lands inside.
 * Stakes are sized for equal payouts. Returns { width, stakes, ifOneWins, ifBothWin } or null.
 * Pushes on integer lines are not modelled (they return stake; this reports the no-push case).
 */
function middle({ kind, a, b }, totalStake = 100) {
  const width = kind === 'totals' ? b.point - a.point : a.point + b.point; // totals: a=over, b=under
  if (!(width > 0) || !(a.dec > 1) || !(b.dec > 1)) return null;
  const s = 1 / a.dec + 1 / b.dec, stakes = [(totalStake / a.dec) / s, (totalStake / b.dec) / s], payout = totalStake / s;
  return { width, stakes, ifOneWins: payout - totalStake, ifBothWin: 2 * payout - totalStake, sumImplied: s };
}

/**
 * Closing-line value: how the price you took compares with the no-vig fair price at the close.
 * clvPct = d_taken / d_closeFair − 1 (positive = you beat the close). probEdgePp = (1/d_closeFair − 1/d_taken)×100.
 */
function clv(takenDec, closeFairDec) {
  if (!(takenDec > 1) || !(closeFairDec > 1)) return null;
  return { clvPct: (takenDec / closeFairDec - 1) * 100, probEdgePp: (1 / closeFairDec - 1 / takenDec) * 100 };
}

const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

module.exports = { americanToDecimal, decimalToAmerican, implied, noVig, ev, kelly, arb, middle, clv, median };
