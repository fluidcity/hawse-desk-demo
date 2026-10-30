'use strict';
// Built-in rule condition types ("signal types"). Each is DATA + a pure evaluator over a candidate context:
//   { id, label, scope: 'line'|'game'|'player', needs: ['odds'|'history'|'stats'], description,
//     params: { name: { type:'number'|'integer'|'string'|'enum'|'list'|'bool', min, max, values, default, required } },
//     evaluate(ctx, params) → { ok:boolean, detail:string, unknown?:boolean, simulated?:boolean } }
// Candidate ctx (built by rules/engine.js for one selection of one upcoming event at its BEST price):
//   ev, sport, market, name, point, team, opponent, isHome, side, best:{book,dec}, fairEx:{prob,books}|null (other books),
//   fairAll, consPoint, minutesToStart, move:{probPp,points}|null, stats(teamName) → TeamInfo|null, statsMode
const M = require('../math');
const S = require('../scanner');

const MARKETS = ['h2h', 'spreads', 'totals'];
const SIDES = ['home', 'away', 'over', 'under', 'favorite', 'underdog'];
const TEAMREF = ['selection', 'opponent', 'either'];
const am = (d) => { const a = M.decimalToAmerican(d); return (a > 0 ? '+' : '') + Math.round(a); };
const fx = (x, d = 1) => (x == null ? '—' : (+x).toFixed(d));
const teamsOf = (ctx, which) => (which === 'opponent' ? [ctx.opponent] : which === 'either' ? [ctx.ev.home, ctx.ev.away] : [ctx.team]).filter(Boolean);
const needTeam = (ctx) => (ctx.team ? null : { ok: false, detail: 'not a team selection (totals)' });
function statsFor(ctx, which) {
  const out = []; for (const t of teamsOf(ctx, which)) { const i = ctx.stats(t); if (i) out.push(i); }
  return out;
}

const BUILTIN = [
  { id: 'sport_in', label: 'Sport is one of', scope: 'game', needs: ['odds'], description: 'Upcoming game belongs to one of these sport keys (The Odds API keys, e.g. basketball_nba).',
    params: { sports: { type: 'list', required: true } },
    evaluate: (c, p) => ({ ok: p.sports.includes(c.sport), detail: c.sport }) },
  { id: 'team_matches', label: 'Team name contains', scope: 'game', needs: ['odds'], description: 'Case-insensitive substring match on the selection team, its opponent, or either team.',
    params: { names: { type: 'list', required: true }, which: { type: 'enum', values: TEAMREF, default: 'either' } },
    evaluate: (c, p) => { const ts = teamsOf(c, p.which); const hit = ts.find((t) => p.names.some((n) => t.toLowerCase().includes(n.toLowerCase()))); return { ok: !!hit, detail: hit || ts.join(' / ') }; } },
  { id: 'starts_within', label: 'Starts within', scope: 'game', needs: ['odds'], description: 'Minutes until the scheduled start are between min and max.',
    params: { minMinutes: { type: 'number', min: 0, default: 0 }, maxMinutes: { type: 'number', min: 1, default: 1440 } },
    evaluate: (c, p) => ({ ok: c.minutesToStart >= p.minMinutes && c.minutesToStart <= p.maxMinutes, detail: `${Math.round(c.minutesToStart)} min to start` }) },
  { id: 'market_is', label: 'Market is', scope: 'line', needs: ['odds'], description: 'h2h (moneyline), spreads or totals.',
    params: { markets: { type: 'list', values: MARKETS, required: true } },
    evaluate: (c, p) => ({ ok: p.markets.includes(c.market), detail: c.market }) },
  { id: 'side_is', label: 'Side is', scope: 'line', needs: ['odds'], description: 'home/away team, over/under, or favorite/underdog by no-vig consensus.',
    params: { side: { type: 'enum', values: SIDES, required: true } },
    evaluate: (c, p) => {
      if (p.side === 'over' || p.side === 'under') return { ok: c.market === 'totals' && c.name.toLowerCase() === p.side, detail: c.name };
      if (p.side === 'home' || p.side === 'away') return c.team ? { ok: c.isHome === (p.side === 'home'), detail: c.isHome ? 'home' : 'away' } : needTeam(c);
      if (!c.team) return needTeam(c);
      const fav = c.market === 'spreads' ? c.consPoint < 0 : c.fairAll ? c.fairAll.prob > 0.5 : null; if (fav == null) return { ok: false, unknown: true, detail: 'no consensus' };
      return { ok: (p.side === 'favorite') === fav, detail: fav ? 'favorite' : 'underdog' };
    } },
  { id: 'odds_between', label: 'Best price between', scope: 'line', needs: ['odds'], description: 'Best available price, in American odds (e.g. min +150, max +300; favourites are negative).',
    params: { minAmerican: { type: 'number', default: -100000 }, maxAmerican: { type: 'number', default: 100000 } },
    evaluate: (c, p) => { if ([p.minAmerican, p.maxAmerican].some((a) => a > -100 && a < 100)) return { ok: false, unknown: true, detail: 'American odds must be ≤ -100 or ≥ +100' }; const lo = M.americanToDecimal(p.minAmerican), hi = M.americanToDecimal(p.maxAmerican); return { ok: c.best.dec >= lo && c.best.dec <= hi, detail: `${am(c.best.dec)} @ ${c.best.book}` }; } },
  { id: 'line_between', label: 'Line (points) between', scope: 'line', needs: ['odds'], description: 'The selection\'s point line (spread for that team, or the total) is within [min, max].',
    params: { min: { type: 'number', default: -1000 }, max: { type: 'number', default: 1000 } },
    evaluate: (c, p) => (c.point == null ? { ok: false, detail: 'moneyline has no point' } : { ok: c.point >= p.min && c.point <= p.max, detail: `line ${c.point}` }) },
  { id: 'ev_at_least', label: 'Edge vs consensus ≥', scope: 'line', needs: ['odds'], description: 'Best price vs the no-vig median of the OTHER books at the same line: EV % ≥ minPct with ≥ minBooks books.',
    params: { minPct: { type: 'number', min: -50, max: 100, default: 2 }, minBooks: { type: 'integer', min: 2, max: 30, default: 3 } },
    evaluate: (c, p) => { if (!c.fairEx || c.fairEx.books < p.minBooks) return { ok: false, detail: `${c.fairEx ? c.fairEx.books : 0} other books (< ${p.minBooks})` }; const e = M.ev(c.fairEx.prob, c.best.dec) * 100; return { ok: e >= p.minPct, detail: `EV ${fx(e, 2)}% vs ${c.fairEx.books} books` }; } },
  { id: 'books_at_least', label: 'Books quoting ≥', scope: 'line', needs: ['odds'], description: 'At least n books quote this exact market and line.',
    params: { n: { type: 'integer', min: 1, max: 40, default: 3 } },
    evaluate: (c, p) => ({ ok: c.books >= p.n, detail: `${c.books} books` }) },
  { id: 'line_moved', label: 'Line moved', scope: 'line', needs: ['history'], description: 'Consensus moved since the scanner first saw it. toward = market moved TO this side (steam); against = moved away (buy-low / contrarian). Uses points for spreads/totals, no-vig probability (pp) for moneylines.',
    params: { minPoints: { type: 'number', min: 0, default: 1 }, minProbPp: { type: 'number', min: 0, default: 3 }, direction: { type: 'enum', values: ['toward', 'against', 'any'], default: 'any' } },
    evaluate: (c, p) => {
      if (!c.move) return { ok: false, unknown: true, detail: 'no history yet' };
      const v = c.market === 'h2h' ? c.move.probPp : c.move.points, th = c.market === 'h2h' ? p.minProbPp : p.minPoints, unit = c.market === 'h2h' ? 'pp' : 'pts';
      if (v == null) return { ok: false, unknown: true, detail: 'no history yet' };
      const ok = p.direction === 'toward' ? v >= th : p.direction === 'against' ? -v >= th : Math.abs(v) >= th;
      return { ok: ok && v !== 0, detail: `moved ${v >= 0 ? '+' : ''}${fx(v, c.market === 'h2h' ? 1 : 1)} ${unit} toward this side since first seen` };
    } },
  { id: 'off_consensus_line', label: 'Better number than consensus by ≥', scope: 'line', needs: ['odds'], description: 'The best book hangs a better point for this side than the most-quoted line (spreads/totals).',
    params: { minPoints: { type: 'number', min: 0.5, default: 1 } },
    evaluate: (c, p) => {
      if (c.point == null || c.consPoint == null) return { ok: false, detail: 'no point line' };
      const better = c.market === 'spreads' ? c.point - c.consPoint : c.name === 'Over' ? c.consPoint - c.point : c.point - c.consPoint;
      return { ok: better >= p.minPoints, detail: `${c.point} vs consensus ${c.consPoint} (${better >= 0 ? '+' : ''}${better} pts)` };
    } },
  { id: 'key_number', label: 'Crosses a key number', scope: 'line', needs: ['odds'], description: 'Best spread vs consensus crosses a key number (default NFL 3 and 7), e.g. +3.5 when the market is +3.',
    params: { numbers: { type: 'list', default: ['3', '7'] } },
    evaluate: (c, p) => {
      if (c.market !== 'spreads' || c.consPoint == null) return { ok: false, detail: 'spreads only' };
      const lo = Math.min(c.point, c.consPoint), hi = Math.max(c.point, c.consPoint), better = c.point > c.consPoint;
      const k = p.numbers.map(Number).find((n) => [n, -n].some((x) => x >= lo && x <= hi && x !== c.point));
      return { ok: better && k != null, detail: k != null ? `${c.consPoint} → ${c.point} crosses ${k}` : 'no key number crossed' };
    } },
  { id: 'arb_available', label: 'Arbitrage on this market ≥', scope: 'line', needs: ['odds'], description: 'Best prices across books on this event market sum to < 100% implied, with margin ≥ minPct.',
    params: { minPct: { type: 'number', min: 0, default: 0.5 } },
    evaluate: (c, p) => { const a = S.arbOpportunities(c.ev, { minMarginPct: p.minPct, markets: [c.market] }).find((x) => (x.legs || []).some((l) => l.name === c.name && (c.point == null || l.point === c.point))); return { ok: !!a, detail: a ? `arb ${fx(a.marginPct, 2)}%` : 'no arb' }; } },
  { id: 'back_to_back', label: 'Team on a back-to-back', scope: 'game', needs: ['stats'], description: 'Team played yesterday (rest days = 0). Pick selection or opponent (e.g. fade teams on a b2b → opponent).',
    params: { team: { type: 'enum', values: TEAMREF, default: 'opponent' } },
    evaluate: (c, p) => { const s = statsFor(c, p.team); if (!s.length) return { ok: false, unknown: true, detail: 'no team stats' }; const hit = s.find((x) => x.backToBack); return { ok: !!hit, detail: s.map((x) => `${x.team} rest ${x.restDays}d`).join(', '), simulated: s.some((x) => x.simulated) }; } },
  { id: 'rest_advantage', label: 'Rest advantage ≥ days', scope: 'game', needs: ['stats'], description: 'Selection team has at least minDays more rest than the opponent.',
    params: { minDays: { type: 'integer', min: 1, max: 7, default: 1 } },
    evaluate: (c, p) => { if (!c.team) return needTeam(c); const a = c.stats(c.team), b = c.stats(c.opponent); if (!a || !b) return { ok: false, unknown: true, detail: 'no team stats' }; const d = a.restDays - b.restDays; return { ok: d >= p.minDays, detail: `rest ${a.restDays}d vs ${b.restDays}d`, simulated: a.simulated || b.simulated }; } },
  { id: 'key_player_out', label: 'Key player out', scope: 'player', needs: ['stats'], description: 'A player with role/usage ≥ minRole on the chosen team is listed OUT (or questionable if includeQuestionable).',
    params: { team: { type: 'enum', values: TEAMREF, default: 'opponent' }, minRole: { type: 'number', min: 0, max: 100, default: 25 }, includeQuestionable: { type: 'bool', default: false } },
    evaluate: (c, p) => { const s = statsFor(c, p.team); if (!s.length) return { ok: false, unknown: true, detail: 'no player stats' };
      const hit = s.flatMap((t) => t.players.filter((x) => x.role >= p.minRole && (x.status === 'out' || (p.includeQuestionable && x.status === 'questionable'))).map((x) => `${x.name} (${t.team}) ${x.status}`));
      return { ok: hit.length > 0, detail: hit.join(', ') || 'no key absences', simulated: s.some((x) => x.simulated) }; } },
  { id: 'player_form', label: 'Player form vs season', scope: 'player', needs: ['stats'], description: 'A player\'s recent average of a stat differs from the season average by ≥ minDeltaPct (direction hot/cold).',
    params: { team: { type: 'enum', values: TEAMREF, default: 'selection' }, stat: { type: 'string', required: true }, minDeltaPct: { type: 'number', min: 1, max: 500, default: 20 }, direction: { type: 'enum', values: ['hot', 'cold'], default: 'hot' } },
    evaluate: (c, p) => { const s = statsFor(c, p.team); if (!s.length) return { ok: false, unknown: true, detail: 'no player stats' };
      let best = null; for (const t of s) for (const x of t.players) { if (x.status === 'out' || !(p.stat in x.season) || !x.season[p.stat]) continue; const d = ((x.recent[p.stat] - x.season[p.stat]) / x.season[p.stat]) * 100, sd = p.direction === 'hot' ? d : -d; if (sd >= p.minDeltaPct && (!best || sd > best.sd)) best = { x, d, sd, t }; }
      return { ok: !!best, detail: best ? `${best.x.name}: ${p.stat} last ${best.x.games} ${best.x.recent[p.stat]} vs season ${best.x.season[p.stat]} (${best.d >= 0 ? '+' : ''}${fx(best.d, 0)}%)` : `no ${p.direction} ${p.stat}`, simulated: s.some((x) => x.simulated) }; } },
];

module.exports = { BUILTIN, MARKETS, SIDES, TEAMREF };
