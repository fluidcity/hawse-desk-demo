'use strict';
// Sandwich / back-run SIMULATION math for the mempool lab (batch-1 H4). Pure functions on numbers someone else already
// broadcast; the output is "what a searcher could have made", never an order. No signing, no bundles, no submission.
//
// V2: exact Uniswap V2 integer math (getAmountOut with a 997/1000 fee, i.e. 0.30%) on BigInt reserves.
// V3: single-tick approximation. Inside one initialized tick range a V3 pool is a constant-product pool with virtual
//     reserves x = L / √P and y = L · √P, so the V2 math is reused with the pool fee; flagged when the move is large
//     enough that it probably crosses initialized ticks (the answer is then optimistic).

const Q96 = 2n ** 96n;
/** UniswapV2Library.getAmountOut, fee given as numerator over 1e6 (V2 = 3000, V3 fee tier = pool fee). */
function amountOut(aIn, rIn, rOut, feePpm = 3000n) {
  if (aIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const f = 1_000_000n - BigInt(feePpm), aw = aIn * f;
  return (aw * rOut) / (rIn * 1_000_000n + aw);
}

/**
 * Optimal front-run size for a victim exact-in swap. Profit(x) = backOut(x) − x, in tokenIn units, before gas and
 * builder payment. Constraint: the victim must still get ≥ minOut (else their tx reverts and there is no sandwich).
 * Returns null when there is no room (victim's minOut already binds at x = 0).
 */
function v2SandwichOpt({ rIn, rOut, victimIn, minOut, feePpm = 3000n }) {
  rIn = BigInt(rIn); rOut = BigInt(rOut); victimIn = BigInt(victimIn); minOut = BigInt(minOut); feePpm = BigInt(feePpm);
  const victimOutAt = (x) => { const y = amountOut(x, rIn, rOut, feePpm); return amountOut(victimIn, rIn + x, rOut - y, feePpm); };
  const quotedOut = amountOut(victimIn, rIn, rOut, feePpm);
  if (quotedOut < minOut || victimIn <= 0n) return { feasible: false, quotedOut, reason: 'victim minOut not met even without a front-run' };
  // largest x with victimOut(x) ≥ minOut (victimOut is decreasing in x)
  let lo = 0n, hi = rIn * 4n; // beyond 4× reserves the victim never clears any sane minOut
  if (victimOutAt(hi) >= minOut) lo = hi; else { while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (victimOutAt(m) >= minOut) lo = m; else hi = m; } }
  const xMax = lo;
  const profit = (x) => {
    const y = amountOut(x, rIn, rOut, feePpm); const r1i = rIn + x, r1o = rOut - y;
    const v = amountOut(victimIn, r1i, r1o, feePpm); const r2i = r1i + victimIn, r2o = r1o - v;
    const z = amountOut(y, r2o, r2i, feePpm); return { x, y, v, z, gross: z - x };
  };
  // profit is unimodal on [0, xMax]: ternary search on integers, then compare with the boundary
  let a = 0n, b = xMax;
  for (let i = 0; i < 200 && b - a > 2n; i++) { const m1 = a + (b - a) / 3n, m2 = b - (b - a) / 3n; if (profit(m1).gross < profit(m2).gross) a = m1; else b = m2; }
  let best = profit(xMax); for (let x = a; x <= b; x++) { const p = profit(x); if (p.gross > best.gross) best = p; }
  if (best.gross <= 0n) best = profit(0n);
  return { feasible: best.x > 0n && best.gross > 0n, xMax, frontIn: best.x, frontOut: best.y, victimOut: best.v, backOut: best.z, gross: best.gross, quotedOut,
    slipTol: quotedOut > 0n ? 1 - Number(minOut * 1_000_000n / quotedOut) / 1e6 : null };
}

/** Virtual reserves for a V3 pool from slot0.sqrtPriceX96 and in-range liquidity L; zeroForOne = victim sells token0. */
function v3VirtualReserves({ sqrtPriceX96, liquidity, zeroForOne }) {
  const s = BigInt(sqrtPriceX96), L = BigInt(liquidity);
  const x = (L * Q96) / s, y = (L * s) / Q96; // token0, token1 virtual reserves
  return zeroForOne ? { rIn: x, rOut: y } : { rIn: y, rOut: x };
}
function v3SingleTickApprox({ sqrtPriceX96, liquidity, zeroForOne, victimIn, minOut, feePpm }) {
  const { rIn, rOut } = v3VirtualReserves({ sqrtPriceX96, liquidity, zeroForOne });
  const r = v2SandwichOpt({ rIn, rOut, victimIn, minOut, feePpm });
  // price impact of front-run + victim on the virtual curve; > 1% probably crosses initialized ticks in busy pools
  const moved = r.feasible ? Number(((rIn + r.frontIn + BigInt(victimIn)) * 10000n) / rIn) / 10000 - 1 : Number(((rIn + BigInt(victimIn)) * 10000n) / rIn) / 10000 - 1;
  return { ...r, approx: 'v3-single-tick', likelyCrossesTicks: moved > 0.01, inputMovePct: moved * 100 };
}

/**
 * Back-run to a reference price after the victim's swap moved the pool. Pool holds (rA, rB); ref = external price of
 * A in units of B (e.g. a Binance ETH mid in USDC when A = WETH, B = USDC; decimals already applied by the caller as
 * a raw-unit ratio refRaw = B_raw per A_raw). Tries both directions and returns the best gross in units of B.
 */
function backrunToRef({ rA, rB, refRaw, feePpm = 3000n }) {
  rA = BigInt(rA); rB = BigInt(rB); feePpm = BigInt(feePpm); if (!(refRaw > 0)) return { gross: 0, dir: null };
  const SCALE = 1_000_000_000_000n, refS = BigInt(Math.round(refRaw * 1e12)); // ref as fixed point
  // buy A from the pool with B, sell A at ref: profit_B(b) = out_A(b)·ref − b
  const pBuyA = (b) => (amountOut(b, rB, rA, feePpm) * refS) / SCALE - b;
  // buy A at ref, sell into pool for B: profit_B(a) = out_B(a) − a·ref
  const pSellA = (a) => amountOut(a, rA, rB, feePpm) - (a * refS) / SCALE;
  const tern = (f, hi) => { let a = 0n, b = hi; for (let i = 0; i < 200 && b - a > 2n; i++) { const m1 = a + (b - a) / 3n, m2 = b - (b - a) / 3n; if (f(m1) < f(m2)) a = m1; else b = m2; } let best = 0n, arg = 0n; for (let x = a; x <= b; x++) { const v = f(x); if (v > best) { best = v; arg = x; } } return { best, arg }; };
  const b1 = tern(pBuyA, rB), a1 = tern(pSellA, rA);
  return b1.best >= a1.best ? { gross: b1.best, dir: 'buyA', size: b1.arg } : { gross: a1.best, dir: 'sellA', size: a1.arg };
}

/** Ceiling (bid share 0) and realistic (builder gets bidShare of gross) net, in USD. */
function netUsd({ grossUsd, gasUsd, bidShare }) {
  if (!(grossUsd > 0)) return { ceil: -gasUsd, real: -gasUsd };
  return { ceil: grossUsd - gasUsd, real: grossUsd * (1 - bidShare) - gasUsd };
}
module.exports = { amountOut, v2SandwichOpt, v3VirtualReserves, v3SingleTickApprox, backrunToRef, netUsd, Q96 };
