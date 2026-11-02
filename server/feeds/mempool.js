'use strict';
// Ethereum mempool OBSERVER for the mempool lab (batch-1 H4). MEASUREMENT ONLY.
// It subscribes to pending transactions and new block headers, filters to Uniswap routers client-side, and makes
// read-only JSON-RPC calls (eth_call for reserves, blocks, receipts, nonces). There is no code path that builds,
// authorizes or broadcasts a transaction: rpc() refuses any method outside READ_ONLY_METHODS (see test/mev-lab.test.js).
//
// Off unless MEMPOOL_ENABLED=true. Sources, in order: ALCHEMY_API_KEY (alchemy_pendingTransactions with a router
// filter; key read server-side only and never shown), else MEMPOOL_WS_URL (default: the free public publicnode
// endpoint, eth_subscribe newPendingTransactions with full objects). Both only show THEIR node's view of the
// mempool; private order flow (Flashbots Protect, MEV Blocker, …) is invisible to us by design.
const { WsClient } = require('../lib/ws');
const { fetchJson, redact } = require('../lib/net');
const { ROUTERS, decodeTx } = require('../mev/decode');

const READ_ONLY_METHODS = Object.freeze(new Set(['eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_getTransactionByHash']));
const PUBLIC_WS = 'wss://ethereum-rpc.publicnode.com';
const PUBLIC_HTTP = 'https://ethereum-rpc.publicnode.com';

class MempoolFeed {
  constructor({ health, cfg = {}, fetch = fetchJson, maxInFlight = 4 } = {}) {
    this.health = health; this.cfg = cfg; this.fetch = fetch; this.maxInFlight = maxInFlight; this.inFlight = 0; this.queue = [];
    this.enabled = !!cfg.enabled; this.listeners = { pending: [], head: [], seen: [] };
    this.stats = { pendingSeen: 0, routerTxs: 0, decoded: 0, undecoded: 0, unsupported: 0, rpcCalls: 0, rpcErrors: 0, heads: 0, since: Date.now() };
    const key = cfg.alchemyKey; this.source = !this.enabled ? 'off' : key ? 'alchemy' : 'public';
    this.wsUrl = key ? `wss://eth-mainnet.g.alchemy.com/v2/${key}` : cfg.wsUrl || PUBLIC_WS;
    this.httpUrl = key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : cfg.rpcUrl || PUBLIC_HTTP;
    this.label = this.source === 'alchemy' ? 'Alchemy (key set, server-side)' : this.source === 'public' ? redact(this.wsUrl) : 'off';
    if (health) {
      health.register('mempool.ws', { label: 'Ethereum pending txs + heads', group: 'websocket', transport: 'ws', staleMs: 60000,
        note: this.enabled ? `${this.label} · read-only, measurement only` : 'MEMPOOL_ENABLED=false: not connected, no calls' });
      health.register('mempool.rpc', { label: 'Ethereum read-only RPC (reserves, blocks, receipts)', group: 'websocket', staleMs: 120000, note: this.enabled ? redact(this.httpUrl) : 'off' });
    }
  }
  get mode() { return this.enabled ? (this.ws && this.ws.open ? 'live' : 'down') : 'off'; }
  onPending(fn) { this.listeners.pending.push(fn); }
  onHead(fn) { this.listeners.head.push(fn); }
  onSeen(fn) { this.listeners.seen.push(fn); } // every pending hash (coverage)
  start() {
    if (!this.enabled) return;
    const routers = Object.keys(ROUTERS), subs = new Map();
    this.ws = new WsClient({ url: this.wsUrl, health: this.health, id: 'mempool.ws', label: 'mempool',
      onOpen: (c) => {
        const sub = (id, params) => c.send({ jsonrpc: '2.0', id, method: 'eth_subscribe', params });
        sub(1, this.source === 'alchemy' ? ['alchemy_pendingTransactions', { toAddress: routers, hashesOnly: false }] : ['newPendingTransactions', true]);
        sub(2, ['newHeads']);
      },
      onMessage: (txt) => {
        const m = JSON.parse(txt);
        if (m.id === 1 || m.id === 2) { if (m.result) subs.set(m.result, m.id === 1 ? 'pending' : 'head'); return null; }
        const p = m.params; if (!p) return null; const kind = subs.get(p.subscription); const r = p.result;
        if (kind === 'head' && r && r.number) { this.stats.heads++; this.emit('head', r); }
        else if (kind === 'pending' && r && typeof r === 'object') this.ingest(r);
        return null;
      } });
    this.ws.start();
  }
  stop() { if (this.ws) this.ws.stop(); }
  ingest(tx) {
    this.stats.pendingSeen++; if (tx.hash) this.emit('seen', tx.hash);
    if (!tx.to || !ROUTERS[tx.to.toLowerCase()]) return null; // client-side router filter (Alchemy's filter is a hint, not a guarantee)
    this.stats.routerTxs++;
    const d = decodeTx(tx); if (!d || d.undecoded) { this.stats.undecoded++; return null; }
    if (d.unsupported) { this.stats.unsupported++; return null; }
    this.stats.decoded++; const seenAt = Date.now(); this.emit('pending', { tx, d, seenAt }); return d;
  }
  emit(k, x) { for (const f of this.listeners[k]) { try { f(x); } catch (e) { /* listener bug must not kill the socket */ } } }
  /** Read-only JSON-RPC. Throws for anything that is not a read. Small in-flight cap to respect public rate limits. */
  async rpc(method, params = []) {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`mempool lab is read-only: ${method} refused`);
    if (!this.enabled) throw new Error('mempool disabled');
    if (this.inFlight >= this.maxInFlight) { if (this.queue.length > 200) throw new Error('rpc queue full'); await new Promise((r) => this.queue.push(r)); }
    this.inFlight++; this.stats.rpcCalls++;
    try {
      const j = await this.fetch(this.httpUrl, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, health: this.health, id: 'mempool.rpc', timeoutMs: 10000 });
      if (j.error) throw new Error(redact(j.error.message || 'rpc error')); return j.result;
    } catch (e) { this.stats.rpcErrors++; throw new Error(redact(e.message)); }
    finally { this.inFlight--; const n = this.queue.shift(); if (n) n(); }
  }
  snapshot() { return { mode: this.mode, source: this.source, label: this.label, stats: { ...this.stats } }; }
}
module.exports = { MempoolFeed, READ_ONLY_METHODS, PUBLIC_WS, PUBLIC_HTTP };
