'use strict';
// Proposed Solana whale accounts for the ONE Helius enhanced webhook (scripts/helius-webhook.js) and the inbox feed's
// watched-only filter. PUBLIC IDENTIFIERS, NOT SECRETS.
// Every address here was checked on 2026-10-30:
//   - label: the "Public name" Solscan shows on https://solscan.io/account/<addr> (fetched that day).
//   - txPerDay: successful signatures/day from the public Solana RPC (api.mainnet-beta.solana.com, getSignaturesForAddress,
//     last 1000 signatures, window in `sampleH`). This is NOT a Helius call and costs no credits. It is an UPPER BOUND for
//     deliveries, because a SWAP/TRANSFER filter can only drop transactions.
// Deliberately left out: Coinbase 1 (H8sMJSCQ…K3WjS, ~7,600 tx/day: alone it would use ~23% of the 1M/month plan), and busy
// DEX pools (tens of thousands of tx/day). Override with HELIUS_WEBHOOK_ADDRESSES / HELIUS_WATCH_ADDRESSES / FOLLOW_WALLETS_SOL.
const PROPOSED_WATCH = Object.freeze([
  { addr: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', label: 'Binance 2', txPerDay: 1662, sampleH: 14.4 },
  { addr: 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', label: 'Bybit Hot Wallet (AC5RD)', txPerDay: 1264, sampleH: 19.0 },
  { addr: '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', label: 'OKX Hot Wallet (5VCwK)', txPerDay: 6, sampleH: 3928 },
  { addr: 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', label: 'Kraken Hot Wallet (FWznb)', txPerDay: 4, sampleH: 6441 },
].map((w) => Object.freeze({ ...w, source: 'https://solscan.io/account/' + w.addr, measured: '2026-10-30' })));
const MEASURED_ON = '2026-10-30';
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
const short = (a) => a.slice(0, 4) + '…' + a.slice(-4);

/** Which accounts to watch: env override (first set wins), else the proposed list above. Pure. */
function resolveWatch(env = {}) {
  for (const k of ['HELIUS_WEBHOOK_ADDRESSES', 'HELIUS_WATCH_ADDRESSES', 'FOLLOW_WALLETS_SOL']) {
    const a = list(env[k]);
    if (a) return { source: k, accounts: a.map((addr) => PROPOSED_WATCH.find((w) => w.addr === addr) || { addr, label: short(addr), txPerDay: null }) };
  }
  return { source: 'proposed (server/feeds/helius-watch.js)', accounts: PROPOSED_WATCH.map((w) => ({ ...w })) };
}

/**
 * Expected credits/day for an enhanced webhook: 1 credit per delivered event. Assumption: every successful transaction that
 * touched a watched account in the measured window is delivered once (upper bound; the type filter only lowers it). Retries
 * after a failed delivery would add more, but the Cloudflare inbox acks fast. Unknown rates make the estimate null.
 */
function estimateCredits(accounts, { safety = 2 } = {}) {
  const unknown = accounts.filter((a) => a.txPerDay == null).map((a) => a.addr);
  const perDay = accounts.reduce((s, a) => s + (a.txPerDay || 0), 0);
  return { perDay: unknown.length ? null : perDay, perMonth: unknown.length ? null : perDay * 30, planned: unknown.length ? null : perDay * safety, safety, unknown,
    assumption: `1 credit/event; every successful tx touching a watched account (public RPC sample, ${MEASURED_ON}) is delivered once; ×${safety} headroom for busier days` };
}

module.exports = { PROPOSED_WATCH, resolveWatch, estimateCredits, MEASURED_ON };
