'use strict';
// Live pilot chart data: REAL Kalshi balance reads and the pilot's own ledger, nothing else.
// - Balance snapshots: every balance the pilot ALREADY reads (shadow/armed shard read, preflight, pre/post-slice reads, the once-a-minute
//   all-pools read, the pool re-read after a transfer) is appended to data/live/kalshi-pilot/balances.jsonl. No extra request is ever made
//   for the chart. A repeat of the same numbers within 15 minutes is not written again (keeps the file small).
// - Transaction history: orders sent, acks, fills, rejects/not sent, settlements, transfers, arm/disarm/halt/reset, from the ledger
//   rows the pilot already writes (replayed on start). Display only: none of this changes pilot state.
// No key material, no request headers, no tokens are stored; rows hold cents, shard numbers, tickers and short Kalshi error text.
const fs = require('fs');
const path = require('path');

const SAME_ROW_GAP_MS = 15 * 60 * 1000;
const MAX_POINTS = 5000;
const MAX_TX = 300;
const VIEW_POINTS = 600;
const TX_TYPES = new Set(['order_sent', 'ack', 'fill', 'not_sent', 'settle', 'transfer', 'transfer_status', 'arm', 'disarm', 'stop', 'reset']);
const POOL = { 0: 'Default', 1: 'Combos', 2: 'Crypto & Commodities', 3: 'Sports' };
const pool = (i) => `${POOL[i] || 'shard ' + i} (shard ${i})`;
const usd = (c) => (Number.isFinite(c) ? `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}` : '—');
const U = 10000; // micro-dollars per cent
const sgn = (c) => (c > 0 ? '+' : c < 0 ? '−' : '±') + '$' + (Math.abs(c) / 100).toFixed(2);

/** Where an arm / disarm / reset came from (ledger `source`: pc | phone, plus the Tailscale login for phone; never a token). */
const via = (r) => (r && r.source === 'phone' ? ' · from phone' + (r.login ? ` (${String(r.login).slice(0, 80)})` : '') : r && r.source === 'pc' ? ' · from desk PC' : '');
/**
 * One ledger row -> one history entry (or null). Plain text, cents, no secrets.
 * tone: 'neutral' = a buy or a transfer (cash moved, not a result), 'pos' / 'neg' = a settled win / loss by its P&L, 'zero' = a settle at
 * exactly $0, 'neg' also = reject / not sent / halt / arm warning. label = the short chart marker text (e.g. "buy 5 @94c", "WIN +$0.28").
 */
function txOf(r) {
  if (!r || !TX_TYPES.has(r.t)) return null;
  const e = { at: r.at, kind: r.t, tk: r.tk || null, amountCents: null, tone: '', text: '' };
  const err = (s) => String(s || '').slice(0, 140);
  switch (r.t) {
    case 'order_sent': e.text = 'order sent'; break;
    case 'ack': e.text = `order acknowledged · filled ${r.fillCount ?? '—'}, remaining ${r.remainingCount ?? '—'}`; break;
    case 'fill': e.tone = 'neutral'; e.label = `buy ${r.count} @${Number.isFinite(r.priceMicros) ? Math.round(r.priceMicros / U) : '?'}c`; e.amountCents = Number.isFinite(r.costMicros) ? -Math.round((r.costMicros + (r.feeMicros || 0)) / U) : null;
      e.text = `fill ${r.count} @ ${Number.isFinite(r.priceMicros) ? (r.priceMicros / U).toFixed(2) + '¢' : '—'}${Number.isFinite(r.feeMicros) ? ' · fee ' + usd(Math.round(r.feeMicros / U)) : ''}${r.source ? ' · source ' + r.source : ''}`; break;
    case 'not_sent': e.tone = 'neg'; e.label = 'rejected'; e.text = 'rejected / not sent' + (r.error || r.reason ? ': ' + err(r.error || r.reason) : ''); break;
    case 'settle': e.amountCents = Number.isFinite(r.pnlMicros) ? Math.round(r.pnlMicros / U) : null; e.tone = e.amountCents > 0 ? 'pos' : e.amountCents < 0 ? 'neg' : 'zero';
      e.label = Number.isFinite(e.amountCents) ? `${e.amountCents > 0 ? 'WIN' : e.amountCents < 0 ? 'LOSS' : 'FLAT'} ${sgn(e.amountCents)}` : (r.win ? 'WIN' : 'LOSS');
      e.text = `settled ${r.result || (r.win ? 'win' : 'loss')} · ${r.contracts ?? '—'} contracts · P&L ${usd(e.amountCents)}${r.source === 'recovered' ? ' · source recovered' : ''}`; break;
    case 'transfer': e.amountCents = r.amountCents; e.tone = r.outcome === 'accepted' ? 'neutral' : 'neg'; e.label = r.outcome === 'accepted' ? 'transfer ' + usd(r.amountCents) : 'transfer failed';
      e.text = `transfer ${usd(r.amountCents)} ${pool(r.from)} → ${pool(r.to)} · ${r.outcome}${r.error ? ': ' + err(r.error) : ''}`; break;
    case 'transfer_status': e.text = `transfer status: ${r.status}`; e.tone = 'neutral'; break;
    case 'arm': e.text = 'ARMED' + (Number.isFinite(r.balanceCents) ? ` · pilot pool cash ${usd(r.balanceCents)}` : '') + via(r); e.tone = 'neg'; break;
    case 'disarm': e.text = 'disarmed (shadow)' + via(r); break;
    case 'stop': e.text = 'HALTED: ' + err(r.reason); e.tone = 'neg'; e.label = 'HALT'; break;
    case 'reset': e.text = 'reset after halt' + via(r); break;
  }
  return e;
}

class LiveHistory {
  constructor({ dir, now = Date.now }) { this.dir = dir; this.now = now; this.file = path.join(dir, 'balances.jsonl'); this.points = []; this.tx = []; this.lastBy = new Map(); this.realized = { cents: 0, n: 0, wins: 0, losses: 0, pts: [] }; }
  load() {
    this.points = []; this.lastBy.clear();
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    for (const l of lines.slice(-MAX_POINTS - 1)) { if (!l.trim()) continue; try { const p = JSON.parse(l); if (Number.isFinite(p.at)) { this.points.push(p); this.lastBy.set(p.kind, p); } } catch { /* torn line */ } }
  }
  /** Ledger row (live or replayed): keep transaction rows for the list and chart markers. */
  noteRow(r) {
    const e = txOf(r); if (!e) return; this.tx.push(e); if (this.tx.length > MAX_TX) this.tx.shift();
    if (r.t === 'settle' && Number.isFinite(e.amountCents)) { // running realized P&L (display only; the pilot's own realized total is the source of truth)
      const R = this.realized; R.cents += e.amountCents; R.n++; if (e.amountCents > 0) R.wins++; else if (e.amountCents < 0) R.losses++;
      R.pts.push([e.at, R.cents]); if (R.pts.length > MAX_TX) R.pts.shift(); e.realizedCents = R.cents;
    }
  }
  /**
   * A balance the pilot just read from Kalshi. kind 'shard' = one pool (exchangeIndex) scoped read: cash + that pool's positions value.
   * kind 'all' = all pools (balance_breakdown): shards[], total cash, all positions value. Never called with made-up numbers.
   */
  record(src, kind, b, exchangeIndex) {
    if (!b) return null;
    const p = { at: this.now(), src, kind };
    if (kind === 'shard') { if (!Number.isFinite(b.cents)) return null; p.exchangeIndex = exchangeIndex; p.cashCents = b.cents; p.pvCents = Number.isFinite(b.portfolioValueCents) ? b.portfolioValueCents : null; }
    else { const sh = Array.isArray(b.shards) ? b.shards.filter((x) => Number.isInteger(x.exchangeIndex) && Number.isFinite(x.cents)).map((x) => ({ exchangeIndex: x.exchangeIndex, cents: x.cents })) : null;
      if (!sh || !sh.length) return null; p.shards = sh; p.cashCents = sh.reduce((a, x) => a + x.cents, 0); p.pvCents = Number.isFinite(b.portfolioValueCents) ? b.portfolioValueCents : null; }
    const key = kind === 'shard' ? 'shard' + exchangeIndex : 'all', prev = this.lastBy.get(key);
    const sig = (x) => JSON.stringify([x.cashCents, x.pvCents, x.shards || null]);
    if (prev && sig(prev) === sig(p) && p.at - prev.at < SAME_ROW_GAP_MS) return null;
    p.kind = kind; this.lastBy.set(key, p);
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(p) + '\n'); } catch { return null; } // display data only: a write error never touches the pilot
    this.points.push(p); if (this.points.length > MAX_POINTS) this.points.shift();
    return p;
  }
  /** Snapshot view: points thinned to <= 600 (first and last kept), newest 40 transactions. */
  view() {
    const P = this.points, n = P.length, step = Math.max(1, Math.ceil(n / VIEW_POINTS));
    const pts = step === 1 ? P.slice() : P.filter((_, i) => i % step === 0 || i === n - 1);
    return { file: 'data/live/kalshi-pilot/balances.jsonl', count: n, first: n ? P[0].at : null, last: n ? P[n - 1].at : null, points: pts,
      tx: this.tx.slice(-40).reverse(), txCount: this.tx.length,
      realized: { cents: this.realized.cents, settled: this.realized.n, wins: this.realized.wins, losses: this.realized.losses, pts: this.realized.pts.slice() } };
  }
}

module.exports = { LiveHistory, txOf, SAME_ROW_GAP_MS };
