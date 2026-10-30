'use strict';
// Feed-loop watchdog. Every feed that polls or streams declares what "alive" means (watchSpec): which health rows
// it feeds, how often it should touch them, and how to restart its own loop. Once per checkMs the watchdog looks at
// each entry's last ACTIVITY (latest ok OR error: a geo-blocked venue that keeps answering 451 is a live loop, not a
// stalled one). If that is older than max(factor x interval, minStaleMs), the loop is restarted (stop+start, or a
// WebSocket reconnect) with exponential backoff per entry, and a single log line is written (ids + ages only,
// never URLs or env values).
// It also detects wall-clock jumps (Date.now advancing much faster than the monotonic clock): this box is a VM that
// is paused/snapshotted between sessions, during which no timer fires and TCP sockets silently die. On a jump every
// entry is kicked at once instead of waiting for the next stale check.
const { performance } = require('perf_hooks');

class Watchdog {
  constructor({ health, log = (m) => console.log(m), now = () => Date.now(), mono = () => performance.now(), checkMs = 15000, factor = 3, minStaleMs = 45000, maxBackoffMs = 10 * 60e3, jumpMs = 30000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    Object.assign(this, { health, log, now, mono, checkMs, factor, minStaleMs, maxBackoffMs, jumpMs, setTimer, clearTimer });
    this.entries = new Map(); this.jumpListeners = []; this.restarts = 0; this.clockJumps = []; this.lastCheckAt = null; this.started = false;
  }
  /** spec: { key, ids: [healthId...], intervalMs, restart: () => void, activity?: 'any'|'ok' } */
  watch(spec) {
    if (!spec || !spec.key || typeof spec.restart !== 'function' || !(spec.ids || []).length) return;
    this.entries.set(spec.key, { activity: 'any', ...spec, restarts: 0, lastRestartAt: null, nextAllowedAt: 0, backoffMs: 0, lastReason: null, staleSince: null, addedAt: this.now() });
  }
  watchAll(feeds) { for (const f of Object.values(feeds || {})) { if (f && typeof f.onClockJump === 'function') this.onJump((j) => f.onClockJump(j)); if (f && typeof f.watchSpec === 'function') { let s; try { s = f.watchSpec(); } catch { s = null; } for (const e of [].concat(s || [])) this.watch(e); } } return this; }
  /** Called with {at, ms} on every detected wall-clock jump (the recorder writes an explicit gap marker). */
  onJump(f) { if (typeof f === 'function') this.jumpListeners.push(f); return this; }
  start() { if (this.started) return; this.started = true; this.w0 = this.now(); this.m0 = this.mono(); this.timer = this.setTimer(() => this.check(), this.checkMs); if (this.timer && this.timer.unref) this.timer.unref(); }
  stop() { this.started = false; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  /** Last activity (ms epoch) across an entry's health rows; null if none of them has ever reported. */
  activity(e) {
    let last = null;
    for (const id of e.ids) { const s = this.health.src.get(id); if (!s) continue; const t = Math.max(s.lastOk || 0, e.activity === 'ok' ? 0 : (s.lastErr || 0)); if (t && (last == null || t > last)) last = t; }
    return last;
  }
  limitMs(e) { return Math.max(this.factor * e.intervalMs, this.minStaleMs); }
  check() {
    const now = this.now(), mono = this.mono();
    let jumped = 0;
    if (this.w0 != null) { const dw = now - this.w0, dm = mono - this.m0; if (dw - dm > this.jumpMs) jumped = dw - dm; }
    this.w0 = now; this.m0 = mono; this.lastCheckAt = now;
    if (jumped) {
      this.clockJumps.push({ at: now, ms: Math.round(jumped) }); this.clockJumps = this.clockJumps.slice(-20);
      this.log(`[watchdog] wall clock jumped +${Math.round(jumped / 1000)}s vs monotonic (box paused/resumed?) -> restarting ${this.entries.size} feed loops`);
      for (const f of this.jumpListeners) { try { f({ at: now, ms: Math.round(jumped) }); } catch { /* listener errors never stop the watchdog */ } }
    }
    const out = [];
    for (const e of this.entries.values()) {
      const last = this.activity(e); const ref = last != null ? last : e.addedAt; const age = now - ref; const limit = this.limitMs(e);
      if (!jumped && age <= limit) { if (e.staleSince) { e.staleSince = null; e.backoffMs = 0; e.nextAllowedAt = 0; } continue; }
      if (!jumped && last == null && e.ids.every((id) => { const s = this.health.src.get(id); return !s || s.kind === 'mock' || s.status === 'pending'; }) && age < 10 * limit) continue; // still connecting
      e.staleSince = e.staleSince || now;
      if (!jumped && now < e.nextAllowedAt) continue;
      e.backoffMs = jumped ? Math.max(e.backoffMs, limit) : Math.min(this.maxBackoffMs, e.backoffMs ? e.backoffMs * 2 : limit);
      e.nextAllowedAt = now + e.backoffMs; e.restarts++; e.lastRestartAt = now; this.restarts++;
      e.lastReason = jumped ? `clock jump +${Math.round(jumped / 1000)}s` : `no activity for ${Math.round(age / 1000)}s (limit ${Math.round(limit / 1000)}s)`;
      if (!jumped) this.log(`[watchdog] ${e.key} stale: ${e.lastReason} -> restarting loop (restart #${e.restarts}, next check no sooner than ${Math.round(e.backoffMs / 1000)}s)`);
      try { e.restart(); } catch (err) { this.log(`[watchdog] ${e.key} restart failed: ${String(err && err.message || err).replace(/https?:\/\/\S+/g, '<url>').slice(0, 120)}`); }
      out.push(e.key);
    }
    return out;
  }
  view() {
    const now = this.now();
    return { checkMs: this.checkMs, factor: this.factor, restarts: this.restarts, lastCheckAt: this.lastCheckAt, clockJumps: this.clockJumps.slice(-5),
      entries: [...this.entries.values()].map((e) => { const last = this.activity(e); return { key: e.key, ids: e.ids, intervalMs: e.intervalMs, limitMs: this.limitMs(e), activityAgeMs: last != null ? now - last : null, restarts: e.restarts, lastRestartAt: e.lastRestartAt, lastReason: e.lastReason, stale: !!e.staleSince }; }) };
  }
}
module.exports = { Watchdog };
