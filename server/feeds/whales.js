'use strict';
// Large-transaction monitors.
//  - Solana: Helius webhook push (default when configured) or an opt-in, budget-guarded Parsed Events slow poll. See SolanaWhaleFeed.
//  - EVM (ethereum/base/arbitrum): JSON-RPC eth_getLogs for big USDC/USDT/WETH transfers plus
//    directional Uniswap v3 WETH/USDC swaps. RPC from env (explicit URL > Alchemy > Infura > public fallback).
//  - Anything unconfigured runs a clearly labeled MOCK generator (every event tagged mock:true).
const { fetchJson, redact } = require('../lib/net');
const { WsClient } = require('../lib/ws');
const H = require('./helius');

// PUBLIC IDENTIFIERS, NOT SECRETS: token mints, public pool addresses, and the keccak256 event topics of
// ERC-20 Transfer and Uniswap-v3 Swap. Scanners flag the 64-hex topics; see .gitleaks.toml.
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

/**
 * Solana large-transaction feed. Modes (HELIUS_MODE):
 *   webhook (default when HELIUS_WEBHOOK_AUTH is set): receive-only. Helius pushes enhanced transactions to POST /hooks/helius
 *            (1 credit/event). Nothing is polled. Needs a publicly reachable HTTPS URL (see README).
 *   poll     opt-in slow fallback: Parsed Events (10 credits/request) every HELIUS_POLL_SEC (>= 300 s) per watched address,
 *            hard-stopped by the monthly HELIUS_CREDIT_BUDGET guard.
 *   mock     (default otherwise): labelled synthetic events (mock:true). No Helius calls at all.
 *   off      no events.
 * The old loop (Enhanced Tx REST every 15 s + logsSubscribe-triggered extra polls, ~1.15M credits/day) was removed.
 */
class SolanaWhaleFeed {
  constructor({ health, apiKey, watch, minUsd, priceFn, mode, enabled = true, webhookAuth = '', pollSec = 900, pollLimit = 25, budget = null, pauseRemote = null, fetchImpl, now = () => Date.now() }) {
    this.health = health; this.apiKey = apiKey; this.minUsd = minUsd; this.priceFn = priceFn; this.now = now; this.fetchImpl = fetchImpl; this.enabled = enabled; this.pauseRemote = pauseRemote;
    this.watchConfigured = !!(watch && watch.length); // live modes watch ONLY configured wallets; the pool list is just for MOCK labels
    this.watch = this.watchConfigured ? watch.map((a) => ({ addr: a, label: a.slice(0, 4) + '…' + a.slice(-4) })) : DEFAULT_SOL_WATCH;
    this.watchSet = new Set(this.watchConfigured ? watch : []); this.autoPaused = null; this.dropped = 0;
    this.webhookAuth = webhookAuth; this.pollSec = Math.max(H.MIN_POLL_SEC, +pollSec || 900); this.pollLimit = Math.min(100, Math.max(1, +pollLimit || 25));
    this.budget = budget; // CreditBudget (server/lib/credits.js); shared by poll + webhook accounting
    this.mode = mode || (webhookAuth ? 'webhook' : 'mock');
    if (this.mode === 'poll' && (!apiKey || !this.watchConfigured)) this.mode = 'mock'; // never poll without a key or the default busy pools
    this.events = []; this.seen = new Set(); this.scanned = 0; this.webhook = { deliveries: 0, events: 0, dupes: 0, rejected: 0, firstAt: null, lastAt: null }; this.pollStats = { calls: 0, refused: 0, lastAt: null };
    this.listeners = [];
    const notes = {
      webhook: `webhook receiver (POST /hooks/helius) · 1 credit/event · ${this.watch.length} accounts · awaiting deliveries`,
      poll: `OPT-IN slow poll: Parsed Events every ${this.pollSec}s × ${this.watch.length} accounts (10 credits/call, budget-guarded)`,
      mock: enabled ? `MOCK: no Helius calls. Configure the webhook (HELIUS_WEBHOOK_AUTH) or HELIUS_MODE=poll with HELIUS_WATCH_ADDRESSES` : 'DEMO (MOCK): whale feed is OFF by default; set WHALES_ENABLED=true to use Helius. No Helius calls are made',
      off: 'disabled (HELIUS_MODE=off)',
    };
    health.register('whale.solana', { label: 'Solana large tx (Helius)', group: 'whales', kind: this.mode === 'mock' ? 'mock' : 'live', transport: this.mode === 'webhook' ? 'webhook' : 'rest',
      staleMs: this.mode === 'poll' ? this.pollSec * 2500 : 6 * 3.6e6, note: notes[this.mode] });
  }
  /** Subscribe to every accepted real transaction (used by wallet-follow). */
  onTx(fn) { this.listeners.push(fn); }
  start() {
    if (this.mode === 'mock') { this.mockTick(); this.timer = setInterval(() => this.mockTick(), 15000); }
    else if (this.mode === 'poll') { this.poll(); this.timer = setInterval(() => this.poll(), this.pollSec * 1000); }
  }
  stop() { clearInterval(this.timer); }
  /** Webhook ingress: already authenticated + parsed by server/feeds/helius.js handleWebhook. Each delivered tx = 1 credit. */
  ingestWebhook(txs) {
    const n = txs.length; const t = this.now(); this.webhook.deliveries++; this.webhook.events += n; this.webhook.firstAt = this.webhook.firstAt || t; this.webhook.lastAt = t;
    if (this.budget) this.budget.record(n * H.CREDITS.webhookEvent, 'webhook-events');
    if (this.checkPause()) { this.dropped += n; return 0; } // billed by Helius, but we stop acting on them while paused
    let accepted = 0; for (const tx of txs) { if (!this.involvesWatched(tx)) { this.dropped++; continue; } if (this.ingestTx(tx, 'webhook')) accepted++; else this.webhook.dupes++; }
    const maxTs = txs.reduce((m, x) => Math.max(m, +x.timestamp || 0), 0);
    if (this.mode === 'webhook') this.health.ok('whale.solana', maxTs ? Math.max(0, t - maxTs * 1000) : 0); // latency = block time → receipt
    return accepted;
  }
  /** Only configured whale wallets count (a mis-scoped webhook must not flood the desk). */
  involvesWatched(tx) {
    if (!this.watchSet.size) return false;
    const ws = this.watchSet, hit = (a) => a && ws.has(a);
    return hit(tx.feePayer) || (tx.accountData || []).some((a) => hit(a.account)) || (tx.tokenTransfers || []).some((t) => hit(t.fromUserAccount) || hit(t.toUserAccount)) || (tx.nativeTransfers || []).some((t) => hit(t.fromUserAccount) || hit(t.toUserAccount));
  }
  /** Auto-pause near the hard cap. Webhook mode also asks Helius to deactivate the webhook (once per UTC day) when configured. */
  checkPause() {
    if (!this.budget || !this.budget.paused()) { if (this.autoPaused && this.autoPaused.day !== this.budget.today()) this.autoPaused = null; return false; }
    const day = this.budget.today(); if (this.autoPaused && this.autoPaused.day === day) return true;
    const v = this.budget.view(); this.autoPaused = { day, at: this.now(), usedToday: v.usedToday, dailyBudget: v.dailyBudget, remote: null };
    const msg = `AUTO-PAUSED at ${v.pauseAtPct}% of the credit cap (${v.usedToday}/${v.dailyBudget} today, ${v.used}/${v.budget} this month)`;
    this.health.setKind('whale.solana', 'live', msg); this.health.fail('whale.solana', msg);
    if (this.mode === 'webhook' && this.pauseRemote) {
      this.autoPaused.remote = 'pending'; this.budget.record(H.CREDITS.webhookManage, 'webhook-manage');
      Promise.resolve(this.pauseRemote()).then((r) => { this.autoPaused.remote = r && r.ok ? 'webhook deactivated (resume with scripts/helius-webhook.js resume --apply)' : 'remote pause failed: ' + ((r && r.error) || '?'); });
    } else if (this.mode === 'webhook') this.autoPaused.remote = 'remote pause not configured (set HELIUS_API_KEY + HELIUS_WEBHOOK_URL): Helius keeps billing deliveries, pause it manually';
    return true;
  }
  /** Shared path for webhook + poll. Dedupes by signature (Helius may deliver duplicates). Returns false if skipped. */
  ingestTx(tx, origin) {
    if (!tx || !tx.signature || this.seen.has(tx.signature) || tx.transactionError) return false;
    this.seen.add(tx.signature); this.scanned++; if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000));
    const c = classifySolanaTx(tx, this.priceFn('SOL'));
    const w = this.watch.find((x) => x.addr === tx.feePayer || (tx.accountData || []).some((a) => a.account === x.addr));
    for (const fn of this.listeners) { try { fn(tx, c, origin); } catch { /* listener bugs must not break ingest */ } }
    if (c.usd >= this.minUsd * 0.1) this.push({ t: (+tx.timestamp || this.now() / 1000) * 1000, chain: 'solana', asset: 'SOL', dir: c.dir, usd: c.usd, whale: c.usd >= this.minUsd,
      desc: `${c.dir === 'transfer' ? 'transfer' : c.dir + ' SOL'} via ${tx.source || '?'}${w ? ' @ ' + w.label : ''} (${origin})`, url: 'https://solscan.io/tx/' + tx.signature, mock: false });
    return true;
  }
  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      for (const w of this.watch) {
        if (this.budget && this.checkPause()) { this.pollStats.refused++; break; }
        if (!this.budget || !this.budget.trySpend(H.CREDITS.parsedHistory, 'parsed-history')) {
          this.pollStats.refused++; this.health.setKind('whale.solana', 'live', `credit budget reached (${this.budget ? this.budget.view().used : '?'} used): poll paused until next month or raise HELIUS_CREDIT_BUDGET`);
          this.health.fail('whale.solana', 'credit budget guard: poll refused'); break;
        }
        try {
          const t0 = Date.now(); const txs = await H.fetchParsedHistory({ apiKey: this.apiKey, address: w.addr, limit: this.pollLimit, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) });
          this.pollStats.calls++; this.pollStats.lastAt = this.now(); this.health.ok('whale.solana', Date.now() - t0);
          for (const tx of txs.reverse()) this.ingestTx(tx, 'poll');
        } catch (e) { this.health.fail('whale.solana', redact(String(e.message || e)).split(this.apiKey || '\u0000').join('***')); }
      }
    } finally { this.busy = false; }
  }
  mockTick() {
    this.health.ok('whale.solana', 0);
    const px = this.priceFn('SOL') || 150; const n = Math.random() < 0.6 ? 1 : 0;
    for (let i = 0; i < n; i++) { const usd = this.minUsd * (0.1 + Math.random() * 2.5); const dir = Math.random() < 0.5 ? 'buy' : 'sell';
      this.push({ t: Date.now(), chain: 'solana', asset: 'SOL', dir, usd, whale: usd >= this.minUsd, desc: `MOCK ${dir} ${(usd / px).toFixed(0)} SOL`, mock: true }); }
  }
  push(ev) { this.events.unshift(ev); if (this.events.length > 300) this.events.pop(); }
  /** Client-safe credit view for the Data Sources panel (no secrets). */
  credits() {
    const n = this.watch.length, b = this.budget ? this.budget.view() : null;
    const est = this.mode === 'poll' ? H.estimates.pollPerMonth(n, this.pollSec) : this.mode === 'webhook' ? H.estimates.webhookPerMonth(this.webhook.events, this.webhook.firstAt, this.now()) : 0;
    return { provider: 'helius', mode: this.mode, unit: 'credits', planMonthly: H.CREDITS.freePlanMonthly, estMonthly: est,
      estBasis: this.mode === 'poll' ? `${n} addr × 10 cr × every ${this.pollSec}s × 30 d` : this.mode === 'webhook' ? (est == null ? '1 cr/event; estimate after 1 h of deliveries' : `observed ${this.webhook.events} events → ×30 d`) : 'no Helius calls in this mode',
      enabled: this.enabled, watchConfigured: this.watchConfigured, watching: this.watchConfigured ? n : 0, dropped: this.dropped, autoPaused: this.autoPaused,
      dailyBudget: b && b.dailyBudget, usedToday: b && b.usedToday, pauseAtPct: b && b.pauseAtPct, paused: !!(b && b.paused),
      estDaily: est == null ? null : Math.round(est / 30),
      legacyPerDay: H.estimates.legacyPerDay(2, 15), budget: b && b.budget, used: b && b.used, remaining: b && b.remaining, refused: b && b.refused, overBudget: !!(b && b.overBudget), month: b && b.month,
      webhook: { ...this.webhook, receiverEnabled: !!this.webhookAuth }, poll: this.mode === 'poll' ? { ...this.pollStats, everySec: this.pollSec } : null };
  }
  publicInfo() { return { credits: this.credits() }; }
  snapshot() { return { mode: this.mode, scanned: this.scanned, events: this.events.length, transport: this.mode === 'webhook' ? 'webhook push' : this.mode === 'poll' ? `parsed-events poll /${this.pollSec}s` : this.mode, credits: this.credits() }; }
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

module.exports = { DEFAULT_SOL_WATCH, SolanaWhaleFeed, EvmWhaleFeed, classifySolanaTx, decodeV3Swap, resolveRpc, resolveWs, EVM };
