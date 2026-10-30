'use strict';
// Large-transaction monitors.
//  - Solana: Helius enhanced-transactions API (HELIUS_API_KEY, server-side only). Sampled, not exhaustive.
//  - EVM (ethereum/base/arbitrum): JSON-RPC eth_getLogs for big USDC/USDT/WETH transfers plus
//    directional Uniswap v3 WETH/USDC swaps. RPC from env (explicit URL > Alchemy > Infura > public fallback).
//  - Anything unconfigured runs a clearly labeled MOCK generator (every event tagged mock:true).
const { fetchJson, redact } = require('../lib/net');
const { WsClient } = require('../lib/ws');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_MINTS = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
const DEFAULT_SOL_WATCH = [
  { addr: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', label: 'Raydium SOL-USDC' },
  { addr: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', label: 'Orca Whirlpool SOL-USDC' },
];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAP_V3_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const EVM = {
  ethereum: { explorer: 'https://etherscan.io/tx/', pollMs: 12000, maxSpan: 6, publicRpc: 'https://ethereum-rpc.publicnode.com', alchemy: 'eth-mainnet', infura: 'mainnet',
    tokens: { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': ['USDC', 6], '0xdac17f958d2ee523a2206206994597c13d831ec7': ['USDT', 6], '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ['WETH', 18] },
    pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' },
  base: { explorer: 'https://basescan.org/tx/', pollMs: 6000, maxSpan: 12, publicRpc: 'https://base-rpc.publicnode.com', alchemy: 'base-mainnet', infura: 'base-mainnet',
    tokens: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': ['USDC', 6], '0x4200000000000000000000000000000000000006': ['WETH', 18] },
    pool: '0xd0b53d9277642d899df5c87a3966a349a798f224' },
  arbitrum: { explorer: 'https://arbiscan.io/tx/', pollMs: 8000, maxSpan: 120, publicRpc: 'https://arbitrum-one-rpc.publicnode.com', alchemy: 'arb-mainnet', infura: 'arbitrum-mainnet',
    tokens: { '0xaf88d065e77c8cc2239327c5edb3a432268e5831': ['USDC', 6], '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': ['USDT', 6], '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': ['WETH', 18] },
    pool: '0xc6962004f452be9203591991d15f6b388e09e8d0' },
};

/** Resolve the RPC for a chain without ever exposing the key in labels. */
function resolveRpc(chain, evmCfg) {
  const c = EVM[chain]; if (!c) return null;
  if (evmCfg.rpc[chain]) return { url: evmCfg.rpc[chain], source: 'custom RPC (env)' };
  if (evmCfg.alchemyKey) return { url: `https://${c.alchemy}.g.alchemy.com/v2/${evmCfg.alchemyKey}`, source: 'Alchemy' };
  if (evmCfg.infuraKey) return { url: `https://${c.infura}.infura.io/v3/${evmCfg.infuraKey}`, source: 'Infura' };
  if (evmCfg.publicFallback) return { url: c.publicRpc, source: 'public RPC (publicnode)' };
  return null;
}

/** Resolve a websocket RPC for push triggers (EVM_WS_URL_<CHAIN> > Alchemy > Infura > public wss). Never labelled with the URL. */
const PUBLIC_WS = { ethereum: 'wss://ethereum-rpc.publicnode.com', base: 'wss://base-rpc.publicnode.com', arbitrum: 'wss://arbitrum-one-rpc.publicnode.com' };
function resolveWs(chain, evmCfg) {
  const c = EVM[chain]; if (!c) return null; const ws = evmCfg.ws || {};
  if (ws[chain]) return { url: ws[chain], source: 'custom WS (env)' };
  if (evmCfg.alchemyKey) return { url: `wss://${c.alchemy}.g.alchemy.com/v2/${evmCfg.alchemyKey}`, source: 'Alchemy' };
  if (evmCfg.infuraKey) return { url: `wss://${c.infura}.infura.io/ws/v3/${evmCfg.infuraKey}`, source: 'Infura' };
  if (evmCfg.publicFallback) return { url: PUBLIC_WS[chain], source: 'publicnode' };
  return null;
}

/** Classify one Helius enhanced transaction into a SOL/stable flow (pure; tested). */
function classifySolanaTx(tx, solPx) {
  const user = tx.feePayer; let stableIn = 0, stableOut = 0, solIn = 0, solOut = 0, stableMoved = 0, solMoved = 0;
  for (const t of tx.tokenTransfers || []) {
    const amt = +t.tokenAmount || 0;
    if (STABLE_MINTS[t.mint]) { stableMoved = Math.max(stableMoved, amt); if (t.toUserAccount === user) stableIn += amt; if (t.fromUserAccount === user) stableOut += amt; }
    else if (t.mint === SOL_MINT) { solMoved = Math.max(solMoved, amt); if (t.toUserAccount === user) solIn += amt; if (t.fromUserAccount === user) solOut += amt; }
  }
  for (const n of tx.nativeTransfers || []) {
    const sol = (+n.amount || 0) / 1e9; if (sol < 1) continue; // ignore rent/fee dust
    solMoved = Math.max(solMoved, sol); if (n.toUserAccount === user) solIn += sol; if (n.fromUserAccount === user) solOut += sol;
  }
  let dir = 'transfer', usd = Math.max(stableMoved, solMoved * (solPx || 0));
  if (tx.type === 'SWAP' || (stableOut > 0 && solIn > 0) || (solOut > 0 && stableIn > 0)) {
    if (stableOut > 0 && solIn > 0) { dir = 'buy'; usd = stableOut; }
    else if (solOut > 0 && stableIn > 0) { dir = 'sell'; usd = stableIn; }
  }
  return { dir, usd, asset: 'SOL' };
}

/** Decode a Uniswap v3 Swap log: positive amount = pool received. (pure; tested) */
function decodeV3Swap(dataHex, stableIsToken0) {
  const d = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
  const word = (i) => { let v = BigInt('0x' + d.slice(i * 64, i * 64 + 64)); if (v >= 1n << 255n) v -= 1n << 256n; return v; };
  const a0 = word(0), a1 = word(1);
  const stable = stableIsToken0 ? a0 : a1, weth = stableIsToken0 ? a1 : a0;
  return { stableUsd: Math.abs(Number(stable)) / 1e6, eth: Math.abs(Number(weth)) / 1e18, dir: stable > 0n ? 'buy' : 'sell' }; // pool got USDC => trader bought ETH
}

class SolanaWhaleFeed {
  constructor({ health, apiKey, watch, minUsd, priceFn, pollMs = 15000 }) {
    this.health = health; this.apiKey = apiKey; this.minUsd = minUsd; this.priceFn = priceFn; this.pollMs = pollMs;
    this.watch = watch && watch.length ? watch.map((a) => ({ addr: a, label: a.slice(0, 4) + '…' + a.slice(-4) })) : DEFAULT_SOL_WATCH;
    this.mode = apiKey ? 'live' : 'mock'; this.events = []; this.seen = new Set(); this.scanned = 0;
    health.register('whale.solana', { label: 'Solana large tx (Helius)', group: 'whales', kind: this.mode, note: apiKey ? `Helius enhanced tx · ${this.watch.length} accounts · sampled` : 'MOCK: set HELIUS_API_KEY for live data' });
  }
  start() {
    this.poll(); this.timer = setInterval(() => this.poll(), this.pollMs);
    if (this.mode === 'live') {
      // Helius standard websocket (logsSubscribe on each watched account) → triggers an immediate enhanced-tx fetch.
      // REST polling stays on as the fallback; the key is only used inside the server process.
      this.health.register('ws.helius', { label: 'Helius websocket (logsSubscribe)', group: 'websocket', transport: 'ws', staleMs: 120000, note: 'push trigger for Solana whale scan; REST poll is the fallback' });
      this.ws = new WsClient({ url: `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.apiKey)}`, health: this.health, id: 'ws.helius', pingMs: 30000, ping: { jsonrpc: '2.0', id: 0, method: 'getHealth' },
        onOpen: (c) => this.watch.forEach((w, i) => c.send({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [w.addr] }, { commitment: 'confirmed' }] })),
        onMessage: (txt) => { const m = JSON.parse(txt); if (m.method === 'logsNotification') { this.wsEvents = (this.wsEvents || 0) + 1; this.trigger(); } return null; } });
      this.ws.start();
    }
  }
  trigger() { if (this.pending) return; this.pending = setTimeout(() => { this.pending = null; this.poll(); }, 3000); }
  stop() { clearInterval(this.timer); this.ws && this.ws.stop(); clearTimeout(this.pending); }
  async poll() {
    if (this.mode === 'mock') return this.mockTick();
    if (this.busy) return; this.busy = true;
    try { await this.pollInner(); } finally { this.busy = false; }
  }
  async pollInner() {
    for (const w of this.watch) {
      try {
        const txs = await fetchJson(`https://api.helius.xyz/v0/addresses/${w.addr}/transactions?api-key=${encodeURIComponent(this.apiKey)}&limit=50`, { health: this.health, id: 'whale.solana', timeoutMs: 10000 });
        const px = this.priceFn('SOL');
        for (const tx of txs.reverse()) {
          if (this.seen.has(tx.signature) || tx.transactionError) continue; this.seen.add(tx.signature); this.scanned++;
          const c = classifySolanaTx(tx, px);
          if (c.usd >= this.minUsd * 0.1) this.push({ t: tx.timestamp * 1000, chain: 'solana', asset: 'SOL', dir: c.dir, usd: c.usd, whale: c.usd >= this.minUsd,
            desc: `${c.dir === 'transfer' ? 'transfer' : c.dir + ' SOL'} via ${tx.source || '?'} @ ${w.label}`, url: 'https://solscan.io/tx/' + tx.signature, mock: false });
        }
      } catch (e) { /* health already marked down; error redacted */ void redact(e.message); }
    }
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000));
  }
  mockTick() {
    this.health.ok('whale.solana', 0);
    const px = this.priceFn('SOL') || 150; const n = Math.random() < 0.6 ? 1 : 0;
    for (let i = 0; i < n; i++) { const usd = this.minUsd * (0.1 + Math.random() * 2.5); const dir = Math.random() < 0.5 ? 'buy' : 'sell';
      this.push({ t: Date.now(), chain: 'solana', asset: 'SOL', dir, usd, whale: usd >= this.minUsd, desc: `MOCK ${dir} ${(usd / px).toFixed(0)} SOL`, mock: true }); }
  }
  push(ev) { this.events.unshift(ev); if (this.events.length > 300) this.events.pop(); }
  snapshot() { return { mode: this.mode, scanned: this.scanned, events: this.events.length, transport: this.ws && this.ws.open ? 'ws-trigger + rest' : 'rest poll', wsEvents: this.wsEvents || 0 }; }
}

class EvmWhaleFeed {
  constructor({ health, chain, evmCfg, minUsd, priceFn }) {
    this.health = health; this.chain = chain; this.c = EVM[chain]; this.minUsd = minUsd; this.priceFn = priceFn;
    this.evmCfg = evmCfg; const r = resolveRpc(chain, evmCfg); this.rpc = r && r.url; this.source = r ? r.source : 'none';
    this.mode = r ? 'live' : 'mock'; this.events = []; this.last = 0; this.blocksScanned = 0; this.stableIs0 = null;
    this.hid = 'whale.' + chain;
    health.register(this.hid, { label: `${chain} large tx (${this.source})`, group: 'whales', kind: this.mode,
      note: r ? 'USDC/USDT/WETH transfers + Uniswap v3 WETH/USDC swaps' : 'MOCK: set EVM_RPC_URL_* / ALCHEMY_API_KEY / INFURA_API_KEY or EVM_PUBLIC_RPC_FALLBACK=true' });
  }
  async rpcCall(method, params) {
    const j = await fetchJson(this.rpc, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, health: this.health, id: this.hid, timeoutMs: 10000 });
    if (j.error) { const e = new Error(`RPC ${method}: ${j.error.message}`); this.health.fail(this.hid, redact(e.message)); throw e; }
    return j.result;
  }
  start() {
    this.poll(); this.timer = setInterval(() => this.poll(), this.c.pollMs);
    const w = this.mode === 'live' && resolveWs(this.chain, this.evmCfg);
    if (w) {
      // newHeads push → scan the new block immediately; the REST interval remains as the fallback.
      const id = 'ws.' + this.chain; this.wsSource = w.source;
      this.health.register(id, { label: `${this.chain} newHeads WS (${w.source})`, group: 'websocket', transport: 'ws', staleMs: this.chain === 'ethereum' ? 60000 : 30000, note: 'push trigger for EVM whale scan' });
      this.ws = new WsClient({ url: w.url, health: this.health, id, pingMs: 0,
        onOpen: (c) => c.send({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }),
        onMessage: (txt) => { const m = JSON.parse(txt); if (m.method === 'eth_subscription') { this.heads = (this.heads || 0) + 1; this.poll(); return parseInt(m.params.result.timestamp, 16) * 1000; } return null; } });
      this.ws.start();
    }
  }
  stop() { clearInterval(this.timer); this.ws && this.ws.stop(); }
  async poll() {
    if (this.mode === 'mock') return this.mockTick();
    if (this.busy) return; this.busy = true;
    try {
      if (this.stableIs0 === null) { const t0 = await this.rpcCall('eth_call', [{ to: this.c.pool, data: '0x0dfe1681' }, 'latest']); const tok0 = '0x' + t0.slice(-40).toLowerCase(); this.stableIs0 = (this.c.tokens[tok0] || [])[0] !== 'WETH'; }
      const head = parseInt(await this.rpcCall('eth_blockNumber', []), 16);
      const from = this.last ? Math.max(this.last + 1, head - this.c.maxSpan) : head - Math.min(3, this.c.maxSpan);
      if (from > head) return;
      const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) };
      const [swaps, transfers] = await Promise.all([
        this.rpcCall('eth_getLogs', [{ ...range, address: this.c.pool, topics: [SWAP_V3_TOPIC] }]),
        this.rpcCall('eth_getLogs', [{ ...range, address: Object.keys(this.c.tokens), topics: [TRANSFER_TOPIC] }]),
      ]);
      this.blocksScanned += head - from + 1; this.last = head;
      const ethPx = this.priceFn('ETH'); const byTx = new Map();
      for (const l of swaps) { const s = decodeV3Swap(l.data, this.stableIs0); const ev = { usd: s.stableUsd, dir: s.dir, desc: `Uniswap v3 ${s.dir} ${s.eth.toFixed(2)} ETH` }; keep(byTx, l.transactionHash, ev, true); }
      for (const l of transfers) {
        const [sym, dec] = this.c.tokens[l.address.toLowerCase()] || []; if (!sym || l.topics.length < 3) continue;
        const amt = Number(BigInt(l.data === '0x' ? '0x0' : l.data)) / 10 ** dec; const usd = sym === 'WETH' ? amt * (ethPx || 0) : amt;
        keep(byTx, l.transactionHash, { usd, dir: 'transfer', desc: `${sym} transfer ${amt.toLocaleString('en-US', { maximumFractionDigits: sym === 'WETH' ? 2 : 0 })} ${short(l.topics[1])}→${short(l.topics[2])}` }, false);
      }
      for (const [hash, ev] of byTx) if (ev.usd >= this.minUsd * 0.1) this.push({ t: Date.now(), chain: this.chain, asset: 'ETH', ...ev, whale: ev.usd >= this.minUsd, url: this.c.explorer + hash, mock: false });
    } catch { /* health marked down */ } finally { this.busy = false; }
  }
  mockTick() {
    this.health.ok(this.hid, 0);
    if (Math.random() < 0.5) { const usd = this.minUsd * (0.1 + Math.random() * 2.5); const dir = ['buy', 'sell', 'transfer'][Math.floor(Math.random() * 3)];
      this.push({ t: Date.now(), chain: this.chain, asset: 'ETH', dir, usd, whale: usd >= this.minUsd, desc: `MOCK ${dir}`, mock: true }); }
  }
  push(ev) { this.events.unshift(ev); if (this.events.length > 300) this.events.pop(); }
  snapshot() { return { mode: this.mode, source: this.source, blocksScanned: this.blocksScanned, head: this.last, transport: this.ws && this.ws.open ? `newHeads WS (${this.wsSource}) + rest` : 'rest poll', heads: this.heads || 0 }; }
}
const short = (topic) => '0x' + topic.slice(-40, -36) + '…' + topic.slice(-4);
function keep(map, hash, ev, isSwap) { const cur = map.get(hash); if (!cur || (isSwap && !cur.isSwap) || (!cur.isSwap && ev.usd > cur.usd)) map.set(hash, { ...ev, isSwap }); }

module.exports = { SolanaWhaleFeed, EvmWhaleFeed, classifySolanaTx, decodeV3Swap, resolveRpc, resolveWs, EVM };
