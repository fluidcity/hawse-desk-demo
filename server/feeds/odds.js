'use strict';
// Sportsbook odds feed.
//  LIVE: The Odds API v4 (https://the-odds-api.com) when ODDS_API_KEY is set server-side. The key goes only into the
//        server-side request URL (their API takes it as a query parameter); errors are redacted before they reach
//        health/logs and it is never sent to the client. Each odds request spends quota; the app polls slowly by
//        default (ODDS_POLL_SEC) and shows the remaining quota the API reports. Check current pricing/quota with the provider.
//  MOCK: without a key (or if the first live request fails), a labelled synthetic market: invented teams/books on an
//        accelerated schedule, outcomes drawn from the mock "true" probabilities. Every bet on it is SIMULATED.
const { redact } = require('../lib/net');

const BASE = 'https://api.the-odds-api.com/v4';
const MOCK_BOOKS = ['mockbook_a', 'mockbook_b', 'mockbook_c', 'mockbook_d', 'mockbook_e', 'mockbook_f'];
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
    this.mode = cfg.apiKey ? 'pending' : 'mock';
    this.note = cfg.apiKey ? 'connecting to The Odds API' : 'ODDS_API_KEY not set → MOCK odds (synthetic, labelled; bets SIMULATED)';
    this.events = new Map(); this.closing = new Map(); this.scores = new Map(); this.quota = null; this.everOk = false; this.mockTruth = new Map();
    health.register('odds.theoddsapi', { label: 'The Odds API · odds', group: 'sports', note: cfg.apiKey ? `${cfg.sports.join(', ')} · ${cfg.regions.join(',')} · every ${cfg.pollSec}s` : 'not configured', staleMs: cfg.pollSec * 2500 });
    health.register('odds.scores', { label: 'The Odds API · scores', group: 'sports', note: 'settles paper bets', staleMs: Infinity });
    health.register('odds.mock', { label: 'Mock sportsbook odds (synthetic)', group: 'sports', kind: 'mock', note: 'used when ODDS_API_KEY is unset or the API fails', staleMs: 30000 });
  }
  get simulated() { return this.mode === 'mock'; }
  start() {
    if (this.c.apiKey) { this.pollOdds(); this.oddsT = setInterval(() => this.pollOdds(), this.c.pollSec * 1000); this.scoreT = setInterval(() => this.pollScores(), this.c.scoresPollSec * 1000); }
    else this.startMock();
  }
  stop() { clearInterval(this.oddsT); clearInterval(this.scoreT); clearInterval(this.mockT); }
  async get(path, params, id) {
    const u = new URL(BASE + path); for (const [k, v] of Object.entries({ ...params, apiKey: this.c.apiKey })) u.searchParams.set(k, v);
    const t0 = Date.now();
    try {
      const r = await this.fetch(u, { headers: { accept: 'application/json', 'user-agent': 'hawse-paper-desk/2.0' }, signal: AbortSignal.timeout(10000) });
      const rem = r.headers.get('x-requests-remaining'), used = r.headers.get('x-requests-used'), last = r.headers.get('x-requests-last'); if (rem != null) this.quota = { remaining: +rem, used: used != null ? +used : null, last: last != null ? +last : null, at: Date.now() };
      const text = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      this.health.ok(id, Date.now() - t0); return JSON.parse(text);
    } catch (e) { const msg = redact(String(e.message || e)).split(this.c.apiKey).join('***'); this.health.fail(id, msg); throw new Error(msg); }
  }
  async pollOdds() {
    try {
      for (const sport of this.c.sports) {
        const rows = await this.get(`/sports/${encodeURIComponent(sport)}/odds`, { regions: this.c.regions.join(','), markets: this.c.markets.join(','), oddsFormat: 'decimal', dateFormat: 'iso' }, 'odds.theoddsapi');
        for (const e of rows) this.upsert(normalizeOddsApi(e));
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
    for (const sport of sports) {
      try { const rows = await this.get(`/sports/${encodeURIComponent(sport)}/scores`, { daysFrom: 3, dateFormat: 'iso' }, 'odds.scores'); for (const r of rows) { const s = scoreFromApi(r); if (s) this.scores.set(r.id, { ...s, at: now }); } } catch { /* health shows it */ }
    }
  }
  /** Store an event snapshot. While the game has not started, it is also the latest closing-line candidate. */
  upsert(ev) {
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
      if (T.stale[key] == null || this.rng() < 0.08) T.stale[key] = this.rng() < 0.12 ? 1 : 0; // ~12% of books lag the market at any time
      const lag = T.stale[key] ? 2.5 : 1, vig = 0.04 + this.rng() * 0.025;
      const mu = T.mu + n() * 0.25 * lag, tot = T.total + n() * 0.5 * lag;
      const pH = Math.min(0.95, Math.max(0.05, cdf(mu / T.sg.margin) + n() * 0.006 * lag));
      const price = (p) => Math.max(1.01, +(1 / (p * (1 + vig))).toFixed(2));
      const spread = half(-mu + (this.rng() < 0.15 * lag ? (this.rng() < 0.5 ? -0.5 : 0.5) : 0)); // home line
      const pCover = Math.min(0.95, Math.max(0.05, cdf((mu + spread) / T.sg.margin) + n() * 0.01 * lag));
      const line = half(tot), pOver = Math.min(0.95, Math.max(0.05, 1 - cdf((line - T.total) / T.sg.total) + n() * 0.01 * lag));
      books.push({ key, title: key.replace('mockbook_', 'MockBook ').toUpperCase() + ' (MOCK)', lastUpdate: this.now(), markets: {
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
  snapshot() {
    const now = this.now();
    return { mode: this.mode, simulated: this.simulated, note: this.note, provider: this.mode === 'mock' ? 'MOCK' : 'The Odds API', quota: this.quota,
      sports: this.mode === 'mock' ? Object.keys(MOCK_TEAMS) : this.c.sports, upcoming: this.upcoming().length, live: this.list().filter((e) => e.commence <= now && !this.scores.has(e.id)).length, settled: this.scores.size };
  }
}
module.exports = { OddsFeed, normalizeOddsApi, scoreFromApi, BASE };
