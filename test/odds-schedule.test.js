'use strict';
// Odds quota fix: snapshot scheduler, budget guard, disk cache, header parsing, quota exhaustion. Fixtures only; NO network, 0 credits.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { oddsCost, planSnapshots, OddsBudget, estimateMonthly } = require('../server/betting/data/schedule');
const { OddsFeed } = require('../server/betting/data/odds');
const bcfg = require('../server/betting/config');

const T0 = Date.UTC(2026, 9, 30, 12, 0); // 05:00 PT
const health = () => ({ rows: {}, register(id, o) { this.rows[id] = { ...o }; }, ok(id) { (this.rows[id] = this.rows[id] || {}).ok = true; }, fail(id, m) { (this.rows[id] = this.rows[id] || {}).err = m; } });
const iso = (t) => new Date(t).toISOString();
const evFix = (id, commence) => ({ id, sport_key: 'basketball_nba', commence_time: iso(commence), home_team: 'Home ' + id, away_team: 'Away ' + id });
const oddsFix = (id, commence) => ({ ...evFix(id, commence), bookmakers: [
  { key: 'pinnacle', title: 'Pinnacle', last_update: iso(T0), markets: [{ key: 'h2h', outcomes: [{ name: 'Home ' + id, price: 1.91 }, { name: 'Away ' + id, price: 2.0 }] }] },
  { key: 'draftkings', title: 'DraftKings', last_update: iso(T0), markets: [{ key: 'h2h', outcomes: [{ name: 'Home ' + id, price: 1.87 }, { name: 'Away ' + id, price: 2.05 }] }] }] });
/** Fixture fetch: mimics The Odds API including x-requests-* headers. Counts calls by endpoint. */
function fixtureFetch({ remaining = 480, slate }) {
  const calls = []; let rem = remaining, used = 500 - remaining;
  const fn = async (u) => {
    const url = new URL(String(u)); const ep = url.pathname.split('/').pop(); calls.push({ ep, params: Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'apiKey')) });
    const cost = ep === 'odds' ? url.searchParams.get('markets').split(',').length * (url.searchParams.get('bookmakers') ? Math.ceil(url.searchParams.get('bookmakers').split(',').length / 10) : 1) : ep === 'scores' ? 2 : 0;
    if (cost > rem) return { ok: false, status: 429, headers: { get: (h) => ({ 'x-requests-remaining': '0', 'x-requests-used': String(used), 'x-requests-last': '0' })[h] ?? null }, text: async () => '{"message":"Usage quota has been reached"}' };
    rem -= cost; used += cost;
    const body = ep === 'events' ? slate.map((e) => evFix(e.id, e.c)) : ep === 'odds' ? slate.map((e) => oddsFix(e.id, e.c)) : [];
    return { ok: true, status: 200, headers: { get: (h) => ({ 'x-requests-remaining': String(rem), 'x-requests-used': String(used), 'x-requests-last': String(cost) })[h] ?? null }, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls; return fn;
}
const mkCfg = (env = {}) => bcfg.fromEnv({ ODDS_API_KEY: 'free-KEY-never-print', CREDITS_FILE: '', ODDS_CACHE_FILE: '', ...env });

test('defaults fit the 500-credit free plan: 1 sport, h2h, 10 books = 1 region, snapshots, 450 guard', () => {
  const c = bcfg.fromEnv({});
  assert.deepEqual(c.sports, ['basketball_nba']); assert.deepEqual(c.markets, ['h2h']); assert.equal(c.bookmakers.length, 10); assert.ok(c.bookmakers.includes('pinnacle'));
  assert.equal(c.schedule, 'snapshots'); assert.deepEqual(c.snapshotsMin, [360, 60, 10]); assert.equal(c.monthlyBudget, 450); assert.equal(c.planCredits, 500);
  assert.equal(oddsCost(c), 1); assert.equal(oddsCost({ markets: ['h2h', 'spreads', 'totals'], regions: ['us', 'eu'] }), 6); assert.equal(oddsCost({ markets: ['h2h'], bookmakers: new Array(11).fill('x') }), 2);
  const est = estimateMonthly({ ...c, offsetsMin: c.snapshotsMin }); assert.ok(est <= c.monthlyBudget && est < 500, 'estimated ' + est);
  assert.ok(3 * 3 * 96 > 500, 'old default (≈864/day) blew the monthly plan in a day');
});

test('key rule: only ODDS_API_KEY; ODDS_API_KEY_PAID is never used unless ODDS_USE_PAID_KEY=true (no auto fallback)', () => {
  assert.equal(bcfg.fromEnv({ ODDS_API_KEY_PAID: 'paid' }).apiKey, '', 'no fallback when the free key is missing');
  assert.equal(bcfg.fromEnv({ ODDS_API_KEY: 'free', ODDS_API_KEY_PAID: 'paid' }).apiKey, 'free');
  assert.equal(bcfg.fromEnv({ ODDS_API_KEY: 'free', ODDS_API_KEY_PAID: 'paid', ODDS_USE_PAID_KEY: 'true' }).apiKey, 'paid');
  assert.equal(bcfg.fromEnv({ ODDS_API_KEY: 'free', ODDS_USE_PAID_KEY: 'true' }).apiKey, '', 'explicit paid mode without a paid key does not fall back either');
});

test('planSnapshots: per-offset targets, merged within window, never after start, closing flagged', () => {
  const H = 3.6e6, slate = [{ id: 'a', sport: 'nba', commence: T0 + 8 * H }, { id: 'b', sport: 'nba', commence: T0 + 8 * H + 10 * 60e3 }, { id: 'c', sport: 'nba', commence: T0 + 11 * H }];
  const p = planSnapshots(slate, { offsetsMin: [360, 60, 10], mergeMin: 15, now: T0 });
  assert.equal(p.length, 6, 'a+b merge at every offset; c separate'); assert.ok(p.every((x) => x.eventIds.every((id) => x.at < slate.find((e) => e.id === id).commence)));
  assert.deepEqual(p.filter((x) => x.closing).map((x) => x.eventIds.sort().join()), ['a,b', 'c']);
  // at T0+7h57m: a's targets are past (beyond 5 min grace); b T-10, c T-60, c T-10 remain
  assert.deepEqual(planSnapshots(slate, { offsetsMin: [360, 60, 10], now: T0 + 7.95 * H }).map((x) => x.eventIds.join() + '@' + x.offsets.join()), ['b@10', 'c@60', 'c@10']);
});

test('OddsBudget: hard cap, daily pacing, closing-only throttle under 15% (local or API headers), month roll', () => {
  let T = T0; const b = new OddsBudget({ monthlyBudget: 4, now: () => T }); // Oct 30 → 2 days left
  assert.equal(b.check(1, 'snapshot').ok, true); b.spend(1, 'snapshot');
  assert.equal(b.check(1, 'snapshot').ok, false, '3 left / 2 days = 1.5/day, 1 already spent today'); assert.equal(b.check(1, 'closing').ok, true, 'closing ignores pacing');
  b.setApiQuota({ remaining: 50, used: 450 }); assert.equal(b.closingOnly(), true); assert.equal(b.check(1, 'scores').ok, false);
  b.setApiQuota({ remaining: 0, used: 500 }); assert.equal(b.check(1, 'closing').ok, false, 'provider says 0 left');
  b.setApiQuota(null); b.spend(3, 'closing'); assert.equal(b.check(1, 'closing').ok, false);
  T = Date.UTC(2026, 10, 1, 12); assert.equal(b.view().used, 0); assert.equal(b.check(1, 'closing').ok, true);
});

test('live feed (fixtures): free /events slate, snapshot only when due, bookmakers= param, headers parsed into desk view', async () => {
  let T = T0; const slate = [{ id: 'g1', c: T0 + 6 * 3.6e6 + 5 * 60e3 }]; const f = fixtureFetch({ remaining: 480, slate });
  const feed = new OddsFeed({ health: health(), cfg: mkCfg(), fetchImpl: f, now: () => T });
  await feed.tickSchedule();
  assert.equal(f.calls.filter((c) => c.ep === 'odds').length, 0, 'T-365: nothing due yet'); assert.equal(f.calls[0].ep, 'events');
  T += 6 * 60e3; await feed.tickSchedule();
  const o = f.calls.filter((c) => c.ep === 'odds'); assert.equal(o.length, 1); assert.equal(o[0].params.markets, 'h2h'); assert.equal(o[0].params.bookmakers.split(',').length, 10); assert.equal(o[0].params.regions, undefined);
  assert.deepEqual({ remaining: feed.quota.remaining, used: feed.quota.used, last: feed.quota.last }, { remaining: 479, used: 21, last: 1 });
  const c = feed.snapshot().credits; assert.equal(c.apiRemaining, 479); assert.equal(c.used, 1); assert.equal(c.costPerCall, 1); assert.equal(c.keySlot, 'ODDS_API_KEY');
  await feed.tickSchedule(); assert.equal(f.calls.filter((x) => x.ep === 'odds').length, 1, 'same snapshot not repeated');
  assert.ok(!JSON.stringify(feed.snapshot()).includes('free-KEY-never-print'));
});

test('disk cache: a restart within TTL reuses cached odds and the last quota instead of re-spending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-')); const env = { ODDS_CACHE_FILE: path.join(dir, 'c.json'), CREDITS_FILE: path.join(dir, 'cr.json') };
  const T = T0 + 6 * 60e3; const slate = [{ id: 'g1', c: T0 + 6 * 3.6e6 + 5 * 60e3 }];
  const f1 = fixtureFetch({ remaining: 480, slate }); const a = new OddsFeed({ health: health(), cfg: mkCfg(env), fetchImpl: f1, now: () => T }); await a.tickSchedule();
  assert.equal(f1.calls.filter((c) => c.ep === 'odds').length, 1);
  const f2 = fixtureFetch({ remaining: 479, slate }); const b = new OddsFeed({ health: health(), cfg: mkCfg(env), fetchImpl: f2, now: () => T + 60e3 });
  assert.equal(b.quota.remaining, 479, 'last header values restored from disk'); await b.tickSchedule();
  assert.equal(f2.calls.length, 0, 'events + odds both served from cache'); assert.ok(b.cacheHits >= 2); assert.equal(b.events.size, 1);
  assert.equal(b.budget.view().used, 1, 'budget persisted across restart');
  assert.ok(!fs.readFileSync(env.ODDS_CACHE_FILE, 'utf8').includes('free-KEY-never-print'), 'key never written to the cache');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quota exhausted: polling stops, desk shows it, no key switch, nothing more is requested', async () => {
  let T = T0 + 6 * 60e3; const slate = [{ id: 'g1', c: T0 + 6 * 3.6e6 + 5 * 60e3 }]; const f = fixtureFetch({ remaining: 0, slate });
  const feed = new OddsFeed({ health: health(), cfg: mkCfg({ ODDS_API_KEY_PAID: 'paid-never-used' }), fetchImpl: f, now: () => T });
  await feed.tickSchedule();
  assert.ok(feed.exhausted, 'exhausted on x-requests-remaining = 0'); assert.match(feed.note, /QUOTA EXHAUSTED/); assert.equal(feed.snapshot().credits.exhausted.why.length > 0, true);
  const n = f.calls.length; T += 3.6e6; await feed.tickSchedule(); await feed.pollOdds(); assert.equal(f.calls.length, n, 'no further requests');
  assert.equal(feed.c.apiKey, 'free-KEY-never-print', 'still the free key: no automatic switch');
  // restart with the persisted quota = 0 → starts exhausted, sends nothing
  const g = new OddsFeed({ health: health(), cfg: mkCfg(), fetchImpl: f, now: () => T }); g.quota = { remaining: 0, used: 500 }; g.start(); g.stop(); assert.ok(g.exhausted); assert.equal(f.calls.length, n);
});

test('guard refuses before sending; network failure refunds the reservation; interval mode is guarded too', async () => {
  const T = T0 + 6 * 60e3; const slate = [{ id: 'g1', c: T0 + 6 * 3.6e6 + 5 * 60e3 }]; const f = fixtureFetch({ remaining: 480, slate });
  const feed = new OddsFeed({ health: health(), cfg: mkCfg({ ODDS_MONTHLY_BUDGET: '0' }), fetchImpl: f, now: () => T }); await feed.tickSchedule();
  assert.equal(f.calls.filter((c) => c.ep === 'odds').length, 0); assert.ok(feed.skipped[0].reason.includes('budget'));
  const bad = new OddsFeed({ health: health(), cfg: mkCfg(), fetchImpl: async () => { throw new Error('ECONNRESET'); }, now: () => T }); bad.everOk = true; bad.slateAt = T;
  bad.slate.set('g1', { id: 'g1', sport: 'basketball_nba', commence: slate[0].c }); await bad.tickSchedule(); assert.equal(bad.budget.view().used, 0, 'refunded: nothing reached the API');
  const f3 = fixtureFetch({ remaining: 480, slate }); const iv = new OddsFeed({ health: health(), cfg: mkCfg({ ODDS_SCHEDULE: 'interval', ODDS_MONTHLY_BUDGET: '1' }), fetchImpl: f3, now: () => T });
  await iv.pollOdds(); await iv.pollOdds(); assert.equal(f3.calls.length, 1, 'second interval poll refused by the guard (cache aside, budget 1)');
});
