'use strict';
// Strategy 4: cross-DEX / triangular gap scanner. Real quotes, honest costs:
//  - Solana: base fee + priority fee (CU × µlamports) always paid; Jito-style tip paid only when the bundle lands.
//  - EVM: gas = gasUnits × eth_gasPrice per swap (L2 L1-data fee not included → flagged); assumed pool fee per leg on mid-price gaps.
//  - Failure: EV = p·(gross − exec − tip) − (1−p)·exec  (public-tx model: reverted/failed attempts still burn fees).
// Only rows built from EXECUTABLE quotes (Jupiter amounts, ParaSwap amounts) can be traded; mid-price rows are indicative only.
// A paper attempt requires the edge to persist across two consecutive scans; the landing outcome is modeled with pSuccess.
const { Strategy } = require('./base');
const F = require('../lib/fees');

function evaluate({ label, grossUsd, execCostUsd, tipUsd = 0, pSuccess, notional, exec, note, minEvUsd }) {
  const evUsd = F.atomicArbEV({ grossUsd, execCostUsd, tipUsd, pSuccess, mode: 'tx' });
  return { label, grossBps: (grossUsd / notional) * 1e4, grossUsd, costUsd: execCostUsd + tipUsd, execCostUsd, tipUsd, evUsd, exec, ok: exec && evUsd > minEvUsd, note };
}

class GapScanner extends Strategy {
  constructor(engine, feed, { rng = Math.random } = {}) {
    super(engine, { id: 'gaps', name: 'DEX Gap Scanner', desc: 'Cross-DEX + triangular gaps · Solana (Jupiter) · Ethereum · Base · Arbitrum · after gas, tips & failure risk', allocPct: 0.1, chains: ['Solana', 'Ethereum', 'Base', 'Arbitrum'] });
    this.feed = feed; this.c = engine.cfg.gaps; this.rng = rng; this.best = []; this.prev = new Set(); this.cool = {};
  }
  dataMode() {
    const s = this.feed.sol; if (s && s.mode === 'live') return 'live';
    return Object.keys(this.feed.evm).length || (s && s.mode === 'indicative') ? 'indicative' : 'down';
  }
  scan() {
    const c = this.c, out = [], N = c.notionalUsd, p = c.pSuccess;
    const s = this.feed.sol, solPx = this.e.price('SOL') || (s && s.solPx);
    if (s && s.bps && solPx) {
      const exec = s.mode === 'live';
      const ex2 = F.solanaTxCostSol({ computeUnits: 400000, microLamportsPerCU: c.solPriorityMicroLamports }) * solPx, tip = c.solTipLamports / 1e9 * solPx;
      s.bps.forEach((row, i) => row.forEach((b, j) => { if (i !== j && b != null) out.push(evaluate({ label: `SOL buy ${s.labels[i]} → sell ${s.labels[j]}`, grossUsd: (b / 1e4) * N - (exec ? 0 : 2 * N * c.evmPoolFeeBps / 1e4), execCostUsd: ex2, tipUsd: tip, pSuccess: p, notional: N, exec, minEvUsd: c.minEvUsd, note: exec ? 'Jupiter executable quotes' : 'indicative mids − assumed pool fees' })); }));
      if (s.tri) out.push(evaluate({ label: `Triangular ${s.tri.label}`, grossUsd: s.tri.grossUsd, execCostUsd: F.solanaTxCostSol({ computeUnits: 600000, microLamportsPerCU: c.solPriorityMicroLamports }) * solPx, tipUsd: tip, pSuccess: p, notional: N, exec: true, minEvUsd: c.minEvUsd, note: s.tri.route }));
    }
    const ethPx = this.e.price('ETH');
    for (const ch of this.feed.chains) {
      const g = this.feed.gas[ch], e = this.feed.evm[ch], pa = this.feed.para[ch];
      const swapGasUsd = g && ethPx ? F.evmTxCostNative({ gasUnits: c.evmGasUnits, gasPriceWei: g.wei }) * ethPx : null;
      const l2 = ch !== 'ethereum' ? ' · excl. L1 data fee' : '';
      if (e && swapGasUsd != null) e.bps.forEach((row, i) => row.forEach((b, j) => { if (i !== j && b != null && b > -50) out.push(evaluate({ label: `${ch} WETH buy ${e.labels[i]} → sell ${e.labels[j]}`, grossUsd: (b / 1e4) * N - 2 * N * c.evmPoolFeeBps / 1e4, execCostUsd: 2 * swapGasUsd, pSuccess: p, notional: N, exec: false, minEvUsd: c.minEvUsd, note: `mid gap − ${c.evmPoolFeeBps}bp/leg assumed pool fee · gas ${(g.wei / 1e9).toFixed(3)} gwei${l2} · indicative` })); }));
      if (pa) out.push(evaluate({ label: `${ch} ParaSwap round trip ${pa.stable}→WETH→${pa.stable}`, grossUsd: pa.grossUsd, execCostUsd: swapGasUsd != null ? 2 * swapGasUsd : pa.gasUsd, pSuccess: p, notional: N, exec: true, minEvUsd: c.minEvUsd, note: pa.route + l2 }));
    }
    return out.sort((a, b) => b.evUsd - a.evUsd);
  }
  tick(now) {
    if (now - this.lastEval < 5000) return; this.lastEval = now;
    this.best = this.scan();
    const okNow = new Set(this.best.filter((b) => b.ok).map((b) => b.label));
    const persisted = this.best.filter((b) => b.ok && this.prev.has(b.label)); this.prev = okNow;
    if (!this.armed) return;
    if (!this.best.length) return this.skip('no DEX quotes yet');
    if (!persisted.length) { const t = this.best.find((b) => b.exec) || this.best[0]; return this.skip('no executable gap after costs', `best ${t.label}: gross ${t.grossBps.toFixed(1)}bp, cost $${t.costUsd.toFixed(2)}, EV ${t.evUsd.toFixed(2)}${okNow.size ? ' (needs to persist 2 scans)' : ''}`); }
    const o = persisted[0];
    if (this.cool[o.label] && now - this.cool[o.label] < 60000) return;
    const g = this.gate(false); if (!g.ok) return this.skip('risk gate: ' + g.reason);
    this.cool[o.label] = now;
    const landed = this.rng() < this.c.pSuccess; // modeled landing; never assumed
    const pnl = landed ? o.grossUsd - o.execCostUsd - o.tipUsd : -o.execCostUsd;
    const rec = this.e.ledger.close(this.id, { pnl, fees: landed ? o.execCostUsd + o.tipUsd : o.execCostUsd, simulated: false, meta: { symbol: o.label, why: landed ? 'landed (modeled)' : 'failed (modeled)' } });
    this.fillLog(`ARB ATTEMPT ${o.label} · ${landed ? 'LANDED' : 'FAILED'} (modeled p=${this.c.pSuccess}) · net ${rec.pnl >= 0 ? '+' : ''}${rec.pnl.toFixed(2)}`, pnl, false);
  }
  view() {
    const f = this.feed, modes = { solana: f.sol ? f.sol.mode : 'pending' }; for (const ch of f.chains) modes[ch] = f.evm[ch] ? 'indicative' : 'pending';
    const matrices = [];
    if (f.sol && f.sol.bps) matrices.push({ title: `Solana SOL/USDC · $${f.sol.notional} size`, source: f.sol.source, labels: f.sol.labels, bps: f.sol.bps });
    for (const ch of f.chains) { const e = f.evm[ch]; if (e && e.labels.length > 1) matrices.push({ title: `${ch} WETH/USD-stable mid gap`, source: 'DexScreener · before pool fees & impact · USD stables at $1', labels: e.labels, bps: e.bps }); }
    return { modes, matrices, best: this.best.slice(0, 8), pSuccess: this.c.pSuccess, notionalUsd: this.c.notionalUsd };
  }
}
module.exports = { GapScanner, evaluate };
