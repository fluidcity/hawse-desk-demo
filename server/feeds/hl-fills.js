'use strict';
// Hyperliquid wallet fills (batch-1 H3). Every HL account's fills are public: POST /info {"type":"userFills","user":addr}
// (no key, no credits). One wallet is polled per slot, staggered so the whole list cycles once per `pollMs`.
// New fills are found by tid, grouped by order id, and turned into wallet signals (open / increase / reduce / flip).
// Only fills AFTER max(feed start, wallet add date) count: no history replay, no look-ahead.
const { fetchJson } = require('../lib/net');

const HL_INFO = 'https://api.hyperliquid.xyz/info';

/** Normalize one raw HL fill (pure). Returns null for spot fills ("@107", "PURR/USDC") and malformed rows. */
function parseFill(f) {
  if (!f || typeof f.coin !== 'string' || f.coin.startsWith('@') || f.coin.includes('/') || f.coin.includes(':')) return null;
  const px = +f.px, sz = +f.sz, time = +f.time, startPos = +f.startPosition;
  if (!(px > 0) || !(sz > 0) || !time || !Number.isFinite(startPos)) return null;
  return { coin: f.coin, px, sz, side: f.side === 'B' ? 'buy' : 'sell', time, startPos, dir: f.dir || '', closedPnl: +f.closedPnl || 0, fee: +f.fee || 0, hash: f.hash || '', oid: f.oid, tid: f.tid };
}

/**
 * Group fills by order (oid, else hash) and classify the position change (pure; tested).
 * Returns signals sorted by time: {t, chain, wallet, asset, side, usd, srcTx, kind, frac, px, posBefore, posAfter}
 *  - kind 'open' | 'increase': side = new position side, usd = added notional (must be ≥ minUsd)
 *  - kind 'reduce': side = the side being reduced, frac = share of the position closed (0..1]
 *  - a flip (long → short) yields a full 'reduce' of the old side plus an 'open' of the new one
 */
function fillsToSignals(raw, { wallet, addedAt = 0, minUsd = 50000 } = {}) {
  const groups = new Map();
  for (const r of raw) {
    const f = parseFill(r); if (!f || f.time < addedAt) continue;
    const k = f.coin + '|' + (f.oid != null ? f.oid : f.hash); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f);
  }
  const out = [];
  for (const fs of groups.values()) {
    fs.sort((a, b) => a.time - b.time || (a.tid > b.tid ? 1 : -1));
    const posBefore = fs[0].startPos; let qty = 0, ntl = 0;
    for (const f of fs) { qty += f.side === 'buy' ? f.sz : -f.sz; ntl += f.px * f.sz; }
    const posAfter = +(posBefore + qty).toFixed(10), px = ntl / fs.reduce((a, f) => a + f.sz, 0), t = fs[fs.length - 1].time;
    const base = { t, chain: 'hyperliquid', wallet, asset: fs[0].coin, srcTx: fs[fs.length - 1].hash, px, posBefore, posAfter };
    const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const flipped = sgn(posBefore) !== 0 && sgn(posAfter) !== 0 && sgn(posBefore) !== sgn(posAfter);
    if (flipped || (sgn(posBefore) !== 0 && Math.abs(posAfter) < Math.abs(posBefore))) {
      const frac = flipped ? 1 : (Math.abs(posBefore) - Math.abs(posAfter)) / Math.abs(posBefore);
      out.push({ ...base, kind: 'reduce', side: posBefore > 0 ? 'long' : 'short', frac, usd: Math.abs(posBefore) * frac * px });
    }
    const added = flipped ? Math.abs(posAfter) : Math.abs(posAfter) > Math.abs(posBefore) ? Math.abs(posAfter) - Math.abs(posBefore) : 0;
    if (added > 0 && added * px >= minUsd) out.push({ ...base, kind: sgn(posBefore) === 0 || flipped ? 'open' : 'increase', side: posAfter > 0 ? 'long' : 'short', frac: null, usd: added * px });
  }
  return out.sort((a, b) => a.t - b.t);
}

class HlFillsFeed {
  /** wallets: array or () => array of {addr, label, addedAt}. fetch is injectable for tests. */
  constructor({ health, wallets = [], pollMs = 30000, minUsd = 50000, fetch = fetchJson, now = Date.now } = {}) {
    this.health = health; this.walletsFn = typeof wallets === 'function' ? wallets : () => wallets; this.pollMs = Math.max(10000, pollMs);
    this.minUsd = minUsd; this.fetch = fetch; this.now = now; this.startedAt = now();
    this.cursor = new Map(); this.seen = new Map(); this.signals = []; this.listeners = []; this.slot = 0; this.calls = 0; this.errors = 0;
    if (health) health.register('follow.hl', { label: 'Hyperliquid wallet fills (userFills)', group: 'whales', kind: 'live', transport: 'rest', staleMs: this.pollMs * 4,
      note: this.wallets().length ? `${this.wallets().length} wallet(s), each polled once per ${Math.round(this.pollMs / 1000)} s · public, no key` : 'no wallets configured (FOLLOW_WALLETS_HL or data/watchlist.json): idle, no calls' });
  }
  get mode() { return this.wallets().length ? 'live' : 'off'; }
  wallets() { return (this.walletsFn() || []).filter((w) => w && /^0x[0-9a-fA-F]{40}$/.test(w.addr)); }
  onSignal(fn) { this.listeners.push(fn); }
  start() {
    const ws = this.wallets(); if (!ws.length) return;
    const every = Math.max(1000, Math.floor(this.pollMs / ws.length)); // stagger: one wallet per slot
    this.timer = setInterval(() => this.pollNext().catch(() => {}), every); this.pollNext().catch(() => {});
  }
  stop() { clearInterval(this.timer); }
  async pollNext() { const ws = this.wallets(); if (!ws.length) return []; const w = ws[this.slot++ % ws.length]; return this.pollWallet(w); }
  async pollWallet(w) {
    this.calls++;
    let raw; try { raw = await this.fetch(HL_INFO, { method: 'POST', body: { type: 'userFills', user: w.addr }, health: this.health, id: 'follow.hl', timeoutMs: 10000 }); }
    catch { this.errors++; return []; }
    return this.ingest(w, Array.isArray(raw) ? raw : []);
  }
  /** Diff by tid against what was already seen for this wallet; emit signals for genuinely new fills only. */
  ingest(w, raw) {
    const key = w.addr.toLowerCase(), floor = Math.max(this.startedAt, +w.addedAt || 0);
    const seen = this.seen.get(key) || new Set(); this.seen.set(key, seen);
    const fresh = raw.filter((f) => f && f.tid != null && !seen.has(f.tid) && +f.time >= floor);
    for (const f of raw) if (f && f.tid != null) seen.add(f.tid);
    if (seen.size > 5000) this.seen.set(key, new Set([...seen].slice(-3000)));
    this.cursor.set(key, Math.max(this.cursor.get(key) || 0, ...raw.map((f) => +f.time || 0)));
    const sig = fillsToSignals(fresh, { wallet: w.addr, addedAt: floor, minUsd: this.minUsd }).map((s) => ({ ...s, label: w.label || null, receivedAt: this.now() }));
    for (const s of sig) { this.signals.unshift(s); for (const fn of this.listeners) { try { fn(s); } catch { /* listener bugs must not break ingest */ } } }
    if (this.signals.length > 200) this.signals.length = 200;
    return sig;
  }
  snapshot() { return { mode: this.mode, wallets: this.wallets().map((w) => ({ addr: w.addr, label: w.label || null, addedAt: w.addedAt || null })), calls: this.calls, errors: this.errors, pollMs: this.pollMs, signals: this.signals.slice(0, 40) }; }
}

module.exports = { HlFillsFeed, parseFill, fillsToSignals, HL_INFO };
