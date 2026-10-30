'use strict';
// Helius plumbing for the Solana whale feed, built around the credit model (verified against helius.dev docs 2026-10-29):
//   - Enhanced Transactions REST (/v0/addresses/{a}/transactions): 100 credits/call, legacy / maintenance mode. NO LONGER USED.
//   - Webhooks: 1 credit per delivered event (charged even if our endpoint errors); create/edit/delete = 100 credits each.
//   - Parsed Events (/v1/parsed-events/transaction-history): 10 credits/request. Used only by the opt-in slow poll fallback.
//   - Free plan: 1,000,000 credits/month.
// Secrets: HELIUS_API_KEY (only for the opt-in poll and the admin script) and HELIUS_WEBHOOK_AUTH (the shared secret Helius
// echoes back in the Authorization header). Both stay server-side; nothing here logs or returns them.
const crypto = require('crypto');

const CREDITS = Object.freeze({ webhookEvent: 1, webhookManage: 100, parsedHistory: 10, enhancedLegacy: 100, freePlanMonthly: 1000000 });
const PARSED_HISTORY_URL = 'https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history';
const WEBHOOKS_URL = 'https://mainnet.helius-rpc.com/v0/webhooks';
const MIN_POLL_SEC = 300;
const MAX_BODY = 5e6;

/** Constant-time compare of the Authorization header against the configured secret (hash both so lengths match). */
function verifyAuth(header, secret) {
  if (!secret || typeof header !== 'string' || !header) return false;
  const a = crypto.createHash('sha256').update(header).digest(), b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pure webhook request handler. Returns { status, body, txs }.
 *  - receiver disabled (no secret configured) -> 503
 *  - bad/missing Authorization                 -> 403 (Helius does not retry 403, so a misconfigured sender is not billed for retries)
 *  - malformed JSON / not an array             -> 400
 *  - ok                                         -> 200 with the enhanced-transaction array in txs
 */
function handleWebhook({ method, headers = {}, rawBody }, { secret }) {
  if (!secret) return { status: 503, body: { error: 'helius webhook receiver disabled: HELIUS_WEBHOOK_AUTH not set' }, txs: [] };
  if (method !== 'POST') return { status: 405, body: { error: 'POST only' }, txs: [] };
  if (!verifyAuth(headers.authorization, secret)) return { status: 403, body: { error: 'forbidden' }, txs: [] };
  let j; try { j = JSON.parse(rawBody || ''); } catch { return { status: 400, body: { error: 'invalid JSON' }, txs: [] }; }
  const arr = Array.isArray(j) ? j : j && Array.isArray(j.transactions) ? j.transactions : null;
  if (!arr) return { status: 400, body: { error: 'expected an array of enhanced transactions' }, txs: [] };
  const txs = arr.filter((t) => t && typeof t === 'object' && typeof t.signature === 'string');
  return { status: 200, body: { ok: true, received: arr.length, accepted: txs.length }, txs };
}

/** Normalize one Parsed Events TransactionResult into the enhanced-transaction shape classifySolanaTx reads. Pure. */
function normalizeParsed(item) {
  const p = item && item.parsed; if (!p) return null;
  const s = p.summary || {}, pd = s.parsedData || {};
  return {
    signature: item.signature, timestamp: p.blockTime, feePayer: p.feePayer,
    type: s.type === 'swap' ? 'SWAP' : s.type === 'transfer' ? 'TRANSFER' : String(s.type || 'UNKNOWN').toUpperCase(),
    source: pd.protocol ? String(pd.protocol).toUpperCase() : undefined,
    transactionError: p.transactionStatus && p.transactionStatus !== 'OK' ? (p.error || p.transactionStatus) : null,
    nativeTransfers: p.nativeTransfers || [],
    tokenTransfers: (p.tokenTransfers || []).map((t) => ({ mint: t.mint, fromUserAccount: t.fromUserAccount, toUserAccount: t.toUserAccount,
      tokenAmount: t.tokenAmount != null ? +t.tokenAmount : (+t.rawTokenAmount || 0) / 10 ** (+t.decimals || 0) })),
  };
}

/** Credit estimates (pure; shown in the Data Sources panel). */
const estimates = {
  /** The removed legacy loop: N addresses x Enhanced Tx (100 cr) every pollSec, plus WS-triggered extra polls. */
  legacyPerDay: (addresses, pollSec = 15, wsTriggeredPerDay = 0) => addresses * CREDITS.enhancedLegacy * (86400 / pollSec) + wsTriggeredPerDay * addresses * CREDITS.enhancedLegacy,
  pollPerMonth: (addresses, pollSec) => Math.round(addresses * CREDITS.parsedHistory * (86400 / pollSec) * 30),
  /** Webhook: 1 credit/event. Extrapolate the observed event rate to 30 days (null until we have an hour of data). */
  webhookPerMonth: (events, sinceMs, now = Date.now()) => { const h = (now - sinceMs) / 3.6e6; return sinceMs && h >= 1 ? Math.round((events / h) * 24 * 30 * CREDITS.webhookEvent) : null; },
};

/** Opt-in Parsed Events fetch for one address (10 credits). The caller must have reserved budget first. */
async function fetchParsedHistory({ apiKey, address, limit = 25, fetchImpl = fetch, timeoutMs = 10000 }) {
  const r = await fetchImpl(PARSED_HISTORY_URL + '?api-key=' + encodeURIComponent(apiKey), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'hawse-paper-desk/2.0' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ address, limit, sortOrder: 'desc', commitment: 'confirmed', status: 'succeeded', tokenAccounts: 'balanceChanged' }),
  });
  const text = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 100).replace(/\s+/g, ' ')}`);
  const j = JSON.parse(text); return (j.data || []).map(normalizeParsed).filter(Boolean);
}

/** Auto-pause: find OUR webhook by its URL and PATCH active:false (an edit = 100 credits). Key only in the URL; errors redacted. */
async function pauseWebhook({ apiKey, url, fetchImpl = fetch }) {
  const q = '?api-key=' + encodeURIComponent(apiKey), red = (m) => String(m).split(apiKey).join('***');
  try {
    const r = await fetchImpl(WEBHOOKS_URL + q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('list HTTP ' + r.status);
    const mine = (JSON.parse(await r.text()) || []).find((w) => w.webhookURL === url); if (!mine) return { ok: false, error: 'no webhook with HELIUS_WEBHOOK_URL' };
    const p = await fetchImpl(WEBHOOKS_URL + '/' + encodeURIComponent(mine.webhookID) + q, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false }), signal: AbortSignal.timeout(10000) });
    if (!p.ok) throw new Error('pause HTTP ' + p.status); return { ok: true, id: mine.webhookID };
  } catch (e) { return { ok: false, error: red(e.message || e) }; }
}

module.exports = { pauseWebhook, CREDITS, PARSED_HISTORY_URL, WEBHOOKS_URL, MIN_POLL_SEC, MAX_BODY, verifyAuth, handleWebhook, normalizeParsed, estimates, fetchParsedHistory };
