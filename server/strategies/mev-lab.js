'use strict';
// Mempool lab (batch-1 H4): sandwich / back-run PAPER lab on Ethereum mainnet. MEASUREMENT AND SIMULATION ONLY.
// It never trades. "Armed" only means simulated sandwich P&L of included, sandwichable events is written to the SIM
// book. The question it answers is "how good is our model and how much flow can we even see", not "how much can we make".
const fs = require('fs');
const path = require('path');
const { Strategy } = require('./base');
const X = require('../lib/explain');
const { bootstrapCI } = require('../betting/clv');
const S = require('../mev/sim');
const T = require('../mev/truth');

const TOKENS = Object.freeze({ // known-priced tokens; everything else is valued through the other side of the pool
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { sym: 'WETH', dec: 18, ref: 'ETH' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { sym: 'USDC', dec: 6, usd: 1 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { sym: 'USDT', dec: 6, usd: 1 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { sym: 'DAI', dec: 18, usd: 1 },
  '0x2260fac5e5542a773aa44fbc8cff7c27e8d1ffa1': { sym: 'WBTC', dec: 8, ref: 'BTC' },
});
const V2_FACTORY = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', V3_FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const PLAN = Object.freeze({ minObserved: 500, minConfirmed: 50, passMedianErrPct: 25, passRecallPct: 60, checkAfterBlocks: 3, giveUpBlocks: 25 });
const pad = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

class MevLab extends Strategy {
  constructor(engine, { feed, cfg = {} } = {}) {
    super(engine, { id: 'mevlab', name: 'Mempool lab (sim only)', desc: 'Ethereum pending-swap sandwich / back-run model vs ground truth. Measurement only, never trades.', allocPct: 0, chains: ['ethereum'] });
    this.feed = feed; this.c = { minUsd: 25000, bidShare: 0.9, gasSandwich: 360000, gasBackrun: 180000, maxEvents: 3000, eventsFile: null, duneFile: null, ...cfg };
    this.events = []; this.byHash = new Map(); this.pools = new Map(); this.head = null; this.baseFee = null;
    this.seenPending = new Set(); this.seenOrder = []; // rolling set of ALL pending hashes we saw (coverage denominator side)
    this.counts = { small: 0, unpriced: 0, exactOut: 0, multihop: 0, feeOnTransfer: 0, noPool: 0, simErrors: 0, blocks: 0, blockTxs: 0, blockTxsSeen: 0, victims: 0, victimsSeen: 0, booked: 0 };
    this.dune = this.loadDune(); this.load();
    if (feed) {
      feed.onPending((x) => this.onPending(x));
      feed.onSeen((h) => this.remember(h)); // every pending hash, not just router swaps
      feed.onHead((h) => this.onHead(h).catch(() => { this.counts.simErrors++; }));
    }
  }
  dataMode() { const m = this.feed ? this.feed.mode : 'off'; return m === 'live' ? 'sim' : 'down'; }
  remember(h) { if (!h) return; h = h.toLowerCase(); if (this.seenPending.has(h)) return; this.seenPending.add(h); this.seenOrder.push(h); if (this.seenOrder.length > 200000) this.seenPending.delete(this.seenOrder.shift()); }
  refPx(sym) {
    const s = this.e.spotQuote && this.e.spotQuote(sym, 'binance', 15000, 60000); if (s && (s.mid || (s.bid && s.ask))) return s.mid || (s.bid + s.ask) / 2;
    const q = this.e.quote && this.e.quote(sym, 60000); return q ? q.mark : null;
  }
  usdPer(token) { const t = TOKENS[token]; if (!t) return null; const p = t.usd || this.refPx(t.ref); return p ? { p, dec: t.dec } : null; }
  rawUsd(raw, token) { const v = this.usdPer(token); return v ? (Number(raw) / 10 ** v.dec) * v.p : null; }

  onPending({ tx, d, seenAt }) {
    if (!d.exactIn) { this.counts.exactOut++; return null; }
    if (d.hops !== 1) { this.counts.multihop++; return null; }
    if (d.feeOnTransfer) { this.counts.feeOnTransfer++; return null; }
    if (d.amountIn == null) { this.counts.unpriced++; return null; }
    const usd = this.rawUsd(d.amountIn, d.tokenIn) ?? this.rawUsd(d.amountOutMin, d.tokenOut);
    if (usd == null) { this.counts.unpriced++; return null; }
    if (usd < this.c.minUsd) { this.counts.small++; return null; }
    const ev = { hash: tx.hash.toLowerCase(), from: (tx.from || '').toLowerCase(), nonce: tx.nonce != null ? parseInt(tx.nonce, 16) : null, seenAt, seenBlock: this.head, router: d.router, fn: d.fn, v: d.v,
      tokenIn: d.tokenIn, tokenOut: d.tokenOut, pair: `${(TOKENS[d.tokenIn] || {}).sym || d.tokenIn.slice(0, 8)}→${(TOKENS[d.tokenOut] || {}).sym || d.tokenOut.slice(0, 8)}`, usd, inclusion: 'pending', status: 'simulating' };
    if (this.byHash.has(ev.hash)) return null;
    this.add(ev); return this.simulate(ev, d, tx).catch((e) => { ev.status = 'sim error: ' + String(e.message).slice(0, 80); this.counts.simErrors++; });
  }
  add(ev) { this.events.unshift(ev); this.byHash.set(ev.hash, ev); while (this.events.length > this.c.maxEvents) this.byHash.delete(this.events.pop().hash); }

  async pool(d) {
    const [a, b] = [d.tokenIn, d.tokenOut], k = `${d.v}:${a < b ? a + b : b + a}:${(d.fees || [])[0] || ''}`;
    if (this.pools.has(k)) return this.pools.get(k);
    const data = d.v === 'v2' ? '0xe6a43905' + pad(a) + pad(b) : '0x1698ee82' + pad(a) + pad(b) + pad(BigInt(d.fees[0]).toString(16));
    const r = await this.feed.rpc('eth_call', [{ to: d.v === 'v2' ? V2_FACTORY : V3_FACTORY, data }, 'latest']);
    const addr = '0x' + String(r).slice(-40); const p = /^0x0{40}$/.test(addr) ? null : addr.toLowerCase(); this.pools.set(k, p); return p;
  }
  async simulate(ev, d, tx) {
    const pool = await this.pool(d); if (!pool) { this.counts.noPool++; ev.status = 'no Uniswap pool for pair'; return; }
    ev.pool = pool; const inIs0 = d.tokenIn < d.tokenOut; ev.inIdx = inIs0 ? 0 : 1;
    let r, feePpm, rIn, rOut;
    if (d.v === 'v2') {
      const h = String(await this.feed.rpc('eth_call', [{ to: pool, data: '0x0902f1ac' }, 'latest'])).slice(2);
      const r0 = BigInt('0x' + h.slice(0, 64)), r1 = BigInt('0x' + h.slice(64, 128)); [rIn, rOut] = inIs0 ? [r0, r1] : [r1, r0]; feePpm = 3000n;
      r = S.v2SandwichOpt({ rIn, rOut, victimIn: d.amountIn, minOut: d.amountOutMin, feePpm });
    } else {
      const s0 = String(await this.feed.rpc('eth_call', [{ to: pool, data: '0x3850c7bd' }, 'latest'])).slice(2), L = BigInt(await this.feed.rpc('eth_call', [{ to: pool, data: '0x1a686502' }, 'latest']));
      const sqrtP = BigInt('0x' + s0.slice(0, 64)); feePpm = BigInt(d.fees[0]); ({ rIn, rOut } = S.v3VirtualReserves({ sqrtPriceX96: sqrtP, liquidity: L, zeroForOne: inIs0 }));
      r = S.v3SingleTickApprox({ sqrtPriceX96: sqrtP, liquidity: L, zeroForOne: inIs0, victimIn: d.amountIn, minOut: d.amountOutMin, feePpm });
      ev.likelyCrossesTicks = r.likelyCrossesTicks;
    }
    ev.slipTolPct = r.slipTol != null ? r.slipTol * 100 : (r.quotedOut > 0n ? (1 - Number(BigInt(d.amountOutMin) * 1000000n / r.quotedOut) / 1e6) * 100 : null);
    const eth = this.refPx('ETH'), gwei = (this.baseFee != null ? this.baseFee : Number(BigInt(tx.maxFeePerGas || tx.gasPrice || 0)) / 1e9) + 1;
    const gas = (units) => (eth ? units * gwei * 1e-9 * eth : null);
    ev.gasUsd = gas(this.c.gasSandwich);
    const grossUsd = r.feasible ? this.rawUsd(r.gross, d.tokenIn) ?? (this.rawUsd(r.gross * rOut / rIn, d.tokenOut)) : 0;
    ev.simGrossUsd = grossUsd; ev.frontInUsd = r.feasible ? this.rawUsd(r.frontIn, d.tokenIn) : 0;
    if (grossUsd != null && ev.gasUsd != null) { const n = S.netUsd({ grossUsd, gasUsd: ev.gasUsd, bidShare: this.c.bidShare }); ev.simSandwichCeilUsd = n.ceil; ev.simSandwichRealUsd = n.real; }
    ev.sandwichable = (ev.simSandwichCeilUsd || 0) > 0;
    // back-run after the victim alone, against the external reference (only when both sides are priced)
    const pa = this.usdPer(d.tokenIn), pb = this.usdPer(d.tokenOut);
    if (pa && pb) {
      const vOut = S.amountOut(BigInt(d.amountIn), rIn, rOut, feePpm); const rIn2 = rIn + BigInt(d.amountIn), rOut2 = rOut - vOut;
      const refRaw = (pa.p / pb.p) * 10 ** (pb.dec - pa.dec); // tokenOut raw per tokenIn raw
      const br = S.backrunToRef({ rA: rIn2, rB: rOut2, refRaw, feePpm }); const g = this.rawUsd(br.gross, d.tokenOut) || 0;
      ev.simBackrunGrossUsd = g; ev.simBackrunUsd = g * (1 - this.c.bidShare) - (gas(this.c.gasBackrun) || 0); ev.simBackrunCeilUsd = g - (gas(this.c.gasBackrun) || 0);
    }
    ev.status = 'simulated'; ev.feasible = r.feasible; ev.reason = r.reason;
  }

  async onHead(h) {
    const num = parseInt(h.number, 16); this.head = num; if (h.baseFeePerGas) this.baseFee = Number(BigInt(h.baseFeePerGas)) / 1e9;
    const blk = await this.feed.rpc('eth_getBlockByNumber', [h.number, true]); if (!blk || !Array.isArray(blk.transactions)) return;
    const txs = blk.transactions, sw = T.detectSandwiches(txs); this.counts.blocks++; this.counts.blockTxs += txs.length;
    for (const t of txs) if (this.seenPending.has(t.hash.toLowerCase())) this.counts.blockTxsSeen++;
    for (const v of sw.keys()) { this.counts.victims++; if (this.seenPending.has(v)) this.counts.victimsSeen++; }
    const idx = new Map(txs.map((t, i) => [t.hash.toLowerCase(), i]));
    for (const ev of this.events) {
      if (ev.inclusion !== 'pending' && !(ev.inclusion === 'dropped' && num - (ev.seenBlock || num) <= PLAN.giveUpBlocks)) continue;
      if (idx.has(ev.hash)) { ev.inclusion = 'included'; ev.block = num; ev.index = idx.get(ev.hash); ev.sandwichChecked = true; const s = sw.get(ev.hash); ev.observedSandwich = !!s; if (s) { ev.attack = s; this.attackerPnl(ev).catch(() => {}); } this.book(ev); continue; }
      if (ev.inclusion === 'pending' && ev.seenBlock != null && num - ev.seenBlock >= PLAN.checkAfterBlocks) this.resolve(ev).catch(() => {});
    }
    this.save();
  }
  async resolve(ev) {
    ev.inclusion = 'checking';
    const rc = await this.feed.rpc('eth_getTransactionReceipt', [ev.hash]);
    if (rc) { ev.inclusion = 'included'; ev.block = parseInt(rc.blockNumber, 16); ev.sandwichChecked = false; return; } // mined in a block we did not process
    const n = ev.from ? parseInt(await this.feed.rpc('eth_getTransactionCount', [ev.from, 'latest']), 16) : null;
    ev.inclusion = n != null && ev.nonce != null && n > ev.nonce ? 'replaced' : 'dropped';
  }
  async attackerPnl(ev) {
    if (!ev.pool) return;
    const [f, b] = await Promise.all([this.feed.rpc('eth_getTransactionReceipt', [ev.attack.front]), this.feed.rpc('eth_getTransactionReceipt', [ev.attack.back])]);
    const g = T.attackerGrossRaw(f, b, ev.pool, ev.inIdx); if (g == null) { ev.attackerOnOtherPool = true; return; }
    ev.attackerGrossUsd = this.rawUsd(g, ev.tokenIn);
  }
  book(ev) {
    if (!this.armed || !(ev.simSandwichRealUsd > 0) || ev.booked) return;
    ev.booked = true; this.counts.booked++;
    this.e.ledger.close(this.id, { pnl: ev.simSandwichRealUsd, fees: (ev.gasUsd || 0) + (ev.simGrossUsd || 0) * this.c.bidShare, simulated: true, meta: { symbol: ev.pair, why: 'sim sandwich (90% builder bid)', hash: ev.hash } });
    this.fillLog(`SIM sandwich on ${ev.pair} $${Math.round(ev.usd).toLocaleString('en-US')} victim → ${ev.simSandwichRealUsd.toFixed(2)} realistic`, ev.simSandwichRealUsd, true);
  }

  metrics() {
    const evs = this.events, dn = this.dune;
    for (const ev of evs) { const t = dn.get(ev.hash); if (t) { ev.duneSandwiched = true; ev.duneAttackerUsd = t.usd; } }
    const sim = evs.filter((e) => e.status === 'simulated'), checked = sim.filter((e) => e.inclusion === 'included' && (e.sandwichChecked || e.duneSandwiched));
    const actual = (e) => !!(e.duneSandwiched || e.observedSandwich);
    const tp = checked.filter((e) => e.sandwichable && actual(e)).length, fp = checked.filter((e) => e.sandwichable && !actual(e)).length, fn = checked.filter((e) => !e.sandwichable && actual(e)).length;
    const errs = checked.map((e) => { const a = e.duneAttackerUsd ?? e.attackerGrossUsd; return actual(e) && a && Math.abs(a) > 1 && e.simGrossUsd != null ? Math.abs(e.simGrossUsd - a) / Math.abs(a) * 100 : null; }).filter((x) => x != null);
    const hist = [[0, 10], [10, 25], [25, 50], [50, 100], [100, Infinity]].map(([a, b]) => ({ label: b === Infinity ? `>${a}%` : `${a}–${b}%`, n: errs.filter((x) => x >= a && x < b).length }));
    const confirmed = checked.filter(actual).length, c = this.counts;
    const m = { observed: sim.length, included: sim.filter((e) => e.inclusion === 'included').length, dropped: sim.filter((e) => e.inclusion === 'dropped').length, replaced: sim.filter((e) => e.inclusion === 'replaced').length,
      confirmed, precisionPct: tp + fp ? tp / (tp + fp) * 100 : null, recallPct: tp + fn ? tp / (tp + fn) * 100 : null, medianErrPct: median(errs), matched: errs.length, errHist: hist,
      realPositivePct: sim.length ? sim.filter((e) => e.simSandwichRealUsd > 0).length / sim.length * 100 : null, backrunPositivePct: sim.filter((e) => e.simBackrunUsd != null).length ? sim.filter((e) => e.simBackrunUsd > 0).length / sim.filter((e) => e.simBackrunUsd != null).length * 100 : null,
      coverageVictimsPct: c.victims ? c.victimsSeen / c.victims * 100 : null, coverageTxsPct: c.blockTxs ? c.blockTxsSeen / c.blockTxs * 100 : null,
      ceilSumUsd: sim.reduce((s, e) => s + Math.max(0, e.simSandwichCeilUsd || 0), 0), realSumUsd: sim.reduce((s, e) => s + Math.max(0, e.simSandwichRealUsd || 0), 0),
      realCi: sim.length >= 10 ? bootstrapCI(sim.map((e) => e.simSandwichRealUsd || 0)) : null, duneRows: dn.size };
    const P = PLAN; let v;
    if (m.observed < P.minObserved || confirmed < P.minConfirmed) v = { status: 'collecting', text: `${m.observed}/${P.minObserved} large pending swaps, ${confirmed}/${P.minConfirmed} confirmed sandwiched; no verdict before both` };
    else if (m.medianErrPct != null && m.medianErrPct <= P.passMedianErrPct && m.recallPct >= P.passRecallPct) v = { status: 'pass', text: `model trustworthy: median error ${m.medianErrPct.toFixed(0)}% ≤ ${P.passMedianErrPct}%, recall ${m.recallPct.toFixed(0)}% ≥ ${P.passRecallPct}%` };
    else v = { status: 'fail', text: `model not trustworthy yet: median error ${m.medianErrPct == null ? '—' : m.medianErrPct.toFixed(0) + '%'}, recall ${m.recallPct == null ? '—' : m.recallPct.toFixed(0) + '%'}` };
    m.verdict = v; return m;
  }
  view() {
    return { mode: this.feed ? this.feed.mode : 'off', feed: this.feed ? this.feed.snapshot() : null, rules: { ...this.c, eventsFile: undefined, duneFile: undefined }, plan: PLAN, counts: { ...this.counts },
      head: this.head, baseFeeGwei: this.baseFee, metrics: this.metrics(),
      events: this.events.slice(0, 25).map((e) => ({ hash: e.hash, seenAt: e.seenAt, pair: e.pair, v: e.v, fn: e.fn, router: e.router, usd: e.usd, slipTolPct: e.slipTolPct, status: e.status,
        simSandwichCeilUsd: e.simSandwichCeilUsd, simSandwichRealUsd: e.simSandwichRealUsd, simBackrunUsd: e.simBackrunUsd, gasUsd: e.gasUsd, inclusion: e.inclusion, block: e.block,
        observedSandwich: e.observedSandwich, duneSandwiched: e.duneSandwiched || false, attackerGrossUsd: e.attackerGrossUsd, likelyCrossesTicks: e.likelyCrossesTicks })) };
  }
  loadDune() { try { return this.c.duneFile ? T.duneIndex(JSON.parse(fs.readFileSync(this.c.duneFile, 'utf8'))) : new Map(); } catch { return new Map(); } }
  load() { if (!this.c.eventsFile) return; try { const j = JSON.parse(fs.readFileSync(this.c.eventsFile, 'utf8')); for (const e of (j.events || []).reverse()) this.add(e); Object.assign(this.counts, j.counts || {}); } catch { /* first run */ } }
  save() {
    if (!this.c.eventsFile || Date.now() - (this.savedAt || 0) < 60000) return; this.savedAt = Date.now();
    try { fs.mkdirSync(path.dirname(this.c.eventsFile), { recursive: true }); fs.writeFileSync(this.c.eventsFile, JSON.stringify({ savedAt: this.savedAt, counts: this.counts, events: this.events.slice(0, this.c.maxEvents) }, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); } catch { /* disk full: keep running */ }
  }
  explain() {
    const c = this.c, P = PLAN;
    return X.explanation(`A research tool, not a strategy. It watches public pending Ethereum swaps sent to Uniswap routers. For every swap of at least
      ${X.usd(c.minUsd)}, it works out what a sandwich (buy just before, sell just after) or a back-run could have made, given the swap's own
      slippage limit and the pool's real reserves. Then it checks the block that included the swap to see whether someone actually sandwiched
      it and what they made. It never builds, approves or sends a transaction. "Armed" only writes the simulated result to the SIM book.`, {
      Markets: ['Ethereum mainnet only; Uniswap V2 Router02, SwapRouter02 and Universal Router (V2 and V3 single-hop, exact-in swaps)',
        'Base / Arbitrum excluded (no public mempool), Solana excluded (no public mempool since March 2024)',
        'Exact-out, multi-hop, fee-on-transfer and Uniswap v4 swaps are decoded and counted, not simulated'],
      Signal: [`Pending tx to a known router, decoded calldata, victim size ≥ ${X.usd(c.minUsd)} (valued via WETH / USDC / USDT / DAI / WBTC at the Binance or Hyperliquid reference price)`,
        'Slippage tolerance = 1 − amountOutMin ÷ the quote at the latest pool state'],
      Entry: ['Simulated only: front-run size x solved to maximise back-out − x while the victim still clears amountOutMin (exact Uniswap V2 integer math, 0.30% fee)',
        'V3: single-tick approximation on virtual reserves; flagged when the move probably crosses ticks (optimistic)',
        'Back-run: after the victim alone, trade the pool back to the external reference price; best of both directions'],
      Exit: [`Ground truth: the block that includes the swap is scanned for a same-sender pair around it (≤ ${T.MAX_GAP} positions apart = heuristic sandwich). The attacker's gross comes from the two legs' Swap logs on the same pool`,
        `After ${P.checkAfterBlocks} blocks without inclusion: receipt + nonce check marks it included elsewhere, replaced, or dropped`,
        'Optional Dune dex.sandwiched CSV import (scripts/mev-import-dune.js) is used as authoritative truth when present; no Dune API calls'],
      Risk: ['No order path exists: the feed refuses every RPC method that is not a read, and there is no key, wallet, or relay code (enforced by test)',
        'Paper only: SIM book, zero real allocation', 'Sandwiching harms users: this stays a measurement tool, never an execution path'],
      Costs: [`Gas: ${X.num(c.gasSandwich, 0)} units for a sandwich, ${X.num(c.gasBackrun, 0)} for a back-run, at base fee + 1 gwei`,
        `Builder payment: ceiling uses 0%, realistic uses ${X.pct(c.bidShare * 100, 0)} of gross (competitive searchers bid most profit to the builder)`],
      Data: ['Free public publicnode WebSocket (or Alchemy when ALCHEMY_API_KEY is set): pending txs + new heads, read-only eth_call / blocks / receipts',
        'Coverage = share of the block\'s heuristic sandwich victims that we saw pending. Private order flow is invisible by design',
        `Plan: ≥ ${P.minObserved} observed large swaps and ≥ ${P.minConfirmed} confirmed sandwiched; pass = median abs error ≤ ${P.passMedianErrPct}% and recall ≥ ${P.passRecallPct}%`,
        'MEMPOOL_ENABLED=false by default: no connection, no calls'],
    });
  }
}
module.exports = { MevLab, TOKENS, PLAN };
