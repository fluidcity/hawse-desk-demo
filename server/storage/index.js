'use strict';
// H7 STORAGE monitor + runtime recorder-cap control (paper desk only; nothing here touches an order path or a secret).
// Bars (each: used, limit, pct, level ok/warn/crit at warnPct 70% / critPct 90%):
//   recorder data (data/recorder vs the recorder cap), paper ledgers (data/paper), odds cache (data/odds-cache.json +
//   data/credits.json), logs (*.log under data/ plus DESK_LOG_FILE), total data/ dir, host disk (statfs of data/'s
//   filesystem), process RSS (vs host RAM) and V8 heap (vs the heap limit). Uncapped consumers are shown as a share of
//   the host disk and say "no cap". With the Cloudflare recorder configured, a 'cf' bar shows its remote SQLite use vs MAX_BYTES
//   and its LIVE/STALE state (STALE also turns the bar amber).
// Runtime cap: setRecorderCap(gb) validates [minGb, maxGb] and the free disk, persists {capGb, at, prevGb} to
// data/runtime/recorder-cap.json (gitignored with the rest of data/), appends to data/runtime/cap-changes.jsonl, writes
// a 'cap_change' meta row in the recorder and applies it to the live store at once (no restart). Shrinking the cap
// prunes the OLDEST CLOSED recorder files first (whole files only, never partial rows, never the open file) through
// RecorderStore.enforceCap, which only walks the recorder dir and skips protected paths (paper ledgers, config/frozen).
const fs = require('fs');
const os = require('os');
const v8 = require('v8');
const path = require('path');
const { walk } = require('../recorder/store');

const GiB = 2 ** 30;
const level = (pct, warn, crit) => (pct == null ? 'n/a' : pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok');
function sizeOf(p) { try { const st = fs.statSync(p); return st.isDirectory() ? walk(p).reduce((a, f) => a + f.size, 0) : st.size; } catch { return 0; } }
function within(child, parent) { const r = path.relative(path.resolve(parent), path.resolve(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); }

/** Read the persisted runtime cap (GiB) or null. Never throws. */
function readRuntimeCap(file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Number.isFinite(+j.capGb) && +j.capGb > 0 ? +j.capGb : null; } catch { return null; } }

class StorageMonitor {
  constructor({ dataDir, recorder = null, cf = null, runtimeDir, logFiles = [], minGb = 1, maxGb = 500, warnPct = 70, critPct = 90, everyMs = 30000,
    statfs = (p) => fs.statfsSync(p), mem = () => process.memoryUsage(), totalMem = () => os.totalmem(), heapLimit = () => v8.getHeapStatistics().heap_size_limit,
    now = () => Date.now(), log = (m) => console.log(m) }) {
    Object.assign(this, { dataDir, recorder, cf, logFiles, minGb, maxGb, warnPct, critPct, everyMs, statfs, mem, totalMem, heapLimit, now, log });
    this.runtimeDir = runtimeDir || path.join(dataDir, 'runtime'); this.capFile = path.join(this.runtimeDir, 'recorder-cap.json'); this.changeLog = path.join(this.runtimeDir, 'cap-changes.jsonl');
    this.last = null; this.changes = []; this.timer = null;
  }
  store() { return this.recorder && this.recorder.store ? this.recorder.store : null; }
  start() { this.measure(); this.timer = setInterval(() => this.measure(), this.everyMs); if (this.timer.unref) this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  disk() { try { const s = this.statfs(this.dataDir); const total = s.blocks * s.bsize, free = s.bavail * s.bsize; return { total, free, used: total - free }; } catch { return null; } }
  bar(id, label, used, limit, note) { const pct = limit ? +((100 * used) / limit).toFixed(1) : null; return { id, label, used, limit, pct, level: level(pct, this.warnPct, this.critPct), note }; }
  measure() {
    const d = this.disk(); const st = this.store(); const D = this.dataDir; const share = d ? d.total : null;
    const recDir = st ? st.dir : path.join(D, 'recorder');
    const rec = sizeOf(recDir), paper = sizeOf(path.join(D, 'paper')), odds = sizeOf(path.join(D, 'odds-cache.json')) + sizeOf(path.join(D, 'credits.json'));
    const logs = walk(D).filter((f) => f.path.endsWith('.log')).reduce((a, f) => a + f.size, 0) + this.logFiles.filter((f) => f && !within(f, D)).reduce((a, f) => a + sizeOf(f), 0);
    const total = sizeOf(D); const m = this.mem(); const capBytes = st ? st.capBytes : null;
    const bars = [
      this.bar('recorder', 'Recorder data', rec, capBytes, capBytes ? `cap ${(capBytes / GiB).toFixed(1)} GiB · oldest closed files pruned first` : 'recorder off'),
      ...(this.cf ? [this.cfBar()] : []),
      this.bar('paper', 'Paper ledgers', paper, share, 'no cap (share of disk) · never pruned (frozen-test ledger is protected)'),
      this.bar('odds', 'Odds cache + credits', odds, share, 'no cap (share of disk) · small JSON, rewritten in place'),
      this.bar('logs', 'Logs', logs, share, 'no cap (share of disk) · *.log under data/' + (this.logFiles.length ? ' + desk log' : '')),
      this.bar('data', 'Total data/ dir', total, share, 'everything under data/ (gitignored)'),
      d ? this.bar('disk', 'Host disk', d.used, d.total, `${(d.free / GiB).toFixed(1)} GiB free`) : this.bar('disk', 'Host disk', 0, null, 'statfs unavailable'),
      this.bar('rss', 'Process memory (RSS)', m.rss, this.totalMem(), 'resident set vs host RAM'),
      this.bar('heap', 'V8 heap', m.heapUsed, this.heapLimit(), 'heap used vs V8 heap limit'),
    ];
    this.last = { at: this.now(), bars, disk: d, thresholds: { warnPct: this.warnPct, critPct: this.critPct } };
    return this.last;
  }
  /** Remote (Cloudflare Durable Object SQLite) usage vs its MAX_BYTES cap, from the last /status the desk fetched. */
  cfBar() {
    const v = this.cf.view(); const used = v.stored ? v.stored.bytes : 0;
    const b = this.bar('cf', 'Cloudflare recorder (remote)', used, v.capBytes || null, v.state === 'off' ? 'not configured' : `${v.state.toUpperCase()}${v.staleReason ? ' (' + v.staleReason + ')' : ''} · ${v.retainDays || '?'} d retention · synced copy under data/recorder/cf`);
    if (v.stale && b.level === 'ok') b.level = 'warn'; b.cf = v; return b;
  }
  limits() { const st = this.store(); const d = this.disk(); const used = st ? st.usedBytes || sizeOf(st.dir) : 0; const room = d ? Math.floor((((d.free + used) * 0.95) / GiB) * 10) / 10 : this.maxGb; return { minGb: this.minGb, maxGb: Math.max(this.minGb, Math.min(this.maxGb, room)) }; }
  /** Change the recorder cap at runtime. Returns { ok, error? , capGb, prevGb, pruned }. */
  setRecorderCap(gb, { by = 'ui' } = {}) {
    const st = this.store(); if (!st) return { ok: false, error: 'recorder is not running' };
    const x = typeof gb === 'string' && gb.trim() !== '' ? +gb : gb;
    if (typeof x !== 'number' || !Number.isFinite(x)) return { ok: false, error: 'capGb must be a number (GiB)' };
    const L = this.limits(); if (x < L.minGb || x > L.maxGb) return { ok: false, error: `capGb must be between ${L.minGb} and ${L.maxGb} GiB (max = 95% of free disk + current recorder use, ≤ ${this.maxGb})` };
    const capGb = Math.round(x * 1000) / 1000; const prevGb = +(st.capBytes / GiB).toFixed(2); const at = this.now();
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const tmp = this.capFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ capGb, at, prevGb, by }) + '\n'); fs.renameSync(tmp, this.capFile);
    const row = { t: 'cap_change', at, prevGb, capGb, by }; fs.appendFileSync(this.changeLog, JSON.stringify(row) + '\n');
    const ev0 = st.evicted; st.capBytes = capGb * GiB; if (this.recorder.cfg) this.recorder.cfg.capBytes = st.capBytes;
    try { st.write('meta', row); } catch { /* store stopped */ }
    st.enforceCap(); const pruned = st.evicted - ev0;
    this.changes.unshift({ ...row, pruned }); this.changes = this.changes.slice(0, 10);
    this.log(`[storage] recorder cap ${prevGb} → ${capGb} GiB (${by})${pruned ? `, pruned ${pruned} oldest file(s)` : ''}`);
    this.measure(); return { ok: true, capGb, prevGb, pruned };
  }
  snapshot() { return { ...(this.last || this.measure()), limits: this.limits(), capFile: path.relative(path.join(this.dataDir, '..'), this.capFile), changes: this.changes }; }
}

/** Same-origin / localhost guard for state-changing storage POSTs. Pure: takes the request's socket address + headers. */
function localOnly(remote, headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const loop = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(remote || ''));
  if (!loop) return { ok: false, why: 'only from localhost' };
  const host = String(h.host || ''); if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return { ok: false, why: 'bad Host header' };
  if (h.origin != null) { let o; try { o = new URL(h.origin); } catch { return { ok: false, why: 'bad Origin' }; } if (o.host.toLowerCase() !== host.toLowerCase()) return { ok: false, why: 'cross-origin' }; }
  if (h['sec-fetch-site'] && !['same-origin', 'none'].includes(h['sec-fetch-site'])) return { ok: false, why: 'cross-site' };
  if (!/^application\/json\b/i.test(String(h['content-type'] || ''))) return { ok: false, why: 'content-type must be application/json' };
  return { ok: true };
}
module.exports = { StorageMonitor, localOnly, readRuntimeCap, within, level };
