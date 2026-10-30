'use strict';
// Sportsbook odds feed.
//  LIVE: The Odds API v4 (https://the-odds-api.com) when ODDS_API_KEY is set server-side. The key goes only into the
//        server-side request URL (their API takes it as a query parameter); errors are redacted before they reach
//        health/logs and it is never sent to the client. Default schedule = SNAPSHOTS (./schedule.js): the free /events
//        endpoint gives the slate, and odds are fetched only at BET_SNAPSHOTS_MIN minutes before each start, with
//        bookmakers= (10 books = 1 region), under a monthly ODDS_MONTHLY_BUDGET guard. The quota headers are shown.
//  MOCK: without a key (or if the first live request fails), a labelled synthetic market: invented teams/books on an
//        accelerated schedule, outcomes drawn from the mock "true" probabilities. Every bet on it is SIMULATED.
const { redact } = require('../util');
const fs = require('fs');
const pathMod = require('path');
const { oddsCost, planSnapshots, OddsBudget, estimateMonthly } = require('./schedule');

/** On-disk response cache (data/odds-cache.json, gitignored) so restarts and repeated schedule ticks never re-spend credits.
 *  Keys exclude the API key. Stores the last seen quota headers too, so the desk shows remaining credits after a restart. */
class DiskCache {
  constructor(file) { this.file = file || ''; this.d = { entries: {}, quota: null }; if (this.file) { try { this.d = { entries: {}, quota: null, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* first run */ } } }
  key(path, params) { return path + '?' + Object.keys(params).sort().map((k) => k + '=' + params[k]).join('&'); }
  get(k, ttlMs, now) { const e = this.d.entries[k]; return e && now - e.t < ttlMs ? e.body : null; }
  put(k, body, now) { this.d.entries[k] = { t: now, body }; for (const [x, e] of Object.entries(this.d.entries)) if (now - e.t > 3 * 864e5) delete this.d.entries[x]; this.save(); }
  setQuota(q) { this.d.quota = q; this.save(); }
  save() { if (!this.file) return; try { fs.mkdirSync(pathMod.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.d)); } catch { /* best effort */ } }
}

const BASE = 'https://api.the-odds-api.com/v4';
const MOCK_SHARP = 'mock_sharp'; // Pinnacle-like MOCK anchor: low vig, never stale, less noise (see betting/anchor.js)
const MOCK_BOOKS = [MOCK_SHARP, 'mockbook_a', 'mockbook_b', 'mockbook_c', 'mockbook_d', 'mockbook_e', 'mockbook_f'];
const MOCK_TEAMS = { basketball_nba: ['Harbor Hawks', 'Mesa Comets', 'River Kings', 'Summit Owls', 'Bay Lynx', 'Iron Foxes', 'Prairie Bison', 'Coast Herons'],
  americanfootball_nfl: ['North Rams', 'Delta Gulls', 'Canyon Elk', 'Metro Bolts', 'Lake Otters', 'Forge Titans'],
  icehockey_nhl: ['Glacier Wolves', 'Port Pilots', 'Ridge Moose', 'Steel Ravens'] };
const SIGMA = { basketball_nba: { margin: 12, total: 18, total0: 226 }, americanfootball_nfl: { margin: 13.5, total: 13, total0: 44.5 }, icehockey_nhl: { margin: 2.3, total: 2.2, total0: 6 } };

const half = (x) => Math.round(x * 2) / 2;
// Standard normal helpers (Abramowitz-Stegun erf; Acklam-ish inverse via bisection on cdf; precision is plenty for a mock).
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const cdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const inv = (p) => { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (cdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };

/** Normalize one The Odds API v4 event (oddsFormat=decimal) into the scanner's shape. Pure; exported for tests. */
function normalizeOddsApi(e) {
  return { id: e.id, sport: e.sport_key, sportTitle: e.sport_title, home: e.home_team, away: e.away_team, commence: Date.parse(e.commence_time), simulated: false,
    books: (e.bookmakers || []).map((b) => ({ key: b.key, title: b.title, lastUpdate: Date.parse(b.last_update) || null,
      marketUpdates: Object.fromEntries((b.markets || []).filter((m) => m.last_update).map((m) => [m.key, Date.parse(m.last_update) || null])),
      markets: Object.fromEntries((b.markets || []).map((m) => [m.key, (m.outcomes || []).map((o) => ({ name: o.name, dec: +o.price, ...(o.point != null ? { point: +o.point } : {}) }))])) })) };
}
/** Final score from a /scores row, or null if not completed. */
function scoreFromApi(row) {
  if (!row || !row.completed || !Array.isArray(row.scores)) return null;
  const s = Object.fromEntries(row.scores.map((x) => [x.name, +x.score])); const home = s[row.home_team], away = s[row.away_team];
  return Number.isFinite(home) && Number.isFinite(away) ? { home, away } : null;
}

class OddsFeed {
  constructor({ health, cfg, rng = Math.random, now = () => Date.now(), fetchImpl = (...a) => fetch(...a) }) {
    this.health = health; this.c = cfg; this.rng = rng; this.now = now; this.fetch = fetchImpl;
    this.mode = cfg.apiKey ? 'pending' : 'mock'; this.listeners = [];
    this.note = cfg.apiKey ? 'connecting to The Odds API' : 'ODDS_API_KEY not set → MOCK odds (synthetic, labelled; bets SIMULATED)';
    this.events = new Map(); this.closing = new Map(); this.scores = new Map(); this.quota = null; this.everOk = false; this.mockTruth = new Map();
    this.schedule = cfg.schedule || 'interval'; this.slate = new Map(); this.done = new Set(); this.skipped = []; this.lastScores = {}; this.slateAt = 0; this.snapshots = 0;
    this.offsets = cfg.snapshotsMin && cfg.snapshotsMin.length ? cfg.snapshotsMin : [10];
    this.budget = new OddsBudget({ monthlyBudget: cfg.monthlyBudget != null ? cfg.monthlyBudget : 450, closingOnlyBelowPct: cfg.closingOnlyBelowPct != null ? cfg.closingOnlyBelowPct : 15, file: cfg.apiKey ? cfg.creditsFile || '' : '', now });
    this.cache = new DiskCache(cfg.apiKey ? cfg.cacheFile || '' : ''); if (this.cache.d.quota) { this.quota = this.cache.d.quota; this.budget.setApiQuota(this.quota); }
    this.cacheTtlMs = (cfg.cacheTtlSec != null ? cfg.cacheTtlSec : 900) * 1000; this.cacheHits = 0;
    this.cost = oddsCost({ markets: cfg.markets, regions: cfg.regions, bookmakers: cfg.bookmakers });
    const what = `${cfg.sports.join(', ')} · ${cfg.markets.join(',')} · ${cfg.bookmakers && cfg.bookmakers.length ? cfg.bookmakers.length + ' books' : cfg.regions.join(',')} · ${this.cost} cr/call`;
    health.register('odds.theoddsapi', { label: 'The Odds API · odds', group: 'sports', note: cfg.apiKey ? (this.schedule === 'snapshots' ? `${what} · snapshots at T-${this.offsets.join('/')} min` : `${what} · every ${cfg.pollSec}s (interval mode)`) : 'not configured',
      staleMs: this.schedule === 'snapshots' ? 36 * 3.6e6 : cfg.pollSec * 2500 });
    health.register('odds.events', { label: 'The Odds API · event slate (free)', group: 'sports', note: '/events costs 0 credits; drives the snapshot schedule', staleMs: (cfg.eventsRefreshMin || 180) * 150e3 });
    health.register('odds.scores', { label: 'The Odds API · scores', group: 'sports', note: 'settles paper bets', staleMs: Infinity });
    health.register('odds.mock', { label: 'Mock sportsbook odds (synthetic)', group: 'sports', kind: 'mock', note: 'used when ODDS_API_KEY is unset or the API fails', staleMs: 30000 });
  }
  get simulated() { return this.mode === 'mock'; }
  start() {
    if (!this.c.apiKey) return this.startMock();
    if (this.quota && this.quota.remaining != null && this.quota.remaining <= 0) { this.markExhausted('last seen x-requests-remaining = 0'); return; }
    if (this.schedule === 'snapshots') { this.tickSchedule(); this.oddsT = setInterval(() => this.tickSchedule(), 60e3); return; }
    this.pollOdds(); this.oddsT = setInterval(() => this.pollOdds(), this.c.pollSec * 1000); this.scoreT = setInterval(() => this.pollScores(), this.c.scoresPollSec * 1000);
  }
  stop() { clearInterval(this.oddsT); clearInterval(this.scoreT); clearInterval(this.mockT); }
  /** Budget gate for one paid call. Reserves `cost` credits up front; get() reconciles with x-requests-last. */
  allow(cost, kind, what) {
    const d = this.budget.check(cost, kind);
    if (!d.ok) { this.budget.refuse(); this.skipped.unshift({ t: this.now(), what, kind, reason: d.reason }); this.skipped.length = Math.min(this.skipped.length, 20); return false; }
    this.budget.spend(cost, kind); this.pendingCost = cost; return true;
  }
  /** Free key ran out: stop ALL polling (no key switching), keep cached data, show it in the desk. */
  markExhausted(why) {
    if (this.exhausted) return; this.exhausted = { at: this.now(), why };
    clearInterval(this.oddsT); clearInterval(this.scoreT); this.oddsT = this.scoreT = null;
    this.note = `The Odds API QUOTA EXHAUSTED (${why}) on ${this.c.keySlot || 'ODDS_API_KEY'}: polling stopped. No automatic key switch; showing cached data only.`;
    this.health.fail('odds.theoddsapi', 'quota exhausted: polling stopped (' + why + ')');
  }
  /** Cache → budget guard → request → cache. Returns null when refused by the guard. cost 0 = free endpoint. */
  async cachedGet(path, params, id, { cost, kind, what, ttlMs }) {
    const k = this.cache.key(path, params); const hit = this.cache.get(k, ttlMs != null ? ttlMs : this.cacheTtlMs, this.now());
    if (hit) { this.cacheHits++; return hit; }
    if (this.exhausted) return null;
    if (cost > 0 && !this.allow(cost, kind, what)) return null;
    const rows = await this.get(path, params, id, cost > 0 ? cost : null); this.cache.put(k, rows, this.now()); return rows;
  }
  /** Free slate refresh (/events = 0 credits). */
  async refreshSlate() {
    const from = new Date(this.now()).toISOString().replace(/\.\d+Z$/, 'Z'), to = new Date(this.now() + (this.c.horizonHours || 36) * 3.6e6).toISOString().replace(/\.\d+Z$/, 'Z');
    for (const sport of this.c.sports) {
      const rows = await this.cachedGet(`/sports/${encodeURIComponent(sport)}/events`, { dateFormat: 'iso', hours: this.c.horizonHours || 36 }, 'odds.events', { cost: 0, ttlMs: (this.c.eventsRefreshMin || 180) * 60e3 })
        .then((r) => r.filter((e) => { const t = Date.parse(e.commence_time); return t >= Date.parse(from) && t <= Date.parse(to); }));
      for (const e of rows) this.slate.set(e.id, { id: e.id, sport: e.sport_key || sport, home: e.home_team, away: e.away_team, commence: Date.parse(e.commence_time) });
    }
    const cut = this.now() - 6 * 3.6e6; for (const [id, e] of this.slate) if (e.commence < cut) this.slate.delete(id);
    this.slateAt = this.now();
  }
  plan() { return planSnapshots([...this.slate.values()], { offsetsMin: this.offsets, mergeMin: this.c.snapshotMergeMin || 15, now: this.now(), horizonMs: (this.c.horizonHours || 36) * 3.6e6 }); }
  /** Snapshot scheduler tick (every 60 s): refresh the free slate when due, run due snapshots, then scores. */
  async tickSchedule() {
    if (this.busy || this.exhausted) return; this.busy = true;
    try {
      if (this.now() - this.slateAt >= (this.c.eventsRefreshMin || 180) * 60e3) {
        try { await this.refreshSlate(); if (!this.everOk) { this.everOk = true; this.mode = 'live'; } if (!this.exhausted) this.note = 'The Odds API (live, scheduled snapshots)'; }
        catch (e) { if (!this.everOk) { this.note = `The Odds API failed (${e.message}) → MOCK odds (labelled; bets SIMULATED)`; this.stop(); this.startMock(); return; } }
      }
      for (const p of this.plan()) {
        if (p.at > this.now() || this.done.has(p.key)) continue;
        this.done.add(p.key); const kind = p.closing ? 'closing' : 'snapshot';
        try { if (await this.snapshotOdds(p.sport, p.latestCommence, kind, `${p.sport} T-${p.offsets.join('/')} (${p.eventIds.length} games)`)) this.snapshots++; } catch { /* health shows it */ }
      }
      if (this.exhausted) return;
      if (this.done.size > 2000) this.done = new Set([...this.done].slice(-500));
      await this.pollScores();
    } finally { this.busy = false; }
  }
  async snapshotOdds(sport, toMs, kind = 'snapshot', what = sport) {
    const p = { markets: this.c.markets.join(','), oddsFormat: 'decimal', dateFormat: 'iso' };
    if (this.c.bookmakers && this.c.bookmakers.length) p.bookmakers = this.c.bookmakers.join(','); else p.regions = this.c.regions.join(',');
    // commenceTimeTo rounded to the minute so the cache key is stable within a tick; commenceTimeFrom omitted (API default = upcoming)
    if (toMs) p.commenceTimeTo = new Date(Math.ceil((toMs + 60e3) / 60e3) * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
    const rows = await this.cachedGet(`/sports/${encodeURIComponent(sport)}/odds`, p, 'odds.theoddsapi', { cost: this.cost, kind, what });
    if (!rows) return false;
    for (const e of rows) this.upsert(normalizeOddsApi(e)); this.prune(); return true;
  }
  async get(path, params, id, reserved = null) {
    const u = new URL(BASE + path); for (const [k, v] of Object.entries({ ...params, apiKey: this.c.apiKey })) u.searchParams.set(k, v);
    const t0 = Date.now(); let gotResponse = false;
    try {
      const r = await this.fetch(u, { headers: { accept: 'application/json', 'user-agent': 'hawse-paper-desk/2.0' }, signal: AbortSignal.timeout(10000) });
      gotResponse = true; const rem = r.headers.get('x-requests-remaining'), used = r.headers.get('x-requests-used'), last = r.headers.get('x-requests-last'); if (rem != null) { this.quota = { remaining: +rem, used: used != null ? +used : null, last: last != null ? +last : null, at: Date.now() }; this.budget.setApiQuota(this.quota); this.cache.setQuota(this.quota); }
      if (reserved != null && last != null && +last !== reserved) this.budget.spend(+last - reserved, 'reconcile'); // provider-reported actual cost wins
      const text = await r.text();
      if ((rem != null && +rem <= 0) || (!r.ok && (r.status === 401 || r.status === 429) && /quota|usage|limit|credits/i.test(text))) this.markExhausted(r.ok ? 'x-requests-remaining = 0' : `HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      this.health.ok(id, Date.now() - t0); return JSON.parse(text);
    } catch (e) {
      if (!gotResponse && reserved) this.budget.spend(-reserved, 'refund'); // network failure: no request reached the API, nothing billed
      const msg = redact(String(e.message || e)).split(this.c.apiKey).join('***'); this.health.fail(id, msg); throw new Error(msg); }
  }
  /** Interval mode (opt-in ODDS_SCHEDULE=interval): every pollSec, all sports. Still budget-guarded. */
  async pollOdds() {
    if (this.exhausted) return;
    try {
      for (const sport of this.c.sports) {
        await this.snapshotOdds(sport, null, 'snapshot', `${sport} interval poll`);
      }
      this.everOk = true; this.mode = 'live'; this.note = 'The Odds API (live odds)';
      this.prune();
    } catch (e) {
      if (!this.everOk && this.mode !== 'mock') { this.note = `The Odds API failed (${e.message}) → MOCK odds (labelled; bets SIMULATED)`; this.startMock(); }
      else this.note = `last odds poll failed: ${e.message} (showing last good data; see staleness)`;
    }
  }
  async pollScores() {
    const now = this.now(); const sports = new Set([...this.events.values()].filter((e) => e.commence < now && !this.scores.has(e.id)).map((e) => e.sport));
    const after = (this.c.scoresAfterMin != null ? this.c.scoresAfterMin : 200) * 60e3, gap = (this.c.scoresMinGapH != null ? this.c.scoresMinGapH : 12) * 3.6e6;
    for (const sport of sports) {
      // Only when a game should be over, and at most once per scoresMinGapH per sport. daysFrom=1 → 2 credits.
      if (![...this.events.values()].some((e) => e.sport === sport && e.commence + after <= now && !this.scores.has(e.id))) continue;
      if (this.lastScores[sport] && now - this.lastScores[sport] < gap) continue;
      this.lastScores[sport] = now;
      try { const rows = (await this.cachedGet(`/sports/${encodeURIComponent(sport)}/scores`, { daysFrom: 1, dateFormat: 'iso' }, 'odds.scores', { cost: 2, kind: 'scores', what: `${sport} scores`, ttlMs: 3 * 3.6e6 })) || []; for (const r of rows) { const s = scoreFromApi(r); if (s) this.scores.set(r.id, { ...s, at: now }); } } catch { /* health shows it */ }
    }
  }
  /** Store an event snapshot. While the game has not started, it is also the latest closing-line candidate. */
  upsert(ev) {
    if (!ev.simulated) for (const f of this.listeners || []) { try { f(ev); } catch { /* recorder tap must never break the feed */ } } // H6 recorder tap (no extra API calls)
    const prev = this.events.get(ev.id); this.events.set(ev.id, { ...ev, firstSeen: prev ? prev.firstSeen : this.now() });
    if (this.now() < ev.commence) this.closing.set(ev.id, { ...ev, capturedAt: this.now() });
  }
  prune() { const cut = this.now() - 3 * 864e5; for (const [id, e] of this.events) if (e.commence < cut) { this.events.delete(id); this.closing.delete(id); this.scores.delete(id); this.mockTruth.delete(id); } }
  list() { return [...this.events.values()]; }
  upcoming(minLeadMs = 0) { const t = this.now() + minLeadMs; return this.list().filter((e) => e.commence > t); }
  /** Last snapshot seen before commence (approximate close: real mode is limited by the poll interval). */
  closeOf(id) { const e = this.events.get(id); return e && this.now() >= e.commence ? this.closing.get(id) || null : null; }
  scoreOf(id) { return this.scores.get(id) || null; }

  // ---------------- MOCK market ----------------
  startMock() {
    this.mode = 'mock'; if (!this.c.apiKey) this.note = 'ODDS_API_KEY not set → MOCK odds (synthetic, labelled; bets SIMULATED)';
    this.mockTick(); clearInterval(this.mockT); this.mockT = setInterval(() => this.mockTick(), this.c.mockTickMs);
  }
  mockEvent(now) {
    const sports = Object.keys(MOCK_TEAMS), sport = sports[Math.floor(this.rng() * sports.length)], teams = MOCK_TEAMS[sport].slice();
    const home = teams.splice(Math.floor(this.rng() * teams.length), 1)[0], away = teams[Math.floor(this.rng() * teams.length)];
    const sg = SIGMA[sport], pHome = 0.3 + this.rng() * 0.4, mu = inv(pHome) * sg.margin, total = sg.total0 + (this.rng() - 0.5) * sg.total;
    const id = 'mock-' + now.toString(36) + '-' + Math.floor(this.rng() * 1e6).toString(36);
    const commence = now + (this.c.mockLeadMin[0] + this.rng() * (this.c.mockLeadMin[1] - this.c.mockLeadMin[0])) * 60e3;
    this.mockTruth.set(id, { sport, mu, total, sg, finalAt: commence + this.c.mockGameMin * 60e3, stale: {} });
    return { id, sport, sportTitle: sport.split('_')[1].toUpperCase() + ' (MOCK)', home, away, commence, simulated: true, books: [] };
  }
  /** Quote every mock book around the drifting "true" line, with vig, noise and the occasional stale/off-market book. */
  mockQuote(ev, T) {
    const n = () => { let s = 0; for (let i = 0; i < 6; i++) s += this.rng(); return (s - 3) / Math.SQRT2; }; // ~N(0,1)
    const books = [];
    for (const key of MOCK_BOOKS) {
      const sharp = key === MOCK_SHARP;
      if (T.stale[key] == null || this.rng() < 0.08) T.stale[key] = !sharp && this.rng() < 0.12 ? 1 : 0; // ~12% of soft books lag the market at any time
      const lag = T.stale[key] ? 2.5 : sharp ? 0.4 : 1, vig = sharp ? 0.02 + this.rng() * 0.005 : 0.04 + this.rng() * 0.025;
      const mu = T.mu + n() * 0.25 * lag, tot = T.total + n() * 0.5 * lag;
      const pH = Math.min(0.95, Math.max(0.05, cdf(mu / T.sg.margin) + n() * 0.006 * lag));
      const price = (p) => Math.max(1.01, +(1 / (p * (1 + vig))).toFixed(2));
      const spread = half(-mu + (this.rng() < 0.15 * lag ? (this.rng() < 0.5 ? -0.5 : 0.5) : 0)); // home line
      const pCover = Math.min(0.95, Math.max(0.05, cdf((mu + spread) / T.sg.margin) + n() * 0.01 * lag));
      const line = half(tot), pOver = Math.min(0.95, Math.max(0.05, 1 - cdf((line - T.total) / T.sg.total) + n() * 0.01 * lag));
      books.push({ key, title: sharp ? 'Sharp anchor (MOCK, Pinnacle-like)' : key.replace('mockbook_', 'MockBook ').toUpperCase() + ' (MOCK)', lastUpdate: this.now(), markets: {
        h2h: [{ name: ev.home, dec: price(pH) }, { name: ev.away, dec: price(1 - pH) }],
        spreads: [{ name: ev.home, point: spread, dec: price(pCover) }, { name: ev.away, point: -spread, dec: price(1 - pCover) }],
        totals: [{ name: 'Over', point: line, dec: price(pOver) }, { name: 'Under', point: line, dec: price(1 - pOver) }] } });
    }
    return books;
  }
  mockTick() {
    const now = this.now();
    while (this.upcoming().filter((e) => e.simulated).length < this.c.mockEvents) { const ev = this.mockEvent(now); this.events.set(ev.id, { ...ev, firstSeen: now }); }
    for (const ev of this.list()) {
      const T = this.mockTruth.get(ev.id); if (!T) continue;
      if (now < ev.commence) { T.mu += (this.rng() - 0.5) * 0.25; T.total += (this.rng() - 0.5) * 0.3; this.upsert({ ...ev, books: this.mockQuote(ev, T) }); } // line movement before the close
      else if (now >= T.finalAt && !this.scores.has(ev.id)) {
        let margin = Math.round(T.mu + inv(Math.min(0.999, Math.max(0.001, this.rng()))) * T.sg.margin); if (margin === 0 && ev.sport !== 'soccer') margin = this.rng() < 0.5 ? 1 : -1;
        let total = Math.max(Math.abs(margin), Math.round(T.total + inv(Math.min(0.999, Math.max(0.001, this.rng()))) * T.sg.total)); if ((total + margin) % 2) total += 1;
        this.scores.set(ev.id, { home: (total + margin) / 2, away: (total - margin) / 2, at: now, simulated: true });
      }
    }
    this.health.ok('odds.mock', 0); this.prune();
  }
  /** Client-safe credit view for the Data Sources panel. */
  credits() {
    const est = estimateMonthly({ sports: this.c.sports, markets: this.c.markets, regions: this.c.regions, bookmakers: this.c.bookmakers, offsetsMin: this.offsets });
    const next = this.schedule === 'snapshots' && this.c.apiKey ? this.plan().filter((p) => !this.done.has(p.key)) : [];
    const day = next.filter((p) => p.at < this.now() + 864e5);
    return { provider: 'theoddsapi', unit: 'credits', planMonthly: this.c.planCredits || 500, cacheHits: this.cacheHits, cacheTtlSec: this.cacheTtlMs / 1000, schedule: this.schedule, costPerCall: this.cost, offsetsMin: this.offsets, live: !!this.c.apiKey && this.mode !== 'mock',
      estMonthly: this.c.apiKey && this.schedule === 'interval' ? Math.round(this.c.sports.length * this.cost * (86400 / this.c.pollSec) * 30) : est,
      estBasis: this.schedule === 'interval' ? `interval: ${this.c.sports.length} sport(s) × ${this.cost} cr every ${this.c.pollSec}s` : `${this.c.sports.length} sport(s) × ${this.offsets.length} snapshots × ~2.5 start-time clusters/day × ${this.cost} cr + scores`,
      legacyPerDay: 3 * 3 * 96, next24h: day.length, next24hCredits: day.length * this.cost, nextAt: next[0] ? next[0].at : null,
      keySlot: this.c.keySlot || 'ODDS_API_KEY', exhausted: this.exhausted || null,
      ...this.budget.view(), apiRemaining: this.quota ? this.quota.remaining : null, apiUsed: this.quota ? this.quota.used : null, skipped: this.skipped.slice(0, 5) };
  }
  publicInfo() { return { credits: this.credits() }; }
  snapshot() {
    const now = this.now();
    return { mode: this.mode, simulated: this.simulated, note: this.note, provider: this.mode === 'mock' ? 'MOCK' : 'The Odds API', quota: this.quota, credits: this.credits(),
      sports: this.mode === 'mock' ? Object.keys(MOCK_TEAMS) : this.c.sports, upcoming: this.upcoming().length, live: this.list().filter((e) => e.commence <= now && !this.scores.has(e.id)).length, settled: this.scores.size };
  }
}
module.exports = { OddsFeed, normalizeOddsApi, scoreFromApi, BASE };
