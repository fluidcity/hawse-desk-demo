'use strict';
// Persisted armed on/off state for the paper strategies (data/state/armed.json, gitignored under /data/).
// Paper only: this file stores booleans per strategy id and nothing else. It never places, sizes or
// routes an order; restoring goes through each strategy's own arm(), exactly like the dashboard toggle.
// Missing or corrupt file -> everything stays disarmed (the default). A corrupt file is kept aside
// as armed.json.corrupt-<ts> so it can be inspected, and is replaced on the next arm/disarm.
const fs = require('fs');
const path = require('path');

const ID = /^[\w-]{1,64}$/;

/** -> { status: 'ok'|'missing'|'corrupt', armed: {id: bool}, error? } */
function loadArmed(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { status: 'missing', armed: {} } : { status: 'corrupt', armed: {}, error: 'unreadable: ' + e.code }; }
  let j; try { j = JSON.parse(raw); } catch (e) { return { status: 'corrupt', armed: {}, error: 'not JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.version !== 1 || !j.armed || typeof j.armed !== 'object' || Array.isArray(j.armed)) return { status: 'corrupt', armed: {}, error: 'unexpected shape' };
  const armed = {};
  for (const [k, v] of Object.entries(j.armed)) {
    if (!ID.test(k) || typeof v !== 'boolean') return { status: 'corrupt', armed: {}, error: 'bad entry' };
    armed[k] = v;
  }
  return { status: 'ok', armed, savedAt: j.savedAt || null };
}

/** Atomic write: temp file in the same dir, fsync, rename over the target, fsync the dir. */
function saveArmed(file, armed, now = Date.now()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const clean = {}; for (const [k, v] of Object.entries(armed)) if (ID.test(k)) clean[k] = v === true;
  const body = JSON.stringify({ version: 1, savedAt: new Date(now).toISOString(), paper: true, armed: clean }, null, 2) + '\n';
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${now}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {} // best effort (not supported everywhere)
  return clean;
}

/** Move a corrupt file aside (never deleted). Returns the new path or null. */
function quarantine(file, now = Date.now()) {
  const to = `${file}.corrupt-${now}`;
  try { fs.renameSync(file, to); return to; } catch (e) { return null; }
}

module.exports = { loadArmed, saveArmed, quarantine };
