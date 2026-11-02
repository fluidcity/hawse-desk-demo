'use strict';
// H7 Stage L: desk-side client for the always-on Cloudflare recorder (cloudflare/recorder, Worker "hawse-recorder").
//   status(): GET {url}/status with the READ token (server-side only; the token is never in a snapshot, log or the client bundle).
//   sync():   GET {url}/pull/list?after=<lastId> then /pull/chunk?id=… for each new chunk, written as
//             data/recorder/cf/<YYYY-MM-DD>/<id>-cf.jsonl.gz (inside the recorder dir, so the recorder cap covers it).
//             Resumes from data/recorder/cf/sync-state.json; a chunk already on disk is not fetched twice.
// Honesty: the panel shows STALE when the remote's last write is older than staleMs, when the remote itself says stale,
// or when the desk could not reach it for 3 status intervals. Nothing here can start/stop the recorder (that needs the
// ADMIN token, which the desk does not load).
const fs = require('fs');
const path = require('path');

class CfRecorderRemote {
  constructor({ url, token, dir, health = null, statusMs = 60000, syncMs = 600000, sync = true, staleMs = 180000, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = (m) => console.log(m) }) {
    Object.assign(this, { dir, health, statusMs, syncMs, syncOn: sync, staleMs, fetchImpl, now, log });
    Object.defineProperty(this, 'token', { value: token || '', enumerable: false }); // not enumerable: never serialized
    this.url = String(url || '').replace(/\/$/, ''); this.configured = !!(this.url && this.token && /^https:\/\//.test(this.url));
    this.last = null; this.lastOkAt = null; this.error = null; this.timers = []; this.syncing = false;
    this.stateFile = path.join(dir, 'sync-state.json'); this.state = this.readState();
    if (health) health.register('rec.cf', { label: 'Recorder · Cloudflare (always-on)', group: 'recorder', note: this.configured ? `${new URL(this.url).host} · status every ${statusMs / 1000}s` : 'not configured (CF_RECORDER_URL / CF_RECORDER_READ_TOKEN)', staleMs: statusMs * 3 });
  }
  readState() { try { const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); return { lastId: +j.lastId || 0, files: +j.files || 0, bytes: +j.bytes || 0, at: j.at || null, rows: +j.rows || 0 }; } catch { return { lastId: 0, files: 0, bytes: 0, rows: 0, at: null }; } }
  diskTotals() {
    let files = 0, bytes = 0;
    try { for (const day of fs.readdirSync(this.dir)) { if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue; for (const f of fs.readdirSync(path.join(this.dir, day))) if (f.endsWith('-cf.jsonl.gz')) { files++; bytes += fs.statSync(path.join(this.dir, day, f)).size; } } } catch {}
    return { files, bytes };
  }
  saveState() { fs.mkdirSync(this.dir, { recursive: true }); const t = this.stateFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(this.state) + '\n'); fs.renameSync(t, this.stateFile); }
  async get(p) {
    const r = await this.fetchImpl(this.url + p, { method: 'GET', headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${p.split('?')[0]}`); return r;
  }
  start() {
    if (!this.configured) return;
    const st = () => this.status().catch(() => {}); st(); this.timers.push(setInterval(st, this.statusMs));
    if (this.syncOn) { const sy = () => this.sync().catch(() => {}); setTimeout(sy, 5000).unref?.(); this.timers.push(setInterval(sy, this.syncMs)); }
    for (const t of this.timers) t.unref?.();
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  async status() {
    if (!this.configured) return null;
    const t0 = this.now();
    try {
      const s = await (await this.get('/status')).json(); this.last = { ...s, checkedAt: this.now() }; this.lastOkAt = this.now(); this.error = null;
      const v = this.view();
      if (this.health) { if (v.stale) this.health.fail('rec.cf', `remote STALE: ${v.staleReason}`); else this.health.ok('rec.cf', this.now() - t0); }
      return s;
    } catch (e) { this.error = String(e.message || e).replace(this.token, '***'); if (this.health) this.health.fail('rec.cf', this.error); throw e; }
  }
  async sync({ max = 500 } = {}) {
    if (!this.configured || this.syncing) return { fetched: 0, skipped: true }; this.syncing = true;
    let fetched = 0, bytes = 0;
    try {
      // Another process (the CLI, or a second desk) may have synced since: adopt the newer on-disk cursor, and count files
      // and bytes from disk so the two never overwrite each other's totals.
      const d = this.readState(); if (d.lastId > this.state.lastId) this.state = d;
      const disk = this.diskTotals(); this.state.files = disk.files; this.state.bytes = disk.bytes;
      for (let guard = 0; guard < 20 && fetched < max; guard++) {
        const j = await (await this.get(`/pull/list?after=${this.state.lastId}&limit=200`)).json(); const list = j.chunks || [];
        if (!list.length) break;
        for (const c of list) {
          if (fetched >= max) break;
          const day = new Date(c.t0).toISOString().slice(0, 10), f = path.join(this.dir, day, `${String(c.id).padStart(9, '0')}-cf.jsonl.gz`);
          if (!fs.existsSync(f)) {
            const buf = Buffer.from(await (await this.get(`/pull/chunk?id=${c.id}`)).arrayBuffer());
            if (buf.length !== c.bytes) throw new Error(`chunk ${c.id}: ${buf.length} bytes, expected ${c.bytes}`);
            fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
            fetched++; bytes += buf.length; this.state.files++; this.state.bytes += buf.length; this.state.rows += c.rows || 0;
          }
          this.state.lastId = c.id; this.state.at = this.now(); this.saveState();
        }
      }
      this.syncError = null; return { fetched, bytes, lastId: this.state.lastId };
    } catch (e) { this.syncError = String(e.message || e).replace(this.token, '***'); throw e; } finally { this.syncing = false; }
  }
  /** Panel view. Numbers only, no URL path secrets, no token. */
  view() {
    const now = this.now(), s = this.last;
    const base = { configured: this.configured, host: this.configured ? new URL(this.url).host : null, error: this.error, sync: { on: this.syncOn, everyS: this.syncMs / 1000, ...this.state, error: this.syncError || null } };
    if (!this.configured) return { ...base, state: 'off', stale: true, staleReason: 'not configured' };
    if (!s) return { ...base, state: this.error ? 'down' : 'pending', stale: true, staleReason: this.error ? 'unreachable: ' + this.error : 'no status yet' };
    const age = s.lastWriteAt ? now - s.lastWriteAt : null, checkAge = now - (this.lastOkAt || 0);
    let staleReason = null;
    if (checkAge > this.statusMs * 3) staleReason = `desk could not reach it for ${Math.round(checkAge / 1000)}s`;
    else if (!s.running) staleReason = 'recorder stopped';
    else if (age == null) staleReason = 'no chunk written yet';
    else if (age > this.staleMs || s.stale) staleReason = `last write ${Math.round(age / 1000)}s ago`;
    const http = s.http || {}; const req = Object.values(http).reduce((a, h) => a + (h.req || 0), 0), s429 = Object.values(http).reduce((a, h) => a + (h.s429 || 0), 0);
    return { ...base, state: staleReason ? 'stale' : 'live', stale: !!staleReason, staleReason, running: !!s.running, lastWriteAt: s.lastWriteAt || null, lastWriteAgeS: age == null ? null : Math.round(age / 1000), checkedAt: s.checkedAt,
      stored: s.stored || null, capBytes: (s.cfg && s.cfg.maxBytes) || null, retainDays: (s.cfg && s.cfg.retainDays) || null, alarms: s.alarms, restarts: s.restarts, gaps: s.gaps, recentGaps: (s.recentGaps || []).slice(-5),
      http, req, s429, share429: req ? +(s429 / req).toFixed(5) : 0, errors: s.errors || {}, kalshi: s.kalshi || [], poly: s.poly || [], rowsByStream: s.rowsByStream || {} };
  }
  snapshot() { return this.view(); }
}

module.exports = { CfRecorderRemote };
