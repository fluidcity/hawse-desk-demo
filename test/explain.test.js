'use strict';
// Stage 11: strategy explainers. The text is generated from the same constants / config the strategy logic reads,
// so these tests check coverage, that config changes flow into the text, and that no secret ever appears in it.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const { Engine } = require('../server/engine');
const X = require('../server/lib/explain');
const { explainConfig } = require('../server/lab/explain');
const { explainRule, STRAT_RULES } = require('../server/betting/explain');
const LAB_TEMPLATES = require('../server/lab/templates').TEMPLATES;
const RULE_TEMPLATES = require('../server/betting/rules/templates').RULES;
const { SignalTypeRegistry } = require('../server/betting/rules/registry');

const FAKE = 'SECRET_TEST_123';
const SECRET_ENV = { HELIUS_API_KEY: FAKE + 'h', ALCHEMY_API_KEY: FAKE + 'a', INFURA_API_KEY: FAKE + 'i', EVM_RPC_URL: 'https://rpc.example/' + FAKE + 'r',
  TRADOVATE_USERNAME: FAKE + 'u', TRADOVATE_PASSWORD: FAKE + 'p', TRADOVATE_SECRET: FAKE + 's', ODDS_API_KEY: FAKE + 'o' };
const engine = (env = {}) => new Engine(config.build(env), { modules: { ...require('../server/modules') } });
const text = (x) => [x.what, ...x.rules.flatMap((r) => [r.k, ...r.items])].join('\n');
const sec = (x, k) => (x.rules.find((r) => r.k === k) || { items: [] }).items;

test('every desk strategy (all modules loaded) explains itself: what first, then Markets/Signal/Entry/Exit/Risk', () => {
  const all = engine().explainAll();
  const ids = all.map((x) => x.id);
  for (const id of ['funding', 'whale', 'onepct', 'gaps', 'orb', 'perpmom', 'basis', 'bet_ev', 'bet_spread', 'bet_arb']) assert.ok(ids.includes(id), 'missing ' + id);
  for (const x of all) {
    assert.equal(x.error, undefined, `${x.id}: ${x.error}`);
    assert.ok(x.what.length > 80, `${x.id} what too short`);
    for (const k of ['Markets', 'Signal', 'Entry', 'Exit', 'Risk']) assert.ok(sec(x, k).length, `${x.id} lacks ${k}`);
    assert.deepEqual(x.rules.map((r) => r.k), X.ORDER.filter((k) => x.rules.some((r) => r.k === k)), `${x.id} sections out of order`);
    for (const r of x.rules) for (const i of r.items) assert.ok(typeof i === 'string' && i.trim() && !/undefined|NaN|\[object/.test(i), `${x.id}/${r.k}: bad item "${i}"`);
    assert.ok(/paper/i.test(text(x)), `${x.id} must state paper-only`);
  }
});

test('no secret value ever appears in any explainer (desk, lab, betting rules)', () => {
  const e = engine(SECRET_ENV);
  assert.ok(e.cfg.helius.apiKey.includes(FAKE) && e.cfg.tradovate.password.includes(FAKE) && e.cfg.betting.apiKey.includes(FAKE)); // the secrets really are in cfg
  const reg = new SignalTypeRegistry();
  const blob = JSON.stringify(e.explainAll()) + JSON.stringify(LAB_TEMPLATES.map(explainConfig)) + JSON.stringify(RULE_TEMPLATES.map((r) => explainRule(r, reg)));
  assert.ok(!blob.includes(FAKE), 'secret leaked into explainer output');
});

test('config changes flow into the text (no hard-coded copies)', () => {
  const by = (env) => Object.fromEntries(engine(env).explainAll().map((x) => [x.id, x]));
  const a = by({}), b = by({ FUNDING_MIN_NET_BPS: '13', ORB_TARGET_R: '2.25', BASIS_MIN_NET_BPS: '9' });
  assert.match(text(a.funding), /≥ 8 bp/); assert.match(text(b.funding), /≥ 13 bp/);
  assert.match(text(a.orb), /1\.5× the risk/); assert.match(text(b.orb), /2\.25× the risk/);
  assert.match(text(b.basis), /net ≥ 9 bp/);
  // the risk gate line follows the live risk settings
  const e = engine(); e.gates.real.dailyLossPct = 4.5; assert.match(text(e.explainAll().find((x) => x.id === 'orb')), /4\.5% day loss/);
});

test('strategy constants are the ones the logic uses', () => {
  const { SETUP } = require('../server/strategies/one-pct');
  const one = engine().explainAll().find((x) => x.id === 'onepct');
  assert.match(text(one), new RegExp(`EMA${SETUP.emaFast} above EMA${SETUP.emaSlow}`));
  assert.match(text(one), new RegExp(`RSI between ${SETUP.rsiMin} and ${SETUP.rsiMax}`));
  const { MOMENTUM_DEFAULTS } = require('../server/strategies/perps');
  assert.match(text(engine().explainAll().find((x) => x.id === 'perpmom')), new RegExp(`prior ${MOMENTUM_DEFAULTS.lookback}-bar high`));
  assert.match(text(engine().explainAll().find((x) => x.id === 'bet_ev')), new RegExp(`Up to ${STRAT_RULES.evMaxPerScan} new bets`));
});

test('helpers: ET clock from minutes after the 09:30 open, ordering and whitespace', () => {
  assert.equal(X.etFromOpen(385), '15:55 ET'); assert.equal(X.etFromOpen(240), '13:30 ET'); assert.equal(X.etFromOpen(0), '9:30 ET');
  const e = X.explanation('  a   b ', { Exit: ['x', null, ''], Markets: ['m'], Risk: [] });
  assert.equal(e.what, 'a b'); assert.deepEqual(e.rules, [{ k: 'Markets', items: ['m'] }, { k: 'Exit', items: ['x'] }]);
});

test('lab: every template and an imported/edited config get an explanation that follows its params', () => {
  for (const t of LAB_TEMPLATES) {
    const x = explainConfig(t);
    assert.ok(x.what.length > 60, t.id);
    for (const k of ['Markets', 'Signal', 'Entry', 'Exit']) assert.ok(sec(x, k).length, `${t.id} lacks ${k}`);
    assert.ok(!/undefined|NaN/.test(text(x)), `${t.id}: ${text(x)}`);
  }
  const ma = JSON.parse(JSON.stringify(LAB_TEMPLATES.find((t) => t.kind === 'ma_cross')));
  ma.params.fast = 7; ma.params.slow = 31; ma.entry = { ...(ma.entry || {}), allowShort: true }; ma.exit = { ...(ma.exit || {}), takePct: 9 };
  const x = explainConfig(ma);
  assert.match(x.what, /7-bar/); assert.match(x.what, /31-bar/); assert.match(text(x), /Short when fast crosses below slow/); assert.match(text(x), /Take profit 9%/);
  // honest about what the backtest does NOT enforce, and about betting configs not being run with their own params
  assert.match(text(x), /NOT enforced/);
  assert.match(text(explainConfig(LAB_TEMPLATES.find((t) => t.kind === 'betting_ev'))), /cannot be backtested/);
  assert.ok(explainConfig({ kind: 'mystery', description: 'custom thing' }).what.includes('custom thing'));
  assert.ok(explainConfig(null).what);
});

test('lab.list() ships explainers for templates and saved configs', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Lab } = require('../server/lab/lab');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-x-'));
  const lab = new Lab({ dir });
  const L0 = lab.list(); assert.ok(L0.templates.every((t) => t.explain && t.explain.what));
  const imp = lab.importAny({ text: 'EMA 9/21 crossover on ETH 1h with a 3% stop' });
  const L = lab.list();
  assert.ok(imp.ok); assert.equal(L.configs.length, 1);
  const c = L.configs[0]; assert.ok(c.explain && c.explain.rules.length); assert.match(c.explain.what, /9-bar/); assert.match(c.explain.what, /21-bar/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('betting rules: explainRule covers every template, NOT conditions, match mode and cooldown', () => {
  const reg = new SignalTypeRegistry();
  for (const r of RULE_TEMPLATES) {
    const x = explainRule(r, reg);
    assert.ok(x.what.length > 30, r.name); assert.ok(sec(x, 'Signal').length, r.name);
    assert.ok(!/undefined|NaN/.test(text(x)), r.name + ': ' + text(x));
  }
  const base = RULE_TEMPLATES[0];
  const neg = { ...base, match: 'any', cooldownMin: 45, conditions: [{ ...base.conditions[0], negate: true }, ...base.conditions.slice(1)] };
  const t = text(explainRule(neg, reg));
  assert.match(t, /\bNOT\b/); assert.match(t, /any/i); assert.match(t, /45 min/);
});
