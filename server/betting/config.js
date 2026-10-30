'use strict';
// Betting-module configuration from env. Self-contained: the host only calls fromEnv(process.env).
// Secrets (ODDS_API_KEY) stay server-side; venue-link env vars are NOT read at all (the venue adapters are disabled stubs).
const path = require('path');
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

// Up to 10 books bill as ONE region. Pinnacle (eu region in The Odds API) is the sharp anchor for H1.
// Keys per the-odds-api.com bookmaker list (checked 2026-10-29). Caesars (williamhill_us) and Fanatics are paid-plan only,
// so the free-plan default swaps them for lowvig + mybookieag; add them back via ODDS_BOOKMAKERS on a paid plan.
const DEFAULT_BOOKS = ['pinnacle', 'draftkings', 'fanduel', 'betmgm', 'betrivers', 'espnbet', 'bovada', 'betonlineag', 'lowvig', 'mybookieag'];

function fromEnv(env = {}) {
  return {
    // Server-side only; never in public flags/snapshots. ONLY ODDS_API_KEY is used. ODDS_API_KEY_PAID is a documented
    // future swap that is read solely when ODDS_USE_PAID_KEY=true is set explicitly: there is NO automatic fallback,
    // so an exhausted free key stops polling instead of silently switching keys.
    apiKey: env.ODDS_USE_PAID_KEY === 'true' ? env.ODDS_API_KEY_PAID || '' : env.ODDS_API_KEY || '',
    keySlot: env.ODDS_USE_PAID_KEY === 'true' ? 'ODDS_API_KEY_PAID' : 'ODDS_API_KEY',
    // Free-plan defaults (500 credits/month): 1 sport, h2h only, 10 named books (= 1 region), 3 snapshots per start time.
    sports: list(env.ODDS_SPORTS, ['basketball_nba']), regions: list(env.ODDS_REGIONS, ['us']), markets: list(env.ODDS_MARKETS, ['h2h']),
    bookmakers: env.ODDS_BOOKMAKERS === '' ? [] : list(env.ODDS_BOOKMAKERS, DEFAULT_BOOKS), // set ODDS_BOOKMAKERS= (empty) to use regions instead
    schedule: env.ODDS_SCHEDULE === 'interval' ? 'interval' : 'snapshots', // 'interval' = old fixed polling (still budget-guarded)
    snapshotsMin: list(env.BET_SNAPSHOTS_MIN, ['360', '60', '10']).map(Number).filter((x) => x > 0), snapshotMergeMin: num(env.ODDS_SNAPSHOT_MERGE_MIN, 15),
    eventsRefreshMin: num(env.ODDS_EVENTS_REFRESH_MIN, 180), horizonHours: num(env.ODDS_HORIZON_HOURS, 36),
    monthlyBudget: num(env.ODDS_MONTHLY_BUDGET, 450), closingOnlyBelowPct: num(env.ODDS_CLOSING_ONLY_BELOW_PCT, 15),
    scoresAfterMin: num(env.ODDS_SCORES_AFTER_MIN, 200), scoresMinGapH: num(env.ODDS_SCORES_MIN_GAP_H, 12),
    planCredits: num(env.ODDS_PLAN_CREDITS, 500), // display + estimate warning; e.g. 20000 on a paid key (raise ODDS_MONTHLY_BUDGET too)
    cacheTtlSec: num(env.ODDS_CACHE_TTL_SEC, 900),
    cacheFile: env.ODDS_CACHE_FILE !== undefined ? env.ODDS_CACHE_FILE : path.join(__dirname, '..', '..', 'data', 'odds-cache.json'),
    creditsFile: env.CREDITS_FILE !== undefined ? env.CREDITS_FILE : path.join(__dirname, '..', '..', 'data', 'credits.json'),
    pollSec: num(env.ODDS_POLL_SEC, 900), scoresPollSec: num(env.ODDS_SCORES_POLL_SEC, 1800),
    minEdgePct: num(env.BET_MIN_EDGE_PCT, 2), minBooks: num(env.BET_MIN_BOOKS, 3), maxOddsDec: num(env.BET_MAX_ODDS_DEC, 6), fairMethod: env.BET_FAIR_METHOD === 'power' ? 'power' : 'multiplicative',
    kellyFraction: num(env.BET_KELLY_FRACTION, 0.25), maxStakePct: num(env.BET_MAX_STAKE_PCT, 2), maxEventPct: num(env.BET_MAX_EVENT_PCT, 4), maxOpenPct: num(env.BET_MAX_OPEN_PCT, 25), minStakeUsd: num(env.BET_MIN_STAKE_USD, 5),
    // H1: Pinnacle-anchored +EV (BET_ANCHOR=consensus restores the old consensus-of-other-books fair price).
    anchor: env.BET_ANCHOR === 'consensus' ? 'consensus' : 'pinnacle', anchorBook: env.BET_ANCHOR_BOOK || 'pinnacle', anchorMethod: env.BET_ANCHOR_METHOD === 'multiplicative' ? 'multiplicative' : 'power',
    minEdgeSpreadsPct: num(env.BET_MIN_EDGE_SPREADS_PCT, 2.5), minEdgeLongshotPct: num(env.BET_MIN_EDGE_LONGSHOT_PCT, 4), longshotDec: num(env.BET_LONGSHOT_DEC, 4),
    maxPriceAgeSec: num(env.BET_MAX_PRICE_AGE_SEC, 600), maxAgeGapSec: num(env.BET_MAX_AGE_GAP_SEC, 300), maxHoldPct: num(env.BET_MAX_HOLD_PCT, 5),
    maxHoursToStart: num(env.BET_MAX_HOURS_TO_START, 36), closeWithinMin: num(env.BET_CLOSE_WITHIN_MIN, 10),
    // Time-to-start gate. The MOCK feed runs an accelerated schedule (games 3-25 min out), so it uses its own small value.
    minMinutesToStart: num(env.BET_MIN_MINUTES_TO_START, 20), mockMinMinutesToStart: num(env.BET_MOCK_MIN_MINUTES_TO_START, 2), minPointEdge: num(env.BET_MIN_POINT_EDGE, 1), pointValuePct: num(env.BET_POINT_VALUE_PCT, 2.5),
    minArbPct: num(env.BET_MIN_ARB_PCT, 0.5), arbStakePct: num(env.BET_ARB_STAKE_PCT, 6), middleMaxCostPct: num(env.BET_MIDDLE_MAX_COST_PCT, 3),
    mockEvents: num(env.ODDS_MOCK_EVENTS, 8), mockTickMs: num(env.ODDS_MOCK_TICK_MS, 5000), mockLeadMin: [3, 25], mockGameMin: num(env.ODDS_MOCK_GAME_MIN, 4),
    // Stage 10: rules → signals → slips
    rules: {
      file: env.BET_RULES_FILE !== undefined ? env.BET_RULES_FILE : path.join(__dirname, '..', '..', 'data', 'betting', 'rules.json'), // data/ is gitignored; '' = in-memory
      scanMs: num(env.BET_SCAN_MS, 5000), maxSignals: num(env.BET_MAX_SIGNALS, 300),
      slipBankrollUsd: num(env.BET_SLIP_BANKROLL_USD, 1000), // used only to suggest a stake on the printed slip
      statsMock: env.BET_STATS_MOCK !== 'false', // MOCK player/team stats (labelled); no real stats provider is wired
    },
  };
}
module.exports = { fromEnv, DEFAULT_BOOKS };
