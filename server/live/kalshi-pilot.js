'use strict';
// Kalshi LIVE PILOT: real money, 7% of exchange shard 2 available cash (the shard the 15-minute crypto markets trade on; compounds; no bankroll cap; no loss limit), follows the frozen paper v3 '7pct' line's 'take' decisions (config/frozen/kalshi-live-pilot.json).
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
const { PoolTransfer } = require('./kalshi-transfer');
const { LiveHistory } = require('./kalshi-live-history');

// p6 (Bryan 2026-11-01): same $5,000 per-trade ceiling for BTC, ETH and SOL (the fixed ETH $400 / SOL $250 caps are gone); everything else as p5.
const PILOT_FILE = path.join(__dirname, '..', '..', 'config', 'frozen', 'kalshi-live-pilot-p6.json');
const PILOT_SHA256 = '37510c0514f47b482a864c6cfa6f5cfe6c2ce32f6e37fe6b0b02c989152ae323';
// history: p5 stays on disk byte-for-byte under its old pin (not loaded)
const PILOT_P5_FILE = path.join(__dirname, '..', '..', 'config', 'frozen', 'kalshi-live-pilot.json');
const PILOT_P5_SHA256 = 'a7d67ee97402c392d450acb9e4b7965b24b55ed88925a76caff0e6d8fc32d2a7';
const U = 10000; // u$ per cent
const BALANCE_REFRESH_MS = 20000, BALANCE_TIMEOUT_MS = 4000; // shadow balance refresh: at most once per 20 s, 4 s timeout
const ARM_CHECK_MS = 120000; // phone confirm step: the fresh cash read it showed is good for 2 min, once
const INFO_REFRESH_MS = 60000; // display-only reads (pending deposits, all-shard balance): at most once a minute
const READ_GAP_MS = 1500; // display reads (deposits, all pools) are spaced at least 1.5 s from each other and from the shard read before them
const FILL_RETRY_MS = [500, 1000, 1500, 2000, 2500]; // Kalshi's fills list can lag the order ack: re-read (each wait >= READ_GAP_MS, so ~9 s in all)
const BACKOFF_MAX_MS = 60000; // 429 too_many_requests: back off (doubling from 2 s) and retry the READ only; never a halt by itself
const NO_SEND_KINDS = new Set(['permission', 'auth', 'insufficient', 'reject']);
const STATES = ['DISABLED', 'DISARMED', 'ARMED', 'HALTED'];
const PERM_MSG = "this key can't trade, make a read+trade key";
/** 401/403, or a clear insufficient-scope / permission reply on an order. */
const INSUF_MSG = 'Kalshi rejected the order for insufficient balance on the trading shard';
/** Kalshi's documented reject for not enough cash on the shard (REST code insufficient_balance; FIX text INSUFFICIENT_BALANCE). */
const isInsufficient = (e) => !!e && /insufficient[_ ]?(balance|funds)/i.test(String(e.code || '') + ' ' + String(e.message || ''));
const isPermission = (e) => !!e && (e.status === 401 || e.status === 403 || /insufficient[_ ]?scope|permission|not authori[sz]ed|forbidden/i.test(String(e.code || '') + ' ' + String(e.message || '')));

function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function loadPilotConfig(file = PILOT_FILE, pin = PILOT_SHA256) {
  const buf = fs.readFileSync(file), hash = sha256(buf);
  if (hash !== pin) throw new Error(`pilot config was edited after the freeze (sha256 ${hash.slice(0, 12)} != pinned ${pin.slice(0, 12)})`);
  const cfg = JSON.parse(buf.toString('utf8'));
  if (cfg.side !== 'yes' || cfg.action !== 'buy' || cfg.order.maxPriceCents > 98) throw new Error('pilot config must be YES BUY at <= 98c');
  if (!(Number.isInteger(cfg.balanceExchangeIndex) && cfg.balanceExchangeIndex >= 0)) throw new Error('pilot config needs an integer balanceExchangeIndex >= 0');
  if (typeof cfg.armPhrase !== 'string' || !cfg.armPhrase) throw new Error('pilot config needs an armPhrase');
  return { cfg, hash };
}
/** Kalshi general taker fee for one order, in cents: ceil(0.07 * C * P * (1-P)) with P in dollars. Integer math. */
function feeCents(contracts, priceCents, rateBp = 700) { const num = rateBp * contracts * priceCents * (100 - priceCents); return Math.floor((num + 999999) / 1000000); }
/** Worst-case loss of buying n YES at the limit: everything paid if it settles NO. Cents. */
/** Kalshi price / fee value -> u$ (1e6 per dollar). Dollar strings ("0.9400") and numbers <= 1 are dollars; larger numbers are cents. */
function pxMicros(v) { if (v == null || v === '') return null; if (typeof v === 'string' && v.includes('.')) return rest.dollarsToMicros(v); const n = Number(v); return Number.isFinite(n) ? Math.round(n <= 1 ? n * 1e6 : n * U) : null; }
const sumDollars = (...a) => { const v = a.filter((x) => x != null && x !== '').map((x) => rest.dollarsToMicros(String(x))).filter(Number.isFinite); return v.length ? v.reduce((p, q) => p + q, 0) : null; };
/** Get Order -> { count, status, avgPriceMicros, feeMicros } (fees/cost from the order's own *_dollars fields when present). */
function orderView(o) {
  if (!o) return null; const count = rest.countToInt(o.fill_count_fp != null ? o.fill_count_fp : o.fill_count) || 0;
  const cost = sumDollars(o.taker_fill_cost_dollars, o.maker_fill_cost_dollars), fee = sumDollars(o.taker_fees_dollars, o.maker_fees_dollars);
  return { orderId: o.order_id || null, count, status: o.status || null, avgPriceMicros: count && cost != null ? Math.round(cost / count) : pxMicros(o.average_fill_price), feeMicros: fee };
}
const cts = (m) => (Number.isFinite(m) && m != null ? Math.round(m / U * 100) / 100 + 'c' : '?');
const worstCents = (n, limit) => n * limit + feeCents(n, limit);
const maxN = (budgetCents, limit, hi) => { let n = Math.max(0, Math.min(hi, Math.floor(budgetCents / limit))); while (n > 0 && worstCents(n, limit) > budgetCents) n--; return n; };
function laDay(ms, tz = 'America/Los_Angeles') { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
const toCents = (d) => Math.round(Number(d) * 100);
/**
 * One GET /portfolio/balance reply -> available cash (cents), portfolio_value (cents, open positions) and per-shard cash from
 * balance_breakdown (dollar strings): otherShardCents = the sum of every shard except `shard`; shards = [{ exchangeIndex, cents }]
 * sorted by index (null when Kalshi sent no breakdown). Display only: sizing uses `cents` of the shard-scoped read.
 */
function parseBalance(b, shard) {
  const cents = Number.isInteger(b && b.balance) ? b.balance : Math.round((rest.dollarsToMicros(b && b.balance_dollars) ?? NaN) / U);
  const pv = Number.isInteger(b && b.portfolio_value) ? b.portfolio_value : null;
  let other = null, shards = null; const bd = b && Array.isArray(b.balance_breakdown) ? b.balance_breakdown : null;
  if (bd) {
    shards = [];
    for (const x of bd) { const m = rest.dollarsToMicros(x.balance); if (m == null || !Number.isInteger(x.exchange_index)) continue; const c = Math.round(m / U); shards.push({ exchangeIndex: x.exchange_index, cents: c }); if (x.exchange_index !== shard) other = (other || 0) + c; }
    shards.sort((a, z) => a.exchangeIndex - z.exchangeIndex);
  }
  return { cents, portfolioValueCents: pv, otherShardCents: other, shards };
}
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
  series: 'series', price: 'price', unknown_volume: 'volume unknown', no_balance: 'no balance yet', shard: 'market on another shard' };
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
    this.cfg = null; this.hash = null; this.error = null; this.state = 'DISABLED'; this.inert = []; this.haltReason = null;
    this.signals = new Map(); this.shadow = []; this.events = []; this.realizedMicros = 0; this.dayLoss = new Map();
    this.shards = null; this.shardsAt = null; this.pvAt = null; this.shardMismatch = null; this.balanceCents = null; this.balanceAt = null; this.balanceTryAt = null; this.balanceStale = false; this.balanceError = null; this.backoffMs = 0; this.backoffUntil = 0; this.info = { at: null, tryAt: null, backoffMs: 0, backoffUntil: 0 }; this.portfolioValueCents = null; this.otherShardCents = null; this.outOfMoney = null; this.apiErrors = 0; this.busy = new Set(); this.timers = []; this.preflight = null;
    try { const f = loadPilotConfig(file, pin); this.cfg = f.cfg; this.hash = f.hash; } catch (e) { this.error = e.message; this.inert.push('config: ' + e.message); }
    if (!this.presence.enabledFlag) this.inert.push('LIVE_PILOT_ENABLED is not "true"');
    if (!this.presence.keySet) this.inert.push('Kalshi key not set');
    this.fetchImpl = fetchImpl; this.keyTest = null;
    this.client = null;
    if (!this.inert.length) { try { this.client = client !== undefined ? client : rest.makeTradeClient({ env, fetchImpl, now }); } catch (e) { this.inert.push(e.message); } }
    if (!this.client && !this.inert.length) this.inert.push('trade client unavailable');
    // "Move cash between pools" (desk PC only, Bryan's click + Confirm). Its rows never change pilot state; nothing here runs it automatically.
    // Live chart: real balance reads already made by the pilot + its own ledger rows. Display only, never sizing, never state.
    this.history = new LiveHistory({ dir: this.dir, now });
    this.transfers = new PoolTransfer({ getClient: () => this.transferClient(), write: (r) => this.write(r), now, sleep });
    if (health) health.register('live.kalshi-pilot', { label: `Kalshi LIVE pilot (v3 7% of shard ${this.cfg ? this.cfg.balanceExchangeIndex : '?'} cash)`, group: 'live', note: 'real money; ships disabled and disarmed', staleMs: 600000 });
  }
  get enabled() { return !this.inert.length; }
  // ---- ledger -------------------------------------------------------------------------------------------------
  write(row) { const r = { at: this.now(), ...row }; fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.ledgerFile, JSON.stringify(r) + '\n'); this.apply(r); return r; }
  sig(tk) { let s = this.signals.get(tk); if (!s) { s = { tk, slices: [], fills: [], filled: 0, costMicros: 0, feeMicros: 0, settle: null, intents: new Map(), seen: new Set() }; this.signals.set(tk, s); } return s; }
  apply(r) {
    this.events.push(r); if (this.events.length > 60) this.events.shift();
    if (this.history) this.history.noteRow(r);
    if (r.t === 'signal') Object.assign(this.sig(r.tk), { decisionAsk: r.decisionAsk, limit: r.limit, close: r.close, bookRx: r.bookRx, asset: r.asset, at: r.at });
    if (r.t === 'order_intent') { const s = this.sig(r.tk); s.intents.set(r.coid, { ...r, status: 'intent' }); s.slices.push(r.coid); }
    if (r.t === 'order_sent') { const i = this.sig(r.tk).intents.get(r.coid); if (i) i.status = 'sent'; }
    if (r.t === 'ack' || r.t === 'reconciled') { const i = this.sig(r.tk).intents.get(r.coid); if (i) Object.assign(i, { status: 'done', orderId: r.orderId, ack: r }); }
    if (r.t === 'not_sent') { const i = this.sig(r.tk).intents.get(r.coid); if (i) i.status = 'not_sent'; }
    if (r.t === 'fill_seen') this.sig(r.tk).seen.add(r.fillId); // a real fill for an order already booked from the order lookup: logged, never counted twice
    if (r.t === 'reconcile_mismatch') this.mismatch = r;
    if (r.t === 'fill') { const s = this.sig(r.tk); if (!s.fills.some((f) => f.fillId === r.fillId)) { s.fills.push(r); s.filled += r.count; s.costMicros += r.costMicros; s.feeMicros += r.feeMicros; } }
    if (r.t === 'balance') this.balanceCents = r.balanceCents;
    if (r.t === 'settle') { const s = this.sig(r.tk); if (!s.settle) { s.settle = r; this.realizedMicros += r.pnlMicros; const d = laDay(r.at, this.cfg ? this.cfg.dailyLossTimeZone : undefined); this.dayLoss.set(d, (this.dayLoss.get(d) || 0) + r.pnlMicros); } }
    if (r.t === 'shadow') { this.shadow.push(r); if (this.shadow.length > 50) this.shadow.shift(); }
    if (r.t === 'stop') { this.state = 'HALTED'; this.haltReason = r.reason; }
    if (r.t === 'reset') { this.haltReason = null; this.state = this.enabled ? 'DISARMED' : 'DISABLED'; }
    // who armed / disarmed / reset, for the card ("armed from phone at 14:05"). Display only: replay never re-arms.
    if (r.t === 'arm' || r.t === 'disarm' || r.t === 'reset') this.lastControl = { t: r.t, at: r.at, source: r.source || 'pc', login: r.login || null };
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
    this.history.load();
    this.write({ t: 'session', state: this.state, hash: this.hash, version: this.cfg ? this.cfg.version : null, pid: process.pid });
    if (this.v1 && this.v1.rowListeners) this.v1.rowListeners.push((r) => { try { this.onV1Row(r); } catch (e) { this.log('[kalshi-pilot] ' + e.message); } });
    this.asks = new Map();
    if (this.kalshi && this.kalshi.on) this.kalshi.on('book', (e) => this.onAskBook(e));
    this.startupReconcile = this.reconcilePending('startup').catch((e) => this.halt('exception in startup reconcile: ' + e.message));
    // read-only: book any acked trade whose fills/settlement never made it into the ledger (never halts, never arms, never clears a halt)
    this.startupRecover = this.startupReconcile.then(() => (this.client ? this.recoverTrades('startup') : null)).catch(() => {});
    const t = setInterval(() => this.tick(), 1000); if (t.unref) t.unref(); this.timers.push(t);
  }
  onAskBook(e) { if (e && e.tk && assetOf(e.tk) && e.ya != null) this.asks.set(e.tk, { ask: +e.ya, rx: e.rx }); }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  killed() { return !!(this.killFile && fs.existsSync(this.killFile)); }
  tick() {
    if (this.killed() && this.state !== 'HALTED') this.halt('kill file present (' + path.basename(this.killFile) + ')');
    this.refreshInfo().catch(() => {}); // display only, throttled to once a minute
    { const now = this.now(); if (!this.asksPrunedAt || now - this.asksPrunedAt > 60000) { this.asksPrunedAt = now; if (this.asks) for (const [tk, a] of this.asks) if (!(a.rx > now - 3600e3)) this.asks.delete(tk); } } // bounded: one ask per ticker, forgotten 1 h after its last book (15-min markets)
    for (const s of this.signals.values()) if (s.fills.length && !s.settle && s.settlePending && this.now() - s.settlePending.at > 60000) this.trySettle(s.tk).catch(() => {});
  }
  // ---- halts --------------------------------------------------------------------------------------------------
  async halt(reason, kind = 'halt') {
    const first = this.state !== 'HALTED';
    if (first) { this.write({ t: 'stop', kind, reason: String(reason).slice(0, 400) }); this.log('[kalshi-pilot] HALTED: ' + reason); }
    if (this.client && !NO_SEND_KINDS.has(kind)) await this.cancelResting('halt'); // auth/permission/order-reject halts send nothing else; otherwise only the pilot's own orders (client_order_id hp1-...), never anything else on the account
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
  // ---- arm / reset (server.js calls these only after pilotGate: desk PC on loopback, or a proxy-signed phone request) -----
  /** src = { source: 'pc' | 'phone', login?: Tailscale login, checkId?: from armCheck } (never a token or key). */
  static src(src) { const s = src && src.source === 'phone' ? 'phone' : 'pc'; const login = src && typeof src.login === 'string' && src.login ? src.login.slice(0, 256) : null; return { source: s, login }; }
  sizingLine() {
    const c = this.cfg, xi = c.balanceExchangeIndex, usd0 = (x) => '$' + (x / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const caps = Object.entries(c.perAssetCapCents || {}).map(([a, v]) => `${a} ${usd0(v)}`).join(' / ');
    return `${Math.round(c.perTradePct * 10000) / 100}% of shard ${xi} cash + open cost (compounds, no cap) · at most ${Math.round(c.participationShare * 100)}% of visible volume · asset caps ${caps} · open risk <= bankroll · limit <= ask + ${c.order.limitAboveAskCents}c (max ${c.order.maxPriceCents}c)`;
  }
  /** Phone confirm step: a fresh READ-ONLY shard read, shown before the phrase box. Issues a one-time check id good for 2 min. */
  async armCheck(src) {
    const { source, login } = KalshiPilot.src(src);
    if (this.state === 'HALTED') return { ok: false, error: 'HALTED: type RESET PILOT first (' + this.haltReason + ')' };
    if (this.state === 'ARMED') return { ok: false, error: 'already ARMED' };
    if (!this.enabled) return { ok: false, error: 'DISABLED: ' + this.inert.join('; ') };
    if (this.killed()) return { ok: false, error: 'kill file present' };
    const xi = this.cfg.balanceExchangeIndex; let b;
    try { b = await this.readShard(this.client); } catch (e) { return { ok: false, error: `shard ${xi} cash unreadable right now (${String(e.message || e).slice(0, 120)}); nothing armed` }; }
    const at = this.now(), cents = b && b.cents;
    if (!Number.isFinite(cents)) return { ok: false, error: `shard ${xi} cash unreadable; nothing armed` };
    if (!(cents > 0)) return { ok: false, error: `shard ${xi} cash is $0.00: nothing to trade; nothing armed` };
    const perTradeCents = Math.floor(((cents + this.openRiskCents()) * Math.round(this.cfg.perTradePct * 10000)) / 10000);
    const checkId = crypto.randomBytes(16).toString('hex');
    this.armCheckPending = { checkId, at, source, login };
    return { ok: true, checkId, readAt: at, expiresAt: at + ARM_CHECK_MS, balanceCents: cents, exchangeIndex: xi, perTradeCents,
      sizing: this.sizingLine(), source: source === 'phone' ? 'from phone over Tailscale' + (login ? ` (${login})` : '') : 'from the desk PC', phrase: this.cfg.armPhrase };
  }
  async arm(phrase, src) {
    const { source, login } = KalshiPilot.src(src);
    if (this.state === 'HALTED') return { ok: false, error: 'HALTED: reset first (' + this.haltReason + ')' };
    if (this.state === 'ARMED') return { ok: true, state: 'ARMED' };
    if (!this.enabled) return { ok: false, error: 'DISABLED: ' + this.inert.join('; ') };
    if (phrase !== this.cfg.armPhrase) return { ok: false, error: 'type the exact phrase to arm' };
    if (source === 'phone') { // the phone must have just seen the fresh cash read (confirm step); one use per check
      const c = this.armCheckPending, id = src && src.checkId;
      if (!c || !id || typeof id !== 'string' || c.checkId !== id || c.source !== 'phone') return { ok: false, error: 'confirm step missing: tap "Check shard cash" first' };
      this.armCheckPending = null;
      if (this.now() - c.at > ARM_CHECK_MS) return { ok: false, error: 'the cash read expired (older than 2 min): check again' };
    }
    if (this.killed()) return { ok: false, error: 'kill file present' };
    const pf = await this.runPreflight(); if (!pf.ok) return { ok: false, error: 'preflight failed: ' + pf.error, preflight: pf };
    this.state = 'ARMED'; this.write({ t: 'arm', hash: this.hash, version: this.cfg.version, balanceCents: pf.balanceCents, scopes: pf.scopes, scopeNote: pf.scopeNote, subaccount: pf.subaccount, keySource: pf.keySource, source, login });
    return { ok: true, state: 'ARMED', preflight: pf, source };
  }
  disarm(src) { if (this.state === 'ARMED') { this.state = 'DISARMED'; this.write({ t: 'disarm', ...KalshiPilot.src(src) }); } return { ok: true, state: this.state }; }
  async runPreflight() {
    const pf = { at: this.now(), ok: false };
    try {
      const b = await this.readShard(this.client); pf.balanceCents = b.cents; pf.exchangeIndex = this.cfg.balanceExchangeIndex;
      if (!Number.isFinite(pf.balanceCents)) throw new Error(`shard ${pf.exchangeIndex} balance unreadable`);
      if (!(pf.balanceCents > 0)) throw new Error(`shard ${pf.exchangeIndex} available cash is $0.00: nothing to trade (move cash to shard ${pf.exchangeIndex}: Kalshi's app/web move cash between shards, API orders don't)`);
      if (!this.checkSkew()) throw new Error('clock skew');
      // the money about to be risked: one full trade at 7% of the bankroll (shard cash + the pilot's own open cost)
      pf.perTradeCents = Math.floor(((pf.balanceCents + this.openRiskCents()) * Math.round(this.cfg.perTradePct * 10000)) / 10000);
      if (pf.balanceCents < pf.perTradeCents || pf.perTradeCents < 1) throw new Error(`balance ${pf.balanceCents}c is below one trade (${pf.perTradeCents}c)`);
      const sc = await this.readScopes(this.client); Object.assign(pf, sc);
      if (sc.tradeScope === false) throw new Error(PERM_MSG);
      pf.keySource = this.client.keySource || this.presence.keySource;
      pf.subaccount = this.client.subaccount;
      if (pf.subaccount != null && (pf.subaccount < 0 || pf.subaccount > 63)) throw new Error('bad subaccount');
      this.write({ t: 'balance', balanceCents: pf.balanceCents, src: 'preflight', exchangeIndex: pf.exchangeIndex }); this.noteBalance(b); this.recordBalance('preflight', b); this.markBalance();
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
      const b = await this.readShard(c); r.exchangeIndex = this.cfg.balanceExchangeIndex; r.balanceCents = b.cents; r.portfolioValueCents = b.portfolioValueCents;
      try { const a = parseBalance(await c.getBalance(), r.exchangeIndex); r.aggregateCents = a.cents; r.shards = a.shards; r.otherShardCents = a.otherShardCents != null ? a.otherShardCents : Number.isFinite(a.cents) ? a.cents - b.cents : null; } catch (e) { r.aggregateError = String(e.message || e).slice(0, 120); }
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
  /** The signed client for a pool transfer: the pilot's own, else one built from the same key (like Test key). Never automatic. */
  transferClient() {
    if (this.client) return this.client;
    try { return (this._xferClient = this._xferClient || rest.makeTradeClient({ env: this.env, fetchImpl: this.fetchImpl, now: this.now })); } catch { return null; }
  }
  /** Desk-PC routes only (server.js pilotLocal). A failed transfer never halts the pilot or changes its state. */
  async transferPrepare(b) { if (!this.cfg) return { ok: false, error: 'pilot config not loaded' }; try { return await this.transfers.prepare(b || {}); } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160) }; } }
  async transferConfirm(b) {
    if (!this.cfg) return { ok: false, error: 'pilot config not loaded' };
    let r; try { r = await this.transfers.confirm(b || {}); } catch (e) { return { ok: false, error: 'transfer failed: ' + String(e.message || e).slice(0, 160) }; }
    // Display only: the pools re-read after the transfer replace the shown per-pool cash; the sizing read (shard-scoped) is simply
    // allowed on its next normal turn (no extra request here). Pilot state is not touched.
    const L = r && r.transfer && r.transfer.last;
    if (L && Array.isArray(L.shards) && L.shards.length && L.shards.every((x) => Number.isInteger(x.cents))) { this.shards = L.shards; this.shardsAt = L.at; this.otherShardCents = L.shards.filter((x) => x.exchangeIndex !== this.cfg.balanceExchangeIndex).reduce((a, x) => a + x.cents, 0); this.balanceTryAt = null; this.history.record('after transfer', 'all', { shards: L.shards }); }
    return r;
  }
  transferCancel() { return this.transfers.cancel(); }
  reset(phrase, src) {
    if (this.state !== 'HALTED') return { ok: true, state: this.state };
    if (phrase !== this.cfg.resetPhrase) return { ok: false, error: 'type the exact reset phrase' };
    if (this.killed()) return { ok: false, error: 'remove the kill file first' };
    const s = KalshiPilot.src(src); this.write({ t: 'reset', by: s.source === 'phone' ? 'phone' : 'localhost', ...s }); return { ok: true, state: this.state };
  }
  // ---- money view ---------------------------------------------------------------------------------------------
  openRiskCents() { let s = 0; for (const x of this.signals.values()) if (!x.settle && x.filled) s += Math.ceil((x.costMicros + x.feeMicros) / U); return s; }
  dayOpenRiskCents(day) { let s = 0; for (const x of this.signals.values()) if (!x.settle && x.filled && laDay(x.at || 0, this.cfg.dailyLossTimeZone) === day) s += Math.ceil((x.costMicros + x.feeMicros) / U); return s; }
  dayLossCents(day) { const v = this.dayLoss.get(day) || 0; return v < 0 ? Math.ceil(-v / U) : 0; }
  /** Bankroll = the sizing shard's (cfg.balanceExchangeIndex, 2 in p5 and p6) available cash + the pilot's own open cost (already out of cash). No cap: it compounds. Never portfolio_value, other shards or pending deposits. null until a balance is read. */
  bankrollCents() {
    if (this.balanceCents == null) return null;
    return Math.max(0, this.balanceCents + this.openRiskCents());
  }
  /** Read the sizing shard only: GET /portfolio/balance?exchange_index=<cfg.balanceExchangeIndex>. */
  /**
   * DISPLAY ONLY: the bankroll by Kalshi pool, built purely from balance reads the pilot already made (balance_breakdown from the all-pools
   * read or the pools re-read after a transfer, and the pilot pool's own exchange_index read). Never an extra request, never a made-up
   * number: a pool Kalshi hasn't reported yet is null ("not read yet"). The pilot pool shows whichever of its two reads is newer.
   */
  poolsView() {
    const xi = this.cfg ? this.cfg.balanceExchangeIndex : null, by = new Map((this.shards || []).map((x) => [x.exchangeIndex, x.cents]));
    const list = Object.keys(rest.POOLS).map(Number).map((i) => {
      let cents = by.has(i) ? by.get(i) : null, at = by.has(i) ? this.shardsAt : null, src = by.has(i) ? 'balance_breakdown' : null;
      if (i === xi && this.balanceCents != null && (cents == null || (this.balanceAt || 0) >= (this.shardsAt || 0))) { cents = this.balanceCents; at = this.balanceAt; src = `balance?exchange_index=${i}`; }
      return { exchangeIndex: i, name: rest.POOLS[i], cents, at, src, pilot: i === xi };
    });
    const known = list.filter((x) => Number.isInteger(x.cents)), cashCents = known.length ? known.reduce((a, x) => a + x.cents, 0) : null;
    const pv = Number.isInteger(this.portfolioValueCents) ? this.portfolioValueCents : null, dep = this.info && this.info.deposits;
    const ats = [...list.map((x) => x.at), pv != null ? this.pvAt : null].filter((x) => Number.isFinite(x));
    return { pilotPool: xi, pilotPoolName: xi != null ? rest.POOLS[xi] : null, list, allRead: known.length === list.length,
      availableForPilotCents: this.balanceCents, availableAt: this.balanceAt, availableStale: !!this.balanceStale,
      openPositionsCents: pv, positionsAt: pv != null ? this.pvAt || null : null,
      pendingDepositsCents: dep && !dep.unknown && Number.isInteger(dep.pendingCents) ? dep.pendingCents : null, pendingUnknown: !!(dep && dep.unknown), pendingAt: dep ? dep.at : null,
      cashCents, totalCents: cashCents != null && pv != null ? cashCents + pv : null, readAt: ats.length ? Math.max(...ats) : null, firstReadAt: ats.length ? Math.min(...ats) : null };
  }
  /** Chart only: append a shard-scoped read the pilot just made (never an extra request). */
  recordBalance(src, b) { try { this.history.record(src, 'shard', b, this.cfg.balanceExchangeIndex); } catch { /* display only */ } }
  async readShard(client) { return parseBalance(await client.getBalance({ exchangeIndex: this.cfg.balanceExchangeIndex }), this.cfg.balanceExchangeIndex); }
  noteBalance(b) { if (b.portfolioValueCents != null) { this.portfolioValueCents = b.portfolioValueCents; this.pvAt = this.now(); } if (b.otherShardCents != null) this.otherShardCents = b.otherShardCents; if (b.shards) { this.shards = b.shards; this.shardsAt = this.now(); } }
  /**
   * The market's own exchange shard, from the public market data the desk already has (the recorder's GET /markets discovery
   * carries exchange_index; no extra request). null = unknown. A KNOWN shard that differs from cfg.balanceExchangeIndex means the
   * pilot would size from the wrong shard's cash, so that market is never traded (plain status, not a halt).
   */
  marketShard(tk, sig) {
    if (sig && Number.isInteger(sig.exchangeIndex)) return sig.exchangeIndex;
    const m = this.kalshi && this.kalshi.markets && typeof this.kalshi.markets.get === 'function' ? this.kalshi.markets.get(tk) : null;
    return m && Number.isInteger(m.exchangeIndex) ? m.exchangeIndex : null;
  }
  shardOk(tk, sig) {
    const ms = this.marketShard(tk, sig), want = this.cfg.balanceExchangeIndex;
    if (ms == null) return true; // unknown: the configured shard is used; a wrong shard is caught by Kalshi's insufficient-balance reject (one attempt, then HALT)
    if (ms === want) { if (this.shardMismatch) this.shardMismatch = null; return true; }
    this.shardMismatch = { at: this.now(), tk, marketShard: ms, balanceShard: want }; return false;
  }
  shardMsg() { const m = this.shardMismatch; return m ? `not trading ${m.tk}: that market is on exchange shard ${m.marketShard} but the pilot sizes from shard ${m.balanceShard} cash (Kalshi checks cash on the market's own shard). Nothing was sent; a different sizing shard needs a new config.` : null; }
  /** 429 is never a halt by itself: double the wait (2 s .. 60 s) before the next read of that kind. */
  backoff(o, e) { if (!(e && e.status === 429)) return false; o.backoffMs = Math.min(BACKOFF_MAX_MS, (o.backoffMs || 1000) * 2); o.backoffUntil = this.now() + o.backoffMs; return true; }
  /** Plain status when the shard can't fund one contract at this limit: the pilot just stops trading (not an error, not a halt). */
  checkFunds(limit) {
    if (this.balanceCents != null && this.balanceCents < worstCents(1, limit)) { this.outOfMoney = { at: this.now(), balanceCents: this.balanceCents, limit, exchangeIndex: this.cfg.balanceExchangeIndex }; return false; }
    this.outOfMoney = null; return true;
  }
  /**
   * DISPLAY ONLY, never used for sizing: pending deposits (GET /portfolio/deposits) and the all-shard balance (for portfolio_value
   * and the other shards' cash). Throttled to once a minute; a failed read shows "unknown" and is never a halt; 429 backs off.
   */
  async refreshInfo({ minGapMs = INFO_REFRESH_MS } = {}) {
    const o = this.info; if (!this.client || !this.presence.enabledFlag || !this.presence.keySet || this.state === 'DISABLED') return;
    const t = this.now(); if ((o.tryAt != null && t - o.tryAt < minGapMs) || t < o.backoffUntil) return;
    o.tryAt = t;
    try {
      await this.sleep(READ_GAP_MS);
      const r = await this.client.getDeposits({ limit: 20 }); const pend = (r.deposits || []).filter((d) => d.status === 'pending');
      o.deposits = { pendingCents: pend.reduce((a, d) => a + (Number.isInteger(d.amount_cents) ? d.amount_cents : 0), 0), pendingCount: pend.length, at: t };
      o.backoffMs = 0;
    } catch (e) { this.backoff(o, e); o.deposits = { unknown: true, at: t, error: String(e && e.message || e).slice(0, 80) }; }
    try {
      if (this.now() < o.backoffUntil) return; await this.sleep(READ_GAP_MS); // a 429 on deposits skips this read (backoff)
      const a = parseBalance(await this.client.getBalance(), this.cfg.balanceExchangeIndex);
      if (a.portfolioValueCents != null) { this.portfolioValueCents = a.portfolioValueCents; this.pvAt = this.now(); } this.history.record('all pools', 'all', a);
      this.otherShardCents = a.otherShardCents != null ? a.otherShardCents : null; if (a.shards) { this.shards = a.shards; this.shardsAt = this.now(); }
      o.at = t;
    } catch (e) { this.backoff(o, e); }
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
    const marketShard = this.marketShard(sig.tk, sig);
    this.write({ t: 'signal', tk: sig.tk, asset: sig.asset, decisionAsk: askCents, limit, close: sig.close, bookRx: sig.bookRx, state: this.state, marketShard });
    if (!this.shardOk(sig.tk, sig)) { // wrong shard: never size or send (shadow and armed alike); not a halt
      if (this.state === 'DISARMED') return this.write({ t: 'shadow', noMoney: true, tk: sig.tk, decisionAsk: askCents, limit, contracts: 0, bound: ['shard'], skipped: this.shardMsg(), sizing: sizingOf(this.cfg, this.bankrollCents(), null, 0, limit, ['shard']), slices: [] });
      if (this.state === 'ARMED') return this.write({ t: 'slice_skip', tk: sig.tk, slice: 1, reason: this.shardMsg() });
      return null;
    }
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
   * SHADOW sizing tracks the live sizing-shard cash: a read-only signed GET balance?exchange_index=<cfg> (2 in p5 and p6) before a decision, at most once
   * per 20 s and with a short timeout. A failure never halts in shadow; it marks the balance stale and the last known value is
   * used (or the decision is skipped if there has never been one). A 429 backs off (doubling, up to 60 s) before the next read.
   */
  async refreshBalance({ minGapMs = BALANCE_REFRESH_MS, timeoutMs = BALANCE_TIMEOUT_MS } = {}) {
    if (!this.client || !this.presence.enabledFlag || !this.presence.keySet) return;
    const t = this.now(); if ((this.balanceTryAt != null && t - this.balanceTryAt < minGapMs) || t < this.backoffUntil) return;
    this.balanceTryAt = t; let timer;
    try {
      const b = await Promise.race([this.readShard(this.client), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('balance read timed out')), timeoutMs); if (timer.unref) timer.unref(); })]);
      if (!Number.isFinite(b.cents)) throw new Error('balance unreadable');
      this.balanceCents = b.cents; this.noteBalance(b); this.recordBalance('shard read', b); this.balanceAt = t; this.balanceStale = false; this.balanceError = null; this.backoffMs = 0;
    } catch (e) { if (this.backoff(this, e)) this.write({ t: 'backoff', what: 'balance read', status: 429, waitMs: this.backoffMs }); this.balanceStale = true; this.balanceError = String(e && e.message || e).slice(0, 120); }
    finally { clearTimeout(timer); }
  }
  async shadowPlan(sig, askCents, limit) {
    await this.refreshBalance(); this.infoRun = this.refreshInfo().catch(() => {}); // display only: not awaited, so its 1.5 s spacing never delays a decision
    const s = this.sig(sig.tk);
    if (this.balanceCents == null) {
      const sizing = sizingOf(this.cfg, null, null, 0, limit, ['no_balance']);
      return this.write({ t: 'shadow', noMoney: true, tk: sig.tk, decisionAsk: askCents, limit, contracts: 0, bound: ['no_balance'], skipped: 'no Kalshi balance yet' + (this.balanceError ? ' (' + this.balanceError + ')' : ''), sizing, balanceStale: true, slices: [] });
    }
    if (!this.checkFunds(limit)) return this.write({ t: 'shadow', noMoney: true, tk: sig.tk, decisionAsk: askCents, limit, contracts: 0, bound: ['cash'], skipped: this.fundsMsg(), sizing: sizingOf(this.cfg, this.bankrollCents(), null, 0, limit, ['cash']), balanceCents: this.balanceCents, slices: [] });
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
        try { const b = await this.readArmedBalance(); this.balanceCents = b.cents; this.noteBalance(b); this.recordBalance('pre-slice', b); this.apiErrors = 0; this.markBalance(); }
        catch (e) { this.apiError(e); this.write({ t: 'slice_skip', tk, slice: i, reason: 'balance read failed before the slice: ' + e.message }); await this.halt('balance unreadable before an armed slice (' + e.message + '); sizing needs the live balance', 'balance'); return; }
        if (!Number.isFinite(this.balanceCents)) { this.balanceCents = null; await this.halt('balance unreadable before an armed slice; sizing needs the live balance', 'balance'); return; }
        if (!this.checkFunds(s.limit)) { this.write({ t: 'slice_skip', tk, slice: i, reason: this.fundsMsg() }); return; }
        const z = this.plan(s, s.filled, vol);
        if (z.contracts < 1) { this.write({ t: 'slice_skip', tk, slice: i, reason: 'size 0', bound: z.bound, caps: z.caps, sizing: z.sizing }); return; }
        const done = await this.sendSlice(s, i, z); if (!done) return;
        if (done.filled >= z.contracts) return; // this slice filled in full: the target is reached
      }
    } finally { this.busy.delete(tk); }
  }
  fundsMsg() { const m = this.outOfMoney; return m ? `stopped trading: shard ${m.exchangeIndex} cash $${(m.balanceCents / 100).toFixed(2)} can't buy one contract at ${m.limit}c (not an error; trading resumes when the shard has cash)` : null; }
  /** Armed per-slice read of the sizing shard. A 429 waits (1 s, then 2 s) and retries the read only; 3 errors in a row is the existing halt. */
  async readArmedBalance() {
    for (let a = 0; ; a++) {
      try { return await this.readShard(this.client); }
      catch (e) {
        if (!(e && e.status === 429) || a >= 2 || this.state !== 'ARMED') throw e;
        this.apiError(e); if (this.state !== 'ARMED') throw e;
        this.write({ t: 'backoff', what: 'armed balance read', status: 429, waitMs: 1000 * 2 ** a }); await this.sleep(1000 * 2 ** a);
      }
    }
  }
  async sendSlice(s, i, z) {
    const coid = ('hp1-' + s.tk + '-s' + i).replace(/[^\w-]/g, '').slice(0, 64);
    if (s.intents.has(coid)) return null; // never twice
    if (!this.presence.enabledFlag || this.state !== 'ARMED') return null; // orders are signed only when LIVE_PILOT_ENABLED === 'true' AND ARMED
    if (!this.shardOk(s.tk)) { this.write({ t: 'slice_skip', tk: s.tk, slice: i, reason: this.shardMsg() }); return null; } // last guard before an intent
    const balBefore = this.balanceCents;
    this.write({ t: 'order_intent', tk: s.tk, coid, slice: i, contracts: z.contracts, limit: s.limit, decisionAsk: s.decisionAsk, tif: 'IOC', side: 'yes', action: 'buy', bound: z.bound, caps: z.caps, sizing: z.sizing, balanceBeforeCents: balBefore });
    if (!this.checkSkew()) return null;
    this.write({ t: 'order_sent', tk: s.tk, coid });
    let ack;
    try { ack = await this.client.createOrder({ ticker: s.tk, side: 'yes', action: 'buy', count: z.contracts, priceCents: s.limit, clientOrderId: coid }); this.apiErrors = 0; }
    catch (e) {
      // any clear reject = one attempt, then HALT; nothing else is sent (no retry, no cancel)
      if (isInsufficient(e)) { this.write({ t: 'not_sent', tk: s.tk, coid, error: e.message }); await this.halt(`${INSUF_MSG} (shard ${this.cfg.balanceExchangeIndex} cash $${((balBefore || 0) / 100).toFixed(2)} was read before the order); nothing else is sent`, 'insufficient'); return null; }
      if (isPermission(e)) { this.write({ t: 'not_sent', tk: s.tk, coid, error: e.message }); await this.halt(`permission denied (${e.status || 'scope'}): ${PERM_MSG}`, 'permission'); return null; }
      if (e.status && e.status < 500) { this.write({ t: 'not_sent', tk: s.tk, coid, error: e.message }); await this.halt(`Kalshi rejected the order (${e.status}${e.code ? ' ' + e.code : ''}); nothing else is sent`, 'reject'); return null; }
      await this.halt('order send failed without a clear answer (' + e.message + '); reconcile before resuming', 'unreconciled'); return null; }
    const fc = rest.countToInt(ack.fill_count), rc = rest.countToInt(ack.remaining_count);
    this.write({ t: 'ack', tk: s.tk, coid, orderId: ack.order_id, fillCount: fc, remainingCount: rc, avgFillPrice: ack.average_fill_price, avgFee: ack.average_fee_paid });
    if (rc > 0) this.write({ t: 'cancel', tk: s.tk, coid, orderId: ack.order_id, contracts: rc, reason: 'IOC remainder expired unfilled' });
    const got = await this.reconcileFills(s, ack.order_id, coid, fc, ack);
    if (got == null) return null;
    await this.checkBalance(balBefore, s, coid);
    return { filled: got };
  }
  /** One read of GET /portfolio/fills for this order. New fills are booked once (by fill_id); if the order was already booked from the order
   * lookup, a late real fill is logged as fill_seen and never counted twice. Returns the real fill count for the order. Throws on error. */
  async readFills(s, orderId, coid, source) {
    const r = await this.client.getFills({ ticker: s.tk, orderId }); let n = 0;
    const synth = s.fills.some((x) => x.orderId === orderId && x.synthetic);
    for (const f of r.fills || []) {
      if (f.order_id !== orderId) continue; const count = rest.countToInt(f.count_fp != null ? f.count_fp : f.count), px = rest.dollarsToMicros(f.yes_price_dollars), fee = rest.dollarsToMicros(f.fee_cost);
      n += count; if (s.fills.some((x) => x.fillId === f.fill_id) || s.seen.has(f.fill_id)) continue;
      if (synth) { this.write({ t: 'fill_seen', tk: s.tk, coid, orderId, fillId: f.fill_id, count, priceMicros: px, note: 'already booked from the order lookup; not counted again' }); continue; }
      const feeM = fee != null ? fee : feeCents(count, Math.round(px / U)) * U;
      this.write({ t: 'fill', tk: s.tk, coid, orderId, fillId: f.fill_id, count, priceMicros: px, costMicros: Math.round(count * px), feeMicros: feeM, feeSource: fee != null ? 'fills fee_cost' : 'formula ceil(0.07*C*P*(1-P))',
        isTaker: f.is_taker, ts: f.created_time, ...(source ? { source } : {}) });
    }
    return n;
  }
  async pullFills(s, orderId, coid) {
    try { const n = await this.readFills(s, orderId, coid); this.apiErrors = 0; return n; }
    catch (e) { this.apiError(e); await this.halt('could not read fills for ' + coid + ': ' + e.message, 'unreconciled'); return null; }
  }
  /** Book the part of an order the fills list has not shown yet, from the order lookup (labeled; deterministic id, so never twice). */
  bookFromOrder(s, orderId, coid, L, ackV, have, source, idPrefix) {
    const count = L.count - have; if (!(count > 0)) return 0;
    const px = L.avgPriceMicros != null ? L.avgPriceMicros : ackV.avgPriceMicros;
    const realFee = s.fills.filter((f) => f.orderId === orderId).reduce((a, f) => a + (f.feeMicros || 0), 0);
    const fee = L.feeMicros != null ? { m: Math.max(0, L.feeMicros - realFee), src: 'order_lookup fees' } : ackV.feeEachMicros != null ? { m: Math.round(ackV.feeEachMicros * count), src: 'ack average_fee_paid' }
      : { m: feeCents(count, Math.round((px || 0) / U)) * U, src: 'formula ceil(0.07*C*P*(1-P))' };
    this.write({ t: 'fill', tk: s.tk, coid, orderId, fillId: idPrefix + orderId, count, priceMicros: px, costMicros: Math.round(count * (px || 0)), feeMicros: fee.m, feeSource: fee.src,
      priceSource: L.avgPriceMicros != null ? 'order_lookup' : 'ack average_fill_price', orderStatus: L.status, synthetic: true, source });
    return count;
  }
  /**
   * Ack vs fills. The fills list can lag the ack by seconds, so a disagreement is re-read (0.5..2.5 s, each wait >= 1.5 s; a 429 backs off
   * and is never a halt) and then cross-checked with GET /portfolio/orders/{order_id}. If the order lookup agrees with the ack, the rest is
   * booked from it (source order_lookup) and trading continues. HALT only when the fills still disagree AND the order lookup disagrees too.
   * Runs inside this ticker's busy lock only; other tickers keep deciding.
   */
  async reconcileFills(s, orderId, coid, fc, ack) {
    let got = await this.pullFills(s, orderId, coid); if (got == null) return null;
    if (got === fc) return got;
    const tries = []; let extra = 0; const bo = this.fillsBackoff || (this.fillsBackoff = {});
    for (const d of FILL_RETRY_MS) {
      await this.sleep(Math.max(d, READ_GAP_MS) + extra); extra = 0;
      try { got = await this.readFills(s, orderId, coid); this.apiErrors = 0; bo.backoffMs = 0; tries.push(got); }
      catch (e) {
        if (this.backoff(bo, e)) { extra = bo.backoffMs; tries.push('429'); this.write({ t: 'backoff', what: 'fills retry', status: 429, waitMs: extra }); continue; }
        tries.push('error'); await this.apiError(e); if (this.state === 'HALTED') return null; continue;
      }
      if (got === fc) { this.write({ t: 'fills_lag', tk: s.tk, coid, orderId, retries: tries.length, fillCount: got, note: 'fills arrived after the ack' }); return got; }
    }
    const ackV = { count: fc, avgPriceMicros: pxMicros(ack.average_fill_price), feeEachMicros: pxMicros(ack.average_fee_paid) };
    let L = null, lErr = null; await this.sleep(READ_GAP_MS);
    try { const r = await this.client.getOrder(orderId); L = orderView(r && (r.order || r)); this.apiErrors = 0; } catch (e) { lErr = String(e && e.message || e).slice(0, 80); }
    if (L && L.count === fc && got <= fc) { this.bookFromOrder(s, orderId, coid, L, ackV, got, 'order_lookup', 'ol-'); this.write({ t: 'fills_lag', tk: s.tk, coid, orderId, retries: tries.length, fillCount: got, acceptedFrom: 'order_lookup', orderCount: L.count }); return fc; }
    const d = { t: 'reconcile_mismatch', tk: s.tk, coid, orderId, retries: tries.length, tries,
      ack: { count: fc, avgPriceMicros: ackV.avgPriceMicros, feeEachMicros: ackV.feeEachMicros }, fills: { count: got },
      orderLookup: L ? { count: L.count, status: L.status, avgPriceMicros: L.avgPriceMicros, feeMicros: L.feeMicros } : { error: lErr || 'no answer' } };
    this.write(d);
    const lk = L ? `${L.count} filled @ ${cts(L.avgPriceMicros)} (${L.status || 'status ?'}${L.feeMicros != null ? ', fee ' + cts(L.feeMicros) : ''})` : 'unavailable (' + (lErr || 'no answer') + ')';
    await this.halt(`unreconciled after ${tries.length} fills retries: ack says ${fc} filled @ ${cts(ackV.avgPriceMicros)}${ackV.feeEachMicros != null ? ' (fee ' + cts(ackV.feeEachMicros * fc) + ')' : ''}; fills say ${got}; order lookup says ${lk}`, 'unreconciled');
    return null;
  }
  /**
   * Read-only recovery (desk startup + the desk-PC-only POST /api/live/kalshi-pilot/recover). For every acked order whose fills are missing from
   * the ledger it reads GET /portfolio/orders/{order_id}, GET /portfolio/fills (ticker + order_id) and GET /portfolio/settlements (ticker), each
   * read 1.5 s apart, and appends the fill / settlement / realized P&L lines exactly like the normal path (source: recovered). Idempotent
   * (deterministic ids, already-booked checks), never halts, never clears a halt, never arms, never sends an order or a transfer. A market
   * Kalshi has not settled yet gets only the fill; the settlement is booked by a later run (or the normal v1 settle path).
   */
  recoverTrades(why = 'desk PC') {
    if (!this.cfg || !this.client) return Promise.resolve({ ok: false, error: 'no trade client' });
    if (!this.recovering) this.recovering = this.recoverRun(why).finally(() => { this.recovering = null; });
    return this.recovering;
  }
  async recoverRun(why) {
    const out = { at: this.now(), why, ok: true, checked: 0, fillsBooked: 0, settled: 0, unsettled: 0, reads: [], notes: [], stateBefore: this.state };
    let first = true; const gap = async () => { if (!first) await this.sleep(READ_GAP_MS); first = false; };
    const booked = (s, id) => s.fills.filter((f) => f.orderId === id).reduce((a, f) => a + f.count, 0);
    const todo = new Set();
    try {
      for (const s of [...this.signals.values()]) for (const i of [...s.intents.values()]) {
        const want = i.ack && i.ack.fillCount; if (!i.orderId || !(want > 0) || booked(s, i.orderId) >= want) continue;
        out.checked++; todo.add(s.tk);
        await gap(); let L = null; try { const r = await this.client.getOrder(i.orderId); L = orderView(r && (r.order || r)); } finally { out.reads.push('Get Order'); }
        await gap(); const before = s.fills.length; let got; try { got = await this.readFills(s, i.orderId, i.coid, 'recovered'); } finally { out.reads.push('Get Fills'); }
        out.fillsBooked += s.fills.length - before;
        if (got < want && L && L.count === want) { if (this.bookFromOrder(s, i.orderId, i.coid, L, { avgPriceMicros: pxMicros(i.ack.avgFillPrice), feeEachMicros: pxMicros(i.ack.avgFee) }, booked(s, i.orderId), 'recovered', 'rec-')) out.fillsBooked++; }
        else if (booked(s, i.orderId) < want) out.notes.push(`${i.coid}: ack ${want}, fills ${got}, order lookup ${L ? L.count : '?'}; not booked (they disagree)`);
      }
      for (const s of [...this.signals.values()]) {
        if (s.settle || !s.filled || !(todo.has(s.tk) || s.fills.some((f) => f.source === 'recovered' || f.source === 'order_lookup'))) continue;
        await gap(); let k; try { const r = await this.client.getSettlements(s.tk); k = (r.settlements || []).find((x) => x.ticker === s.tk) || null; } finally { out.reads.push('Get Settlements'); }
        if (!k) { out.unsettled++; out.notes.push(`${s.tk}: Kalshi has not settled it yet; fill booked, settlement later`); continue; }
        const win = k.market_result ? String(k.market_result).toLowerCase() === 'yes' : Number(k.revenue) > 0, winMicros = win ? s.filled * 1e6 : 0, pnl = winMicros - s.costMicros - s.feeMicros;
        const i0 = s.slices.length ? s.intents.get(s.slices[0]) : null, b0 = i0 ? i0.balanceBeforeCents : null, bNow = this.balanceCents, bk = this.bankrollCents();
        const net = Math.round((winMicros - s.costMicros - s.feeMicros) / U);
        this.write({ t: 'settle', tk: s.tk, win, result: k.market_result || (win ? 'yes' : 'no'), contracts: s.filled, costMicros: s.costMicros, feeMicros: s.feeMicros, pnlMicros: pnl,
          source: 'recovered', kalshiRevenueCents: k.revenue, bankrollBeforeCents: bk, bankrollAfterCents: bk == null ? null : bk + Math.floor(pnl / U),
          check: { costCents: -Math.round(s.costMicros / U), feeCents: -Math.round(s.feeMicros / U), payoutCents: Math.round(winMicros / U), netCents: net, balanceBeforeCents: b0, balanceNowCents: bNow,
            balanceDeltaCents: b0 != null && bNow != null ? bNow - b0 : null, matches: b0 != null && bNow != null ? bNow - b0 === net : null, note: 'display only, never a trigger (main-account balance can include other activity)' } });
        out.settled++;
      }
    } catch (e) {
      out.ok = false; if (e && e.status === 429) { this.backoff(this.recoverBackoff || (this.recoverBackoff = {}), e); out.error = '429 from Kalshi: stopped this run; run it again later'; } else out.error = String(e && e.message || e).slice(0, 120);
    }
    out.stateAfter = this.state; if (out.fillsBooked || out.settled) this.write({ t: 'recovery', why, fillsBooked: out.fillsBooked, settled: out.settled, unsettled: out.unsettled });
    this.lastRecovery = out;
    if (out.fillsBooked || out.settled) { const b = await this.afterEventBalance('recovery'); out.balanceRead = b ? { shardCents: b.shardCents, allCents: b.allCents, skipped: b.skipped || null } : null; }
    return out;
  }
  async checkBalance(before, s, coid) {
    try {
      const b = await this.readShard(this.client); const now = Number.isFinite(b.cents) ? b.cents : 0;
      this.recordBalance('after order', b);
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
    this.afterEventBalance('settle ' + tk); // one real balance read so the chart shows the payout (not awaited; never a halt)
  }
  /**
   * ONE read-only balance snapshot after a settlement or a recovery, so the live chart's shard and account-value lines move right away, even
   * while HALTED (a halted pilot does not poll; this is a single read, not a loop). Reuses the pilot's own reads: the sizing-shard read, then
   * the all-pools read, each after the 1.5 s gap, skipped while a 429 backoff is running. Calls that land while one is in flight share it.
   * Display + the pilot's last-known balance only: no order, no transfer, no state change, never a halt.
   */
  afterEventBalance(why) {
    if (!this.client || !this.cfg || this.state === 'DISABLED') return Promise.resolve(null);
    if (!this.postRead) this.postRead = this.postEventRead(why).finally(() => { this.postRead = null; });
    return this.postRead;
  }
  async postEventRead(why) {
    const o = this.postBo || (this.postBo = {}), out = { why, at: this.now(), shardCents: null, allCents: null };
    const busy = () => this.now() < (o.backoffUntil || 0) || this.now() < (this.backoffUntil || 0) || this.now() < (this.info && this.info.backoffUntil || 0);
    if (busy()) { out.skipped = '429 backoff'; return (this.lastPostRead = out); }
    try {
      await this.sleep(READ_GAP_MS); const b = await this.readShard(this.client);
      this.balanceCents = b.cents; this.balanceAt = this.now(); this.balanceStale = false; this.noteBalance(b); this.recordBalance('after ' + why, b); out.shardCents = b.cents; o.backoffMs = 0;
      if (busy()) return (this.lastPostRead = out);
      await this.sleep(READ_GAP_MS); const a = parseBalance(await this.client.getBalance(), this.cfg.balanceExchangeIndex);
      if (a.portfolioValueCents != null) { this.portfolioValueCents = a.portfolioValueCents; this.pvAt = this.now(); }
      if (a.shards) { this.shards = a.shards; this.shardsAt = this.now(); } this.otherShardCents = a.otherShardCents != null ? a.otherShardCents : null;
      this.history.record('after ' + why, 'all', a); out.allCents = a.cents;
    } catch (e) { if (this.backoff(o, e)) out.skipped = '429 backoff'; out.error = String(e && e.message || e).slice(0, 80); }
    return (this.lastPostRead = out);
  }
  /** No loss limit (p4, p5): realized P&L is information only. Only the optional daily stop (OFF in p5) lives here. */
  checkStops() {
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
        source: (s.fills.find((f) => f.source) || {}).source || null, feeSource: (s.fills.find((f) => f.feeSource) || {}).feeSource || null,
        sizing: i0 ? i0.sizing || null : null, sliceSizing: s.slices.map((k) => (s.intents.get(k) || {}).sizing || null) };
    });
    const compare = [...this.signals.values()].slice(-30).reverse().map((s) => {
      const p = L && L.orders.get(s.tk), sh = this.shadow.find((x) => x.tk === s.tk);
      return { tk: s.tk, at: s.at, decisionAsk: s.decisionAsk, paper: p ? { filled: p.filled, vwapCents: p.vwap != null ? Math.round(p.vwap * 10000) / 100 : null, unfilled: p.unfilled, feeCents: Math.round(p.fee * 100) } : null,
        live: s.filled ? { filled: s.filled, vwapCents: Math.round(s.costMicros / s.filled) / U, feeCents: s.feeMicros / U } : null, shadow: sh ? { contracts: sh.contracts, limit: sh.limit, skipped: sh.skipped || null } : null,
        sizing: s.slices.length ? (s.intents.get(s.slices[0]) || {}).sizing || null : sh ? sh.sizing || null : null,
        slippageCents: s.filled ? Math.round((s.costMicros / s.filled / U - s.decisionAsk) * 100) / 100 : null, unfilled: i0Unfilled(s) };
    });
    return { title: `LIVE · REAL MONEY · Kalshi pilot (v3 7% of shard ${c ? c.balanceExchangeIndex : '?'} cash)`, state: this.state, statusChip: this.state === 'DISARMED' ? 'DISARMED-SHADOW' : this.state, inert: this.inert, error: this.error,
      control: { armed: this.state === 'ARMED' && this.lastControl && this.lastControl.t === 'arm' ? this.lastControl : null, last: this.lastControl || null }, // who armed/disarmed/reset (pc|phone + Tailscale login)
      env: this.presence, hash: this.hash, haltReason: this.haltReason, killFile: this.killed(), preflight: this.preflight ? { ok: this.preflight.ok, error: this.preflight.error, warn: this.preflight.warn, scopeNote: this.preflight.scopeNote, at: this.preflight.at } : null,
      keyTest: this.keyTest ? { at: this.keyTest.at, ok: this.keyTest.ok, balanceCents: this.keyTest.balanceCents, exchangeIndex: this.keyTest.exchangeIndex, aggregateCents: this.keyTest.aggregateCents, otherShardCents: this.keyTest.otherShardCents, shards: this.keyTest.shards || null, tradeScope: this.keyTest.tradeScope, scopeNote: this.keyTest.scopeNote, error: this.keyTest.error, warn: this.keyTest.warn, keySource: this.keyTest.keySource } : null,
      mainAccount: this.client ? this.client.subaccount == null : !this.presence.subaccount,
      config: c ? { perTradePct: c.perTradePct, perAssetCapCents: c.perAssetCapCents, participationShare: c.participationShare,
        dailyLossStopCents: c.dailyLossStopCents, shrinkToDailyBudget: !!c.shrinkToDailyBudget, balanceExchangeIndex: c.balanceExchangeIndex, maxPriceCents: c.order.maxPriceCents, maxSlices: c.order.maxSlices, sliceGapMs: c.order.sliceGapMs,
        series: c.series, follows: c.follows.line, armPhrase: c.armPhrase, resetPhrase: c.resetPhrase } : null, // phrases are read-only display (what to type), not secrets
      money: { real: true, bankrollCents: this.cfg ? this.bankrollCents() : null, perTradeCents: this.cfg && this.bankrollCents() != null ? Math.floor((this.bankrollCents() * Math.round(c.perTradePct * 10000)) / 10000) : null, balanceCents: this.balanceCents, balanceAt: this.balanceAt, balanceStale: this.balanceStale,
        balanceSource: c ? { exchangeIndex: c.balanceExchangeIndex, field: 'balance (available cash)', at: this.balanceAt } : null, backoffMs: this.backoffMs || 0,
        pools: this.poolsView(), shardsAt: this.shardsAt, openPositionsCents: this.portfolioValueCents, otherShardCents: this.otherShardCents, shards: this.shards, otherShards: c && this.shards ? this.shards.filter((x) => x.exchangeIndex !== c.balanceExchangeIndex) : null, shardMismatch: this.shardMismatch ? this.shardMsg() : null, deposits: this.info.deposits || null, outOfMoney: this.outOfMoney ? this.fundsMsg() : null, realizedCents: this.realizedMicros / U, openRiskCents: this.openRiskCents(),
        dayLossCents: this.cfg ? this.dayLossCents(laDay(this.now(), c.dailyLossTimeZone)) : 0, fills: [...this.signals.values()].reduce((a, s) => a + s.fills.length, 0),
        settled: [...this.signals.values()].filter((s) => s.settle && s.filled).length, wins: [...this.signals.values()].filter((s) => s.settle && s.filled && s.settle.pnlMicros > 0).length, losses: [...this.signals.values()].filter((s) => s.settle && s.filled && s.settle.pnlMicros < 0).length },
      reconcile: this.mismatch ? { at: this.mismatch.at, tk: this.mismatch.tk, coid: this.mismatch.coid, retries: this.mismatch.retries, ack: this.mismatch.ack, fills: this.mismatch.fills, orderLookup: this.mismatch.orderLookup } : null,
      recovery: this.lastRecovery ? { at: this.lastRecovery.at, why: this.lastRecovery.why, ok: this.lastRecovery.ok, checked: this.lastRecovery.checked, fillsBooked: this.lastRecovery.fillsBooked, settled: this.lastRecovery.settled, unsettled: this.lastRecovery.unsettled, notes: this.lastRecovery.notes.slice(0, 5), error: this.lastRecovery.error || null } : null,
      transfer: this.transfers.view().transfer,
      live: this.history.view(),
      trades, compare, shadow: this.shadow.slice(-15).reverse(), events: this.events.slice(-12).reverse().map((e) => ({ at: e.at, t: e.t, tk: e.tk, reason: e.reason, coid: e.coid })) };
    function i0Unfilled(s) { const a = [...s.intents.values()]; return a.length ? Math.max(0, a[0].contracts - s.filled) : null; }
  }
}

module.exports = { KalshiPilot, PERM_MSG, INSUF_MSG, isPermission, isInsufficient, parseBalance, INFO_REFRESH_MS, planSlice, sizingOf, BALANCE_REFRESH_MS, feeCents, worstCents, laDay, loadPilotConfig, PILOT_FILE, PILOT_SHA256, PILOT_P5_FILE, PILOT_P5_SHA256, STATES };
