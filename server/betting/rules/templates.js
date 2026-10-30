'use strict';
// Starter rules (all enabled:false until the user turns them on). They express SETUPS to review, not proven edges.
const RULES = [
  { name: 'Line-shop +EV ≥ 3%', description: 'Best price beats the no-vig consensus of the other books by ≥ 3% EV, ≥ 4 books, starts within 12 h.',
    conditions: [{ type: 'ev_at_least', params: { minPct: 3, minBooks: 4 } }, { type: 'starts_within', params: { minMinutes: 5, maxMinutes: 720 } }] },
  { name: 'Home dog getting +3.5 or more', description: 'Home underdogs on the spread at +3.5 or better, with at least 3 books quoting.',
    conditions: [{ type: 'market_is', params: { markets: ['spreads'] } }, { type: 'side_is', params: { side: 'home' } }, { type: 'side_is', params: { side: 'underdog' } }, { type: 'line_between', params: { min: 3.5, max: 30 } }, { type: 'books_at_least', params: { n: 3 } }] },
  { name: 'Steam: line moved ≥ 1 pt toward a side', description: 'Consensus spread/total moved at least a point toward this side since first seen (follow the move).',
    conditions: [{ type: 'market_is', params: { markets: ['spreads', 'totals'] } }, { type: 'line_moved', params: { minPoints: 1, direction: 'toward' } }] },
  { name: 'Fade teams on a back-to-back', description: 'Opponent played yesterday (stats are MOCK in this build → signals are tagged simulated).',
    conditions: [{ type: 'market_is', params: { markets: ['h2h', 'spreads'] } }, { type: 'back_to_back', params: { team: 'opponent' } }, { type: 'rest_advantage', params: { minDays: 1 } }] },
  { name: 'Opponent missing a key player', description: 'A high-usage opponent player is OUT, and the price on our side is still ≥ consensus (MOCK stats).',
    conditions: [{ type: 'market_is', params: { markets: ['h2h'] } }, { type: 'key_player_out', params: { team: 'opponent', minRole: 30 } }, { type: 'ev_at_least', params: { minPct: 0, minBooks: 3 } }] },
  { name: 'Better number than market (≥ 1 pt)', description: 'A book hangs a spread/total at least one point better than the most-quoted line.',
    conditions: [{ type: 'off_consensus_line', params: { minPoints: 1 } }, { type: 'books_at_least', params: { n: 3 } }] },
];
module.exports = { RULES: RULES.map((r) => ({ schema: 'hawse.betRule/1', enabled: false, match: 'all', cooldownMin: 30, source: { type: 'template' }, ...r })) };
