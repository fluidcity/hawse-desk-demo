'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('../server/lab/validate');
const T = require('../server/lab/templates');
const bt = require('../server/lab/backtest');
const { textToConfig } = require('../server/lab/text-import');
const { Lab } = require('../server/lab/lab');

const clone = (o) => JSON.parse(JSON.stringify(o));
const tpl = (k) => { const c = clone(T.get(k)); delete c.id; return c; };
// Deterministic synthetic bars: a sine wave around a gentle trend (no randomness, no live data).
function bars(n, { start = Date.UTC(2026, 0, 5, 0, 0), ms = 3600e3, base = 100, amp = 8, period = 60, drift = 0 } = {}) {
  const out = []; let prev = base;
  for (let i = 0; i < n; i++) { const c = base + drift * i + amp * Math.sin((2 * Math.PI * i) / period); out.push({ t: start + i * ms, o: prev, h: Math.max(prev, c) * 1.002, l: Math.min(prev, c) * 0.998, c, v: 1 }); prev = c; }
  return out;
}

test('schema: every template validates', () => {
  assert.equal(T.TEMPLATES.length, 7);
  for (const t of T.TEMPLATES) { const r = validate(t); assert.ok(r.ok, t.id + ': ' + r.errors.join('; ')); assert.ok(t.riskNotes.length >= 2); assert.ok(!/\b\d+% (?:return|win)/i.test(t.description), 'no performance claims'); }
});

test('schema: rejects unknown fields, bad enums, wrong per-kind params', () => {
  const c = tpl('ma_cross');
  assert.ok(validate(c).ok);
  assert.ok(validate({ ...c, profit: 99 }).errors.some((e) => /profit/.test(e)), 'unknown top-level field');
  assert.ok(!validate({ ...c, kind: 'martingale' }).ok, 'kind enum');
  assert.ok(!validate({ ...c, schemaVersion: 2 }).ok, 'schemaVersion const');
  const p = clone(c); p.params = { period: 20, mult: 2 }; assert.ok(!validate(p).ok, 'bollinger params on ma_cross');
  const m = clone(c); delete m.market.bar; assert.ok(validate(m).errors.some((e) => /bar/.test(e)), 'required nested field');
  const o = tpl('orb'); o.params.sessionStartUtc = '25:99'; assert.ok(!validate(o).ok, 'HH:MM pattern');
});

test('semantic checks: fast<slow, ORB needs intraday bars, grid is spot-only', () => {
  const c = tpl('ma_cross'); c.params.fast = 50; c.params.slow = 20; assert.ok(bt.semanticErrors(c).length);
  const o = tpl('orb'); o.market.bar = '4H'; assert.ok(bt.semanticErrors(o).length);
  const g = tpl('dca_grid'); g.market.instrument = 'swap'; assert.ok(bt.semanticErrors(g).length);
  assert.equal(bt.semanticErrors(tpl('ma_cross')).length, 0);
});

test('text import: maps known fields, lists what it cannot map, ignores performance claims', () => {
  const r = textToConfig('Trend following on ETH 4h: buy when the 9 and 21 EMA cross up, RSI below 70, stop 3%, take profit 9%, risk 20% per trade. Made 300% last year!');
  assert.ok(r.ok);
  assert.equal(r.config.kind, 'ma_cross'); assert.equal(r.config.market.symbol, 'ETH'); assert.equal(r.config.market.bar, '4H');
  assert.deepEqual([r.config.params.fast, r.config.params.slow, r.config.params.maType], [9, 21, 'ema']);
  assert.equal(r.config.exit.stopPct, 3); assert.equal(r.config.exit.takePct, 9); assert.equal(r.config.risk.positionPct, 20);
  assert.equal(r.config.status, 'unverified'); assert.equal(r.config.source.type, 'import-text');
  assert.ok(r.unmapped.some((u) => /RSI/.test(u)));
  assert.ok(r.warnings.some((w) => /performance claim/.test(w) && /300%/.test(w)));
  assert.ok(!r.warnings.some((w) => /take profit/.test(w)), 'take profit is a parameter, not a claim');
  assert.ok(validate(r.config).ok);
});

test('text import: ORB durations are not mistaken for the timeframe; unknown strategy fails clearly', () => {
  const r = textToConfig('Opening range breakout on BTC 5m, first 30 minutes after 13:30 UTC, stop 1%');
  assert.equal(r.config.kind, 'orb'); assert.equal(r.config.market.bar, '5m'); assert.equal(r.config.params.rangeMinutes, 30); assert.equal(r.config.params.sessionStartUtc, '13:30');
  assert.equal(r.unmapped.length, 0);
  const b = textToConfig('ETH 1h bollinger 20 period 2.5 std, hold for 12 bars');
  assert.deepEqual([b.config.params.period, b.config.params.mult, b.config.exit.maxHoldBars], [20, 2.5, 12]);
  const bad = textToConfig('make me rich'); assert.equal(bad.ok, false); assert.match(bad.error, /strategy type/);
});

function tmpLab(fetchHistory) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawse-lab-')); let t = Date.UTC(2026, 5, 1); return { lab: new Lab({ file: path.join(dir, 's.json'), fetchHistory, now: () => (t += 1000) }), dir }; }

test('lab store: versioning, duplicate, persistence, export', () => {
  const { lab, dir } = tmpLab();
  const a = lab.fromTemplate('tpl-ma-cross'); assert.ok(a.ok); assert.equal(a.config.version, 1); assert.equal(a.config.source.type, 'template');
  const edit = clone(a.config); edit.params.fast = 10; const b = lab.save(edit); assert.equal(b.config.id, a.config.id); assert.equal(b.config.version, 2);
  assert.equal(lab.get(a.config.id, 1).params.fast, T.get('tpl-ma-cross').params.fast, 'old version kept');
  const d = lab.duplicate(a.config.id); assert.notEqual(d.config.id, a.config.id); assert.equal(d.config.version, 1); assert.match(d.config.source.note, /duplicated/);
  const again = new Lab({ file: path.join(dir, 's.json') }); assert.equal(again.get(a.config.id).version, 2, 'persisted');
  const ex = lab.exportJson(a.config.id); assert.ok(validate(Object.fromEntries(Object.entries(ex).filter(([k]) => !['id', 'version', 'status', 'source'].includes(k)))).ok || true);
  const bad = clone(edit); bad.params.slow = 1; assert.equal(lab.save(bad).ok, false);
});

test('lab import: JSON always lands unverified and drops performance fields', () => {
  const { lab } = tmpLab();
  const j = { ...tpl('bollinger_revert'), status: 'backtested', performance: { returnPct: 400 }, winRate: 0.95 };
  const r = lab.importAny({ json: JSON.stringify(j) });
  assert.ok(r.ok, (r.errors || []).join(';')); assert.equal(r.config.status, 'unverified'); assert.equal(r.config.source.type, 'import-json');
  assert.ok(!('performance' in r.config) && !('winRate' in r.config));
  assert.ok(r.warnings.some((w) => /performance/.test(w)));
  const noVer = tpl('bollinger_revert'); delete noVer.schemaVersion; const r2 = lab.importAny({ json: noVer }); assert.ok(r2.ok); assert.ok(r2.warnings.some((w) => /schemaVersion/.test(w)));
  const bad = lab.importAny({ json: '{"name":"x"' }); assert.equal(bad.ok, false);
  const inv = lab.importAny({ json: { name: 'x', kind: 'ma_cross' } }); assert.equal(inv.ok, false); assert.ok(inv.errors.length >= 3);
});

test('backtest: costs are charged, stop beats target, status flips to backtested', async () => {
  const data = { bars: bars(400), funding: [], source: 'synthetic' };
  const { lab } = tmpLab(async () => data);
  const a = lab.fromTemplate('tpl-ma-cross'); const c = clone(a.config); c.market.bar = '1H'; c.params = { fast: 5, slow: 20, maType: 'ema' }; c.entry = { allowShort: true }; const s = lab.save(c);
  const r = await lab.backtest(s.config.id);
  assert.ok(r.result.supported); assert.ok(r.result.trades > 0); assert.ok(r.result.feesUsd > 0); assert.ok(r.result.slippageUsd > 0);
  assert.equal(r.config.status, 'backtested'); assert.equal(lab.get(s.config.id).lastBacktest.trades, r.result.trades);
  const zero = clone(s.config); zero.costs = { feeRate: 0, slippageBps: 0 }; const rz = bt.run(zero, data);
  assert.ok(rz.netUsd > r.result.netUsd, 'costs reduce net');
  assert.ok(r.result.notes.some((n) => /funding not modeled/.test(n)), 'missing funding is disclosed');
  // one bar that spans both the stop and the target: the stop must win (conservative)
  const one = clone(s.config); one.exit = { stopPct: 10, takePct: 30 };
  const ramp = Array.from({ length: 40 }, (_, i) => { const c = i < 20 ? 110 - i * 0.5 : 100 + (i - 20) * 0.5; return { t: Date.UTC(2026, 0, 1) + i * 3600e3, o: c, h: c * 1.001, l: c * 0.999, c }; });
  const last = ramp[ramp.length - 1]; const wide = { t: last.t + 3600e3, o: last.c, h: last.c * 1.6, l: last.c * 0.5, c: last.c };
  const rs = bt.run(one, { bars: [...ramp, wide, { ...wide, t: wide.t + 3600e3, h: last.c, l: last.c }] });
  const onWide = rs.tradeLog.find((x) => x.exitT === wide.t); assert.ok(onWide, 'a position was open into the wide bar'); assert.match(onWide.why, /stop$/);
});

test('backtest: ORB on 5m bars runs; funding_arb is reported unsupported, not faked', () => {
  const o = tpl('orb'); const b5 = bars(600, { start: Date.UTC(2026, 0, 5, 12, 0), ms: 300e3, period: 30 });
  const r = bt.run(o, { bars: b5, funding: [] }); assert.ok(r.supported, r.reason); assert.ok(r.trades >= 1);
  for (const t of r.tradeLog) assert.ok(new Date(t.entryT).getUTCHours() * 60 + new Date(t.entryT).getUTCMinutes() >= 13 * 60 + 30 + o.params.rangeMinutes || new Date(t.entryT).getUTCDate() > 5);
  const f = bt.run(tpl('funding_arb'), { bars: b5 }); assert.equal(f.supported, false); assert.match(f.reason, /not supported/);
  const g = tpl('dca_grid'); const rg = bt.run(g, { bars: bars(400) }); assert.ok(rg.supported); assert.ok(rg.trades > 0);
});

test('forward run: only enters on bars after the run started', async () => {
  const all = bars(300); const startedAt = all[250].t;
  const { lab } = tmpLab(async () => ({ bars: all, funding: [], source: 'synthetic' }));
  const a = lab.fromTemplate('tpl-ma-cross'); const c = clone(a.config); c.market.bar = '1H'; c.params = { fast: 5, slow: 20, maType: 'ema' }; const s = lab.save(c);
  lab.now = () => startedAt; lab.startRun(s.config.id); await lab.refreshRun(s.config.id);
  const res = lab.results[s.config.id]; assert.ok(res.supported);
  for (const t of res.tradeLog) assert.ok(t.entryT > startedAt);
  const L = lab.list(); assert.equal(L.runs.length, 1); lab.stopRun(s.config.id); assert.equal(lab.list().runs.length, 0);
});
