'use strict';
// DISABLED venue-link adapters for a possible later direct link to Kalshi or Polymarket (the user's OWN account).
// This build ships the INTERFACE ONLY: every method throws VenueLinkDisabledError. No network, no credential reads:
// these files never touch process.env. The env var names below are documentation for a future, separately reviewed change.
//
// Contract a future implementation must keep:
//  - Per-order approval: placeOrder(order, approval) requires an approval the USER created for THAT order in the UI
//    ({ orderHash, signalId, approvedBy:'user', approvedAt, expiresAt }, short-lived, single use). No batch / standing approval,
//    no auto-placing from rules or signals.
//  - Read-only methods (getBalance, getPositions, findMarkets) must never be able to move funds.
//  - Credentials are read server-side from env only, never sent to the browser, never logged.

class VenueLinkDisabledError extends Error {
  constructor(venue, method) { super(`${venue}.${method}: venue link is DISABLED in this build (paper desk; place bets yourself from the slip)`); this.name = 'VenueLinkDisabledError'; this.code = 'VENUE_LINK_DISABLED'; this.venue = venue; this.method = method; }
}

const METHODS = ['connect', 'getBalance', 'getPositions', 'findMarkets', 'previewOrder', 'placeOrder', 'cancelOrder'];

class VenueAdapter {
  constructor({ id, label, docs, envVars, auth }) { Object.assign(this, { id, label, docs, envVars, auth }); this.enabled = false; }
  describe() { return { id: this.id, label: this.label, enabled: false, status: 'disabled (interface only)', docs: this.docs, auth: this.auth, envVars: this.envVars, methods: METHODS, approval: 'per-order user approval required (future)' }; }
}
for (const m of METHODS) VenueAdapter.prototype[m] = function () { throw new VenueLinkDisabledError(this.id, m); };

/** Shape check a future placeOrder() must run before anything else. Pure; exported for tests and future use. */
function checkApproval(order, approval, now = Date.now()) {
  const errs = [];
  if (!approval || approval.approvedBy !== 'user') errs.push('approval must come from the user');
  else {
    if (!order || approval.orderHash !== order.hash) errs.push('approval is for a different order');
    if (!(approval.expiresAt > now)) errs.push('approval expired');
    if (!(approval.expiresAt - approval.approvedAt <= 120e3)) errs.push('approval window must be ≤ 2 minutes');
  }
  return errs;
}

const kalshi = new VenueAdapter({ id: 'kalshi', label: 'Kalshi', docs: 'https://docs.kalshi.com', auth: 'API key ID + RSA private key (request signing); check current docs',
  envVars: [{ name: 'KALSHI_API_KEY_ID', note: 'API key id from your Kalshi account' }, { name: 'KALSHI_PRIVATE_KEY_PATH', note: 'path to the PEM private key file on the server (never in the repo)' }, { name: 'KALSHI_ENV', note: 'demo | prod (this order-path stub stays disabled either way; the read-only recorder WebSocket defaults to prod)' }] });
const polymarket = new VenueAdapter({ id: 'polymarket', label: 'Polymarket', docs: 'https://docs.polymarket.com', auth: 'wallet private key (L1) + CLOB API key/secret/passphrase (L2); check current docs and your jurisdiction',
  envVars: [{ name: 'POLYMARKET_PRIVATE_KEY', note: 'wallet key; use a dedicated low-balance wallet' }, { name: 'POLYMARKET_FUNDER_ADDRESS', note: 'proxy/funder address if applicable' }, { name: 'POLYMARKET_API_KEY' }, { name: 'POLYMARKET_API_SECRET' }, { name: 'POLYMARKET_API_PASSPHRASE' }] });

const VENUES = { kalshi, polymarket };
module.exports = { VenueAdapter, VenueLinkDisabledError, METHODS, VENUES, checkApproval };
