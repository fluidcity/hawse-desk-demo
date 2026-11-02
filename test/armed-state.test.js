'use strict';
// Armed on/off persistence (data/state/armed.json): atomic save, load ok/missing/corrupt, restore through arm(),
// never written by an engine that was not started, halt/breaker untouched. Temp files only; no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadArmed, saveArmed } = require('../server/lib/armed-state');
const config = require('../server/config');
const { Engine } = require('../server/engine');
const modules = require('../server/modules');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hawse-armed-'));
function engine(file, extra = {}) {
  const tmp = tmpdir();
  const cfg = config.build({ CREDITS_FILE: '', ODDS_CACHE_FILE: '', BET_RULES_FILE: '', LAB_FILE: '', INBOX_STATE_FILE: '', KALSHI_H2_DIR: path.join(tmp, 'h2'), RECORDER_DIR: path.join(tmp, 'rec'), STORAGE_DATA_DIR: tmp, ARMED_STATE_FILE: file, ...extra });
  if (cfg.lab) cfg.lab.file = '';
  return new Engine(cfg, { modules });
}
const tapeMsgs = (e) => e.tape.rows.map((t) => t.msg);

test('config: default path is data/state/armed.json; empty disables', () => {
  assert.match(config.build({}).armedState.file, /data[\\/]state[\\/]armed\.json$/);
  assert.strictEqual(config.build({ ARMED_STATE_FILE: '' }).armedState.file, null);
});

test('saveArmed/loadArmed: atomic round trip, no temp files left, missing and corrupt detected', () => {
  const d = tmpdir(); const f = path.join(d, 'state', 'armed.json');
  assert.deepStrictEqual(loadArmed(f), { status: 'missing', armed: {} });
  saveArmed(f, { funding_arb: true, 'kalshi-h2': false, 'bad id!': true });
  const r = loadArmed(f); assert.strictEqual(r.status, 'ok'); assert.deepStrictEqual(r.armed, { funding_arb: true, 'kalshi-h2': false });
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); assert.strictEqual(j.version, 1); assert.strictEqual(j.paper, true);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['armed.json']);
  for (const bad of ['{', '[]', 'null', '{"version":2,"armed":{}}', '{"version":1}', '{"version":1,"armed":[]}', '{"version":1,"armed":{"x":"yes"}}', '{"version":1,"armed":{"../x":true}}']) {
    fs.writeFileSync(f, bad); const b = loadArmed(f); assert.strictEqual(b.status, 'corrupt', bad); assert.deepStrictEqual(b.armed, {});
  }
});

test('engine: not started -> arm() never writes the file', () => {
  const f = path.join(tmpdir(), 'armed.json'); const e = engine(f); const id = e.strategies[0].id;
  assert.deepStrictEqual(e.arm(id, true), { persisted: false }); assert.ok(!fs.existsSync(f));
});

test('engine: arm/disarm persists atomically; a fresh engine restores through arm() and logs "Restored armed state"', () => {
  const f = path.join(tmpdir(), 'state', 'armed.json');
  const a = engine(f); a.restoreArmed();
  assert.ok(tapeMsgs(a).some((m) => /^Restored armed state: no saved state .* all strategies disarmed/.test(m)));
  const [s0, s1] = a.strategies; assert.ok(s0 && s1, 'need two strategies');
  assert.deepStrictEqual(a.arm(s0.id, true), { persisted: true }); a.arm(s1.id, true); a.arm(s1.id, false);
  assert.deepStrictEqual(Object.entries(loadArmed(f).armed).filter(([, v]) => v).map(([k]) => k), [s0.id]);
  assert.strictEqual(Object.keys(loadArmed(f).armed).length, a.strategies.length);
  // restart: a new engine restores via each strategy's own arm()
  const b = engine(f); const calls = []; for (const s of b.strategies) { const o = s.arm.bind(s); s.arm = (on) => { calls.push([s.id, on]); return o(on); }; }
  const r = b.restoreArmed(); assert.deepStrictEqual(r.restored, [s0.id]); assert.deepStrictEqual(calls, [[s0.id, true]]);
  assert.strictEqual(b.strategy(s0.id).armed, true); assert.strictEqual(b.strategy(s1.id).armed, false);
  assert.ok(tapeMsgs(b).some((m) => m.startsWith(`Restored armed state: armed ${s0.id} · ${b.strategies.length - 1} disarmed`)), tapeMsgs(b));
  // halt / breaker state is not persisted and keeps working as before
  b.halt(); assert.strictEqual(b.gates.real.manual, true); assert.ok(!('halted' in loadArmed(f).armed));
  const c = engine(f); c.restoreArmed(); assert.strictEqual(c.gates.real.manual, false); assert.strictEqual(c.strategy(s0.id).armed, true);
});

test('engine: corrupt file -> all disarmed, kept aside, replaced on next arm; unknown saved ids preserved', () => {
  const d = tmpdir(); const f = path.join(d, 'armed.json');
  fs.writeFileSync(f, '{"version":1,"armed":{"x":');
  const e = engine(f); e.restoreArmed();
  assert.ok(e.strategies.every((s) => !s.armed));
  assert.ok(tapeMsgs(e).some((m) => /^Restored armed state: saved state unusable \(not JSON\) · all strategies disarmed · kept as armed\.json\.corrupt-\d+/.test(m)));
  assert.ok(fs.readdirSync(d).some((n) => /^armed\.json\.corrupt-\d+$/.test(n))); assert.ok(!fs.existsSync(f));
  const id = e.strategies[0].id; e.arm(id, true); assert.strictEqual(loadArmed(f).armed[id], true);
  saveArmed(f, { ...loadArmed(f).armed, retired_strategy: true });
  const g = engine(f); const r = g.restoreArmed(); assert.ok(!g.strategy('retired_strategy'));
  assert.ok(tapeMsgs(g).some((m) => /1 saved id\(s\) not loaded/.test(m)));
  g.arm(id, false); const after = loadArmed(f).armed; assert.strictEqual(after.retired_strategy, true); assert.strictEqual(after[id], false);
  assert.deepStrictEqual(r.restored, [id]);
});

test('engine: save failure keeps the arm but reports persisted:false on the tape', () => {
  const d = tmpdir(); const blocker = path.join(d, 'file'); fs.writeFileSync(blocker, 'x');
  const e = engine(path.join(blocker, 'armed.json')); e.restoreArmed(); const id = e.strategies[0].id;
  assert.deepStrictEqual(e.arm(id, true), { persisted: false }); assert.strictEqual(e.strategy(id).armed, true);
  assert.ok(tapeMsgs(e).some((m) => /^armed state not saved/.test(m)));
});

test('engine: ARMED_STATE_FILE="" disables persistence (no restore line, never writes)', () => {
  const e = engine(''); assert.strictEqual(e.restoreArmed(), null); assert.deepStrictEqual(e.arm(e.strategies[0].id, true), { persisted: false });
});

test('static: start() restores armed state right after "Desk online"; restore only via s.arm()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'engine.js'), 'utf8');
  assert.match(src, /Desk online · PAPER mode · live order path disabled' \}\);\n\s*this\.restoreArmed\(\);/);
  const body = src.slice(src.indexOf('  restoreArmed() {'), src.indexOf('  persistArmed() {'));
  assert.ok(!/\.armed\s*=/.test(body) && !/order|place|submit/i.test(body.replace(/disarmed|armed/g, '')), 'restore must only call s.arm(true)');
});
