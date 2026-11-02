'use strict';
// HAWSE webhook inbox poller. Helius pushes enhanced transactions to a Cloudflare Worker (POST <HAWSE_WEBHOOK_URL>/helius),
// which keeps them ~24 h. The desk reads them with GET /events?since=<cursor>&limit=<n> (Authorization: Bearer
// <HAWSE_READ_TOKEN>). Polling the inbox costs NO Helius credits; Helius bills each delivery (the feed counts those).
//  - every pollSec (clamped to 15..60 s); loops immediately while more=true (capped per tick)
//  - cursor + last-ok time + recent signatures + gaps persisted to stateFile (data/inbox-state.json by default)
//  - dedupe on transaction signature (Helius retries deliveries)
//  - offline > retention (24 h) => events may have been purged: recorded as a gap and shown in health
//  - 401/403 long backoff, 429 honours Retry-After, 5xx/network exponential backoff
// The base URL and the token are secrets: they never appear in health notes, errors, logs or the client view.
const fs = require('fs');
const path = require('path');
const { withTimeout } = require('../lib/net');

const RETENTION_MS = 24 * 3.6e6;
const clamp = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, n)) : d; };

class InboxPoller {
  constructor({ baseUrl = '', readToken = '', pollSec = 30, limit = 100, stateFile = '', fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
    health = null, hid = 'whale.inbox', onEvent = () => {}, maxPagesPerTick = 50, retentionMs = RETENTION_MS, timeoutMs = 10000, maxSigs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, ''); this.readToken = String(readToken || '');
    this.pollMs = clamp(pollSec, 15, 60, 30) * 1000; this.limit = clamp(limit, 1, 200, 100);
    this.stateFile = stateFile; this.fetchImpl = fetchImpl; this.now = now; this.health = health; this.hid = hid; this.onEvent = onEvent;
    this.maxPages = maxPagesPerTick; this.retentionMs = retentionMs; this.timeoutMs = timeoutMs; this.maxSigs = maxSigs; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.configured = !!(this.baseUrl && this.readToken && /^https?:\/\//.test(this.baseUrl));
    this.state = { cursor: 0, lastOkAt: null, gaps: [], sigs: [] };
    this.stats = { polls: 0, pages: 0, events: 0, txs: 0, dupes: 0, malformed: 0, errors: 0, authFails: 0, rateLimited: 0, lastPollAt: null, lastEventAt: null, lastRttMs: null, lastLagMs: null, lastError: null, backoffMs: 0, nextAt: null };
    this.load(); this.sigSet = new Set(this.state.sigs); this.fails = 0; this.stopped = true;
    if (health) health.register(hid, { label: 'HAWSE webhook inbox (Cloudflare Worker)', group: 'whales', kind: 'live', transport: 'rest', staleMs: this.pollMs * 4,
      note: this.configured ? `polls /events every ${this.pollMs / 1000}s (no Helius credits)` : 'inbox not configured (HAWSE_WEBHOOK_URL / HAWSE_READ_TOKEN missing)' });
  }
  load() {
    if (!this.stateFile) return;
    try { const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); if (Number.isInteger(j.cursor) && j.cursor >= 0) this.state = { cursor: j.cursor, lastOkAt: j.lastOkAt || null, gaps: (j.gaps || []).slice(-20), sigs: (j.sigs || []).slice(-this.maxSigs) }; } catch { /* fresh start: cursor 0 */ }
  }
  save() {
    if (!this.stateFile) return;
    try { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); const tmp = this.stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ ...this.state, sigs: [...this.sigSet].slice(-this.maxSigs) })); fs.renameSync(tmp, this.stateFile); } catch { /* read-only disk: keep going in memory */ }
  }
  /** Strip anything secret from a message before it reaches health/UI/logs. */
  scrub(m) {
    let s = String(m && m.message || m || '');
    for (const v of [this.readToken, this.baseUrl, this.baseUrl.replace(/^https?:\/\//, '')]) if (v && v.length >= 4) s = s.split(v).join('***');
    return s.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/https?:\/\/[^\s"')]+/g, '<url>').slice(0, 160);
  }
  start() { if (!this.configured || !this.stopped) return; this.stopped = false; this.schedule(0); }
  stop() { this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  schedule(ms) { if (this.stopped) return; if (this.timer) this.clearTimer(this.timer); this.stats.nextAt = this.now() + ms; this.timer = this.setTimer(() => { this.timer = null; this.tick().catch(() => {}); }, ms); if (this.timer && this.timer.unref) this.timer.unref(); }
  /** One poll cycle (all pages while more=true, up to maxPages). Returns the delay chosen for the next cycle. */
  async tick() {
    if (this.busy) return this.pollMs; this.busy = true; let delay = this.pollMs; const g = this.gen;
    try {
      this.stats.polls++; this.stats.lastPollAt = this.now();
      for (let page = 0; page < this.maxPages; page++) {
        const r = await this.fetchPage();
        if (g !== this.gen) return delay; // superseded by a watchdog restart
        if (!r.ok) { delay = this.backoff(r); break; }
        this.fails = 0; this.stats.backoffMs = 0;
        if (!r.more) break;
        if (page === this.maxPages - 1) delay = 1000; // still more: come back soon instead of waiting a full interval
      }
    } catch (e) { delay = this.backoff(this.fail('network', 'inbox poll error (' + ((e && (e.code || e.name)) || 'error') + ')')); }
    finally { if (g === this.gen) { this.busy = false; this.schedule(delay); } } // always reschedule, whatever happened above
    return delay;
  }
  /** Watchdog hook: drop any in-flight poll and start a fresh loop now. */
  restart() { if (!this.configured) return; this.gen = (this.gen || 0) + 1; this.busy = false; this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; this.start(); }
  backoff(r) {
    this.fails++; let ms;
    if (r.kind === 'auth') ms = Math.min(30 * 60e3, 5 * 60e3 * 2 ** (this.fails - 1));
    else if (r.kind === 'rate') ms = r.retryAfterMs != null ? Math.min(60 * 60e3, Math.max(this.pollMs, r.retryAfterMs)) : Math.min(15 * 60e3, 60e3 * 2 ** (this.fails - 1));
    else ms = Math.min(5 * 60e3, this.pollMs * 2 ** this.fails);
    this.stats.backoffMs = ms; return ms;
  }
  fail(kind, msg, extra = {}) {
    const m = this.scrub(msg); this.stats.errors++; this.stats.lastError = { at: this.now(), kind, msg: m };
    if (this.health) this.health.fail(this.hid, m); return { ok: false, kind, ...extra };
  }
  async fetchPage() {
    const t0 = this.now(); let res;
    try {
      res = await withTimeout(this.fetchImpl(`${this.baseUrl}/events?since=${this.state.cursor}&limit=${this.limit}`, { headers: { authorization: 'Bearer ' + this.readToken, accept: 'application/json', 'user-agent': 'hawse-paper-desk/2.0' }, signal: AbortSignal.timeout(this.timeoutMs) }), this.timeoutMs + 1000);
    } catch (e) { return this.fail('network', 'inbox unreachable (' + ((e && (e.cause && e.cause.code || e.code || e.name)) || 'network error') + ')'); }
    const rtt = this.now() - t0; this.stats.lastRttMs = rtt;
    if (res.status === 401 || res.status === 403) { this.stats.authFails++; return this.fail('auth', `inbox auth rejected (HTTP ${res.status}): check HAWSE_READ_TOKEN`); }
    if (res.status === 429) {
      this.stats.rateLimited++; const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      const sec = ra != null && ra !== '' && isFinite(+ra) ? +ra : null; return this.fail('rate', `inbox rate-limited (HTTP 429)${sec != null ? `, retry after ${sec}s` : ''}`, { retryAfterMs: sec != null ? sec * 1000 : null });
    }
    if (!res.ok) return this.fail('server', `inbox HTTP ${res.status}`);
    let j; try { j = JSON.parse(await withTimeout(res.text(), this.timeoutMs + 1000)); } catch (e) { return e && e.code === 'ETIMEDOUT' ? this.fail('network', 'inbox response body timed out') : this.fail('server', 'inbox returned invalid JSON'); }
    if (!j || j.ok !== true || !Array.isArray(j.events)) return this.fail('server', 'inbox returned an unexpected shape');
    this.checkGap();
    let maxId = this.state.cursor;
    for (const ev of j.events) {
      if (!ev || !Number.isInteger(+ev.id)) { this.stats.malformed++; continue; }
      if (+ev.id <= this.state.cursor) continue; // already consumed (defensive: the inbox is ascending by id)
      maxId = Math.max(maxId, +ev.id); this.stats.events++;
      const payload = Array.isArray(ev.payload) ? ev.payload : ev.payload && typeof ev.payload === 'object' ? (Array.isArray(ev.payload.transactions) ? ev.payload.transactions : [ev.payload]) : [];
      const txs = payload.filter((t) => t && typeof t === 'object' && typeof t.signature === 'string'); this.stats.malformed += payload.length - txs.length;
      const fresh = [];
      for (const tx of txs) { if (this.sigSet.has(tx.signature)) { this.stats.dupes++; continue; } this.sigSet.add(tx.signature); fresh.push(tx); }
      if (this.sigSet.size > this.maxSigs * 1.5) this.sigSet = new Set([...this.sigSet].slice(-this.maxSigs));
      this.stats.txs += txs.length; const recv = +ev.received_at || this.now();
      this.stats.lastEventAt = recv; this.stats.lastLagMs = Math.max(0, this.now() - recv);
      try { this.onEvent({ id: +ev.id, receivedAt: recv, delivered: payload.length, txs: fresh, dupes: txs.length - fresh.length }); } catch { /* consumer bugs must not stall the cursor */ }
    }
    const next = Number.isInteger(+j.cursor) && +j.cursor >= maxId ? +j.cursor : maxId; // trust the inbox cursor unless it would move backwards
    this.state.cursor = next; this.state.lastOkAt = this.now(); this.stats.pages++; this.save();
    if (this.health) { this.health.ok(this.hid, rtt); this.health.setKind(this.hid, 'live', this.note()); }
    return { ok: true, more: !!j.more && j.events.length > 0 };
  }
  /** Offline longer than the inbox keeps events => some deliveries may be gone. Record once per outage. */
  checkGap() {
    const last = this.state.lastOkAt, t = this.now();
    if (last && t - last > this.retentionMs) {
      this.state.gaps.push({ from: last, to: t, hours: +((t - last) / 3.6e6).toFixed(1), cursor: this.state.cursor });
      this.state.gaps = this.state.gaps.slice(-20);
    }
  }
  note() {
    const g = this.state.gaps[this.state.gaps.length - 1];
    return `polls /events every ${this.pollMs / 1000}s (no Helius credits) · cursor ${this.state.cursor}` + (g ? ` · GAP: offline ${g.hours} h (> 24 h retention), deliveries may be missing` : '');
  }
  /** Client-safe view: counters and times only, never the URL or token. */
  view() {
    const t = this.now(), g = this.state.gaps;
    return { configured: this.configured, cursor: this.state.cursor, pollSec: this.pollMs / 1000, lastOkAt: this.state.lastOkAt, lastOkAgoMs: this.state.lastOkAt ? t - this.state.lastOkAt : null,
      lastEventAgoMs: this.stats.lastEventAt ? t - this.stats.lastEventAt : null, stale: !!(this.state.lastOkAt && t - this.state.lastOkAt > this.pollMs * 4), gaps: g.slice(-5), gapCount: g.length, ...this.stats,
      lastError: this.stats.lastError ? { ...this.stats.lastError } : null };
  }
}

module.exports = { InboxPoller, RETENTION_MS };
