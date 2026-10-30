'use strict';
// Stage 4 data: real DEX quotes for the gap scanner.
//  Solana: Jupiter (lite-api) per-DEX direct-route quotes (executable amounts, pool fees included) + a triangular
//          USDC→SOL→USDT→USDC loop. If Jupiter fails, DexScreener pool mid-prices are used as INDICATIVE only.
//  EVM (ethereum/base/arbitrum): DexScreener WETH/USDC pool mid-prices (indicative, before pool fees/impact),
//          ParaSwap best-route round trip (executable quotes) and eth_gasPrice from the chain RPC.
const { fetchJson, sleep } = require('../lib/net');
const { resolveRpc } = require('./whales');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_DEXES = ['Raydium', 'Raydium CLMM', 'Whirlpool', 'Meteora DLMM'];
const EVM_TOKENS = {
  // usdc = the stable used for ParaSwap round trips; stables = USD quote tokens accepted for pool mids (each treated as $1, flagged in the UI).
  ethereum: { id: 1, weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', stable: 'USDC', ds: 'ethereum', stables: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'] },
  base: { id: 8453, weth: '0x4200000000000000000000000000000000000006', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', stable: 'USDC', ds: 'base', stables: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'] },
  // Arbitrum: ParaSwap finds no route for native USDC from public quotes, so the round trip uses USD₮0; pools accept native USDC, USDC.e and USD₮0.
  arbitrum: { id: 42161, weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', usdc: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', stable: 'USD₮0', ds: 'arbitrum',
    stables: ['0xaf88d065e77c8cC2239327C5C2b2F60f8b4a89A9', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'] },
};

/** Pure: buy-on-i / sell-on-j matrix (bps) from per-DEX executable quotes. buys[i] = SOL received for N USDC; sellPx[j] = USDC per SOL when selling. */
function solMatrix(buys, sellPx, notional) {
  return buys.map((b) => sellPx.map((s) => (b == null || s == null ? null : ((b * s - notional) / notional) * 1e4)));
}
/** Pure: mid-price gap matrix (bps): buy at p[i], sell at p[j]. */
function midMatrix(px) { return px.map((pi) => px.map((pj) => (pi && pj ? (pj / pi - 1) * 1e4 : null))); }
/** Pure: WETH price in USDC from a DexScreener pair, or null when the pair is not WETH/USDC. */
function pairWethPx(p, t) {
  const b = (p.baseToken.address || '').toLowerCase(), q = (p.quoteToken.address || '').toLowerCase(), w = t.weth.toLowerCase();
  const st = (t.stables || [t.usdc]).map((x) => x.toLowerCase());
  if (b === w && st.includes(q)) return +p.priceNative;
  if (st.includes(b) && q === w) return 1 / +p.priceNative;
  return null;
}

class DexFeed {
  constructor({ health, cfg, evmCfg, priceFn }) {
    this.health = health; this.c = cfg; this.evmCfg = evmCfg; this.priceFn = priceFn; this.jup = cfg.jupiterBase;
    this.sol = null; this.evm = {}; this.gas = {}; this.para = {};
    health.register('dex.jupiter', { label: 'Jupiter per-DEX quotes (Solana)', group: 'dex', note: 'public lite-api, executable amounts' });
    health.register('dex.dexscreener', { label: 'DexScreener pool prices', group: 'dex', note: 'indicative mid prices' });
    health.register('dex.paraswap', { label: 'ParaSwap best-route quotes', group: 'dex', note: 'public, executable amounts' });
    this.chains = (evmCfg.chains || []).filter((c) => EVM_TOKENS[c]);
    this.rpc = {};
    for (const ch of this.chains) { const r = resolveRpc(ch, evmCfg); this.rpc[ch] = r && r.url; health.register('dex.gas.' + ch, { label: `${ch} eth_gasPrice`, group: 'dex', note: r ? r.source : 'no RPC' }); }
  }
  start() {
    this.runSol(); this.runEvm();
    this.t1 = setInterval(() => this.runSol(), this.c.solPollMs); this.t2 = setInterval(() => this.runEvm(), this.c.evmPollMs);
  }
  stop() { clearInterval(this.t1); clearInterval(this.t2); }
  async jq(inputMint, outputMint, amount, dex) {
    const u = new URL(this.jup + '/swap/v1/quote');
    u.search = new URLSearchParams({ inputMint, outputMint, amount: String(Math.round(amount)), slippageBps: '50', onlyDirectRoutes: 'true', ...(dex ? { dexes: dex } : {}) });
    for (let a = 0; ; a++) {
      try { const j = await fetchJson(u.toString(), { health: this.health, id: 'dex.jupiter' }); await sleep(1100); return j; } // stay inside the public rate limit
      catch (e) { if (a >= 1 || !/HTTP 429|timeout|aborted/i.test(e.message)) throw e; await sleep(2500); }
    }
  }
  async runSol() {
    if (this.solBusy) return; this.solBusy = true;
    try {
      const N = this.c.notionalUsd; const px = this.priceFn('SOL');
      if (!px) { this.sol = { ...(this.sol || {}), error: 'no SOL reference price yet' }; return; }
      const buys = [], sellPx = []; let anyOk = false;
      for (const d of SOL_DEXES) {
        try { const b = await this.jq(USDC_MINT, SOL_MINT, N * 1e6, d); buys.push(+b.outAmount / 1e9); anyOk = true; } catch { buys.push(null); }
        try { const solIn = N / px; const s = await this.jq(SOL_MINT, USDC_MINT, solIn * 1e9, d); sellPx.push((+s.outAmount / 1e6) / solIn); anyOk = true; } catch { sellPx.push(null); }
      }
      let tri = null;
      try {
        const a = await this.jq(USDC_MINT, SOL_MINT, N * 1e6); const b = await this.jq(SOL_MINT, USDT_MINT, +a.outAmount); const c = await this.jq(USDT_MINT, USDC_MINT, +b.outAmount);
        const route = [a, b, c].map((q) => (q.routePlan || []).map((r) => r.swapInfo.label).join('+')).join(' → ');
        tri = { label: 'USDC→SOL→USDT→USDC', outUsd: +c.outAmount / 1e6, grossUsd: +c.outAmount / 1e6 - N, route };
      } catch {}
      if (anyOk) this.sol = { ts: Date.now(), mode: 'live', source: 'Jupiter direct-route quotes', labels: SOL_DEXES, buys, sellPx, bps: solMatrix(buys, sellPx, N), tri, notional: N, solPx: px };
      else await this.solIndicative(px);
    } finally { this.solBusy = false; }
  }
  async solIndicative(px) {
    // Jupiter down: fall back to DexScreener SOL/USDC pool mids. Indicative only, never traded.
    try {
      const rows = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/solana/${SOL_MINT}`, { health: this.health, id: 'dex.dexscreener' });
      const pools = rows.filter((p) => p.quoteToken.address === USDC_MINT && p.baseToken.address === SOL_MINT && (p.liquidity?.usd || 0) > 500000).sort((a, b) => b.liquidity.usd - a.liquidity.usd).slice(0, 5);
      const labels = pools.map((p) => `${p.dexId}${p.labels?.[0] ? ' ' + p.labels[0] : ''}`); const mids = pools.map((p) => +p.priceNative);
      this.sol = { ts: Date.now(), mode: 'indicative', source: 'DexScreener mid prices (Jupiter unavailable)', labels, mids, bps: midMatrix(mids), tri: null, notional: this.c.notionalUsd, solPx: px };
    } catch (e) { this.sol = { ts: Date.now(), mode: 'down', error: String(e.message || e) }; }
  }
  async rpcCall(ch, method, params = []) {
    const t0 = Date.now();
    try {
      const r = await fetch(this.rpc[ch], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message); this.health.ok('dex.gas.' + ch, Date.now() - t0); return j.result;
    } catch (e) { this.health.fail('dex.gas.' + ch, e.message); throw e; }
  }
  async runEvm() {
    if (this.evmBusy) return; this.evmBusy = true;
    try {
      const N = this.c.notionalUsd;
      for (const ch of this.chains) {
        const t = EVM_TOKENS[ch];
        if (this.rpc[ch]) try { this.gas[ch] = { wei: parseInt(await this.rpcCall(ch, 'eth_gasPrice'), 16), ts: Date.now() }; } catch {}
        try {
          const rows = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${t.ds}/${t.weth}`, { health: this.health, id: 'dex.dexscreener' });
          const seen = new Set(); const pools = [];
          for (const p of rows.filter((p) => pairWethPx(p, t) && (p.liquidity?.usd || 0) > 300000).sort((a, b) => b.liquidity.usd - a.liquidity.usd)) {
            const k = p.dexId + (p.labels?.[0] || ''); if (seen.has(k) && pools.length >= 3) continue; seen.add(k); pools.push(p); if (pools.length >= 5) break;
          }
          const mids = pools.map((p) => pairWethPx(p, t));
          this.evm[ch] = { ts: Date.now(), mode: 'indicative', labels: pools.map((p) => `${p.dexId}${p.labels?.[0] ? ' ' + p.labels[0] : ''} ${(p.baseToken.address.toLowerCase() === t.weth.toLowerCase() ? p.quoteToken : p.baseToken).symbol} ${p.pairAddress.slice(2, 6)}`), mids, liq: pools.map((p) => p.liquidity.usd), bps: midMatrix(mids) };
        } catch {}
        try {
          const q = (src, dst, amt, sd, dd) => fetchJson(`https://api.paraswap.io/prices?srcToken=${src}&destToken=${dst}&amount=${amt}&srcDecimals=${sd}&destDecimals=${dd}&side=SELL&network=${t.id}`, { health: this.health, id: 'dex.paraswap' });
          const a = await q(t.usdc, t.weth, Math.round(N * 1e6), 6, 18); await sleep(600);
          const b = await q(t.weth, t.usdc, a.priceRoute.destAmount, 18, 6); await sleep(600);
          const out = +b.priceRoute.destAmount / 1e6;
          this.para[ch] = { ts: Date.now(), outUsd: out, grossUsd: out - N, gasUsd: (+a.priceRoute.gasCostUSD || 0) + (+b.priceRoute.gasCostUSD || 0),
            stable: t.stable, route: [a, b].map((x) => x.priceRoute.bestRoute.flatMap((r) => r.swaps.flatMap((s) => s.swapExchanges.map((e) => e.exchange))).join('+')).join(' → ') };
        } catch {}
      }
    } finally { this.evmBusy = false; }
  }
  snapshot() {
    const ticker = [];
    if (this.sol && this.sol.mode === 'live') { const v = this.sol.sellPx.filter(Boolean); if (v.length) ticker.push({ label: 'SOL·JUP', px: Math.max(...v), src: 'Jupiter' }); }
    for (const ch of this.chains) { const e = this.evm[ch]; if (e && e.mids.length) ticker.push({ label: 'ETH·' + ch.slice(0, 4).toUpperCase(), px: e.mids[0], src: 'DexScreener' }); }
    return { ticker, chains: this.chains };
  }
}
module.exports = { DexFeed, solMatrix, midMatrix, pairWethPx, EVM_TOKENS, SOL_DEXES };
