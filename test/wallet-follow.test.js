'use strict';
// Wallet-follow v2 (H3): latency delay, chase guard, concurrency, mirror / opposite exits, TP/SL, SIM-booked controls,
// counterfactual delays, scoreboard verdicts, watchlist add dates. No network.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../server/config');
const { Engine } = require('../server/engine');
const { rec } = require('../server/feeds/funding');
const { HlFillsFeed } = require('../server/feeds/hl-fills');
const { WalletFollow, loadWatchlist } = require('../server/strategies/wallet-follow');
const { summarize, PLAN } = require('../server/strategies/follow-score');

const W = '0x' + 'b'.repeat(40);
function mk() {
  const cfg = config.build({ FUNDING_HL_TOP_OI: '0', CARRY_ENABLED: 'false', WS_ENABLED: 'false', FUNDING_SYMBOLS: 'BTC,ETH,SOL,XRP' }); cfg.funding.scoreFile = null;
  const e = new Engine(cfg); const hl = new HlFillsFeed({ wallets: [{ addr: W }], fetch: async () => [] });
  const s = e.addStrategy(new WalletFollow(e, { hl, rng: () => 0.9, cfg: { ...cfg.follow, scoreFile: null } })); s.arm(true); return { e, s, hl };
}
const px = (e, sym, p) => e.feeds.funding.put([rec('hyperliquid', sym, { rate: 0, intervalH: 1, nextFundingTime: Date.now() + 3.6e6, mark: p, bid: p * 0.9999, ask: p * 1.0001, dayNtlVlm: 1e9 })]);
const sig = (o) => ({ t: Date.now(), receivedAt: Date.now(), chain: 'hyperliquid', wallet: W, asset: 'BTC', side: 'long', kind: 'open', usd: 100000, px: 50000, srcTx: '0xh', ...o });

test('entry waits the latency delay, then fills at the then-current quote with two SIM controls', () => {
  const { e, s } = mk(); px(e, 'BTC', 50000); const t0 = Date.now();
  s.onSignal(sig({ receivedAt: t0 })); s.tick(t0 + 5000); assert.strictEqual(s.positions.length, 0, 'not before the 20 s delay');
  px(e, 'BTC', 50100); s.tick(t0 + 20000);
  const f = s.positions.filter((p) => !p.control), c = s.positions.filter((p) => p.control);
  assert.strictEqual(f.length, 1); assert.strictEqual(f[0].delaySec, 20); assert.ok(Math.abs(f[0].chasePct - 0.2) < 1e-9); assert.strictEqual(f[0].simulated, false);
  assert.deepStrictEqual(c.map((x) => x.control + ':' + x.side + ':' + x.simulated).sort(), ['hold:long:true', 'random:short:true']);
  assert.strictEqual(f[0].controlId.length, 2);
});

test('chase guard: skip when price already moved > 0.5% in the wallet direction', () => {
  const { e, s } = mk(); px(e, 'BTC', 50300); const t0 = Date.now();
  s.onSignal(sig({ receivedAt: t0 })); s.tick(t0 + 20000); assert.strictEqual(s.positions.length, 0); assert.match(s.lastSkip.reason, /already moved 0\.60%/);
});

test('below the $50k floor is skipped; max 1 per asset and 3 follows at once', () => {
  const { e, s } = mk(); for (const [k, p] of [['BTC', 50000], ['ETH', 3000], ['SOL', 150], ['XRP', 2]]) px(e, k, p); const t0 = Date.now();
  s.onSignal(sig({ usd: 40000 })); assert.strictEqual(s.pending.length, 0);
  for (const [a, p] of [['BTC', 50000], ['BTC', 50000], ['ETH', 3000], ['SOL', 150], ['XRP', 2]]) s.onSignal(sig({ asset: a, px: p, receivedAt: t0 }));
  s.tick(t0 + 20000); const f = s.positions.filter((p) => !p.control);
  assert.deepStrictEqual(f.map((p) => p.symbol), ['BTC', 'ETH', 'SOL']);
});

test('mirror exit on a ≥ 50% cut closes the follow and its controls, and writes a scoreboard record', () => {
  const { e, s } = mk(); px(e, 'BTC', 50000); const t0 = Date.now();
  s.onSignal(sig({ receivedAt: t0 })); s.tick(t0 + 20000); px(e, 'BTC', 50500);
  s.onSignal(sig({ kind: 'reduce', frac: 0.4 })); assert.strictEqual(s.positions.length, 3, '40% cut is not a mirror exit');
  s.onSignal(sig({ kind: 'reduce', frac: 0.6 })); assert.strictEqual(s.positions.length, 0);
  const r = s.records[0]; assert.match(r.why, /mirror exit/); assert.ok(r.netPct > 0 && r.netPct < 1, 'net of fees');
  assert.ok(r.randomPct < 0, 'random control was short'); assert.ok(r.holdPct > 0); assert.ok(r.cf[0] != null && r.cf.d != null);
  const L = e.ledger.book('wfollow'); assert.strictEqual(L.real.trades, 1); assert.strictEqual(L.sim.trades, 2, 'controls are SIM-booked only');
});

test('opposite-side fill closes; TP / SL / time stop apply', () => {
  const { e, s } = mk(); px(e, 'BTC', 50000); let t0 = Date.now();
  s.onSignal(sig({ receivedAt: t0 })); s.tick(t0 + 20000); s.onSignal(sig({ side: 'short' }));
  assert.match(s.records[0].why, /opposite-side/);
  s.pending = []; t0 = Date.now(); s.onSignal(sig({ receivedAt: t0 - 20000 })); s.tick(t0); px(e, 'BTC', 49400); s.tick(t0 + 1000);
  assert.strictEqual(s.records[1].why, 'stop-loss');
  t0 = Date.now(); px(e, 'BTC', 50000); s.onSignal(sig({ receivedAt: t0 - 20000 })); s.tick(t0); px(e, 'BTC', 51100); s.tick(t0 + 1000);
  assert.strictEqual(s.records[2].why, 'take-profit');
});

test('a reduce while the entry is still queued cancels it; disarmed logs only', () => {
  const { e, s } = mk(); px(e, 'BTC', 50000); const t0 = Date.now();
  s.onSignal(sig({ receivedAt: t0 })); s.onSignal(sig({ kind: 'reduce', frac: 1 })); s.tick(t0 + 20000); assert.strictEqual(s.positions.length, 0);
  s.arm(false); s.onSignal(sig({ receivedAt: t0 })); s.tick(t0 + 20000); assert.strictEqual(s.positions.length, 0); assert.match(s.lastSkip.reason, /disarmed/);
});

test('scoreboard verdicts: collecting, pass vs random, fail at 60 s delay, fail after 200 with CI at 0', () => {
  const r = (net, rnd, d60 = net) => ({ chain: 'hyperliquid', wallet: W, netPct: net, randomPct: rnd, holdPct: 0, cf: { 0: net, d: net, 60: d60 } });
  assert.strictEqual(summarize([r(1, 0)]).overall.verdict.status, 'collecting');
  const pass = Array.from({ length: PLAN.minSignals }, (_, i) => r(0.8 + (i % 5) * 0.1, 0)); assert.strictEqual(summarize(pass).overall.verdict.status, 'pass');
  const late = pass.map((x) => ({ ...x, cf: { ...x.cf, 60: -0.1 } })); assert.match(summarize(late).overall.verdict.text, /60 s delay/);
  const noise = Array.from({ length: PLAN.failAfter }, (_, i) => r(i % 2 ? 1 : -1, 0)); assert.strictEqual(summarize(noise).overall.verdict.status, 'fail');
  const mixed = summarize([...pass, { ...r(5, 0), mock: true }]); assert.strictEqual(mixed.overall.n, PLAN.minSignals); assert.strictEqual(mixed.mockCount, 1);
  assert.strictEqual(mixed.wallets[0].wallet, W);
});

test('watchlist: file wallets keep their add date, env-only wallets start now', () => {
  const fs = require('fs'), os = require('os'), path = require('path'); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wl-')), 'w.json');
  const A = '0x' + 'c'.repeat(40); fs.writeFileSync(f, JSON.stringify({ wallets: [{ addr: A, chain: 'hyperliquid', addedAt: 111 }] }));
  const wl = loadWatchlist(f, [A, W], 999); assert.deepStrictEqual(wl.map((w) => [w.addr, w.addedAt]), [[A, 111], [W, 999]]);
});

test('explainer covers every section and the controls', () => {
  const { s } = mk(); const x = s.explain(); const txt = JSON.stringify(x);
  assert.match(txt, /random-direction/); assert.match(txt, /delay/); assert.match(txt, /add date/);
});
