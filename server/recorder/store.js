'use strict';
// Append-only, rotated, disk-capped JSONL store for the market-data recorder (H6).
// Layout: <dir>/<YYYY-MM-DD UTC>/<stream>.<HHMMSS>-<pid>.jsonl. One file per stream per period. A file is only ever
// appended to (O_APPEND) while it is open. It rotates hourly (rotateMs) or once it reaches maxFileBytes. After a file
// rotates it is gzipped (zlib, built in) to .jsonl.gz and the raw copy is removed.
// Disk cap: every capCheckMs the whole <dir> is measured. Past capBytes, the OLDEST CLOSED files are deleted until usage
// is back under 90% of the cap (FIFO retention; each deletion is logged as an 'evict' row in the meta stream). If
// usage is still over the cap after that (only open files left), writes are DROPPED and counted, never silently: the
// status panel shows "capped". Nothing here is ever committed: data/ is gitignored.
// Every row gets rx (local receive/write time, ms epoch) and mono (monotonic ms since process start) unless it already has them.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { performance } = require('perf_hooks');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const hmsOf = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`; };
const STREAM_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

function walk(dir) {
  const out = [];
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) { try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* raced with eviction */ } }
  }
  return out;
}

class RecorderStore {
  constructor({ dir, capBytes = 5 * 2 ** 30, maxFileBytes = 64 * 2 ** 20, rotateMs = 3600e3, flushMs = 1000, capCheckMs = 30000, gzip = true,
    now = () => Date.now(), mono = () => performance.now(), log = (m) => console.log(m), pid = process.pid } = {}) {
    if (!dir) throw new Error('RecorderStore needs a dir');
    Object.assign(this, { dir, capBytes, maxFileBytes, rotateMs, flushMs, capCheckMs, gzip, now, mono, log, pid });
    this.open = new Map(); // stream -> { fd, file, openedAt, bytes, buf: [] , bufBytes }
    this.rows = 0; this.bytes = 0; this.dropped = 0; this.evicted = 0; this.evictedBytes = 0; this.rotations = 0; this.gzipped = 0; this.gzIn = 0; this.gzOut = 0;
    this.byStream = {}; this.lastWriteAt = null; this.lastFlushAt = null; this.capped = false; this.usedBytes = null; this.fileCount = null; this.errors = 0; this.lastError = null;
    this.perSec = new Map(); // second -> rows (rolling 60 s)
    this.started = false; this.pending = new Set();
  }
  start() {
    if (this.started) return; this.started = true; fs.mkdirSync(this.dir, { recursive: true });
    this.ft = setInterval(() => this.flush(), this.flushMs); if (this.ft.unref) this.ft.unref();
    this.ct = setInterval(() => this.enforceCap(), this.capCheckMs); if (this.ct.unref) this.ct.unref();
    this.enforceCap();
  }
  stop() { clearInterval(this.ft); clearInterval(this.ct); this.flush(); for (const s of [...this.open.keys()]) this.close(s, false); this.started = false; }
  /** Queue one row (object) on a stream. Returns false if dropped (disk cap reached). */
  write(stream, row) {
    if (!STREAM_RE.test(stream)) throw new Error('bad stream name');
    if (this.capped) { this.dropped++; return false; }
    const now = this.now();
    const r = { rx: now, mono: Math.round(this.mono()), ...row };
    const line = JSON.stringify(r) + '\n';
    let o = this.open.get(stream); if (!o) { o = { fd: null, file: null, openedAt: null, bytes: 0, buf: [], bufBytes: 0 }; this.open.set(stream, o); }
    o.buf.push(line); o.bufBytes += Buffer.byteLength(line);
    this.rows++; const bs = this.byStream[stream] || (this.byStream[stream] = { rows: 0, bytes: 0, lastAt: null }); bs.rows++; bs.lastAt = now;
    const sec = Math.floor(now / 1000); this.perSec.set(sec, (this.perSec.get(sec) || 0) + 1);
    if (o.bufBytes > 1 << 20) this.flushStream(stream, o);
    return true;
  }
  flush() { for (const [s, o] of this.open) this.flushStream(s, o); this.lastFlushAt = this.now(); const cut = Math.floor(this.now() / 1000) - 60; for (const k of this.perSec.keys()) if (k < cut) this.perSec.delete(k); }
  flushStream(stream, o) {
    if (!o.buf.length) return;
    const now = this.now();
    if (o.fd != null && (now - o.openedAt >= this.rotateMs || o.bytes >= this.maxFileBytes || dayOf(now) !== dayOf(o.openedAt))) this.close(stream, true);
    if (o.fd == null) {
      const d = path.join(this.dir, dayOf(now)); fs.mkdirSync(d, { recursive: true });
      let file = path.join(d, `${stream}.${hmsOf(now)}-${this.pid}.jsonl`); let i = 1; while (fs.existsSync(file) || fs.existsSync(file + '.gz')) file = path.join(d, `${stream}.${hmsOf(now)}-${this.pid}-${i++}.jsonl`);
      try { o.fd = fs.openSync(file, 'a'); } catch (e) { this.errors++; this.lastError = e.code || e.message; return; }
      o.file = file; o.openedAt = now; o.bytes = 0;
    }
    const data = o.buf.join(''); o.buf = []; const n = o.bufBytes; o.bufBytes = 0;
    try { fs.writeSync(o.fd, data); o.bytes += n; this.bytes += n; this.byStream[stream].bytes += n; this.lastWriteAt = now; }
    catch (e) { this.errors++; this.lastError = e.code || e.message; }
  }
  close(stream, rotate) {
    const o = this.open.get(stream); if (!o || o.fd == null) return;
    try { fs.closeSync(o.fd); } catch { /* already closed */ }
    const file = o.file; o.fd = null; o.file = null; o.openedAt = null; o.bytes = 0;
    if (rotate) this.rotations++;
    if (this.gzip) this.compress(file);
  }
  compress(file) {
    if (this.pending.has(file)) return; this.pending.add(file);
    let raw; try { raw = fs.readFileSync(file); } catch { this.pending.delete(file); return; }
    const done = (err, gz) => {
      this.pending.delete(file);
      if (err) { this.errors++; this.lastError = 'gzip: ' + (err.code || err.message); return; }
      try { fs.writeFileSync(file + '.gz', gz); fs.unlinkSync(file); this.gzipped++; this.gzIn += raw.length; this.gzOut += gz.length; } catch (e) { this.errors++; this.lastError = e.code || e.message; }
    };
    if (this.started) zlib.gzip(raw, done); else { try { done(null, zlib.gzipSync(raw)); } catch (e) { done(e); } }
  }
  openFiles() { return new Set([...this.open.values()].map((o) => o.file).filter(Boolean)); }
  enforceCap() {
    const files = walk(this.dir); let used = files.reduce((a, f) => a + f.size, 0);
    if (used > this.capBytes) {
      const open = this.openFiles(); const target = this.capBytes * 0.9;
      const closed = files.filter((f) => !open.has(f.path) && !this.pending.has(f.path)).sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
      const gone = [];
      for (const f of closed) { if (used <= target) break; try { fs.unlinkSync(f.path); used -= f.size; this.evicted++; this.evictedBytes += f.size; gone.push(path.relative(this.dir, f.path)); } catch { /* ignore */ } }
      if (gone.length) { this.log(`[recorder] disk cap ${Math.round(this.capBytes / 2 ** 20)} MiB: evicted ${gone.length} oldest file(s)`); this.capped = false; this.write('meta', { t: 'evict', files: gone.slice(0, 50), n: gone.length, usedAfter: used }); }
    }
    const wasCapped = this.capped; this.capped = used > this.capBytes;
    if (this.capped && !wasCapped) this.log('[recorder] disk cap reached with only open files left: dropping writes (counted)');
    this.usedBytes = used; this.fileCount = files.length;
    return { used, capped: this.capped };
  }
  rowsPerMin() { const cut = Math.floor(this.now() / 1000) - 60; let n = 0; for (const [k, v] of this.perSec) if (k >= cut) n += v; return n; }
  /** Last row of the newest meta file left by an EARLIER process (used to mark the offline gap on startup). */
  lastMetaRow() {
    const metas = walk(this.dir).filter((f) => /\/meta\.[^/]+\.jsonl(\.gz)?$/.test(f.path)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of metas) {
      try {
        let buf = fs.readFileSync(f.path); if (f.path.endsWith('.gz')) buf = zlib.gunzipSync(buf);
        const lines = buf.toString('utf8').trimEnd().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* torn last line after a crash */ } }
      } catch { /* unreadable: skip */ }
    }
    return null;
  }
  view() {
    const gzRatio = this.gzIn ? this.gzOut / this.gzIn : null;
    return { dir: this.dir, capBytes: this.capBytes, usedBytes: this.usedBytes, files: this.fileCount, capped: this.capped, dropped: this.dropped, evicted: this.evicted, evictedBytes: this.evictedBytes,
      rows: this.rows, bytes: this.bytes, rowsPerMin: this.rowsPerMin(), lastWriteAt: this.lastWriteAt, rotations: this.rotations, gzipped: this.gzipped, gzRatio, errors: this.errors, lastError: this.lastError,
      streams: Object.fromEntries(Object.entries(this.byStream).map(([k, v]) => [k, { ...v }])) };
  }
}
module.exports = { RecorderStore, dayOf, walk };
