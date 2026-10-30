'use strict';
// Strategy 2: whale-flow follower. Watches large on-chain swaps/transfers (Solana via Helius, EVM via RPC)
// and, when directional whale flow over a 15-minute window is strong and one-sided, takes a small paper
// position on the corresponding perp (real Hyperliquid/OKX quotes). Mock-sourced signals book to the SIM book.
const { Strategy } = require('./base');
const F = require('../lib/fees');
const { openPos, managePos } = require('./directional');

const X = require('../lib/explain');

// Fixed rules, read by the logic AND by explain() so the explainer cannot drift.
const RULES = Object.freeze({ windowMin: 15, signalX: 2, minSwaps: 3, minOneSided: 0.6, cooldownMin: 30, evalMs: 10000, sizePct: 0.5, tp: 0.012, sl: 0.006, maxHoldMin: 90 });
const WINDOW = RULES.windowMin * 60e3;
class WhaleFollow extends Strategy {
  constructor(engine, feeds) {
    super(engine, { id: 'whale', name: 'Whale Flow', desc: 'Large-tx monitor (Solana · Ethereum · Base · Arbitrum) → follows one-sided whale swap flow', allocPct: 0.08, chains: ['Solana', 'Ethereum', 'Base', 'Arbitrum'] });
    this.feeds = feeds; this.minUsd = engine.cfg.helius.minUsd; this.signalUsd = this.minUsd * RULES.signalX; this.rules = RULES; this.cool = {};
  }
  dataMode() { const m = new Set(this.feeds.map((f) => f.mode)); return m.size > 1 ? 'mixed' : [...m][0]; }
  groups() {
    const now = Date.now();
    const g = { SOL: { chain: 'solana', feeds: this.feeds.filter((f) => !f.chain) }, ETH: { chain: 'evm (eth+base+arb)', feeds: this.feeds.filter((f) => f.chain) } };
    return Object.entries(g).map(([asset, x]) => {
      const evs = x.feeds.flatMap((f) => f.events).filter((e) => now - e.t <= WINDOW && e.dir !== 'transfer');
      const buy = evs.filter((e) => e.dir === 'buy').reduce((a, e) => a + e.usd, 0), sell = evs.filter((e) => e.dir === 'sell').reduce((a, e) => a + e.usd, 0);
      return { asset, chain: x.chain, window: RULES.windowMin + 'm', netUsd: buy - sell, grossUsd: buy + sell, count: evs.length, mock: evs.some((e) => e.mock) || x.feeds.some((f) => f.mode === 'mock') };
    });
  }
  tick(now) {
    managePos(this, (sym) => this.e.price(sym), now);
    if (now - this.lastEval < RULES.evalMs) return; this.lastEval = now;
    this.net = this.groups();
    if (!this.armed) return;
    for (const n of this.net) {
      if (this.positions.some((p) => p.symbol === n.asset)) continue;
      if (this.cool[n.asset] && now - this.cool[n.asset] < RULES.cooldownMin * 60e3) continue;
      const dom = n.grossUsd ? Math.abs(n.netUsd) / n.grossUsd : 0;
      if (Math.abs(n.netUsd) < this.signalUsd || n.count < RULES.minSwaps || dom < RULES.minOneSided) { this.skip(`${n.asset}: whale flow not decisive`, `net $${(n.netUsd / 1e3).toFixed(0)}k · ${n.count} swaps · ${(dom * 100).toFixed(0)}% one-sided (need ≥$${(this.signalUsd / 1e3).toFixed(0)}k, ≥3, ≥60%)`); continue; }
      const q = this.e.quote(n.asset); if (!q) { this.skip(`${n.asset}: no fresh perp quote`); continue; }
      const simulated = n.mock;
      const g = this.gate(simulated); if (!g.ok) { this.skip('risk gate: ' + g.reason); continue; }
      const notional = this.sleeve(simulated) * RULES.sizePct;
      const slipBps = F.slippageBps({ halfSpreadBps: q.halfSpreadBps, notional, depthUsd: q.dayNtlVlm ? q.dayNtlVlm * 0.0005 : 1e6 });
      openPos(this, { symbol: n.asset, side: n.netUsd > 0 ? 'long' : 'short', notional, quote: q, feeRate: F.TAKER_FEES[q.venue] || 0.0005, slipBps,
        tp: RULES.tp, sl: RULES.sl, maxHoldMs: RULES.maxHoldMin * 60e3, simulated, reason: `${n.chain} whale net ${n.netUsd > 0 ? '+' : '-'}$${(Math.abs(n.netUsd) / 1e6).toFixed(2)}M${simulated ? ' (MOCK signal → sim book)' : ''}`, now });
      this.cool[n.asset] = now;
    }
  }
  view() {
    const modes = {}; for (const f of this.feeds) modes[f.chain || 'solana'] = f.mode;
    const flows = this.feeds.flatMap((f) => f.events).sort((a, b) => b.t - a.t).slice(0, 60);
    return { modes, net: this.net || this.groups(), flows, minUsd: this.minUsd, signalUsd: this.signalUsd, sources: this.feeds.map((f) => f.snapshot()) };
  }
  explain() {
    const r = RULES;
    return X.explanation(`Watches large on-chain swaps by "whales" on Solana and on Ethereum, Base and Arbitrum. When the big money over the last
      ${r.windowMin} minutes is clearly flowing one way, it takes a small paper position on that asset's perpetual future in the same
      direction, with a tight stop, a modest target and a short time limit.`, {
      Markets: ['Signals: Solana swaps (Helius enhanced webhook → HAWSE inbox, polled every 15–60 s; off unless WHALES_ENABLED=true) and Ethereum/Base/Arbitrum swaps (public RPC)', 'Trades: SOL perp for Solana flow, ETH perp for EVM flow, priced from real perp quotes'],
      Signal: [`Counts swaps ≥ ${X.usd(this.minUsd)} (plain transfers are ignored) over a rolling ${r.windowMin}-min window, per asset`,
        `Net whale flow ≥ ${X.usd(this.signalUsd)} (${r.signalX}× the swap threshold)`, `At least ${r.minSwaps} swaps, and ≥ ${X.pct(r.minOneSided * 100, 0)} of the gross flow on one side`,
        `Checked every ${X.num(r.evalMs / 1000, 0)} s`],
      Entry: ['Long on net whale buying, short on net selling', `Size: ${X.pct(r.sizePct * 100, 0)} of the sleeve`, 'Needs a fresh perp quote; one position per asset',
        `${r.cooldownMin}-min cooldown per asset after an entry`],
      Exit: [`Take profit +${X.pct(r.tp * 100, 1)}`, `Stop loss −${X.pct(r.sl * 100, 1)}`, `Time stop after ${r.maxHoldMin} min`],
      Risk: X.deskRisk(this),
      Data: [X.feesLine(), 'Chains without a key/RPC (or Solana with the inbox not configured) run on MOCK whale events; trades from MOCK signals go to the SIMULATED book, never the real one',
        'Solana deliveries older than 10 min (inbox backlog after downtime) are shown but never trigger entries; offline > 24 h is flagged as a data gap'] });
  }
}
module.exports = { WhaleFollow };
