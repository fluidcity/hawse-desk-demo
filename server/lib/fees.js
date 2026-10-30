'use strict';
// Pure fee / slippage / cost math. No I/O. Covered by test/fees.test.js.
// Conventions: rates are fractions (0.0005 = 0.05% = 5 bps); bps are basis points.

const BPS = 1e4;

/**
 * Venue taker fees (base / VIP0 tier, fraction of notional). Re-verified against the venues' public fee pages on
 * FEES_VERIFIED. Re-check before any paper test that depends on them (H2) and update the date + table together.
 *   Hyperliquid  https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees        perps 0.045%, spot 0.070%
 *   Bybit        https://www.bybit.com/en/help-center/article/Trading-Fee-Structure perps 0.055%, spot 0.100%
 *   Binance      https://www.binance.com/en/fee/futureFee  /fee/schedule             USD-M 0.050%, spot 0.100%
 *   OKX          https://www.okx.com/fees                                            swaps 0.050%, spot 0.100%
 */
const FEES_VERIFIED = '2026-10-29';
const FEE_SOURCES = Object.freeze({
  hyperliquid: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees',
  bybit: 'https://www.bybit.com/en/help-center/article/Trading-Fee-Structure',
  binance: 'https://www.binance.com/en/fee/futureFee',
  okx: 'https://www.okx.com/fees',
});
const TAKER_FEES = Object.freeze({
  binance: 0.0005,     // USD-M futures base taker 0.050%
  bybit: 0.00055,      // linear perps base taker 0.055%
  okx: 0.0005,         // perps base taker 0.050%
  hyperliquid: 0.00045,// base taker 0.045%
  spot: 0.001,         // generic CEX spot taker 0.10%
});
/** Spot taker fees per venue (base tier), used by carry mode (spot long + perp short on the same venue). */
const SPOT_TAKER_FEES = Object.freeze({ binance: 0.001, bybit: 0.001, okx: 0.001, hyperliquid: 0.0007 });

function fee(notional, rate) {
  if (!(notional >= 0) || !(rate >= 0)) throw new RangeError('fee: notional and rate must be >= 0');
  return notional * rate;
}

/**
 * Slippage estimate in bps: half the quoted spread plus a square-root market-impact term.
 * impactBps = impactCoef * sqrt(notional / depthUsd) * 100, capped at maxBps.
 */
function slippageBps({ halfSpreadBps = 0, notional = 0, depthUsd = Infinity, impactCoef = 1, minBps = 0.5, maxBps = 200 } = {}) {
  if (notional < 0 || halfSpreadBps < 0) throw new RangeError('slippageBps: negative input');
  const impact = depthUsd > 0 && isFinite(depthUsd) ? impactCoef * Math.sqrt(notional / depthUsd) * 100 : 0;
  return Math.min(maxBps, Math.max(minBps, halfSpreadBps + impact));
}

/** Price after slippage: buys fill higher, sells fill lower. */
function applySlippage(price, side, bps) {
  if (!(price > 0)) throw new RangeError('applySlippage: price must be > 0');
  const s = bps / BPS;
  if (side === 'buy' || side === 'long') return price * (1 + s);
  if (side === 'sell' || side === 'short') return price * (1 - s);
  throw new RangeError('applySlippage: bad side ' + side);
}

/** Funding rate per hour from a rate quoted per interval. */
function hourlyRate(rate, intervalHours) {
  if (!(intervalHours > 0)) throw new RangeError('hourlyRate: intervalHours must be > 0');
  return rate / intervalHours;
}
const annualizedPct = (hourly) => hourly * 24 * 365 * 100;

/** Funding cashflow for one settlement. Positive rate: longs pay shorts. Returns signed USD to the position holder. */
function fundingPayment({ side, notional, rate }) {
  if (side === 'short') return notional * rate;
  if (side === 'long') return -notional * rate;
  throw new RangeError('fundingPayment: bad side');
}

/**
 * Expected net edge of a delta-neutral funding pair held for holdHours, assuming
 * current hourly rates persist (they usually do not; this is an estimate).
 * Costs: open+close taker fee on both legs, slippage on all 4 fills, plus a basis buffer.
 */
function fundingArbEdge({ shortHourly, longHourly, holdHours, notional, shortFee, longFee, shortSlipBps, longSlipBps, basisBufferBps = 0 }) {
  const grossFunding = (shortHourly - longHourly) * holdHours * notional;
  const fees = 2 * notional * shortFee + 2 * notional * longFee;
  const slippage = 2 * notional * (shortSlipBps + longSlipBps) / BPS;
  const basisBuffer = notional * basisBufferBps / BPS;
  const net = grossFunding - fees - slippage - basisBuffer;
  return { grossFunding, fees, slippage, basisBuffer, net, netBps: notional > 0 ? (net / notional) * BPS : 0 };
}

/**
 * Exit/entry price ratio needed for a long round trip to net `netTarget`
 * after taker fees (fraction, each side) and slippage (bps, each side).
 */
function grossMoveForNet({ netTarget, feeRate, slipBps }) {
  const s = slipBps / BPS, f = feeRate;
  return ((1 + netTarget) * (1 + s) * (1 + f)) / ((1 - s) * (1 - f));
}

/** Net return of a long round trip after fees and slippage. */
function longRoundTripNet({ entry, exit, feeRate, slipBps }) {
  const s = slipBps / BPS;
  const cost = entry * (1 + s) * (1 + feeRate);
  const proceeds = exit * (1 - s) * (1 - feeRate);
  return proceeds / cost - 1;
}

/** Solana transaction cost in SOL. priority = computeUnits * microLamportsPerCU / 1e6 lamports. */
function solanaTxCostSol({ signatures = 1, computeUnits = 300000, microLamportsPerCU = 50000, tipLamports = 0 }) {
  const base = 5000 * signatures;
  const priority = (computeUnits * microLamportsPerCU) / 1e6;
  return (base + priority + tipLamports) / 1e9;
}

/** EVM tx cost in native units (e.g. ETH): gasUnits * gasPriceWei (+ optional L1 data fee in wei). */
function evmTxCostNative({ gasUnits, gasPriceWei, l1FeeWei = 0 }) {
  return (gasUnits * gasPriceWei + l1FeeWei) / 1e18;
}

/**
 * Expected value of an atomic arb attempt.
 * mode 'bundle' (Jito/private): failed attempts cost nothing; fees+tip only on landing.
 * mode 'tx' (public mempool / plain tx): failed attempts still pay execution cost (reverts burn gas).
 */
function atomicArbEV({ grossUsd, execCostUsd, tipUsd = 0, pSuccess, mode = 'tx' }) {
  if (!(pSuccess >= 0 && pSuccess <= 1)) throw new RangeError('pSuccess must be in [0,1]');
  const win = pSuccess * (grossUsd - execCostUsd - tipUsd);
  const lose = mode === 'bundle' ? 0 : (1 - pSuccess) * execCostUsd;
  return win - lose;
}

/** Futures PnL in USD for a round trip incl. per-side fees and slippage in ticks. */
function futuresRoundTrip({ side, entry, exit, contracts, pointValue, tickSize, slipTicks = 1, feePerSide }) {
  const dir = side === 'long' ? 1 : side === 'short' ? -1 : NaN;
  if (isNaN(dir)) throw new RangeError('futuresRoundTrip: bad side');
  const slipPts = 2 * slipTicks * tickSize;
  const gross = dir * (exit - entry) * pointValue * contracts;
  const slippage = slipPts * pointValue * contracts;
  const fees = 2 * feePerSide * contracts;
  return { gross, slippage, fees, net: gross - slippage - fees };
}

module.exports = {
  BPS, TAKER_FEES, SPOT_TAKER_FEES, FEES_VERIFIED, FEE_SOURCES, fee, slippageBps, applySlippage, hourlyRate, annualizedPct, fundingPayment,
  fundingArbEdge, grossMoveForNet, longRoundTripNet, solanaTxCostSol, evmTxCostNative, atomicArbEV, futuresRoundTrip,
};
