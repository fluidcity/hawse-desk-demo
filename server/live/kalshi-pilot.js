'use strict';
// Kalshi LIVE PILOT: real money, 7% of the FULL live Kalshi balance (compounds; no bankroll cap), a $150 realized-loss limit (permanent halt), follows the frozen paper v3 '7pct' line's 'take' decisions (config/frozen/kalshi-live-pilot.json).
// Ships DISABLED and DISARMED. It cannot send an order unless ALL of these hold: LIVE_PILOT_ENABLED === 'true', both trade key env
// key present (dedicated trade key, else the desk's existing key), a passing read-only preflight, and the exact phrase typed on the desk machine (localhost-only endpoint; the auth
// proxy never forwards it). ARMED is never restored after a restart. HALTED is persisted and needs a manual reset.
// It never edits or re-decides v1/v2/v3: it only reads v3's rows after v3 has written them. All exchange calls go through
// server/live/kalshi-rest.js (the only file that names Kalshi order endpoints). Money: integer cents for limits and plans;
// Kalshi amounts are parsed exactly to integer micro-dollars (u$). No floats touch a balance.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rest = require('./kalshi-rest');

const PILOT_FILE = path.join(__dirname, '..', '..', 'config', 'frozen', 'kalshi-live-pilot.json');
const PILOT_SHA256 = '0da14a1b0f909942cef51019fb83a3e233b6f36e1a4d6d14f176af91b20c8d31';
const U = 10000; // u$ per cent
const BALANCE_REFRESH_MS = 20000, BALANCE_TIMEOUT_MS = 4000; // shadow balance refresh: at most once per 20 s, 4 s timeout
const STATES = ['DISABLED', 'DISARMED', 'ARMED', 'HALTED'];
const PERM_MSG = "this key can't trade, make a read+trade key";
/** 401/403, or a clear insufficient-scope / permission reply on an order. */
const isPermission = (e) => !!e && (e.status === 401 || e.status === 403 || /insufficient[_ ]?scope|permission|not authori[sz]ed|forbidden/i.test(String(e.code || '') + ' ' + String(e.message || '')));

/** The arm phrase names the frozen realized-loss limit, so it can't drift from the config: 'ARM LIVE $150 LOSS LIMIT'. */
function armPhraseFor(cfg) { const c = cfg.lossLimitCents; return `ARM LIVE $${c % 100 ? (c / 100).toFixed(2) : c / 100} LOSS LIMIT`; }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function loadPilotConfig(file = PILOT_FILE, pin = PILOT_SHA256) {
  const buf = fs.readFileSync(file), hash = sha256(buf);
  if (hash !== pin) throw new Error(`pilot config was edited after the freeze (sha256 ${hash.slice(0, 12)} != pinned ${pin.slice(0, 12)})`);
  const cfg = JSON.parse(buf.toString('utf8'));
  if (cfg.side !== 'yes' || cfg.action !== 'buy' || cfg.order.maxPriceCents > 98) throw new Error('pilot config must be YES BUY at <= 98c');
  if (!(Number.isInteger(cfg.lossLimitCents) && cfg.lossLimitCents > 0)) throw new Error('pilot config needs a positive integer lossLimitCents');
  cfg.armPhrase = armPhraseFor(cfg); // derived, never stored: the phrase always states the frozen loss limit
  return { cfg, hash };
}
/** Kalshi general taker fee for one order, in cents: ceil(0.07 * C * P * (1-P)) with P in dollars. Integer math. */
function feeCents(contracts, priceCents, rateBp = 700) { const num = rateBp * contracts * priceCents * (100 - priceCents); return Math.floor((num + 999999) / 1000000); }
/** Worst-case loss of buying n YES at the limit: everything paid if it settles NO. Cents. */
const worstCents = (n, limit) => n * limit + feeCents(n, limit);
const maxN = (budgetCents, limit, hi) => { let n = Math.max(0, Math.min(hi, Math.floor(budgetCents / limit))); while (n > 0 && worstCents(n, limit) > budgetCents) n--; return n; };
function laDay(ms, tz = 'America/Los_Angeles') { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
const toCents = (d) => Math.round(Number(d) * 100);
const assetOf = (tk) => { const m = /^KX(BTC|ETH|SOL)15M-/.exec(String(tk)); return m ? m[1] : null; };

/**
 * Size one slice. Pure. All inputs integer cents except vol (contracts, may be fractional or null).
 * target = min(7% of bankroll / ask, asset cap / ask, 10% of volume); remaining = target - filled; then capped by
 * open risk (<= the bankroll), available balance and (only when enabled) the remaining daily-loss budget.
 */
function planSlice({ cfg, tk, askCents, limitCents, bankrollCents, availCents, vol, filled = 0, openRiskCents = 0, dayLossCents = 0, dayOpenRiskCents = 0 }) {
  const asset = assetOf(tk), caps = {};
  const perTrade = Math.floor((bankrollCents * Math.round(cfg.perTradePct * 10000)) / 10000);
  const none = (b) => ({ contracts: 0, bound: [b], caps, perTradeCents: perTrade, worstCents: 0, sizing: sizingOf(cfg, bankrollCents, perTrade, 0, limitCents, [b]) });
  if (!asset || !cfg.series.some((s) => tk.startsWith(s + '-'))) return none('series');
  if (!(limitCents >= 1 && limitCents <= cfg.order.maxPriceCents)) return none('price');
  if (vol == null) return none('unknown_volume');
  caps.pct = Math.floor(perTrade / askCents);
  caps.asset = Math.floor((cfg.perAssetCapCents[asset] || 0) / askCents);
  caps.participation = Math.floor(cfg.participationShare * vol + 1e-9);
  const target = Math.min(caps.pct, caps.asset, caps.participation); const rem = Math.max(0, target - filled);
  caps.remaining = rem;
  caps.openRisk = maxN(bankrollCents - openRiskCents, limitCents, rem); // total open risk <= the live bankroll
  caps.cash = maxN(availCents, limitCents, rem);
  if (cfg.dailyLossStopCents != null && cfg.shrinkToDailyBudget) caps.daily = maxN(cfg.dailyLossStopCents - dayLossCents - dayOpenRiskCents, limitCents, rem);
  const vals = Object.entries(caps).filter(([k]) => k !== 'pct' && k !== 'asset' && k !== 'participation'), n = Math.max(0, Math.min(...vals.map(([, v]) => v)));
  const bound = n < rem ? vals.filter(([, v]) => v === n).map(([k]) => k) : Object.entries({ pct: caps.pct, asset: caps.asset, participation: caps.participation }).filter(([, v]) => v === target).map(([k]) => k);
  return { contracts: n, bound, caps, perTradeCents: perTrade, worstCents: n ? worstCents(n, limitCents) : 0, sizing: sizingOf(cfg, bankrollCents, perTrade, n, limitCents, bound) };
}
/** Card/ledger sizing fields: bankroll used, percent, order dollars (contracts x limit), 7% target dollars, which cap bound. */
const CAP_LABEL = { pct: '7% line', asset: 'asset cap', participation: '10% volume', openRisk: 'open-risk', cash: 'balance', daily: 'daily budget', remaining: 'target reached',
  series: 'series', price: 'price', unknown_volume: 'volume unknown', no_balance: 'no balance yet' };
function sizingOf(cfg, bankrollCents, perTradeCents, contracts, limitCents, bound) {
  const caps = (bound || []).map((b) => CAP_LABEL[b] || b);
  return { bankrollCents, pct: Math.round(cfg.perTradePct * 10000) / 100, targetCents: perTradeCents == null ? null : perTradeCents, sizeCents: contracts * (limitCents || 0),
    contracts, limitCents, capBound: caps.length ? caps.join(' + ') : null, capped: !!caps.length && !caps.includes('7% line') };
}

class KalshiPilot {
  constructor({ v1 = null, v3 = null, kalshi = null, dir, killFile, file = PILOT_FILE, pin = PILOT_SHA256, env = process.env, client, fetchImpl,
    now = Date.now, log = () => {}, sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }), health = null } = {}) {
    Object.assign(this, { v1, v3, kalshi, dir, killFile, file, pin, env, now, log, sleep, health });
    this.ledgerFile = path.join(dir, 'ledger.jsonl');
    this.presence = rest.tradeEnvPresence(env);
    this.cfg = null; this.hash = null; this.error = null; this.state = 'DISABLED'; this.inert = []; this.haltReason = null; this.totalStop = false;
    this.signals = new Map(); this.shadow = []; this.events = []; this.realizedMicros = 0; this.dayLoss = new Map();
    this.balanceCents = null; this.balanceAt = null; this.balanceTryAt = null; this.balanceStale = false; this.balanceError = null; this.apiErrors = 0; this.busy = new Set(); this.timers = []; this.preflight = null;
    try { const f = loadPilotConfig(file, pin); this.cfg = f.cfg; this.hash = f.hash; } catch (e) { this.error = e.message; this.inert.push('config: ' + e.message); }
    if (!this.presence.enabledFlag) this.inert.push('LIVE_PILOT_ENABLED is not "true"');
    if (!this.presence.keySet) this.inert.push('Kalshi key not set');
    this.fetchImpl = fetchImpl; this.keyTest = null;
    this.client = null;
    if (!this.inert.length) { try { this.client = client !== undefined ? client : rest.makeTradeClient({ env, fetchImpl, now }); } catch (e) { this.inert.push(e.message); } }
    if (!this.client && !this.inert.length) this.inert.push('trade client unavailable');
    if (health) health.register('live.kalshi-pilot', { label: 'Kalshi LIVE pilot (v3 7% of full balance)', group: 'live', note: 'real money; ships disabled and disarmed', staleMs: 600000 });
  }
  get enabled() { return !this.inert.length; }
  // ---- ledger -------------------------------------------------------------------------------------------------
  write(row) { const r = { at: this.now(), ...row }; fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.ledgerFile, JSON.stringify(r) + '\n'); this.apply(r); return r; }
  sig(tk) { let s = this.signals.get(tk); if (!s) { s = { tk, slices: [], fills: [], filled: 0, costMicros: 0, feeMicros: 0, settle: null, intents: new Map() }; this.signals.set(tk, s); } return s; }
  apply(r) {
    this.events.push(r); if (this.events.length > 60) this.events.shift();
    if (r.t === 'signal') Object.assign(this.sig(r.tk), { decisionAsk: r.decisionAsk, limit: r.limit, close: r.close, bookRx: r.bookRx, asset: r.asset, at: r.at });
    if (r.t === 'order_intent') { const s = this.sig(r.tk); s.intents.set(r.coid, { ...r, status: 'intent' }); s.slices.push(r.coid); }
    if (r.t === 'order_sent') { const i = this.sig(r.tk).intents.get(r.coid); if (i) i.status = 'sent'; }
    if (r.t === 'ack' || r.t === 'reconciled') { const i = this.sig(r.tk).intents.get(r.coid); if (i) Object.assign(i, { status: 'done', orderId: r.orderId, ack: r }); }
    if (r.t === 'not_sent') { const i = this.sig(r.tk).intents.get(r.coid); if (i) i.status = 'not_sent'; }
    if (r.t === 'fill') { const s = this.sig(r.tk); if (!s.fills.some((f) => f.fillId === r.fillId)) { s.fills.push(r); s.filled += r.count; s.costMicros += r.costMicros; s.feeMicros += r.feeMicros; } }
    if (r.t === 'balance') this.balanceCents = r.balanceCents;
    if (r.t === 'settle') { const s = this.sig(r.tk); if (!s.settle) { s.settle = r; this.realizedMicros += r.pnlMicros; const d = laDay(r.at, this.cfg ? this.cfg.dailyLossTimeZone : undefined); this.dayLoss.set(d, (this.dayLoss.get(d) || 0) + r.pnlMicros); } }
    if (r.t === 'shadow') { this.shadow.push(r); if (this.shadow.length > 50) this.shadow.shift(); }
    if (r.t === 'stop') { this.state = 'HALTED'; this.haltReason = r.reason; if (r.kind === 'total_loss') this.totalStop = true; }
    if (r.t === 'reset') { this.haltReason = null; this.totalStop = false; this.state = this.enabled ? 'DISARMED' : 'DISABLED'; }
  }
  replay() {
    if (!fs.existsSync(this.ledgerFile)) return;
    for (const l of fs.readFileSync(this.ledgerFile, 'utf8').split('\n')) { if (!l.trim()) continue; try { this.apply(JSON.parse(l)); } catch { /* torn line */ } }
  }
  // ---- lifecycle ----------------------------------------------------------------------------------------------
  start() {
    if (!this.cfg) return;
    this.replay();
    const halted = this.state === 'HALTED';
    this.state = halted ? 'HALTED' : this.enabled ? 'DISARMED' : 'DISABLED'; // ARMED is never restored
    if (this.state === 'DISABLED') return; // inert: no listeners, no timers, no files, no network
    this.write({ t: 'session', state: this.state, hash: this.hash, pid: process.pid });
    if (this.v1 && this.v1.rowListeners) this.v1.rowListeners.push((r) => { try { this.onV1Row(r); } catch (e) { this.log('[kalshi-pilot] ' + e.message); } });
    this.asks = new Map();
    if (this.kalshi && this.kalshi.on) this.kalshi.on('book', (e) => { if (e && e.tk && assetOf(e.tk) && e.ya != null) this.asks.set(e.tk, { ask: +e.ya, rx: e.rx }); });
    this.startupReconcile = this.reconcilePending('startup').catch((e) => this.halt('exception in startup reconcile: ' + e.message));
    const t = setInterval(() => this.tick(), 1000); if (t.unref) t.unref(); this.timers.push(t);
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  killed() { return !!(this.killFile && fs.existsSync(this.killFile)); }
  tick() {
    if (this.killed() && this.state !== 'HALTED') this.halt('kill file present (' + path.basename(this.killFile) + ')');
    for (const s of this.signals.values()) if (s.fills.length && !s.settle && s.settlePending && this.now() - s.settlePending.at > 60000) this.trySettle(s.tk).catch(() => {});
  }
  // ---- halts --------------------------------------------------------------------------------------------------
  async halt(reason, kind = 'halt') {
    const first = this.state !== 'HALTED' || (kind === 'total_loss' && !this.totalStop);
    if (first) { this.write({ t: 'stop', kind, reason: String(reason).slice(0, 200) }); this.log('[kalshi-pilot] HALTED: ' + reason); }
    if (this.client && kind !== 'permission' && kind !== 'auth') await this.cancelResting('halt'); // auth halts send nothing else; otherwise only the pilot's own orders (client_order_id hp1-...), never anything else on the account
    return { ok: true, state: this.state, reason: this.haltReason };
  }
  async cancelResting(why) {
    for (const s of this.signals.values()) {
      if (s.settle || !s.slices.length) continue;
      let r; try { r = await this.client.getOrders(s.tk); } catch (e) { this.write({ t: 'cancel', tk: s.tk, reason: why, error: e.message }); continue; }
      for (const o of r.orders || []) {
        if (!String(o.client_order_id || '').startsWith('hp1-') || o.status !== 'resting') continue;
        try { await this.client.cancelOrder(o.order_id, s.tk); this.write({ t: 'cancel', tk: s.tk, coid: o.client_order_id, orderId: o.order_id, reason: why }); } catch (e) { this.write({ t: 'cancel', tk: s.tk, coid: o.client_order_id, reason: why, error: e.message }); }
      }
    }
  }
  apiError(e) {
    this.apiErrors++;
    if (e && (e.status === 401 || e.status === 403)) return this.halt('auth failure from Kalshi (' + e.status + '); nothing else is sent', 'auth');
    if (this.apiErrors >= this.cfg.halts.apiErrorsInRow) return this.halt(`${this.apiErrors} Kalshi API errors in a row`, 'api_errors');
    return null;
  }
  checkSkew() { const s = this.client && this.client.lastSkewMs; if (s != null && Math.abs(s) > this.cfg.halts.maxClockSkewMs) { this.halt(`clock skew ${s} ms vs Kalshi`, 'clock'); return false; } return true; }
  // ---- arm / reset (server.js only calls these after its localhost + no-forwarding checks) --------------------------
  async arm(phrase) {
    if (this.state === 'HALTED') return { ok: false, error: 'HALTED: reset first (' + this.haltReason + ')' };
    if (this.state === 'ARMED') return { ok: true, state: 'ARMED' };
    if (!this.enabled) return { ok: false, error: 'DISABLED: ' + this.inert.join('; ') };
    if (phrase !== this.cfg.armPhrase) return { ok: false, error: 'type the exact phrase to arm' };
    if (this.killed()) return { ok: false, error: 'kill file present' };
    const pf = await this.runPreflight(); if (!pf.ok) return { ok: false, error: 'preflight failed: ' + pf.error, preflight: pf };
    this.state = 'ARMED'; this.write({ t: 'arm', balanceCents: pf.balanceCents, scopes: pf.scopes, scopeNote: pf.scopeNote, subaccount: pf.subaccount, keySource: pf.keySource });
    return { ok: true, state: 'ARMED', preflight: pf };
  }
  disarm() { if (this.state === 'ARMED') { this.state = 'DISARMED'; this.write({ t: 'disarm' }); } return { ok: true, state: this.state }; }
  async runPreflight() {
    const pf = { at: this.now(), ok: false };
    try {
      const b = await this.client.getBalance(); pf.balanceCents = Number.isInteger(b.balance) ? b.balance : Math.round((rest.dollarsToMicros(b.balance_dollars) || 0) / U);
      if (!(pf.balanceCents > 0)) throw new Error('balance is zero or unreadable');
      if (!this.checkSkew()) throw new Error('clock skew');
      // the money about to be risked: one full trade at 7% of the full bankroll (balance + the pilot's own open cost)
      pf.perTradeCents = Math.floor(((pf.balanceCents + this.openRiskCents()) * Math.round(this.cfg.perTradePct * 10000)) / 10000);
      if (pf.balanceCents < pf.perTradeCents || pf.perTradeCents < 1) throw new Error(`balance ${pf.balanceCents}c is below one trade (${pf.perTradeCents}c)`);
      const sc = await this.readScopes(this.client); Object.assign(pf, sc);
      if (sc.tradeScope === false) throw new Error(PERM_MSG);
      pf.keySource = this.client.keySource || this.presence.keySource;
      pf.subaccount = this.client.subaccount;
      if (pf.subaccount != null && (pf.subaccount < 0 || pf.subaccount > 63)) throw new Error('bad subaccount');
      this.write({ t: 'balance', balanceCents: pf.balanceCents, src: 'preflight' }); this.markBalance();
      pf.ok = true; this.apiErrors = 0;
    } catch (e) { pf.error = e.message; if (e.status) this.apiError(e); }
    this.preflight = pf; return pf;
  }
  /** Read-only: GET /api_keys for this key's scopes. Never fails the caller: if Kalshi does not reveal scopes, says so. */
  async readScopes(client) {
    let k = null; try { k = await client.getApiKeys(); } catch { k = null; }
    const mine = k && (k.api_keys || []).find((x) => x.api_key_id === client.keyId);
    if (!mine || !Array.isArray(mine.scopes)) return { scopes: null, tradeScope: null, scopeNote: "trade scope can't be verified until the first armed order" };
    const tradeScope = mine.scopes.some((x) => x === 'write' || x === 'write::trade');
    return { scopes: mine.scopes, tradeScope, scopeNote: tradeScope ? 'trade scope present' : PERM_MSG,
      warn: mine.scopes.includes('write::transfer') ? 'key can also move funds (write::transfer); a read+trade-only key is safer' : undefined };
  }
  /**
   * "Test key (read-only balance check)": signed GETs only (balance, then this key's scopes). No orders, no writes, no ledger rows.
   * Works while DISABLED as long as a key is set. Result has no key material.
   */
  async testKey() {
    const r = { at: this.now(), ok: false, keySource: this.presence.keySource, readOnly: true };
    let c = this.client;
    if (!c) { try { c = rest.makeTradeClient({ env: this.env, fetchImpl: this.fetchImpl, now: this.now }); } catch (e) { r.error = e.message; return (this.keyTest = r); } }
    if (!c) { r.error = 'no Kalshi key set'; return (this.keyTest = r); }
    try {
      const b = await c.getBalance(); r.balanceCents = Number.isInteger(b.balance) ? b.balance : Math.round((rest.dollarsToMicros(b.balance_dollars) || 0) / U);
      r.skewMs = c.lastSkewMs;
      if (r.skewMs != null && Math.abs(r.skewMs) > this.cfg.halts.maxClockSkewMs) r.error = `clock skew: this PC is ${Math.round(r.skewMs / 1000)} s off Kalshi; fix the Windows clock (Settings > Time > Sync now)`;
      Object.assign(r, await this.readScopes(c));
      r.ok = !r.error;
    } catch (e) {
      r.status = e.status || null;
      r.error = e.status === 401 ? 'Kalshi rejected the key (401): the key ID and private key do not match, the key was revoked, or the PC clock is off'
        : e.status === 403 ? 'Kalshi refused this key (403)' : 'balance check failed: ' + String(e.message || e).slice(0, 120);
    }
    return (this.keyTest = r);
  }
  reset(phrase) {
    if (this.state !== 'HALTED') return { ok: true, state: this.state };
    if (phrase !== this.cfg.resetPhrase) return { ok: false, error: 'type the exact reset phrase' };
    if (this.killed()) return { ok: false, error: 'remove the kill file first' };
    const rf = path.join(this.dir, 'RESET_TOTAL_STOP');
    if (this.totalStop) { if (!fs.existsSync(rf)) return { ok: false, error: 'total-loss stop: create the manual reset file first' }; fs.unlinkSync(rf); }
    this.write({ t: 'reset', by: 'localhost' }); return { ok: true, state: this.state };
  }
  // ---- money view ---------------------------------------------------------------------------------------------
  openRiskCents() { let s = 0; for (const x of this.signals.values()) if (!x.settle && x.filled) s += Math.ceil((x.costMicros + x.feeMicros) / U); return s; }
  dayOpenRiskCents(day) { let s = 0; for (const x of this.signals.values()) if (!x.settle && x.filled && laDay(x.at || 0, this.cfg.dailyLossTimeZone) === day) s += Math.ceil((x.costMicros + x.feeMicros) / U); return s; }
  dayLossCents(day) { const v = this.dayLoss.get(day) || 0; return v < 0 ? Math.ceil(-v / U) : 0; }
  /** Bankroll = the FULL live Kalshi balance + the pilot's own open cost (already out of cash). No cap: it compounds with wins and deposits. null until a balance is read. */
  bankrollCents() {
    if (this.balanceCents == null) return null;
    return Math.max(0, this.balanceCents + this.openRiskCents());
  }
  /** Realized-loss limit (the only fixed guardrail): cumulative realized pilot P&L since start, real fills and fees. */
  lossView() {
    const lim = this.cfg.lossLimitCents, realized = this.realizedMicros / U, loss = Math.max(0, -realized);
    return { limitCents: lim, realizedCents: realized, lossCents: loss, headroomCents: Math.max(0, lim - loss) };
  }
  // ---- signal path --------------------------------------------------------------------------------------------
  onV1Row(r) {
    if (!this.cfg || !r || !r.tk) return;
    if (r.t === 'signal') {
      if (this.signals.has(r.tk) || r.backfill) return;
      const x = this.v3 && this.v3.rows && this.v3.rows.get(r.tk); if (!x || !x.sig || x.sig.decision !== this.cfg.follows.decision) return;
      return this.onTake(x.sig);
    }
    if (r.t === 'settle') { const s = this.signals.get(r.tk); if (s && s.fills.length && !s.settle) { s.official = { win: !!r.win, result: r.result, settledAt: r.settledAt }; return this.trySettle(r.tk).catch((e) => this.halt('exception in settle: ' + e.message)); } }
  }
  secLeft(s) { const c = typeof s.close === 'number' ? s.close : Date.parse(s.close); return Number.isFinite(c) ? (c - this.now()) / 1000 : null; }
  inWindow(s) { const t = this.secLeft(s), [lo, hi] = this.cfg.order.entryWindowSecondsLeft; return t != null && t >= lo && t <= hi; }
  volume(sig) { try { const v = this.v3.volumeAt(sig.tk, sig.bookRx); return v && v.known ? v.vol : null; } catch { return null; } }
  onTake(sig) {
    if (this.state === 'DISABLED') return null;
    const askCents = toCents(sig.ya), limit = Math.min(this.cfg.order.maxPriceCents, askCents + this.cfg.order.limitAboveAskCents);
    this.write({ t: 'signal', tk: sig.tk, asset: sig.asset, decisionAsk: askCents, limit, close: sig.close, bookRx: sig.bookRx, state: this.state });
    if (this.state === 'DISARMED') { const p = this.shadowPlan(sig, askCents, limit).catch((e) => { this.log('pilot shadow: ' + e.message); return null; }); this.sig(sig.tk).run = p; return p; }
    if (this.state === 'ARMED') { const p = this.runSignal(sig.tk).catch((e) => this.halt('exception in order path: ' + e.message, 'exception')); this.sig(sig.tk).run = p; return p; }
    return null;
  }
  plan(s, filled, vol) {
    const day = laDay(this.now(), this.cfg.dailyLossTimeZone);
    const bank = this.bankrollCents() || 0;
    return planSlice({ cfg: this.cfg, tk: s.tk, askCents: s.decisionAsk, limitCents: s.limit, bankrollCents: bank, availCents: Math.max(0, this.balanceCents || 0),
      vol, filled, openRiskCents: this.openRiskCents(), dayLossCents: this.dayLossCents(day), dayOpenRiskCents: this.dayOpenRiskCents(day) });
  }
  markBalance() { this.balanceAt = this.balanceTryAt = this.now(); this.balanceStale = false; this.balanceError = null; }
  /**
   * SHADOW sizing tracks the live balance: a read-only signed GET balance before a decision, at most once per
   * cfg-independent 20 s and with a short timeout. A failure never halts in shadow; it marks the balance stale and the
   * last known value is used (or the decision is skipped if there has never been one).
   */
  async refreshBalance({ minGapMs = BALANCE_REFRESH_MS, timeoutMs = BALANCE_TIMEOUT_MS } = {}) {
    if (!this.client || !this.presence.enabledFlag || !this.presence.keySet) return;
    const t = this.now(); if (this.balanceTryAt != null && t - this.balanceTryAt < minGapMs) return;
    this.balanceTryAt = t; let timer;
    try {
      const b = await Promise.race([this.client.getBalance(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('balance read timed out')), timeoutMs); if (timer.unref) timer.unref(); })]);
      const c = Number.isInteger(b.balance) ? b.balance : Math.round((rest.dollarsToMicros(b.balance_dollars) || NaN) / U);
      if (!Number.isFinite(c)) throw new Error('balance unreadable');
      this.balanceCents = c; this.balanceAt = t; this.balanceStale = false; this.balanceError = null;
    } catch (e) { this.balanceStale = true; this.balanceError = String(e && e.message || e).slice(0, 120); }
    finally { clearTimeout(timer); }
  }
  async shadowPlan(sig, askCents, limit) {
    await this.refreshBalance();
    const s = this.sig(sig.tk);
    if (this.balanceCents == null) {
      const sizing = sizingOf(this.cfg, null, null, 0, limit, ['no_balance']);
      return this.write({ t: 'shadow', noMoney: true, tk: sig.tk, decisionAsk: askCents, limit, contracts: 0, bound: ['no_balance'], skipped: 'no Kalshi balance yet' + (this.balanceError ? ' (' + this.balanceError + ')' : ''), sizing, balanceStale: true, slices: [] });
    }
    const z = this.plan(s, 0, this.volume(sig));
    return this.write({ t: 'shadow', noMoney: true, tk: sig.tk, decisionAsk: askCents, limit, contracts: z.contracts, bound: z.bound, caps: z.caps, perTradeCents: z.perTradeCents,
      sizing: z.sizing, balanceCents: this.balanceCents, balanceStale: this.balanceStale,
      worstCents: z.worstCents, slices: z.contracts ? [{ slice: 1, contracts: z.contracts, limit, tif: 'IOC', note: `up to ${this.cfg.order.maxSlices} IOC slices ${this.cfg.order.sliceGapMs / 1000}s apart for any unfilled remainder` }] : [] });
  }
  async runSignal(tk) {
    const s = this.signals.get(tk); if (!s || this.busy.has(tk)) return; this.busy.add(tk);
    try {
      const vol = this.volume({ tk, bookRx: s.bookRx });
      for (let i = 1; i <= this.cfg.order.maxSlices; i++) {
        if (i > 1) await this.sleep(this.cfg.order.sliceGapMs);
        if (this.state !== 'ARMED' || this.killed()) { if (this.killed()) await this.halt('kill file present'); return; }
        if (!this.inWindow(s)) { this.write({ t: 'slice_skip', tk, slice: i, reason: 'outside the frozen v3 entry window' }); return; }
        const cur = this.asks && this.asks.get(tk); if (cur && toCents(cur.ask) > s.limit) { this.write({ t: 'slice_skip', tk, slice: i, reason: `ask ${toCents(cur.ask)}c above limit ${s.limit}c` }); continue; }
        // fresh balance right before every slice: sizing uses it, and the after-slice check compares against it (so a settlement credit
        // from an earlier market landing between slices is not mistaken for a mismatch)
        try { const b = await this.client.getBalance(); this.balanceCents = Number.isInteger(b.balance) ? b.balance : Math.round((rest.dollarsToMicros(b.balance_dollars) ?? NaN) / U); this.apiErrors = 0; this.markBalance(); }
        catch (e) { this.apiError(e); this.write({ t: 'slice_skip', tk, slice: i, reason: 'balance read failed before the slice: ' + e.message }); await this.halt('balance unreadable before an armed slice (' + e.message + '); sizing needs the live balance', 'balance'); return; }
        if (!Number.isFinite(this.balanceCents)) { this.balanceCents = null; await this.halt('balance unreadable before an armed slice; sizing needs the live balance', 'balance'); return; }
        const z = this.plan(s, s.filled, vol);
        if (z.contracts < 1) { this.write({ t: 'slice_skip', tk, slice: i, reason: 'size 0', bound: z.bound, caps: z.caps, sizing: z.sizing }); return; }
        const done = await this.sendSlice(s, i, z); if (!done) return;
        if (done.filled >= z.contracts) return; // this slice filled in full: the target is reached
      }
    } finally { this.busy.delete(tk); }
  }
  async sendSlice(s, i, z) {
    const coid = ('hp1-' + s.tk + '-s' + i).replace(/[^\w-]/g, '').slice(0, 64);
    if (s.intents.has(coid)) return null; // never twice
    if (!this.presence.enabledFlag || this.state !== 'ARMED') return null; // orders are signed only when LIVE_PILOT_ENABLED === 'true' AND ARMED
    const balBefore = this.balanceCents;
    this.write({ t: 'order_intent', tk: s.tk, coid, slice: i, contracts: z.contracts, limit: s.limit, decisionAsk: s.decisionAsk, tif: 'IOC', side: 'yes', action: 'buy', bound: z.bound, caps: z.caps, sizing: z.sizing, balanceBeforeCents: balBefore });
    if (!this.checkSkew()) return null;
    this.write({ t: 'order_sent', tk: s.tk, coid });
    let ack;
    try { ack = await this.client.createOrder({ ticker: s.tk, side: 'yes', action: 'buy', count: z.contracts, priceCents: s.limit, clientOrderId: coid }); this.apiErrors = 0; }
    catch (e) {
      if (isPermission(e)) { this.write({ t: 'not_sent', tk: s.tk, coid, error: e.message }); await this.halt(`permission denied (${e.status || 'scope'}): ${PERM_MSG}`, 'permission'); return null; }
      if (e.status && e.status < 500 && e.status !== 429) { this.write({ t: 'not_sent', tk: s.tk, coid, error: e.message }); } else { await this.halt('order send failed without a clear answer (' + e.message + '); reconcile before resuming', 'unreconciled'); return null; } this.apiError(e); return null; }
    const fc = rest.countToInt(ack.fill_count), rc = rest.countToInt(ack.remaining_count);
    this.write({ t: 'ack', tk: s.tk, coid, orderId: ack.order_id, fillCount: fc, remainingCount: rc, avgFillPrice: ack.average_fill_price, avgFee: ack.average_fee_paid });
    if (rc > 0) this.write({ t: 'cancel', tk: s.tk, coid, orderId: ack.order_id, contracts: rc, reason: 'IOC remainder expired unfilled' });
    const got = await this.pullFills(s, ack.order_id, coid);
    if (got == null) return null;
    if (got !== fc) { await this.halt(`unreconciled: ack says ${fc} filled, fills say ${got}`, 'unreconciled'); return null; }
    await this.checkBalance(balBefore, s, coid);
    return { filled: got };
  }
  async pullFills(s, orderId, coid) {
    try {
      const r = await this.client.getFills({ ticker: s.tk, orderId }); this.apiErrors = 0; let n = 0;
      for (const f of r.fills || []) {
        if (f.order_id !== orderId) continue; const count = rest.countToInt(f.count_fp != null ? f.count_fp : f.count), px = rest.dollarsToMicros(f.yes_price_dollars), fee = rest.dollarsToMicros(f.fee_cost) || 0;
        n += count; if (!s.fills.some((x) => x.fillId === f.fill_id)) this.write({ t: 'fill', tk: s.tk, coid, orderId, fillId: f.fill_id, count, priceMicros: px, costMicros: Math.round(count * px), feeMicros: fee, isTaker: f.is_taker, ts: f.created_time });
      }
      return n;
    } catch (e) { this.apiError(e); await this.halt('could not read fills for ' + coid + ': ' + e.message, 'unreconciled'); return null; }
  }
  async checkBalance(before, s, coid) {
    try {
      const b = await this.client.getBalance(); const now = Number.isInteger(b.balance) ? b.balance : Math.round((rest.dollarsToMicros(b.balance_dollars) || 0) / U);
      const spent = s.fills.filter((f) => f.coid === coid).reduce((a, f) => a + f.costMicros + f.feeMicros, 0);
      const mine = s.fills.filter((f) => f.coid === coid);
      this.write({ t: 'balance', balanceCents: now, src: 'after ' + coid, beforeCents: before, pilotSpentCents: Math.round(spent / U), shared: this.client.subaccount == null });
      // the pilot's OWN fills must be inside its own order: never above the limit, never more than asked
      const over = mine.find((f) => f.priceMicros > s.limit * U);
      if (over) return void (await this.halt(`fill ${over.fillId} at ${over.priceMicros / U}c is above the ${s.limit}c limit`, 'balance'));
      // Main account (no subaccount): the balance is not the pilot's alone (other trades, deposits, settlements), so it is never compared as an
      // absolute. Only a dedicated subaccount gets the strict before - pilot spend = after check.
      if (this.client.subaccount == null) return;
      if (before != null && Math.abs(before - Math.round(spent / U) - now) > this.cfg.halts.balanceToleranceCents) await this.halt(`balance mismatch after ${coid}: before ${before}c, spent ${Math.round(spent / U)}c, now ${now}c`, 'balance');
    } catch (e) { this.apiError(e); }
  }
  /** On startup (and after a halt): every intent without an ack is looked up by client_order_id; never re-sent. */
  async reconcilePending(why) {
    const pending = [...this.signals.values()].flatMap((s) => [...s.intents.values()].filter((i) => i.status === 'intent' || i.status === 'sent').map((i) => [s, i]));
    if (!pending.length) return;
    if (!this.client) return this.halt(`${pending.length} order intent(s) unreconciled at ${why} and no trade client`, 'unreconciled');
    for (const [s, i] of pending) {
      let r; try { r = await this.client.getOrders(s.tk); } catch (e) { this.apiError(e); return this.halt('reconcile failed: ' + e.message, 'unreconciled'); }
      const o = (r.orders || []).find((x) => x.client_order_id === i.coid);
      if (!o) { this.write({ t: 'not_sent', tk: s.tk, coid: i.coid, reason: why + ': not on Kalshi; never re-sent' }); continue; }
      this.write({ t: 'reconciled', tk: s.tk, coid: i.coid, orderId: o.order_id, status: o.status, fillCount: rest.countToInt(o.fill_count_fp) });
      if (o.status === 'resting') { try { await this.client.cancelOrder(o.order_id, s.tk); this.write({ t: 'cancel', tk: s.tk, coid: i.coid, orderId: o.order_id, reason: 'resting at ' + why }); } catch (e) { return this.halt('could not cancel a resting order: ' + e.message, 'unreconciled'); } }
      await this.pullFills(s, o.order_id, i.coid);
    }
  }
  async trySettle(tk) {
    const s = this.signals.get(tk); if (!s || s.settle || !s.official) return;
    const winMicros = s.official.win ? s.filled * 1e6 : 0, pnl = winMicros - s.costMicros - s.feeMicros;
    let k = null;
    if (this.client) { try { const r = await this.client.getSettlements(tk); k = (r.settlements || []).find((x) => x.ticker === tk) || null; } catch (e) { this.apiError(e); } }
    if (this.client && !k) { s.settlePending = s.settlePending || { at: this.now() }; if (this.now() - s.settlePending.at < 30 * 60000) return; }
    const tol = this.cfg.halts.balanceToleranceCents * U, shared = this.client && this.client.subaccount == null;
    // main account: Kalshi's per-market revenue can include positions the pilot did not open, so only LESS than the pilot's payout is a mismatch
    if (k && (shared ? winMicros - k.revenue * U > tol : Math.abs(k.revenue * U - winMicros) > tol)) await this.halt(`settlement mismatch on ${tk}: kalshi revenue ${k.revenue}c vs ${winMicros / U}c`, 'balance');
    const before = this.bankrollCents();
    this.write({ t: 'settle', tk, win: s.official.win, result: s.official.result, contracts: s.filled, costMicros: s.costMicros, feeMicros: s.feeMicros, pnlMicros: pnl,
      source: k ? 'kalshi settlement' : 'kalshi official result (via v1)', kalshiRevenueCents: k ? k.revenue : undefined, bankrollBeforeCents: before, bankrollAfterCents: before == null ? null : before + Math.floor(pnl / U) });
    this.checkStops();
  }
  checkStops() {
    if (this.realizedMicros <= -this.cfg.lossLimitCents * U) return this.halt(`loss limit: realized ${(this.realizedMicros / 1e6).toFixed(2)} dollars since start (limit -$${(this.cfg.lossLimitCents / 100).toFixed(2)})`, 'total_loss');
    if (this.cfg.dailyLossStopCents != null) { const d = laDay(this.now(), this.cfg.dailyLossTimeZone); if (this.dayLossCents(d) >= this.cfg.dailyLossStopCents) return this.halt(`daily loss stop (${d})`, 'daily_loss'); }
    return null;
  }
  // ---- snapshot (no secrets: presence booleans only) ----------------------------------------------------------
  paperLine() { return this.v3 && this.v3.lines ? this.v3.lines.find((L) => L.id === this.cfg.follows.line) : null; }
  snapshot() {
    const c = this.cfg, L = this.paperLine();
    const trades = [...this.signals.values()].filter((s) => s.slices.length).slice(-30).reverse().map((s) => {
      const i0 = s.slices.length ? s.intents.get(s.slices[0]) : null;
      return { tk: s.tk, at: s.at, limit: s.limit, decisionAsk: s.decisionAsk, contracts: s.filled, requested: i0 ? i0.contracts : 0, fillPx: s.filled ? Math.round(s.costMicros / s.filled) / U : null,
        feeCents: s.feeMicros / U, costCents: s.costMicros / U, result: s.settle ? s.settle.result : null, win: s.settle ? s.settle.win : null, pnlCents: s.settle ? s.settle.pnlMicros / U : null,
        balanceBeforeCents: i0 ? i0.balanceBeforeCents : null, balanceAfterCents: s.settle ? s.settle.bankrollAfterCents : null, slices: s.slices.length,
        sizing: i0 ? i0.sizing || null : null, sliceSizing: s.slices.map((k) => (s.intents.get(k) || {}).sizing || null) };
    });
    const compare = [...this.signals.values()].slice(-30).reverse().map((s) => {
      const p = L && L.orders.get(s.tk), sh = this.shadow.find((x) => x.tk === s.tk);
      return { tk: s.tk, at: s.at, decisionAsk: s.decisionAsk, paper: p ? { filled: p.filled, vwapCents: p.vwap != null ? Math.round(p.vwap * 10000) / 100 : null, unfilled: p.unfilled, feeCents: Math.round(p.fee * 100) } : null,
        live: s.filled ? { filled: s.filled, vwapCents: Math.round(s.costMicros / s.filled) / U, feeCents: s.feeMicros / U } : null, shadow: sh ? { contracts: sh.contracts, limit: sh.limit, skipped: sh.skipped || null } : null,
        sizing: s.slices.length ? (s.intents.get(s.slices[0]) || {}).sizing || null : sh ? sh.sizing || null : null,
        slippageCents: s.filled ? Math.round((s.costMicros / s.filled / U - s.decisionAsk) * 100) / 100 : null, unfilled: i0Unfilled(s) };
    });
    return { title: 'LIVE · REAL MONEY · Kalshi pilot (v3 7% of full balance)', state: this.state, statusChip: this.state === 'DISARMED' ? 'DISARMED-SHADOW' : this.state, inert: this.inert, error: this.error,
      env: this.presence, hash: this.hash, haltReason: this.haltReason, totalStop: this.totalStop, killFile: this.killed(), preflight: this.preflight ? { ok: this.preflight.ok, error: this.preflight.error, warn: this.preflight.warn, scopeNote: this.preflight.scopeNote, at: this.preflight.at } : null,
      keyTest: this.keyTest ? { at: this.keyTest.at, ok: this.keyTest.ok, balanceCents: this.keyTest.balanceCents, tradeScope: this.keyTest.tradeScope, scopeNote: this.keyTest.scopeNote, error: this.keyTest.error, warn: this.keyTest.warn, keySource: this.keyTest.keySource } : null,
      mainAccount: this.client ? this.client.subaccount == null : !this.presence.subaccount,
      config: c ? { perTradePct: c.perTradePct, perAssetCapCents: c.perAssetCapCents, participationShare: c.participationShare,
        dailyLossStopCents: c.dailyLossStopCents, shrinkToDailyBudget: !!c.shrinkToDailyBudget, lossLimitCents: c.lossLimitCents, maxPriceCents: c.order.maxPriceCents, maxSlices: c.order.maxSlices, sliceGapMs: c.order.sliceGapMs,
        series: c.series, follows: c.follows.line, armPhrase: c.armPhrase } : null,
      loss: c ? this.lossView() : null,
      money: { real: true, bankrollCents: this.cfg ? this.bankrollCents() : null, perTradeCents: this.cfg && this.bankrollCents() != null ? Math.floor((this.bankrollCents() * Math.round(c.perTradePct * 10000)) / 10000) : null, balanceCents: this.balanceCents, balanceAt: this.balanceAt, balanceStale: this.balanceStale, realizedCents: this.realizedMicros / U, openRiskCents: this.openRiskCents(),
        dayLossCents: this.cfg ? this.dayLossCents(laDay(this.now(), c.dailyLossTimeZone)) : 0, fills: [...this.signals.values()].reduce((a, s) => a + s.fills.length, 0),
        settled: [...this.signals.values()].filter((s) => s.settle && s.filled).length, wins: [...this.signals.values()].filter((s) => s.settle && s.filled && s.settle.pnlMicros > 0).length, losses: [...this.signals.values()].filter((s) => s.settle && s.filled && s.settle.pnlMicros < 0).length },
      trades, compare, shadow: this.shadow.slice(-15).reverse(), events: this.events.slice(-12).reverse().map((e) => ({ at: e.at, t: e.t, tk: e.tk, reason: e.reason, coid: e.coid })) };
    function i0Unfilled(s) { const a = [...s.intents.values()]; return a.length ? Math.max(0, a[0].contracts - s.filled) : null; }
  }
}

module.exports = { KalshiPilot, armPhraseFor, PERM_MSG, isPermission, planSlice, sizingOf, BALANCE_REFRESH_MS, feeCents, worstCents, laDay, loadPilotConfig, PILOT_FILE, PILOT_SHA256, STATES };
