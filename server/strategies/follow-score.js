'use strict';
// Wallet-follow v2 scoreboard (batch-1 H3 paper-test plan). Pure functions over closed follow records.
// Each record: {wallet, chain, asset, side, netPct, randomPct, holdPct, cf: {0, d, 60}, delaySec, chasePct, why, t}
// Returns are % of notional, NET of 2× taker + slippage. Controls are SIM-booked and labeled; they are the baseline, never the result.
const { bootstrapCI } = require('../betting/clv');

const PLAN = Object.freeze({ minSignals: 100, passEdgeVsRandomPct: 0.3, failAfter: 200, delayFailSec: 60 });
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const nums = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x));

function verdict(m) {
  if (m.n < PLAN.minSignals) return { status: 'collecting', text: `${m.n}/${PLAN.minSignals} closed follows; no verdict before ${PLAN.minSignals}` };
  if (m.mean60 != null && m.mean60 <= 0 && m.mean > 0) return { status: 'fail', text: `edge gone at a ${PLAN.delayFailSec} s delay (mean ${m.mean60.toFixed(2)}%): not capturable` };
  if (m.mean > 0 && m.ci && m.ci[0] > 0 && m.edgeVsRandom != null && m.edgeVsRandom >= PLAN.passEdgeVsRandomPct) return { status: 'pass', text: `mean ${m.mean.toFixed(2)}% > 0, CI > 0, beats random by ${m.edgeVsRandom.toFixed(2)}%/trade` };
  if (m.n >= PLAN.failAfter && (!m.ci || m.ci[0] <= 0)) return { status: 'fail', text: `CI includes 0 after ${m.n} follows` };
  return { status: 'inconclusive', text: 'pass criteria not met yet; keep collecting' };
}

function metrics(recs) {
  const xs = nums(recs.map((r) => r.netPct)), n = xs.length, m = mean(xs);
  const rnd = nums(recs.map((r) => r.randomPct)), hold = nums(recs.map((r) => r.holdPct));
  const cf = (k) => mean(nums(recs.map((r) => r.cf && r.cf[k])));
  const out = { n, mean: m, ci: bootstrapCI(xs), hitPct: n ? (xs.filter((x) => x > 0).length / n) * 100 : null,
    meanRandom: mean(rnd), meanHold: mean(hold), edgeVsRandom: m != null && rnd.length ? m - mean(rnd) : null,
    mean0: cf('0'), meanDelay: cf('d'), mean60: cf('60'), meanChase: mean(nums(recs.map((r) => r.chasePct))) };
  out.verdict = verdict(out); return out;
}

/** Overall + per-wallet scoreboard. Only REAL-data follows count; mock-signal follows are reported apart. */
function summarize(records) {
  const real = records.filter((r) => !r.mock), mock = records.filter((r) => r.mock);
  const by = new Map(); for (const r of real) { const k = r.chain + '|' + r.wallet; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const wallets = [...by.entries()].map(([k, rs]) => ({ chain: rs[0].chain, wallet: rs[0].wallet, label: rs[0].label || null, ...metrics(rs) })).sort((a, b) => b.n - a.n);
  return { plan: PLAN, overall: metrics(real), wallets, mockCount: mock.length };
}
module.exports = { summarize, metrics, verdict, PLAN };
