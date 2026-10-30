'use strict';
// H4 sandwich / back-run math: exact V2 integer math vs a brute-force search, V3 virtual reserves, back-run, net.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../server/mev/sim');

const E18 = 10n ** 18n, E6 = 10n ** 6n;
test('amountOut matches the Uniswap V2 formula (0.3% fee) and rounds down', () => {
  const out = S.amountOut(1000n * E6, 3000000n * E6, 1000n * E18);
  const ref = (1000n * E6 * 997n * 1000n * E18) / (3000000n * E6 * 1000n + 1000n * E6 * 997n);
  assert.equal(out, ref);
});
test('v2SandwichOpt: optimum matches a brute-force grid and respects the victim minOut', () => {
  const rIn = 3000000n * E6, rOut = 1000n * E18, victimIn = 100000n * E6;
  const quoted = S.amountOut(victimIn, rIn, rOut), minOut = quoted * 99n / 100n; // 1% slippage
  const r = S.v2SandwichOpt({ rIn, rOut, victimIn, minOut });
  assert.equal(r.feasible, true); assert.ok(Math.abs(r.slipTol - 0.01) < 1e-4);
  assert.ok(r.victimOut >= minOut, 'victim must still clear minOut');
  // brute force on a 2k-step grid in [0, xMax]
  let best = -1n; for (let i = 0n; i <= 2000n; i++) { const x = r.xMax * i / 2000n; const y = S.amountOut(x, rIn, rOut); const v = S.amountOut(victimIn, rIn + x, rOut - y); if (v < minOut) continue; const z = S.amountOut(y, rOut - y - v, rIn + x + victimIn); if (z - x > best) best = z - x; }
  assert.ok(r.gross >= best, `opt ${r.gross} ≥ grid ${best}`);
  assert.ok(Number(r.gross - best) / Number(best) < 0.001);
  const usd = Number(r.gross) / 1e6; assert.ok(usd > 800 && usd < 1100, `gross ≈ $935, got ${usd}`);
});
test('v2SandwichOpt: zero slippage → nothing to take; impossible minOut → infeasible', () => {
  const rIn = 3000000n * E6, rOut = 1000n * E18, victimIn = 100000n * E6, q = S.amountOut(victimIn, rIn, rOut);
  assert.equal(S.v2SandwichOpt({ rIn, rOut, victimIn, minOut: q }).feasible, false);
  assert.equal(S.v2SandwichOpt({ rIn, rOut, victimIn, minOut: q + 1n }).feasible, false);
});
test('v3VirtualReserves reproduce the pool price (sqrtP² = y/x) and single-tick approx flags big moves', () => {
  const sqrtP = 2n ** 96n * 2n; // price 4 token1 per token0
  const L = 10n ** 24n; const { rIn, rOut } = S.v3VirtualReserves({ sqrtPriceX96: sqrtP, liquidity: L, zeroForOne: true });
  assert.ok(Math.abs(Number(rOut) / Number(rIn) - 4) < 1e-9);
  const small = S.v3SingleTickApprox({ sqrtPriceX96: sqrtP, liquidity: L, zeroForOne: true, victimIn: rIn / 10000n, minOut: 0n, feePpm: 500n });
  const big = S.v3SingleTickApprox({ sqrtPriceX96: sqrtP, liquidity: L, zeroForOne: true, victimIn: rIn / 20n, minOut: 0n, feePpm: 500n });
  assert.equal(small.likelyCrossesTicks, false); assert.equal(big.likelyCrossesTicks, true);
});
test('backrunToRef: profit only when the pool is off the reference by more than the fee, both directions', () => {
  const rA = 1000n * E18, rB = 3000000n * E6; // pool 3000 USDC/WETH
  const ref = (p) => p * 1e6 / 1e18;
  assert.equal(S.backrunToRef({ rA, rB, refRaw: ref(3001) }).gross, 0n); // inside the 0.3% fee band
  const up = S.backrunToRef({ rA, rB, refRaw: ref(3100) }), dn = S.backrunToRef({ rA, rB, refRaw: ref(2900) });
  assert.ok(up.gross > 0n && dn.gross > 0n); assert.notEqual(up.dir, dn.dir);
});
test('netUsd: ceiling keeps all gross, realistic pays the bid share; negative gross only costs gas', () => {
  const n = S.netUsd({ grossUsd: 1000, gasUsd: 20, bidShare: 0.9 }); assert.equal(n.ceil, 980); assert.ok(Math.abs(n.real - 80) < 1e-9);
  assert.deepEqual(S.netUsd({ grossUsd: 0, gasUsd: 5, bidShare: 0.9 }), { ceil: -5, real: -5 });
});
