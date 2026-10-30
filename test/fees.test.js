'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../server/lib/fees');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('fee is notional * rate and rejects negatives', () => {
  close(F.fee(10000, 0.0005), 5);
  assert.throws(() => F.fee(-1, 0.001), RangeError);
});

test('slippage: half spread + sqrt impact, clamped', () => {
  close(F.slippageBps({ halfSpreadBps: 1, notional: 10000, depthUsd: 1e6 }), 1 + Math.sqrt(0.01) * 100);
  assert.equal(F.slippageBps({ halfSpreadBps: 0, notional: 0, depthUsd: 1e6 }), 0.5); // min floor
  assert.equal(F.slippageBps({ halfSpreadBps: 500, notional: 1, depthUsd: 1e9 }), 200); // max cap
});

test('applySlippage moves price against the taker', () => {
  close(F.applySlippage(100, 'buy', 10), 100.1);
  close(F.applySlippage(100, 'sell', 10), 99.9);
  assert.throws(() => F.applySlippage(100, 'hold', 1));
});

test('hourly normalization across 1h/4h/8h intervals', () => {
  close(F.hourlyRate(0.0008, 8), 0.0001);
  close(F.hourlyRate(0.0004, 4), 0.0001);
  close(F.annualizedPct(0.0001), 87.6);
  assert.throws(() => F.hourlyRate(0.001, 0));
});

test('funding payment sign: positive rate -> long pays, short receives', () => {
  close(F.fundingPayment({ side: 'short', notional: 10000, rate: 0.0001 }), 1);
  close(F.fundingPayment({ side: 'long', notional: 10000, rate: 0.0001 }), -1);
  close(F.fundingPayment({ side: 'long', notional: 10000, rate: -0.0002 }), 2);
});

test('funding arb edge charges 4 taker fills, 4 slippage fills and basis buffer', () => {
  const e = F.fundingArbEdge({ shortHourly: 0.0001, longHourly: 0, holdHours: 24, notional: 10000, shortFee: 0.0005, longFee: 0.0005, shortSlipBps: 1, longSlipBps: 1, basisBufferBps: 2 });
  close(e.grossFunding, 24);        // 1bp/h * 24h * 10k
  close(e.fees, 20);                // 2*5 + 2*5
  close(e.slippage, 4);             // 2 * 10k * 2bps
  close(e.basisBuffer, 2);
  close(e.net, -2);
  close(e.netBps, -2);
});

test('a tiny funding spread is not profitable after costs', () => {
  const e = F.fundingArbEdge({ shortHourly: 0.00001, longHourly: 0.000005, holdHours: 24, notional: 5000, shortFee: 0.00055, longFee: 0.00045, shortSlipBps: 0.5, longSlipBps: 0.5 });
  assert.ok(e.net < 0);
});

test('1% net target: gross move and round-trip net are inverses', () => {
  const ratio = F.grossMoveForNet({ netTarget: 0.01, feeRate: 0.001, slipBps: 2 });
  assert.ok(ratio > 1.012 && ratio < 1.013, String(ratio));
  close(F.longRoundTripNet({ entry: 100, exit: 100 * ratio, feeRate: 0.001, slipBps: 2 }), 0.01, 1e-12);
  assert.ok(F.longRoundTripNet({ entry: 100, exit: 100, feeRate: 0.001, slipBps: 2 }) < 0, 'flat exit loses fees');
});

test('solana and evm tx costs', () => {
  close(F.solanaTxCostSol({ signatures: 1, computeUnits: 200000, microLamportsPerCU: 10000, tipLamports: 0 }), (5000 + 2000) / 1e9);
  close(F.solanaTxCostSol({ signatures: 2, computeUnits: 0, microLamportsPerCU: 0, tipLamports: 100000 }), 110000 / 1e9);
  close(F.evmTxCostNative({ gasUnits: 300000, gasPriceWei: 2e9 }), 0.0006);
});

test('atomic arb EV: failed plain tx still pays gas; failed bundle does not', () => {
  close(F.atomicArbEV({ grossUsd: 10, execCostUsd: 1, tipUsd: 1, pSuccess: 0.5, mode: 'tx' }), 0.5 * 8 - 0.5 * 1);
  close(F.atomicArbEV({ grossUsd: 10, execCostUsd: 1, tipUsd: 1, pSuccess: 0.5, mode: 'bundle' }), 4);
  assert.ok(F.atomicArbEV({ grossUsd: 1, execCostUsd: 2, pSuccess: 1 }) < 0);
  assert.throws(() => F.atomicArbEV({ grossUsd: 1, execCostUsd: 0, pSuccess: 1.5 }));
});

test('futures round trip includes slippage ticks and per-side fees', () => {
  const r = F.futuresRoundTrip({ side: 'long', entry: 5000, exit: 5004, contracts: 1, pointValue: 5, tickSize: 0.25, slipTicks: 1, feePerSide: 0.62 });
  close(r.gross, 20); close(r.slippage, 2.5); close(r.fees, 1.24); close(r.net, 16.26);
  const s = F.futuresRoundTrip({ side: 'short', entry: 20000, exit: 20010, contracts: 2, pointValue: 2, tickSize: 0.25, slipTicks: 1, feePerSide: 0.5 });
  close(s.net, -40 - 2 - 2);
});
