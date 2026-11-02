'use strict';
// Pilot p6 (Bryan 2026-11-01): the fixed ETH $400 / SOL $250 caps are gone; every asset has the same $5,000 per-trade ceiling.
// Everything else is p5. Pure sizing math only: no exchange, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../server/live/kalshi-pilot');

const ROOT = path.join(__dirname, '..');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const P5_FILE = 'config/frozen/kalshi-live-pilot.json', P6_FILE = 'config/frozen/kalshi-live-pilot-p6.json';
const P5_SHA = 'a7d67ee97402c392d450acb9e4b7965b24b55ed88925a76caff0e6d8fc32d2a7';
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const TKS = { BTC: 'KXBTC15M-26NOV011015-15', ETH: 'KXETH15M-26NOV011015-15', SOL: 'KXSOL15M-26NOV011015-15' };
const ASK = 95, LIMIT = 96, BIG_VOL = 1e9; // mock: deep book, so the volume rule does not bind unless a test says so
const plan = (cfg, asset, bankrollCents, extra = {}) => P.planSlice({ cfg, tk: TKS[asset], askCents: ASK, limitCents: LIMIT, bankrollCents, availCents: bankrollCents, vol: BIG_VOL, ...extra });

test('p6 is the active pinned pilot config; p5 kept byte-for-byte as history; paper v1/v2/v3 unchanged', () => {
  assert.equal(path.relative(ROOT, P.PILOT_FILE), P6_FILE, 'loader points at p6');
  assert.equal(sha(P6_FILE), P.PILOT_SHA256); assert.equal(P.loadPilotConfig().cfg.version, 'p6'); assert.equal(P.loadPilotConfig().hash, P.PILOT_SHA256);
  assert.equal(sha(P5_FILE), P5_SHA, 'p5 file unchanged'); assert.equal(P.PILOT_P5_SHA256, P5_SHA);
  assert.equal(P.loadPilotConfig(path.join(ROOT, P5_FILE), P5_SHA).cfg.version, 'p5', 'p5 still loads under its own old pin');
  assert.throws(() => P.loadPilotConfig(path.join(ROOT, P5_FILE)), /edited after the freeze/, 'p5 is not the active pin');
  assert.equal(sha('config/frozen/kalshi-h2-v1.json'), '2f0053c4eb13bd48697eb06d4a6c841b327313393e97c619e96e3e9956c9675c');
  assert.equal(sha('config/frozen/kalshi-h2-v2.json'), 'ee5185f8e059a8995c557b474b873f47dae867be5f02fb021368c83cf0294a4c');
  assert.equal(sha('config/frozen/kalshi-h2-v3.json'), '5498e1cbea6c45e427876dd2971f041421ef18ad06c103dc7921898f5179ce1c');
});

test('p6 differs from p5 only in version, caps, source/status notes; caps are $5,000 for BTC, ETH and SOL', () => {
  const p5 = read(P5_FILE), p6 = read(P6_FILE);
  assert.deepEqual(p6.perAssetCapCents, { BTC: 500000, ETH: 500000, SOL: 500000 });
  assert.deepEqual(p5.perAssetCapCents, { BTC: 500000, ETH: 40000, SOL: 25000 }, 'history: p5 had ETH $400 / SOL $250');
  assert.match(p6.source, /if we fix it now we won't really have to worry in the future/); assert.match(p6.source, /2026-11-01 \(p6\)/);
  assert.equal(p6.supersedes.version, 'p5'); assert.equal(p6.supersedes.sha256, P5_SHA);
  const changed = Object.keys({ ...p5, ...p6 }).filter((k) => JSON.stringify(p5[k]) !== JSON.stringify(p6[k])).sort();
  assert.deepEqual(changed, ['perAssetCapCents', 'source', 'status', 'supersedes', 'version']);
  // the rules Bryan said stay identical
  assert.equal(p6.perTradePct, 0.07); assert.equal(p6.participationShare, 0.1); assert.equal(p6.balanceExchangeIndex, 2); assert.equal(p6.dailyLossStopCents, null);
  assert.equal(p6.armPhrase, 'ARM LIVE'); assert.equal(p6.resetPhrase, 'RESET PILOT'); assert.deepEqual(p6.order.entryWindowSecondsLeft, [360, 600]);
  assert.equal(p6.order.maxPriceCents, 98); assert.equal(p6.order.limitAboveAskCents, 1); assert.equal(p6.order.timeInForce, 'immediate_or_cancel');
  assert.ok(!Object.keys(p6).some((k) => /loss ?limit|totalLoss|bankrollCents|maxTradeCents/i.test(k)), 'still no loss cap, no bankroll cap');
});

// per-trade size (contracts at a 95c ask) at each bankroll, deep mock book
const BANKROLLS = [7700, 100000, 500000, 1000000, 5000000, 10000000];
const EXPECT = { // floor(min(7% of bankroll, $5,000) / 95c)
  7700: 5, 100000: 73, 500000: 368, 1000000: 736, 5000000: 3684, 10000000: Math.floor(500000 / 95),
};
test('planSlice p6: 7% of bankroll for every asset (ETH/SOL no longer capped at $400/$250); the $5,000 ceiling still applies', () => {
  const p5 = read(P5_FILE), p6 = P.loadPilotConfig().cfg;
  for (const b of BANKROLLS) for (const a of ['BTC', 'ETH', 'SOL']) {
    const z = plan(p6, a, b); assert.equal(z.contracts, EXPECT[b], `${a} at $${b / 100}`);
    assert.deepEqual(z.bound, b > 7142857 ? ['asset'] : ['pct'], `${a} at $${b / 100} bound`);
  }
  // the old p5 caps would have bound ETH from ~$5,715 and SOL from ~$3,572; p6 does not
  assert.equal(plan(p5, 'ETH', 1000000).contracts, Math.floor(40000 / 95)); assert.deepEqual(plan(p5, 'ETH', 1000000).bound, ['asset']);
  assert.equal(plan(p5, 'SOL', 500000).contracts, Math.floor(25000 / 95)); assert.deepEqual(plan(p5, 'SOL', 500000).bound, ['asset']);
  assert.equal(plan(p6, 'ETH', 1000000).contracts, 736); assert.equal(plan(p6, 'SOL', 500000).contracts, 368);
  // ceiling: 7% of $100k is $7,000 -> held at $5,000 for every asset; dollar size of the ceiling slice <= $5,000
  for (const a of ['BTC', 'ETH', 'SOL']) { const z = plan(p6, a, 10000000); assert.ok(z.contracts * ASK <= 500000); assert.equal(z.sizing.capBound, 'asset cap'); }
  // small bankroll unchanged from p5
  for (const a of ['BTC', 'ETH', 'SOL']) assert.equal(plan(p6, a, 7700).contracts, plan(p5, a, 7700).contracts);
});

test('planSlice p6: the 10% volume rule and the open-risk cap still bind', () => {
  const p6 = P.loadPilotConfig().cfg;
  for (const a of ['ETH', 'SOL']) {
    let z = plan(p6, a, 1000000, { vol: 2000 }); assert.equal(z.contracts, 200, `${a}: 10% of 2,000 visible`); assert.deepEqual(z.bound, ['participation']);
    z = plan(p6, a, 5000000, { vol: 15 }); assert.equal(z.contracts, 1); assert.deepEqual(z.bound, ['participation']);
    z = plan(p6, a, 1000000, { vol: null }); assert.equal(z.contracts, 0); assert.deepEqual(z.bound, ['unknown_volume']);
    z = plan(p6, a, 1000000, { openRiskCents: 990000 }); assert.ok(z.contracts > 0 && z.worstCents <= 10000, `${a}: only the $100 left under the bankroll`); assert.deepEqual(z.bound, ['openRisk']);
    z = plan(p6, a, 1000000, { openRiskCents: 1000000 }); assert.equal(z.contracts, 0, 'open risk already = bankroll');
    z = plan(p6, a, 1000000, { availCents: 20000 }); assert.ok(z.worstCents <= 20000); assert.deepEqual(z.bound, ['cash']);
    z = P.planSlice({ cfg: p6, tk: TKS[a], askCents: 98, limitCents: 99, bankrollCents: 1000000, availCents: 1000000, vol: BIG_VOL }); assert.equal(z.contracts, 0, 'limit above 98c never sent'); assert.deepEqual(z.bound, ['price']);
  }
});

test('the card and the sizing line read the caps from config: $5,000 each, no $400 / $250', () => {
  const UI = require('../public/pilot');
  const cfg = P.loadPilotConfig().cfg;
  const h = UI.render({ state: 'DISARMED', statusChip: 'DISARMED-SHADOW', config: { ...cfg }, money: { bankrollCents: 7700, perTradeCents: 539 }, env: {}, trades: [], compare: [] }, { local: true });
  assert.match(h, /asset caps BTC \$5,000 \/ ETH \$5,000 \/ SOL \$5,000/); assert.ok(!/\$400|\$250/.test(h));
  const line = P.KalshiPilot.prototype.sizingLine.call({ cfg }); assert.match(line, /asset caps BTC \$5,000 \/ ETH \$5,000 \/ SOL \$5,000/);
});
