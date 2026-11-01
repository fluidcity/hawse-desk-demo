'use strict';
// "Move cash between pools": moves Bryan's OWN cash between his own Kalshi pools (exchange shards) in his main account.
// Asked for by Bryan ("I want poder to set up a button to be able to do that for me with my key").
//
// - Runs ONLY when Bryan presses "Move cash between pools", then Confirm, on the desk PC (routes are loopback-only and the
//   auth proxy hard-blocks them; see server/server.js and scripts/auth-proxy.js). Never on startup, never on arm, never automatically.
// - Pools: Default (0), Combos (1), Crypto & Commodities (2), Sports (3). Source != destination. Whole cents, > $0, at most the
//   source pool's available cash read fresh at prepare and again at confirm.
// - Two steps: prepare -> a one-time confirm token (2 minutes); confirm needs confirm:true, the token and the echoed amount/from/to.
//   A fresh client_transfer_id (UUID) per click; an uncertain send (network error, 5xx, 429) keeps the same id so "Retry" is an
//   identical retry (Kalshi returns 409 for a repeat and creates no new transfer).
// - One transfer at a time. Transfers are asynchronous: status is polled a few times >= 1.5 s apart (429 backs off), then the four
//   pool balances are re-read and shown.
// - Ledger: one `transfer` row per attempt (amount, from, to, client_transfer_id, outcome), then `transfer_status`. These rows never
//   change pilot state; a failed transfer never halts the pilot.
// - The only HTTP is through the pilot's signed client (server/live/kalshi-rest.js createTransfer / getTransfer / listTransfers / getBalance).
const crypto = require('crypto');

const POOL_NAMES = Object.freeze({ 0: 'Default', 1: 'Combos', 2: 'Crypto & Commodities', 3: 'Sports' });
const POOL_IDS = [0, 1, 2, 3];
const CONFIRM_TTL_MS = 120000;
const POLL_GAP_MS = 1500;
const POLL_TRIES = 5;
const $ = (c) => '$' + (c / 100).toFixed(2);
const poolLabel = (i) => `${POOL_NAMES[i]} (shard ${i})`;
/** "70", "70.5", "70.00", "$1,070.25" -> integer cents; anything else (sub-cent, negative, exponent, empty) -> null. */
function parseDollars(v) {
  if (typeof v === 'number') v = String(v);
  const s = String(v == null ? '' : v).trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s); if (!m) return null;
  return Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
}
const toPool = (v) => { const n = typeof v === 'string' && /^\d$/.test(v) ? Number(v) : v; return Number.isInteger(n) && POOL_IDS.includes(n) ? n : null; };
function shardsFrom(b) {
  const bd = b && Array.isArray(b.balance_breakdown) ? b.balance_breakdown : null; if (!bd) return null;
  const out = []; for (const x of bd) { const i = Number(x.exchange_index), m = /^(-)?(\d+)(?:\.(\d{0,6})\d*)?$/.exec(String(x.balance == null ? '' : x.balance).trim());
    if (!Number.isInteger(i) || !m) continue; const c = Number(m[2]) * 100 + Number(((m[3] || '') + '00').slice(0, 2)); out.push({ exchangeIndex: i, cents: m[1] ? -c : c }); }
  return out.sort((a, b2) => a.exchangeIndex - b2.exchangeIndex);
}

class PoolTransfer {
  /** getClient(): the pilot's signed client (or null). write(row): the pilot ledger. Nothing here touches pilot state. */
  constructor({ getClient, write, now = Date.now, sleep, uuid = () => crypto.randomUUID(), token = () => crypto.randomBytes(16).toString('hex') }) {
    Object.assign(this, { getClient, write, now, sleep, uuid, token });
    this.pending = null; this.busy = false; this.last = null;
  }
  fail(error, extra = {}) { return { ok: false, error, ...extra }; }
  async poolCents(c, i) { const b = await c.getBalance({ exchangeIndex: i }); const v = Number(b && b.balance); if (!Number.isInteger(v)) throw new Error('no balance in the reply'); return v; }
  /** Step 1 (desk PC): validate, read the source pool fresh, hand back a one-time confirm token. Sends nothing that moves money. */
  async prepare({ amount, from, to } = {}) {
    if (this.busy) return this.fail('a transfer is already in progress; wait for it to finish');
    const amountCents = parseDollars(amount), f = toPool(from), t = toPool(to);
    if (f == null || t == null) return this.fail('pick a source and a destination pool');
    if (f === t) return this.fail('source and destination are the same pool');
    if (amountCents == null) return this.fail('type a dollar amount in whole cents, e.g. 70.00');
    if (amountCents <= 0) return this.fail('the amount must be more than $0.00');
    const c = this.getClient(); if (!c) return this.fail('no Kalshi key set');
    if (c.subaccount != null) return this.fail('pool transfers are main-account only (KALSHI_TRADE_SUBACCOUNT is set)');
    let avail; try { avail = await this.poolCents(c, f); } catch (e) { return this.fail(`could not read ${poolLabel(f)} cash: ${String(e.message || e).slice(0, 120)}`); }
    if (amountCents > avail) return this.fail(`${$(amountCents)} is more than the ${$(avail)} available in ${poolLabel(f)}`, { availableCents: avail });
    this.pending = { token: this.token(), amountCents, from: f, to: t, clientTransferId: this.uuid(), availableCents: avail, at: this.now(), expiresAt: this.now() + CONFIRM_TTL_MS, tries: 0 };
    return { ok: true, confirm: { token: this.pending.token, amountCents, from: f, to: t, availableCents: avail, expiresAt: this.pending.expiresAt,
      text: `Move ${$(amountCents)} from ${poolLabel(f)} to ${poolLabel(t)}?` } };
  }
  cancel() { const had = !!this.pending && !this.busy; if (!this.busy) this.pending = null; return { ok: true, cancelled: had }; }
  /** Step 2 (desk PC): confirm:true + the token + the echoed amount/from/to. One transfer at a time. */
  async confirm(b = {}) {
    if (b.confirm !== true) return this.fail('not confirmed: press Confirm on the card');
    if (this.busy) return this.fail('a transfer is already in progress; wait for it to finish');
    const p = this.pending;
    if (!p || typeof b.token !== 'string' || b.token !== p.token) return this.fail('no matching transfer to confirm; press "Move cash between pools" again');
    if (this.now() > p.expiresAt) { this.pending = null; return this.fail('the confirm step expired; start again'); }
    if (b.amountCents !== p.amountCents || toPool(b.from) !== p.from || toPool(b.to) !== p.to) return this.fail('the confirmed amount or pools do not match what was shown; start again');
    const c = this.getClient(); if (!c) return this.fail('no Kalshi key set');
    this.busy = true;
    try { return await this.run(c, p); } finally { this.busy = false; }
  }
  async run(c, p) {
    const row = { amountCents: p.amountCents, from: p.from, to: p.to, clientTransferId: p.clientTransferId, attempt: ++p.tries };
    let avail; try { avail = await this.poolCents(c, p.from); } catch (e) { this.write({ t: 'transfer', ...row, outcome: 'not_sent', error: 'source read failed: ' + String(e.message || e).slice(0, 120) }); return this.done(p, 'not_sent', { error: `could not re-read ${poolLabel(p.from)} cash; nothing was sent`, keep: true }); }
    if (p.amountCents > avail) { this.write({ t: 'transfer', ...row, outcome: 'not_sent', error: 'over balance', availableCents: avail }); return this.done(p, 'not_sent', { error: `${$(p.amountCents)} is more than the ${$(avail)} now in ${poolLabel(p.from)}; nothing was sent` }); }
    let id = null, outcome, err = null;
    try { const r = await c.createTransfer({ amountCents: p.amountCents, from: p.from, to: p.to, clientTransferId: p.clientTransferId }); id = r && r.transfer_id ? String(r.transfer_id) : null; outcome = 'accepted'; }
    catch (e) {
      err = String(e.message || e).slice(0, 160);
      if (e.status === 409) { outcome = 'accepted'; id = await this.findById(c, p.clientTransferId); } // identical retry of a transfer Kalshi already took
      else if (e.status === 401 || e.status === 403) outcome = 'refused_key';
      else if (e.status === 429) outcome = 'rate_limited';
      else if (e.status && e.status < 500) outcome = 'rejected';
      else outcome = 'uncertain'; // network error or 5xx: may or may not have landed; Retry reuses the same client_transfer_id
    }
    this.write({ t: 'transfer', ...row, centicents: p.amountCents * 100, outcome, transferId: id, error: outcome === 'accepted' ? undefined : err });
    if (outcome === 'refused_key') return this.done(p, outcome, { error: `Kalshi refused this key for transfers (${err}); nothing moved. A key allowed to transfer is needed.` });
    if (outcome === 'rejected') return this.done(p, outcome, { error: 'Kalshi rejected the transfer: ' + err });
    if (outcome === 'rate_limited' || outcome === 'uncertain') return this.done(p, outcome, { keep: true, error: (outcome === 'rate_limited' ? 'Kalshi is rate-limiting; ' : 'no clear answer from Kalshi; ') + 'press Retry (same transfer id, so it cannot move the money twice)' });
    const status = id ? await this.poll(c, id) : 'unknown';
    const shards = await this.readPools(c);
    this.write({ t: 'transfer_status', clientTransferId: p.clientTransferId, transferId: id, status, shards });
    return this.done(p, 'accepted', { transferId: id, status, shards });
  }
  async findById(c, ctid) {
    try { const r = await c.listTransfers({ limit: 50 }); const x = (r && r.transfers || []).find((t) => t.client_transfer_id === ctid); return x ? String(x.transfer_id) : null; } catch { return null; }
  }
  async poll(c, id) {
    let status = 'pending', wait = POLL_GAP_MS;
    for (let i = 0; i < POLL_TRIES; i++) {
      await this.sleep(wait); wait = POLL_GAP_MS;
      try { const r = await c.getTransfer(id); status = (r && r.transfer && r.transfer.status) || status; if (status === 'complete') break; }
      catch (e) { if (e.status === 429) wait = Math.min(30000, POLL_GAP_MS * 2 ** (i + 1)); }
    }
    return status;
  }
  /** All four pools: the aggregate balance_breakdown in one read, else one read per pool spaced 1.5 s apart. */
  async readPools(c) {
    await this.sleep(POLL_GAP_MS);
    try { const s = shardsFrom(await c.getBalance()); if (s && s.length) return s; } catch { /* fall back */ }
    const out = [];
    for (const i of POOL_IDS) { await this.sleep(POLL_GAP_MS); try { out.push({ exchangeIndex: i, cents: await this.poolCents(c, i) }); } catch { out.push({ exchangeIndex: i, cents: null }); } }
    return out;
  }
  done(p, outcome, x = {}) {
    if (!x.keep) this.pending = null; else if (this.pending) this.pending.expiresAt = this.now() + CONFIRM_TTL_MS; // Retry window
    this.last = { at: this.now(), amountCents: p.amountCents, from: p.from, to: p.to, clientTransferId: p.clientTransferId, outcome, status: x.status || null, transferId: x.transferId || null,
      shards: x.shards || null, error: x.error || null, retry: !!x.keep && !!this.pending,
      text: outcome === 'accepted' ? `Moved ${$(p.amountCents)} from ${poolLabel(p.from)} to ${poolLabel(p.to)}: ${x.status === 'complete' ? 'complete' : 'accepted, ' + (x.status || 'pending')}`
        : `${$(p.amountCents)} from ${poolLabel(p.from)} to ${poolLabel(p.to)}: ${x.error}` };
    return { ok: outcome === 'accepted', ...this.view(), error: outcome === 'accepted' ? undefined : x.error, retryToken: this.last.retry ? this.pending.token : undefined };
  }
  /** Snapshot view. No token (it is only handed to the desk-PC browser that pressed the button). */
  view() { return { transfer: { busy: this.busy, pools: POOL_NAMES, last: this.last, pending: this.pending ? { amountCents: this.pending.amountCents, from: this.pending.from, to: this.pending.to, expiresAt: this.pending.expiresAt } : null } }; }
}

module.exports = { PoolTransfer, parseDollars, POOL_NAMES, POOL_IDS, CONFIRM_TTL_MS, POLL_GAP_MS, poolLabel };
