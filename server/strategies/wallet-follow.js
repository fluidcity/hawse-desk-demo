'use strict';
// Strategy (batch-1 H3): wallet-follow v2. Follows SPECIFIC tracked wallets (Hyperliquid userFills; Solana via the Helius
// whale feed when it is enabled) instead of aggregate pool flow (whale-follow.js stays as the aggregate strategy).
// Every follow is entered after a deliberate latency delay at the then-current real quote + modeled slippage, and is paired
// with two SIM-booked controls opened at the same moment: a random-direction trade and a buy-and-hold. The scoreboard
// compares follows to those controls. Paper only.
const fs = require('fs');
const path = require('path');
const { Strategy } = require('./base');
const F = require('../lib/fees');
const { openPos } = require('./directional');
const { summarize, PLAN } = require('./follow-score');
const X = require('../lib/explain');

const RULES = Object.freeze({ maxFollows: 3, maxPerAsset: 1, sizePct: 0.25, depthFrac: 0.0005, minNotional: 50, mirrorFrac: 0.5, quoteMaxAgeMs: 60e3, cfDelaySec: 60, maxPending: 50 });

/** Load the offline watchlist (scripts/score-wallets.js) and merge env wallets. Env-only wallets get addedAt = now (no look-back). */
function loadWatchlist(file, envAddrs = [], now = Date.now()) {
  let wl = [];
  try { if (file && fs.existsSync(file)) wl = (JSON.parse(fs.readFileSync(file, 'utf8')).wallets || []).filter((w) => !w.chain || w.chain === 'hyperliquid'); } catch { wl = []; }
  const by = new Map(wl.map((w) => [String(w.addr).toLowerCase(), { addr: w.addr, label: w.label || 'watchlist', addedAt: +w.addedAt || now, source: 'watchlist' }]));
  for (const a of envAddrs) if (!by.has(a.toLowerCase())) by.set(a.toLowerCase(), { addr: a, label: 'env', addedAt: now, source: 'env' });
  return [...by.values()];
}

class WalletFollow extends Strategy {
  constructor(engine, { hl, sol = null, rng = Math.random, cfg } = {}) {
    super(engine, { id: 'wfollow', name: 'Wallet Follow v2', desc: 'Follows tracked wallets (Hyperliquid fills · Solana swaps) after a latency delay, vs random and buy-and-hold controls', allocPct: 0.06, chains: ['Hyperliquid', 'Solana'] });
    this.c = cfg || engine.cfg.follow; this.hl = hl; this.sol = sol; this.rng = rng; this.rules = RULES;
    this.walletSignals = []; this.pending = []; this.records = []; this.ctrlRet = new Map();
    this.solWallets = new Set((this.c.walletsSol || []).map((a) => a));
    this.scoreFile = this.c.scoreFile !== undefined ? this.c.scoreFile : path.join(__dirname, '..', '..', 'data', 'follow', 'scoreboard.json');
    this.load();
    if (hl) hl.onSignal((s) => this.onSignal(s));
    if (sol && sol.onTx) sol.onTx((tx, c) => this.onSolTx(tx, c));
  }
  load() { try { if (this.scoreFile && fs.existsSync(this.scoreFile)) this.records = JSON.parse(fs.readFileSync(this.scoreFile, 'utf8')).records || []; } catch { /* start fresh */ } }
  save() { if (!this.scoreFile) return; try { fs.mkdirSync(path.dirname(this.scoreFile), { recursive: true }); fs.writeFileSync(this.scoreFile, JSON.stringify({ records: this.records.slice(-2000) })); } catch { /* read-only disk */ } }
  dataMode() { return (this.hl && this.hl.mode === 'live') || (this.sol && this.sol.mode !== 'mock' && this.solWallets.size) ? 'live' : 'down'; }
  delaySec(chain) { return chain === 'solana' ? this.c.delaySecSol : this.c.delaySecHl; }
  minUsd(chain) { return chain === 'solana' ? this.c.minUsdSol : this.c.minUsdHl; }
  holdMs(chain) { return (chain === 'solana' ? this.c.maxHoldHSol : this.c.maxHoldHHl) * 3.6e6; }

  /** Solana: a tracked wallet (fee payer) swapping stables → SOL is a buy signal; SOL → stables closes our follow (spot cannot short). */
  onSolTx(tx, c) {
    if (!tx || !this.solWallets.has(tx.feePayer) || !c || (c.dir !== 'buy' && c.dir !== 'sell')) return;
    const t = (+tx.timestamp || Date.now() / 1000) * 1000;
    this.onSignal({ t, receivedAt: Date.now(), chain: 'solana', wallet: tx.feePayer, asset: 'SOL', side: 'long', kind: c.dir === 'buy' ? 'open' : 'reduce', frac: c.dir === 'sell' ? 1 : null, usd: c.usd, srcTx: tx.signature, px: null });
  }
  onSignal(s) {
    const now = s.receivedAt || Date.now();
    this.walletSignals.unshift({ t: s.t, chain: s.chain, wallet: s.wallet, label: s.label || null, asset: s.asset, side: s.side, usd: s.usd, srcTx: s.srcTx, kind: s.kind, frac: s.frac });
    if (this.walletSignals.length > 200) this.walletSignals.length = 200;
    const mine = (p) => !p.control && p.wallet === s.wallet && p.symbol === s.asset;
    if (s.kind === 'reduce') {
      this.pending = this.pending.filter((q) => !(q.sig.wallet === s.wallet && q.sig.asset === s.asset)); // the wallet is already leaving: do not enter late
      if (s.frac >= RULES.mirrorFrac) for (const p of this.positions.filter((p) => mine(p) && p.side === s.side)) this.closeFollow(p, `mirror exit: wallet cut ${(s.frac * 100).toFixed(0)}%`, now);
      return;
    }
    for (const p of this.positions.filter((p) => mine(p) && p.side !== s.side)) this.closeFollow(p, 'whale opposite-side fill', now); // e.g. a flip
    if (s.usd < this.minUsd(s.chain)) return this.skip(`${s.asset}: wallet fill $${(s.usd / 1e3).toFixed(0)}k < $${(this.minUsd(s.chain) / 1e3).toFixed(0)}k`);
    if (this.pending.length >= RULES.maxPending) return this.skip('follow queue full');
    const q = this.markQuote(s.chain, s.asset);
    this.pending.push({ sig: s, dueAt: now + this.delaySec(s.chain) * 1000, ref0: q ? q.mark : null, queuedAt: now });
  }
  /** Real quote used for entries and marks: Hyperliquid-first perp quote for HL wallets, real spot top-of-book for Solana. */
  markQuote(chain, asset) {
    if (chain === 'solana') { const q = this.e.spotQuote(asset, null, 10000, 90000); return q ? { ...q, mark: q.mid || (q.bid + q.ask) / 2, market: 'spot' } : null; }
    const q = this.e.quote(asset, RULES.quoteMaxAgeMs); return q ? { ...q, market: 'perp' } : null;
  }
  tick(now) {
    this.manage(now);
    if (!this.pending.length) return;
    const due = this.pending.filter((q) => q.dueAt <= now); this.pending = this.pending.filter((q) => q.dueAt > now);
    for (const q of due) this.enter(q, now);
  }
  enter({ sig, ref0, queuedAt }, now) {
    const tag = `${sig.asset} (${sig.chain} ${short(sig.wallet)})`;
    if (!this.armed) return this.skip(`${tag}: disarmed, signal logged only`);
    const follows = this.positions.filter((p) => !p.control);
    if (follows.length >= RULES.maxFollows) return this.skip(`${tag}: ${RULES.maxFollows} follows already open`);
    if (follows.some((p) => p.symbol === sig.asset)) return this.skip(`${tag}: already following ${sig.asset}`);
    const q = this.markQuote(sig.chain, sig.asset); if (!q || !(q.mark > 0)) return this.skip(`${tag}: no fresh real quote`);
    const whalePx = sig.px || ref0; if (!whalePx) return this.skip(`${tag}: no reference price for the chase check`);
    const dir = sig.side === 'long' ? 1 : -1, chasePct = (dir > 0 ? q.mark / whalePx - 1 : whalePx / q.mark - 1) * 100;
    if (chasePct > this.c.maxChasePct) return this.skip(`${tag}: price already moved ${chasePct.toFixed(2)}% their way (> ${this.c.maxChasePct}%)`, 'chasing');
    const simulated = !!sig.mock;
    const g = this.gate(simulated); if (!g.ok) return this.skip('risk gate: ' + g.reason);
    const depth = q.dayNtlVlm ? q.dayNtlVlm * RULES.depthFrac : Infinity, notional = Math.min(this.sleeve(simulated) * RULES.sizePct, depth);
    if (notional < RULES.minNotional) return this.skip(`${tag}: size $${notional.toFixed(0)} below $${RULES.minNotional} after the liquidity cap`);
    const isSpot = q.market === 'spot', feeRate = isSpot ? (F.SPOT_TAKER_FEES[q.venue] || 0.001) : (F.TAKER_FEES[q.venue] || 0.0005);
    const slipBps = F.slippageBps({ halfSpreadBps: q.halfSpreadBps || 1, notional, depthUsd: Number.isFinite(depth) ? depth : 1e6 });
    const common = { symbol: sig.asset, notional, quote: q, feeRate, slipBps, maxHoldMs: this.holdMs(sig.chain), now };
    const delaySec = Math.round((now - (sig.receivedAt || queuedAt)) / 1000);
    const p = openPos(this, { ...common, side: sig.side, tp: this.c.tp, sl: this.c.sl, simulated,
      reason: `follow ${sig.chain} ${short(sig.wallet)} ${sig.kind} $${(sig.usd / 1e3).toFixed(0)}k after ${delaySec}s (chase ${chasePct.toFixed(2)}%)`,
      extra: { wallet: sig.wallet, label: sig.label || null, chain: sig.chain, market: q.market, delaySec, chasePct, whalePx, ref0, signalAt: sig.receivedAt || queuedAt, srcTx: sig.srcTx, ref60: null, mock: simulated } });
    p.controlId = [];
    if (this.c.controls !== false) {
      const rdir = this.rng() < 0.5 ? 'long' : 'short';
      for (const [kind, side, tp, sl] of [['random', isSpot ? 'long' : rdir, this.c.tp, this.c.sl], ['hold', 'long', null, null]]) {
        if (isSpot && kind === 'random' && rdir === 'short') { p.controlId.push(null); continue; } // no spot shorts: random short skipped on Solana, recorded as missing
        const c = openPos(this, { ...common, side, tp, sl, simulated: true, reason: `CONTROL (${kind}) for ${p.id} · SIM`, extra: { control: kind, parentId: p.id, market: q.market, chain: sig.chain } });
        p.controlId.push(c.id);
      }
    }
  }
  /** Mark everything on real quotes; TP / SL / time stop for follows and the random control; buy-and-hold closes with its parent. */
  manage(now) {
    let ur = 0, us = 0;
    for (const p of [...this.positions]) {
      if (!this.positions.includes(p)) continue;
      const q = this.markQuote(p.chain, p.symbol); if (!q) { p.stale = true; continue; } p.stale = false; p.mark = q.mark;
      if (!p.control && p.ref60 == null && now - p.signalAt >= RULES.cfDelaySec * 1000) p.ref60 = q.mark;
      const move = p.side === 'long' ? q.mark / p.ref - 1 : p.ref / q.mark - 1;
      let why = null;
      if (p.tp != null && move >= p.tp) why = 'take-profit'; else if (p.sl != null && move <= -p.sl) why = 'stop-loss'; else if (p.maxHoldMs && now - p.openedAt >= p.maxHoldMs) why = 'time stop';
      if (why) { if (p.control) this.closeControl(p, why, q.mark); else this.closeFollow(p, why, now, q.mark); continue; }
      p.upnl = this.outcome(p, q.mark).pnl; if (p.simulated) us += p.upnl; else ur += p.upnl;
    }
    this.e.ledger.setUnrealized(this.id, { real: ur, sim: us });
  }
  outcome(p, px) {
    const exitPx = F.applySlippage(px, p.side === 'long' ? 'sell' : 'buy', p.slipBps);
    const gross = p.side === 'long' ? (exitPx - p.entry) * p.qty : (p.entry - exitPx) * p.qty, exitFee = F.fee(exitPx * p.qty, p.feeRate);
    return { exitPx, exitFee, pnl: gross - exitFee, net: gross - exitFee - p.entryFee };
  }
  closePos(p, why, px) {
    const o = this.outcome(p, px); this.positions.splice(this.positions.indexOf(p), 1);
    this.e.ledger.close(this.id, { pnl: o.pnl, total: o.net, fees: p.entryFee + o.exitFee, simulated: p.simulated, meta: { symbol: p.symbol, side: p.side, why, control: p.control || null } });
    this.fillLog(`CLOSE ${p.control ? 'CONTROL(' + p.control + ') ' : ''}${p.side.toUpperCase()} ${p.symbol} @ ${o.exitPx.toFixed(4)} (${why}) · net ${o.net >= 0 ? '+' : ''}${o.net.toFixed(2)}${p.control ? ' · SIM' : ''}`, o.pnl, p.simulated);
    return { ...o, netPct: (o.net / p.notional) * 100 };
  }
  closeControl(c, why, px) { const o = this.closePos(c, why, px); this.ctrlRet.set(c.id, o.netPct); return o; }
  closeFollow(p, why, now = Date.now(), px) {
    if (px == null) { const q = this.markQuote(p.chain, p.symbol); px = q ? q.mark : p.mark; }
    if (!(px > 0)) return null;
    for (const c of this.positions.filter((x) => x.parentId === p.id)) this.closeControl(c, 'parent closed', px);
    const o = this.closePos(p, why, px), dir = p.side === 'long' ? 1 : -1;
    const costPct = (2 * p.feeRate + (2 * p.slipBps) / 1e4) * 100, cfRet = (ref) => (ref > 0 ? dir * (px / ref - 1) * 100 - costPct : null);
    const [rid, hid] = p.controlId || [];
    const rec = { t: now, wallet: p.wallet, label: p.label, chain: p.chain, asset: p.symbol, side: p.side, delaySec: p.delaySec, chasePct: p.chasePct, why, notional: p.notional,
      netPct: o.netPct, randomPct: rid ? this.ctrlRet.get(rid) ?? null : null, holdPct: hid ? this.ctrlRet.get(hid) ?? null : null,
      cf: { 0: cfRet(p.ref0), d: cfRet(p.ref), 60: cfRet(p.ref60) }, heldMin: (now - p.openedAt) / 60e3, mock: !!p.mock };
    for (const id of p.controlId || []) this.ctrlRet.delete(id);
    this.records.push(rec); this.save();
    return rec;
  }
  posView(p) { return { ...p, kind: p.control ? 'control' : 'follow' }; }
  view() {
    const sc = summarize(this.records);
    return { hl: this.hl ? this.hl.snapshot() : null, sol: { mode: this.sol ? this.sol.mode : 'off', wallets: this.solWallets.size },
      signals: this.walletSignals.slice(0, 30), pending: this.pending.map((q) => ({ asset: q.sig.asset, wallet: q.sig.wallet, side: q.sig.side, dueInSec: Math.max(0, Math.round((q.dueAt - Date.now()) / 1000)) })),
      rules: { ...RULES, ...this.c, walletsHl: undefined, walletsSol: undefined, scoreFile: undefined }, score: sc, recent: this.records.slice(-15).reverse() };
  }
  explain() {
    const c = this.c, r = RULES;
    return X.explanation(`Follows specific wallets with a track record instead of the overall flow of big trades. When a tracked Hyperliquid
      trader opens or adds at least ${X.usd(c.minUsdHl)} (or a tracked Solana wallet swaps at least ${X.usd(c.minUsdSol)} into SOL), it waits a
      deliberate delay to model real-world latency, then opens a small paper position at the then-current real price. Each follow is paired with
      two simulated controls opened at the same moment, a random-direction trade and a buy-and-hold, so you can see whether following them
      actually beats chance.`, {
      Markets: ['Hyperliquid perps that tracked wallets trade (marked on the Hyperliquid-first real perp quote)', 'Solana: SOL only, on a real CEX spot top-of-book (the whale classifier only reads SOL ↔ stable swaps)'],
      Signal: [`Hyperliquid: public userFills for each tracked wallet, one wallet per slot, the whole list every ${X.num(c.pollMs / 1000, 0)} s; new fills found by trade id and grouped per order`,
        `Entry signal: an open or increase ≥ ${X.usd(c.minUsdHl)} notional (Hyperliquid) or a stables → SOL swap ≥ ${X.usd(c.minUsdSol)} (Solana, only when the Helius whale feed is enabled)`,
        'Only fills after the wallet\'s add date count (watchlist look-ahead guard); history is never replayed'],
      Entry: [`Delay ${c.delaySecHl} s (Hyperliquid) / ${c.delaySecSol} s (Solana) after receipt, then fill at the current quote + modeled slippage`,
        `Skip if the price already moved more than ${c.maxChasePct}% in the wallet's direction since their fill (chasing)`,
        `At most ${r.maxFollows} follows at once and ${r.maxPerAsset} per asset; size ${X.pct(r.sizePct * 100, 0)} of the sleeve, capped at ${r.depthFrac * 100}% of the asset's 24h volume`,
        'Controls (SIM book, labeled): a random-direction trade with the same target/stop/time rules and a buy-and-hold long, same size, same moment'],
      Exit: [`Mirror exit: the wallet cuts the position by ≥ ${X.pct(r.mirrorFrac * 100, 0)}`, 'Close on the wallet\'s opposite-side fill (a flip)',
        `Else take profit +${X.pct(c.tp * 100, 1)}, stop −${X.pct(c.sl * 100, 1)}, time stop ${c.maxHoldHHl} h (Hyperliquid) / ${c.maxHoldHSol} h (Solana)`, 'Controls close when their follow closes (the random one can also hit its own target/stop)'],
      Risk: X.deskRisk(this),
      Data: [X.feesLine(), 'Hyperliquid fills are public and free; no Helius credits are spent by this strategy (Solana uses the existing whale feed, off by default)',
        `Scoreboard per wallet: mean net return per follow after 2× taker + slippage, bootstrap 95% CI, hit rate, vs random and buy-and-hold, and the same follow re-scored at 0 s / actual / ${r.cfDelaySec} s delay from logged quotes`,
        `Verdict after ${PLAN.minSignals} follows: pass if mean > 0 with CI above 0 and ≥ ${PLAN.passEdgeVsRandomPct}%/trade better than random; fail if the CI includes 0 after ${PLAN.failAfter} or the edge is gone at a ${PLAN.delayFailSec} s delay`,
        'Controls are SIMULATED and never count as results; the scoreboard persists in data/follow/ (gitignored)'] });
  }
}
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '?');
module.exports = { WalletFollow, loadWatchlist, RULES };
