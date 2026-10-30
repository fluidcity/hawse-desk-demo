'use strict';
// Strategy 2: whale-flow follower. Watches large on-chain swaps/transfers (Solana via Helius, EVM via RPC)
// and, when directional whale flow over a 15-minute window is strong and one-sided, takes a small paper
// position on the corresponding perp (real Hyperliquid/OKX quotes). Mock-sourced signals book to the SIM book.
const { Strategy } = require('./base');
const F = require('../lib/fees');
const { openPos, managePos } = require('./directional');

const WINDOW = 15 * 60e3;
class WhaleFollow extends Strategy {
  constructor(engine, feeds) {
    super(engine, { id: 'whale', name: 'Whale Flow', desc: 'Large-tx monitor (Solana · Ethereum · Base · Arbitrum) → follows one-sided whale swap flow', allocPct: 0.15, chains: ['Solana', 'Ethereum', 'Base', 'Arbitrum'] });
    this.feeds = feeds; this.minUsd = engine.cfg.helius.minUsd; this.signalUsd = this.minUsd * 2; this.cool = {};
  }
  dataMode() { const m = new Set(this.feeds.map((f) => f.mode)); return m.size > 1 ? 'mixed' : [...m][0]; }
  groups() {
    const now = Date.now();
    const g = { SOL: { chain: 'solana', feeds: this.feeds.filter((f) => !f.chain) }, ETH: { chain: 'evm (eth+base+arb)', feeds: this.feeds.filter((f) => f.chain) } };
    return Object.entries(g).map(([asset, x]) => {
      const evs = x.feeds.flatMap((f) => f.events).filter((e) => now - e.t <= WINDOW && e.dir !== 'transfer');
      const buy = evs.filter((e) => e.dir === 'buy').reduce((a, e) => a + e.usd, 0), sell = evs.filter((e) => e.dir === 'sell').reduce((a, e) => a + e.usd, 0);
      return { asset, chain: x.chain, window: '15m', netUsd: buy - sell, grossUsd: buy + sell, count: evs.length, mock: evs.some((e) => e.mock) || x.feeds.some((f) => f.mode === 'mock') };
    });
  }
  tick(now) {
    managePos(this, (sym) => this.e.price(sym), now);
    if (now - this.lastEval < 10000) return; this.lastEval = now;
    this.net = this.groups();
    if (!this.armed) return;
    for (const n of this.net) {
      if (this.positions.some((p) => p.symbol === n.asset)) continue;
      if (this.cool[n.asset] && now - this.cool[n.asset] < 30 * 60e3) continue;
      const dom = n.grossUsd ? Math.abs(n.netUsd) / n.grossUsd : 0;
      if (Math.abs(n.netUsd) < this.signalUsd || n.count < 3 || dom < 0.6) { this.skip(`${n.asset}: whale flow not decisive`, `net $${(n.netUsd / 1e3).toFixed(0)}k · ${n.count} swaps · ${(dom * 100).toFixed(0)}% one-sided (need ≥$${(this.signalUsd / 1e3).toFixed(0)}k, ≥3, ≥60%)`); continue; }
      const q = this.e.quote(n.asset); if (!q) { this.skip(`${n.asset}: no fresh perp quote`); continue; }
      const simulated = n.mock;
      const g = this.gate(simulated); if (!g.ok) { this.skip('risk gate: ' + g.reason); continue; }
      const notional = this.sleeve(simulated) * 0.5;
      const slipBps = F.slippageBps({ halfSpreadBps: q.halfSpreadBps, notional, depthUsd: q.dayNtlVlm ? q.dayNtlVlm * 0.0005 : 1e6 });
      openPos(this, { symbol: n.asset, side: n.netUsd > 0 ? 'long' : 'short', notional, quote: q, feeRate: F.TAKER_FEES[q.venue] || 0.0005, slipBps,
        tp: 0.012, sl: 0.006, maxHoldMs: 90 * 60e3, simulated, reason: `${n.chain} whale net ${n.netUsd > 0 ? '+' : '-'}$${(Math.abs(n.netUsd) / 1e6).toFixed(2)}M${simulated ? ' (MOCK signal → sim book)' : ''}`, now });
      this.cool[n.asset] = now;
    }
  }
  view() {
    const modes = {}; for (const f of this.feeds) modes[f.chain || 'solana'] = f.mode;
    const flows = this.feeds.flatMap((f) => f.events).sort((a, b) => b.t - a.t).slice(0, 60);
    return { modes, net: this.net || this.groups(), flows, minUsd: this.minUsd, signalUsd: this.signalUsd, sources: this.feeds.map((f) => f.snapshot()) };
  }
}
module.exports = { WhaleFollow };
