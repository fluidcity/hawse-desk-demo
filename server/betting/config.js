'use strict';
// Betting-module configuration from env. Self-contained: the host only calls fromEnv(process.env).
// Secrets (ODDS_API_KEY) stay server-side; venue-link env vars are NOT read at all (the venue adapters are disabled stubs).
const path = require('path');
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

function fromEnv(env = {}) {
  return {
    apiKey: env.ODDS_API_KEY || '', // server-side only; never in public flags/snapshots
    sports: list(env.ODDS_SPORTS, ['basketball_nba', 'americanfootball_nfl', 'icehockey_nhl']), regions: list(env.ODDS_REGIONS, ['us']), markets: list(env.ODDS_MARKETS, ['h2h', 'spreads', 'totals']),
    pollSec: num(env.ODDS_POLL_SEC, 900), scoresPollSec: num(env.ODDS_SCORES_POLL_SEC, 1800),
    minEdgePct: num(env.BET_MIN_EDGE_PCT, 2), minBooks: num(env.BET_MIN_BOOKS, 3), maxOddsDec: num(env.BET_MAX_ODDS_DEC, 6), fairMethod: env.BET_FAIR_METHOD === 'power' ? 'power' : 'multiplicative',
    kellyFraction: num(env.BET_KELLY_FRACTION, 0.25), maxStakePct: num(env.BET_MAX_STAKE_PCT, 2), maxEventPct: num(env.BET_MAX_EVENT_PCT, 4), maxOpenPct: num(env.BET_MAX_OPEN_PCT, 25), minStakeUsd: num(env.BET_MIN_STAKE_USD, 5),
    minMinutesToStart: num(env.BET_MIN_MINUTES_TO_START, 2), minPointEdge: num(env.BET_MIN_POINT_EDGE, 1), pointValuePct: num(env.BET_POINT_VALUE_PCT, 2.5),
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
module.exports = { fromEnv };
