'use strict';
// Helius plumbing for the Solana whale feed, built around the credit model (verified against helius.dev docs 2026-10-29/30):
//   - Webhooks: 1 credit per delivered event (charged even if the receiver errors; Helius retries for up to 24 h);
//     create/edit/delete = 100 credits each. Free plan: 1,000,000 credits/month, 5 webhooks.
//   - Deliveries go to the HAWSE inbox (Cloudflare Worker, <HAWSE_WEBHOOK_URL>/helius); the desk polls the inbox, which costs
//     no Helius credits (server/feeds/inbox.js). The old local receiver, Parsed Events poll and Enhanced Tx loop are gone.
// Secrets: HELIUS_API_KEY (admin script + optional auto-pause only). Nothing here logs or returns it.
const CREDITS = Object.freeze({ webhookEvent: 1, webhookManage: 100, enhancedLegacy: 100, freePlanMonthly: 1000000 });
// Host per helius-sdk 3.x and the Helius OpenAPI spec; older docs pages show mainnet.helius-rpc.com. Override: HELIUS_WEBHOOKS_API.
const WEBHOOKS_URL = 'https://api-mainnet.helius-rpc.com/v0/webhooks';
/** The webhookURL Helius should deliver to: <HAWSE_WEBHOOK_URL>/helius ('' when unset). */
const inboxHookUrl = (base) => (base ? String(base).replace(/\/+$/, '') + '/helius' : '');

/** Credit estimates (pure; shown in the Data Sources panel). */
const estimates = {
  /** The removed legacy loop: N addresses x Enhanced Tx (100 cr) every pollSec, plus WS-triggered extra polls. */
  legacyPerDay: (addresses, pollSec = 15, wsTriggeredPerDay = 0) => addresses * CREDITS.enhancedLegacy * (86400 / pollSec) + wsTriggeredPerDay * addresses * CREDITS.enhancedLegacy,
  /** Webhook: 1 credit/event. Extrapolate the observed event rate to 30 days (null until we have an hour of data). */
  webhookPerMonth: (events, sinceMs, now = Date.now()) => { const h = (now - sinceMs) / 3.6e6; return sinceMs && h >= 1 ? Math.round((events / h) * 24 * 30 * CREDITS.webhookEvent) : null; },
};

/** Auto-pause: find OUR webhook by its URL and PATCH active:false (an edit = 100 credits). Key only in the URL; errors redacted. */
async function pauseWebhook({ apiKey, url, api = WEBHOOKS_URL, fetchImpl = fetch }) {
  const q = '?api-key=' + encodeURIComponent(apiKey), red = (m) => String(m).split(apiKey).join('***').replace(/https?:\/\/[^\s"')]+/g, '<url>');
  try {
    const r = await fetchImpl(api + q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('list HTTP ' + r.status);
    const mine = (JSON.parse(await r.text()) || []).find((w) => w.webhookURL === url); if (!mine) return { ok: false, error: 'no webhook pointing at <HAWSE_WEBHOOK_URL>/helius' };
    const p = await fetchImpl(api + '/' + encodeURIComponent(mine.webhookID) + q, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false }), signal: AbortSignal.timeout(10000) });
    if (!p.ok) throw new Error('pause HTTP ' + p.status); return { ok: true, id: mine.webhookID };
  } catch (e) { return { ok: false, error: red(e.message || e) }; }
}

module.exports = { pauseWebhook, CREDITS, WEBHOOKS_URL, inboxHookUrl, estimates };
