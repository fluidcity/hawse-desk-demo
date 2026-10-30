'use strict';
// Betting explainers: plain-English "what it does" + a compact rules list for the three bet strategies and for every
// user rule on the rules desk. Generated from the same cfg values / rule conditions the code evaluates, so the text
// cannot drift. Self-contained (module boundary): same shape as the host's server/lib/explain.js:
//   { what, rules: [{ k, items: [string] }] }
const ORDER = ['Markets', 'Signal', 'Entry', 'Exit', 'Risk', 'Costs', 'Data'];
const num = (x, d = 2) => { const n = Number(x); return Number.isFinite(n) ? String(+n.toFixed(d)) : '?'; };
const pct = (x, d = 2) => `${num(x, d)}%`;
const list = (a) => (a && a.length ? a.join(', ') : 'none');
function explanation(what, sections) {
  const rules = [];
  for (const k of ORDER) { const items = (sections[k] || []).filter(Boolean); if (items.length) rules.push({ k, items }); }
  return { what: String(what).replace(/\s+/g, ' ').trim(), rules };
}
// Per-scan take limits used by strategies.js (exported there too via STRAT_RULES) so logic and text share them.
const STRAT_RULES = Object.freeze({ evMaxPerScan: 3, spreadMaxPerScan: 2, arbMaxPerScan: 2, middleDedupMin: 10, scanMs: 5000 });

function common(s) {
  const c = s.c;
  return {
    Markets: [`Sports: ${list(c.sports)}`, `Markets: ${list(c.markets)} · ${c.bookmakers && c.bookmakers.length ? `books: ${list(c.bookmakers)}` : `regions: ${list(c.regions)}`}`, `Only games starting more than ${c.minMinutesToStart} min from now`],
    Risk: [`Paper sleeve ${pct(s.allocPct * 100, 1)} of the paper account`, `Caps: ≤ ${pct(c.maxStakePct, 1)} of the sleeve per bet, ≤ ${pct(c.maxEventPct, 1)} per game, ≤ ${pct(c.maxOpenPct, 1)} open in total`,
      `Minimum stake $${num(c.minStakeUsd)}; the desk risk gate (daily loss / drawdown / HALT) also blocks new bets`, 'Paper only: real-money placement is a disabled stub that refuses'],
    Data: [`Without ODDS_API_KEY the odds are a MOCK feed; those bets are tagged SIMULATED and go to the SIM book only`,
      c.schedule === 'interval' ? `Live odds are refreshed every ${num(c.pollSec / 60, 1)} min (interval mode), capped by a ${num(c.monthlyBudget, 0)}-credit monthly budget`
        : `Live odds are snapshots taken ${list((c.snapshotsMin || []).map((m) => 'T-' + m + ' min'))} before each start (not continuous), capped by a ${num(c.monthlyBudget, 0)}-credit monthly budget; prices between snapshots may have moved`],
  };
}

function explainStrategy(s) {
  const c = s.c, base = common(s), R = STRAT_RULES;
  const settle = 'Held to settlement and graded from final scores; closing-line value (CLV) is recorded at kickoff';
  if (s.id === 'bet_ev') return explanation(`Line shopping: for each game it compares every sportsbook's price with a fair price built from the
    other books after removing their margin (the "vig"). When one book pays clearly more than that fair price, it books a small
    paper bet sized by fractional Kelly, inside strict exposure caps.`, { ...base,
    Signal: [`Fair probability = no-vig consensus of the other books (${c.fairMethod} method), needs ≥ ${c.minBooks} books quoting`,
      `Expected value at the best price ≥ ${pct(c.minEdgePct)}`, `Ignores prices longer than ${num(c.maxOddsDec)} decimal odds`],
    Entry: [`Stake = ${c.kellyFraction}× Kelly of the sleeve, capped at ${pct(c.maxStakePct, 1)}`, `Up to ${R.evMaxPerScan} new bets per scan (every ${R.scanMs / 1000} s); one bet per selection`],
    Exit: [settle] });
  if (s.id === 'bet_spread') return explanation(`Looks for a sportsbook hanging a better point spread than the market consensus (a stale or soft
    line). Each point of difference is converted into extra win probability using a fixed ASSUMPTION, not an estimate, and it books a
    small fractional-Kelly paper bet when the resulting edge clears the threshold.`, { ...base,
    Signal: [`Line ≥ ${num(c.minPointEdge)} point(s) better than the consensus spread, with ≥ ${c.minBooks} books quoting`,
      `Assumed value: ${pct(c.pointValuePct)} win probability per point (an assumption, shown as such)`, `Resulting edge ≥ ${pct(c.minEdgePct)}`],
    Entry: [`Stake = ${c.kellyFraction}× Kelly of the sleeve, capped at ${pct(c.maxStakePct, 1)}`, `Up to ${R.spreadMaxPerScan} new bets per scan; one bet per selection`],
    Exit: [settle] });
  if (s.id === 'bet_arb') return explanation(`Scans for prices across different sportsbooks where backing every outcome locks in a profit at the
    quoted prices (an arbitrage), and paper-books all legs together. It also spots "middles" (two lines with a gap between them) but only
    ALERTS on those and never stakes them. Real books may limit, void or move a line before you can place it.`, { ...base,
    Signal: [`Arb: sum of implied probabilities across the best books gives a locked margin ≥ ${pct(c.minArbPct)}`,
      `Middle: opposing lines with a gap, costing ≤ ${pct(c.middleMaxCostPct)} if it misses (alert only, repeats suppressed for ${R.middleDedupMin} min)`],
    Entry: [`Total stake ${pct(c.arbStakePct, 1)} of the sleeve, split across legs to equalize the payout`, `Up to ${R.arbMaxPerScan} arbs per scan; one per market/line per game`],
    Exit: [settle], Risk: [`Arb cap ${pct(c.arbStakePct, 1)} per arb (replaces the per-bet cap)`, ...base.Risk] });
  return explanation(s.desc, base);
}

/** Explain a user rule from its conditions and the signal-type registry (labels + descriptions). */
function explainRule(rule, reg) {
  const fmtParams = (p) => Object.entries(p || {}).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join('/') : v}`).join(', ');
  const conds = (rule.conditions || []).map((c) => {
    const t = reg && reg.get ? reg.get(c.type) : null;
    const head = `${c.negate ? 'NOT ' : ''}${t ? t.label : c.type}${c.params && Object.keys(c.params).length ? ` (${fmtParams(c.params)})` : ''}`;
    return t && t.description ? `${head}: ${t.description}` : head;
  });
  const find = (type) => (rule.conditions || []).find((c) => c.type === type && !c.negate);
  const sp = find('sport_in'), mk = find('market_is');
  const n = conds.length, joiner = rule.match === 'any' ? 'ANY one' : n > 1 ? 'ALL' : 'the';
  const what = rule.description || `Flags upcoming games where ${joiner} of its ${n} condition${n === 1 ? '' : 's'} hold${n === 1 ? 's' : ''}.`;
  return explanation(`${what} It only creates a signal for you to review and optionally print as a slip; nothing is ever placed.`, {
    Markets: [sp ? `Sports: ${list(sp.params.sports)}` : 'Sports: every sport the odds feed covers', mk ? `Markets: ${list(mk.params.markets)}` : 'Markets: moneyline, spreads and totals', 'Upcoming games only'],
    Signal: [`Matches when ${rule.match === 'any' ? 'ANY' : 'ALL'} of:`, ...conds],
    Entry: ['Creates a signal on the Signals tab (status "new"); best-EV pick kept when several selections match'],
    Exit: [`A dismissed or expired signal stays quiet for ${num(rule.cooldownMin ?? 30, 0)} min`, 'Signals expire when the game starts'],
    Risk: ['Alerts only: no auto-placement; the slip suggests a fractional-Kelly stake from the PAPER bankroll setting', rule.enabled ? 'Enabled: scanning now' : 'Disabled: not scanning'],
  });
}

module.exports = { explainStrategy, explainRule, STRAT_RULES, explanation };
