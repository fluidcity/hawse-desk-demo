'use strict';
// Stage 10: rules → signals → slips, registry-based signal types, disabled venue adapters, module boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SignalTypeRegistry } = require('../server/betting/rules/registry');
const { validateRule, scan } = require('../server/betting/rules/engine');
const { textToRule } = require('../server/betting/rules/text');
const TEMPLATES = require('../server/betting/rules/templates').RULES;
const { LineHistory } = require('../server/betting/data/lines');
const { SignalBook } = require('../server/betting/signals');
const { buildSlip, slipText } = require('../server/betting/slip');
const V = require('../server/betting/venues');
const { RuleDesk } = require('../server/betting/desk');
const { routes } = require('../server/betting/routes');
const { OddsFeed } = require('../server/betting/data/odds');
const bettingCfg = require('../server/betting/config').fromEnv({});

const T0 = Date.UTC(2026, 9, 29, 18, 0, 0);
const HOME = 'Home Hawks', AWAY = 'Away Owls';
const book = (key, h, a, spH = -3, sp = [1.91, 1.91]) => ({ key, title: key, lastUpdate: T0, markets: { h2h: [{ name: HOME, dec: h }, { name: AWAY, dec: a }], spreads: [{ name: HOME, point: spH, dec: sp[0] }, { name: AWAY, point: -spH, dec: sp[1] }] } });
// book_a hangs a stale +EV price on the home team; the others agree.
const mkEv = (over = {}) => ({ id: 'ev1', sport: 'basketball_nba', home: HOME, away: AWAY, commence: T0 + 3 * 3600e3, books: [book('book_a', 2.3, 1.65), book('book_b', 2.0, 1.85), book('book_c', 2.0, 1.85), book('book_d', 2.0, 1.85)], ...over });
const fakeFeed = (events, simulated = true) => ({ mode: simulated ? 'mock' : 'live', simulated, upcoming: () => events, list: () => events });
const fakeStats = { mode: 'mock', label: 'test stats', simulated: true, teamInfo: (sport, team) => ({ team, restDays: team === AWAY ? 0 : 2, backToBack: team === AWAY, simulated: true,
  players: [{ name: team + ' Star', role: 30, status: team === AWAY ? 'out' : 'active', season: { pts: 20 }, recent: { pts: 28 }, games: 5 }] }) };
const evRule = { name: 'EV 3', conditions: [{ type: 'ev_at_least', params: { minPct: 3, minBooks: 3 } }] };

test('registry: built-in types are described without code and are not replaceable', () => {
  const reg = new SignalTypeRegistry(); const d = reg.describe();
  assert.ok(d.length >= 17); assert.ok(d.every((t) => t.builtin && !('evaluate' in t)));
  for (const id of ['ev_at_least', 'line_moved', 'back_to_back', 'key_player_out', 'arb_available', 'odds_between']) assert.ok(reg.has(id), id);
  assert.match(reg.addCustom({ id: 'ev_at_least', label: 'x', conditions: [{ type: 'market_is', params: { markets: ['h2h'] } }] }).errors.join(), /built-in/);
});

test('registry: signal-type packs (e.g. from ReelRipper) import as data-only compositions with placeholders', () => {
  const reg = new SignalTypeRegistry();
  const pack = { schema: 'hawse.signalTypes/1', source: { type: 'reelripper', note: 'video 123' }, types: [
    { id: 'tired_opp_value', label: 'Tired opponent + value', params: { edge: { type: 'number', default: 2 } }, conditions: [{ type: 'back_to_back', params: { team: 'opponent' } }, { type: 'ev_at_least', params: { minPct: '$edge', minBooks: 3 } }] },
    { id: 'tired_opp_ml', label: 'Uses the previous type', conditions: [{ type: 'tired_opp_value', params: { edge: 1 } }, { type: 'market_is', params: { markets: ['h2h'] } }] }] };
  const r = reg.importPack(pack); assert.deepEqual(r.errors, []); assert.deepEqual(r.added, ['tired_opp_value', 'tired_opp_ml']);
  assert.equal(reg.get('tired_opp_value').source.type, 'reelripper'); assert.deepEqual(reg.get('tired_opp_value').needs.sort(), ['odds', 'stats']);
  assert.equal(reg.exportPack().types.length, 2);
  // invalid packs are refused with reasons
  assert.equal(reg.importPack({ types: [] }).ok, false);
  const bad = reg.importPack({ schema: 'hawse.signalTypes/1', types: [
    { id: 'Bad Id', label: 'x', conditions: [{ type: 'market_is', params: { markets: ['h2h'] } }] },
    { id: 'self_ref', label: 'x', conditions: [{ type: 'self_ref' }] },
    { id: 'no_such', label: 'x', conditions: [{ type: 'does_not_exist' }] },
    { id: 'ph_missing', label: 'x', conditions: [{ type: 'ev_at_least', params: { minPct: '$nope' } }] },
    { id: 'bad_param', label: 'x', conditions: [{ type: 'ev_at_least', params: { minPct: 'lots' } }] }] });
  assert.equal(bad.ok, false); assert.deepEqual(bad.added, []);
  const e = bad.errors.join('\n'); for (const re of [/must match/, /unknown type "self_ref"|recursive/, /unknown type "does_not_exist"/, /placeholder \$nope/, /minPct/]) assert.match(e, re);
});

test('custom types evaluate through the scanner (placeholder substitution, negate)', () => {
  const reg = new SignalTypeRegistry();
  reg.importPack({ schema: 'hawse.signalTypes/1', types: [{ id: 'value_vs_tired', label: 'v', params: { edge: { type: 'number', default: 2 } }, conditions: [{ type: 'back_to_back', params: { team: 'opponent' } }, { type: 'ev_at_least', params: { minPct: '$edge', minBooks: 3 } }] }] });
  const mk = (edge, negate) => validateRule(reg, { name: 'r', conditions: [{ type: 'value_vs_tired', params: { edge }, negate }, { type: 'market_is', params: { markets: ['h2h'] } }] }).rule;
  const hits = scan(reg, [mk(3)], [mkEv()], { now: T0, stats: fakeStats });
  assert.equal(hits.length, 1); assert.equal(hits[0].name, HOME); assert.ok(hits[0].evPct > 3); assert.ok(hits[0].simulated); assert.match(hits[0].simReasons.join(), /value_vs_tired used MOCK stats/);
  assert.equal(scan(reg, [mk(50)], [mkEv()], { now: T0, stats: fakeStats }).length, 0, 'placeholder value is applied');
  assert.ok(scan(reg, [mk(50, true)], [mkEv()], { now: T0, stats: fakeStats }).length >= 1, 'negate inverts a known result');
});

test('validateRule: refuses auto-placement fields, unknown types and bad params; drops performance claims', () => {
  const reg = new SignalTypeRegistry();
  for (const k of ['autoPlace', 'autoBet', 'placeOrders', 'live', 'execute', 'venue', 'orderSize']) assert.match(validateRule(reg, { ...evRule, [k]: true }).errors.join(), /not supported/, k);
  assert.match(validateRule(reg, { name: 'x', conditions: [{ type: 'nope' }] }).errors.join(), /unknown condition type/);
  assert.match(validateRule(reg, { name: 'x', conditions: [{ type: 'side_is', params: { side: 'sideways' } }] }).errors.join(), /side/);
  assert.match(validateRule(reg, { conditions: evRule.conditions }).errors.join(), /name/);
  assert.equal(validateRule(reg, { name: 'x', conditions: [] }).ok, false);
  const v = validateRule(reg, { ...evRule, winRate: 0.9, roi: 40 }); assert.ok(v.ok); assert.match(v.warnings.join(), /winRate/); assert.ok(!('winRate' in v.rule));
  assert.equal(v.rule.id, 'rule-ev-3');
  for (const t of TEMPLATES) { const x = validateRule(reg, t); assert.ok(x.ok, t.name + ': ' + (x.errors || []).join()); assert.equal(t.enabled, false); }
});

test('scan: upcoming games only; signals tagged simulated when the odds feed is MOCK', () => {
  const reg = new SignalTypeRegistry(), rule = validateRule(reg, evRule).rule;
  const live = scan(reg, [rule], [mkEv()], { now: T0, oddsSimulated: false });
  assert.equal(live.length, 1); assert.equal(live[0].book, 'book_a'); assert.equal(live[0].simulated, false);
  assert.equal(scan(reg, [rule], [mkEv()], { now: T0, oddsSimulated: true })[0].simulated, true);
  assert.deepEqual(scan(reg, [rule], [mkEv({ commence: T0 - 1 })], { now: T0 }), [], 'started games are ignored');
  assert.deepEqual(scan(reg, [{ ...rule, enabled: false }], [mkEv()], { now: T0 }), [], 'disabled rules do not scan');
});

test('stats-based conditions are tagged simulated with MOCK stats; unknown without stats', () => {
  const reg = new SignalTypeRegistry();
  const rule = validateRule(reg, { name: 'fade tired', conditions: [{ type: 'back_to_back', params: { team: 'opponent' } }, { type: 'key_player_out', params: { team: 'opponent' } }, { type: 'market_is', params: { markets: ['h2h'] } }] }).rule;
  const s = scan(reg, [rule], [mkEv()], { now: T0, stats: fakeStats, oddsSimulated: false });
  assert.equal(s.length, 1); assert.equal(s[0].name, HOME); assert.equal(s[0].simulated, true);
  assert.deepEqual(s[0].simReasons, ['back_to_back used MOCK stats', 'key_player_out used MOCK stats']);
  assert.equal(scan(reg, [rule], [mkEv()], { now: T0, stats: null }).length, 0);
});

test('line_moved uses LineHistory (toward = steam)', () => {
  const reg = new SignalTypeRegistry(), lines = new LineHistory();
  const rule = validateRule(reg, { name: 'steam', conditions: [{ type: 'line_moved', params: { minPoints: 1, direction: 'toward' } }, { type: 'market_is', params: { markets: ['spreads'] } }] }).rule;
  const e1 = mkEv(); lines.observe(e1, T0);
  assert.equal(scan(reg, [rule], [e1], { now: T0, lines }).length, 0, 'no movement yet');
  // market moves from Home -3 to Home -4.5 (toward home)
  const e2 = mkEv({ books: ['book_a', 'book_b', 'book_c', 'book_d'].map((k) => book(k, 1.8, 2.05, -4.5)) }); lines.observe(e2, T0 + 60e3);
  const mv = lines.move('ev1', 'spreads', HOME); assert.ok(mv.points > 0, JSON.stringify(mv));
  const hits = scan(reg, [rule], [e2], { now: T0 + 60e3, lines });
  assert.deepEqual(hits.map((h) => h.name), [HOME]);
});

test('SignalBook: refresh, cooldown, dismiss sticks, expiry at start', () => {
  let now = T0; const raised = [];
  const b = new SignalBook({ now: () => now, onRaise: (s) => raised.push(s) });
  const reg = new SignalTypeRegistry(), rule = { ...validateRule(reg, evRule).rule, cooldownMin: 30 };
  const d = () => scan(reg, [rule], [mkEv()], { now, oddsSimulated: true });
  assert.equal(b.ingest(d(), { [rule.id]: rule }).length, 1); assert.equal(raised.length, 1);
  now += 60e3; assert.equal(b.ingest(d(), { [rule.id]: rule }).length, 0, 'same open signal is refreshed, not duplicated');
  const id = b.list()[0].id; b.setStatus(id, 'dismissed'); now += 60e3;
  assert.equal(b.ingest(d(), { [rule.id]: rule }).length, 0, 'dismissed stays dismissed'); assert.equal(b.get(id).status, 'dismissed');
  assert.equal(b.setStatus(id, 'placed'), null, 'no "placed" status exists');
  now = T0 + 4 * 3600e3; b.ingest([], {}); assert.equal(b.get(id).expired, true);
  assert.deepEqual(Object.keys(b.counts()).sort(), ['dismissed', 'new', 'open', 'reviewed', 'slipped']);
});

test('slip: manual-placement slip with price limits, prediction-market cents, capped stake and a SIM watermark', () => {
  const reg = new SignalTypeRegistry(); const [sig] = scan(reg, [validateRule(reg, evRule).rule], [mkEv()], { now: T0, oddsSimulated: true });
  const s = buildSlip({ ...sig, id: 'sig-1' }, { bankrollUsd: 1000, kellyFraction: 0.25, maxStakePct: 2, now: T0 });
  assert.equal(s.schema, 'hawse.betSlip/1'); assert.equal(s.simulated, true); assert.match(s.watermark, /SIMULATED/);
  assert.equal(s.seenAt.american, '+130'); assert.equal(s.seenAt.book, 'book_a');
  assert.ok(s.fair.prob > 0.47 && s.fair.prob < 0.49, String(s.fair.prob));
  assert.equal(s.predictionMarket.maxYesCents, Math.floor(s.fair.prob * 100));
  assert.equal(s.stake.suggestedUsd, 20, "quarter-Kelly here exceeds 2%, so the 2% cap binds"); assert.equal(s.stake.capPct, 2);
  const txt = slipText(s); assert.match(txt, /SIMULATED/); assert.match(txt, /You place this yourself/); assert.match(txt, /Re-check the price/);
  const real = buildSlip({ ...sig, id: 'sig-2', simulated: false, simReasons: [] }, { bankrollUsd: 1000, now: T0 }); assert.ok(!real.watermark);
});

test('venue adapters: every method refuses with VENUE_LINK_DISABLED; per-order approval check; no env reads', () => {
  for (const v of Object.values(V.VENUES)) {
    assert.equal(v.enabled, false); assert.equal(v.describe().enabled, false);
    for (const m of V.METHODS) assert.throws(() => v[m]({ any: 'thing' }), (e) => e instanceof V.VenueLinkDisabledError && e.code === 'VENUE_LINK_DISABLED', `${v.id}.${m}`);
    assert.ok(v.envVars.length >= 2 && v.envVars.every((e) => /^[A-Z][A-Z0-9_]+$/.test(e.name) && !('value' in e)));
  }
  const order = { hash: 'abc' }, ok = { approvedBy: 'user', orderHash: 'abc', approvedAt: T0, expiresAt: T0 + 60e3 };
  assert.deepEqual(V.checkApproval(order, ok, T0 + 1), []);
  assert.ok(V.checkApproval(order, { ...ok, approvedBy: 'rule' }, T0).length);
  assert.ok(V.checkApproval({ hash: 'zzz' }, ok, T0).length);
  assert.ok(V.checkApproval(order, ok, T0 + 61e3).length);
  assert.ok(V.checkApproval(order, { ...ok, expiresAt: T0 + 3600e3 }, T0).length);
  const src = fs.readFileSync(path.join(__dirname, '../server/betting/venues/index.js'), 'utf8');
  assert.ok(!/process\.env/.test(src.replace(/\/\/.*$/gm, '')), 'venue adapters never read process.env');
  assert.ok(!/require\(['"](https?|net|tls|child_process)['"]\)|fetch\(/.test(src), 'no network code in the disabled adapters');
});

test('textToRule: deterministic phrase mapping into a disabled draft, fade flips sides, unsupported items listed', () => {
  const t = textToRule('Fade NBA road favorites on a back-to-back, moneyline, within 12 hours of tip. 70% win rate lock.');
  assert.ok(t.ok); assert.equal(t.rule.enabled, false); assert.equal(t.rule.source.type, 'text-import');
  const types = t.rule.conditions.map((c) => c.type + ':' + JSON.stringify(c.params));
  assert.ok(types.some((x) => x.startsWith('sport_in') && x.includes('basketball_nba')));
  assert.ok(types.includes('side_is:{"side":"home"}') && types.includes('side_is:{"side":"underdog"}'), types.join(' | '));
  assert.ok(types.some((x) => x.startsWith('back_to_back')));
  assert.match(t.warnings.join(), /performance|win rate|claim/i);
  const u = textToRule('Auto-place a 3-leg parlay on live player props');
  assert.match([...(u.unmapped || []), ...(u.warnings || []), u.error || ''].join(' '), /parlay/i);
  assert.equal(textToRule('Home dogs getting +3.5 or more in the NFL').rule.name, 'Home dogs getting +3.5 or more in the NFL');
});

test('RuleDesk: templates → enable → scan on the MOCK odds feed raises SIM signals; slips; persistence; imports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betdesk-')), file = path.join(dir, 'rules.json');
  let now = T0; const H = { register() {}, ok() {}, fail() {} };
  const cfg = { ...bettingCfg, mockTickMs: 1e9 };
  const feed = new OddsFeed({ health: H, cfg, now: () => now, rng: (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })() });
  feed.startMock(); clearInterval(feed.mockT);
  const seen = []; const d = new RuleDesk({ cfg, feed, now: () => now, file, onSignal: (s) => seen.push(s) });
  const r = d.fromTemplate(0); assert.ok(r.ok); assert.equal(r.rule.enabled, false);
  d.scanOnce(); assert.equal(d.signals.list().length, 0, 'disabled template raises nothing');
  d.setEnabled(r.rule.id, true); d.saveRule({ name: 'Any price', conditions: [{ type: 'books_at_least', params: { n: 2 } }], cooldownMin: 0 });
  for (let i = 0; i < 12; i++) { now += 5000; feed.mockTick(); d.scanOnce(); }
  const sigs = d.signals.list(); assert.ok(sigs.length > 0); assert.ok(sigs.every((s) => s.simulated && s.simReasons.includes('odds feed is MOCK')));
  assert.equal(seen.length, sigs.length);
  const x = d.slip(sigs[0].id); assert.match(x.text, /SIMULATED/);
  d.setStatus(sigs[0].id, 'slipped');
  // persistence round-trip
  d.importAny({ json: { schema: 'hawse.signalTypes/1', types: [{ id: 'my_type', label: 'mine', conditions: [{ type: 'market_is', params: { markets: ['h2h'] } }] }] } });
  const d2 = new RuleDesk({ cfg, feed, now: () => now, file });
  assert.equal(d2.listRules().length, 2); assert.ok(d2.reg.has('my_type')); assert.equal(d2.signals.get(sigs[0].id).status, 'slipped');
  // imports: JSON list is disabled unless explicitly enabled; text → draft
  const imp = d2.importAny({ json: { schema: 'hawse.betRules/1', rules: [{ name: 'A', conditions: evRule.conditions }, { name: 'B', enabled: true, conditions: evRule.conditions }] } });
  assert.ok(imp.ok); assert.deepEqual(imp.rules.map((q) => q.enabled), [false, true]);
  assert.equal(d2.importAny({ json: { name: 'bad', autoPlace: true, conditions: evRule.conditions } }).ok, false);
  const tx = d2.importAny({ text: 'Steam: line moved 1 point toward a side in the NFL' }); assert.ok(tx.ok); assert.equal(tx.rule.enabled, false);
  // snapshot
  const snap = d2.snapshot(); assert.equal(snap.mode, 'mock'); assert.equal(snap.oddsSimulated, true); assert.equal(snap.stats.simulated, true); assert.ok(snap.venues.every((v) => v.enabled === false));
  feed.stop(); fs.rmSync(dir, { recursive: true, force: true });
});

test('routes: rules CRUD, slip downloads, venue endpoints answer 403 VENUE_LINK_DISABLED', async () => {
  const d = new RuleDesk({ cfg: bettingCfg, feed: fakeFeed([mkEv()]), now: () => T0, file: '', stats: fakeStats });
  const h = routes(d), body = (b) => async () => b;
  let [st, r] = await h('POST', '/api/betting/rules', body({ rule: { ...evRule, cooldownMin: 0 } })); assert.equal(st, 200); const id = r.rule.id;
  [st] = await h('POST', '/api/betting/rules', body({ rule: { name: 'x', autoPlace: true, conditions: evRule.conditions } })); assert.equal(st, 422);
  [st, r] = await h('POST', '/api/betting/scan', body({})); assert.equal(r.raised, 1);
  [st, r] = await h('GET', '/api/betting', body()); assert.equal(r.signals.length, 1); assert.equal(r.rulesFull.length, 1);
  const sid = r.signals[0].id;
  const txt = await h('GET', `/api/betting/signals/${sid}/slip.txt`, body()); assert.equal(txt.status, 200); assert.match(txt.type, /text\/plain/); assert.match(txt.filename, /\.txt$/); assert.match(txt.body, /HAWSE BET SLIP/);
  const js = await h('GET', `/api/betting/signals/${sid}/slip.json`, body()); assert.equal(JSON.parse(js.body).schema, 'hawse.betSlip/1');
  [st, r] = await h('POST', `/api/betting/signals/${sid}/status`, body({ status: 'slipped' })); assert.equal(r.signal.status, 'slipped');
  const ex = await h('GET', `/api/betting/rules/${id}/export`, body()); assert.equal(JSON.parse(ex.body).name, 'EV 3');
  [st, r] = await h('POST', `/api/betting/rules/${id}/enable`, body({ on: false })); assert.equal(r.rule.enabled, false);
  for (const v of ['kalshi', 'polymarket']) for (const m of ['connect', 'placeOrder', 'getBalance']) { [st, r] = await h('POST', `/api/betting/venues/${v}/${m}`, body({})); assert.equal(st, 403); assert.equal(r.code, 'VENUE_LINK_DISABLED'); }
  [st] = await h('GET', '/api/betting/nope', body()); assert.equal(st, 404);
  assert.equal(await h('GET', '/api/other', body()), null);
  [st, r] = await h('GET', '/api/betting/registry', body()); assert.ok(r.types.length >= 17);
});

test('host wiring: engine mounts the module (feed, route, importer); lab import path delegates bet rules', () => {
  const { Engine } = require('../server/engine'); const config = require('../server/config');
  const eng = new Engine(config.build({}), { modules: { betting: require('../server/modules').betting } });
  assert.ok(eng.feeds.betdesk); assert.equal(eng.routes.length, 1); assert.equal(eng.importers.length, 1);
  assert.throws(() => eng.placeLiveBet({}), /disabled/i);
  const { Lab } = require('../server/lab/lab');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  const lab = new Lab({ dir }); lab.importers = eng.importers; eng.feeds.betdesk.file = '';
  const a = lab.importAny({ json: JSON.stringify({ schema: 'hawse.betRule/1', name: 'Via lab', conditions: evRule.conditions }) });
  assert.equal(a.routedTo, 'betting'); assert.ok(a.ok); assert.equal(a.rules[0].enabled, false);
  const b = lab.importAny({ text: 'Home dogs getting +3.5 or more in the NFL', as: 'bet_rule' }); assert.equal(b.routedTo, 'betting'); assert.equal(b.kind, 'bet_rule');
  const c = lab.importAny({ json: { schema: 'hawse.signalTypes/1', types: [{ id: 'lab_type', label: 'l', conditions: [{ type: 'market_is', params: { markets: ['totals'] } }] }] } }); assert.equal(c.routedTo, 'betting');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('module boundary: server/betting only requires node built-ins and files inside server/betting', () => {
  const root = path.join(__dirname, '../server/betting'), files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } }; walk(root);
  const builtins = new Set(require('module').builtinModules);
  for (const f of files) {
    for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (builtins.has(spec.replace(/^node:/, ''))) continue;
      assert.ok(spec.startsWith('.'), `${path.relative(root, f)} requires package "${spec}"`);
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(target.startsWith(root + path.sep) || target === root, `${path.relative(root, f)} reaches outside the module: ${spec}`);
    }
  }
  assert.ok(files.length >= 15);
});
