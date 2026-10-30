'use strict';
// Ground truth for the mempool lab (batch-1 H4). Read-only analysis of blocks that were already mined.
//  1. Heuristic sandwich detector on a full block: two txs from the SAME sender to the SAME contract, at most
//     MAX_GAP positions apart, with one or more other senders' txs between them = front-run, victim(s), back-run.
//     This is the classic adjacent-pair pattern; it misses sandwiches split across senders and can flag a few
//     non-sandwich bot pairs, so it is labelled "heuristic" everywhere.
//  2. Attacker realized gross from the two legs' receipts: the pool's Uniswap V2/V3 Swap logs give the attacker's
//     net flow of the victim's input token.
//  3. Dune `dex.sandwiched` CSV import (authoritative when present): join on the victim tx hash. No Dune API calls
//     are made by this repo (no key, and it would cost Dune credits); export the query result to CSV and import it.
const MAX_GAP = 4;
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

/** block.transactions (full objects, in order) → Map(victimHash → { front, back, attacker }). */
function detectSandwiches(txs) {
  const out = new Map(); const L = (s) => (s || '').toLowerCase();
  for (let i = 0; i < txs.length; i++) {
    const a = txs[i]; if (!a.to) continue;
    for (let j = i + 2; j <= Math.min(txs.length - 1, i + MAX_GAP + 1); j++) {
      const b = txs[j]; if (L(b.from) !== L(a.from) || L(b.to) !== L(a.to)) continue;
      const mid = txs.slice(i + 1, j).filter((t) => L(t.from) !== L(a.from));
      if (mid.length) for (const v of mid) out.set(L(v.hash), { front: L(a.hash), back: L(b.hash), attacker: L(a.from), contract: L(a.to), victims: mid.length });
      break;
    }
  }
  return out;
}

const s256 = (h) => { const x = BigInt('0x' + h); return x >= 1n << 255n ? x - (1n << 256n) : x; };
/** Change in the pool's balance of token index `idx` (0/1) from one receipt's Swap logs on `pool` (positive = pool received). */
function poolDelta(receipt, pool, idx) {
  let d = 0n, n = 0;
  for (const lg of (receipt && receipt.logs) || []) {
    if ((lg.address || '').toLowerCase() !== pool) continue; const t0 = lg.topics && lg.topics[0]; const h = (lg.data || '').slice(2);
    if (t0 === V2_SWAP) { const w = (k) => BigInt('0x' + h.slice(k * 64, k * 64 + 64)); d += idx === 0 ? w(0) - w(2) : w(1) - w(3); n++; }
    else if (t0 === V3_SWAP) { d += s256(h.slice(idx * 64, idx * 64 + 64)); n++; }
  }
  return n ? d : null;
}
/** Attacker's gross in raw units of the token at index `idx` = −(pool delta over front + back legs). */
function attackerGrossRaw(frontRcpt, backRcpt, pool, idx) {
  const a = poolDelta(frontRcpt, pool, idx), b = poolDelta(backRcpt, pool, idx); if (a == null || b == null) return null; return -(a + b);
}

/** Minimal CSV (quoted fields ok). Expects a Dune `dex.sandwiched` export with tx_hash and amount_usd-like columns. */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase()); return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
function duneIndex(rows) {
  const m = new Map();
  for (const r of rows) { const h = (r.tx_hash || r.victim_tx_hash || '').toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(h)) continue;
    const usd = +(r.attacker_profit_usd ?? r.profit_usd ?? NaN), trade = +(r.amount_usd ?? NaN); // dex.sandwiched amount_usd is the VICTIM trade size, not attacker profit
    m.set(h, { block: +r.block_number || null, usd: Number.isFinite(usd) ? usd : null, tradeUsd: Number.isFinite(trade) ? trade : null, project: r.project || null }); }
  return m;
}
module.exports = { detectSandwiches, poolDelta, attackerGrossRaw, parseCsv, duneIndex, MAX_GAP, V2_SWAP, V3_SWAP };
