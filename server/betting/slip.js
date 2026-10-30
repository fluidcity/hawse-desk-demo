'use strict';
// Bet SLIP: a printable / copyable / downloadable summary of one signal so the user can place the bet THEMSELVES on
// Kalshi, Polymarket or a sportsbook. HAWSE never places it. Prices move: the slip states the worst price that still
// has an edge, and a prediction-market (YES-contract) equivalent in cents, BEFORE venue fees.
const M = require('./math');

const am = (d) => { if (!(d > 1)) return '—'; const a = M.decimalToAmerican(d); return (a > 0 ? '+' : '') + a; };
const pct = (x, n = 1) => (x == null ? '—' : (x * 100).toFixed(n) + '%');
const MARKET_NAME = { h2h: 'Moneyline (game winner)', spreads: 'Point spread', totals: 'Game total (over/under)' };

function buildSlip(sig, { bankrollUsd = 1000, kellyFraction = 0.25, maxStakePct = 2, now = Date.now() } = {}) {
  const p = sig.fairProb, fairDec = p ? 1 / p : null, k = p ? M.kelly(p, sig.dec, { fraction: kellyFraction, maxPct: maxStakePct / 100 }) : { stakePct: 0 };
  const stake = Math.floor(bankrollUsd * k.stakePct);
  const yesCents = p ? Math.max(1, Math.min(99, Math.floor(p * 100 - 1e-9))) : null;
  return {
    schema: 'hawse.betSlip/1', id: 'slip-' + sig.id, signalId: sig.id, generatedAt: new Date(now).toISOString(),
    simulated: !!sig.simulated, watermark: sig.simulated ? 'SIMULATED — built from MOCK data (' + sig.simReasons.join('; ') + '). Do not bet on this.' : null,
    rule: { id: sig.ruleId, name: sig.ruleName, version: sig.ruleVersion },
    event: sig.event, sport: sig.sport, startsAt: new Date(sig.commence).toISOString(),
    market: sig.market, marketName: MARKET_NAME[sig.market] || sig.market, selection: sig.label,
    seenAt: { book: sig.book, decimal: +sig.dec.toFixed(3), american: am(sig.dec), impliedPct: +(100 / sig.dec).toFixed(2), at: new Date(sig.updatedAt || sig.createdAt || now).toISOString() },
    fair: p ? { prob: +p.toFixed(4), decimal: +fairDec.toFixed(3), american: am(fairDec), books: sig.fairBooks, method: 'no-vig median of other books' } : null,
    evPct: sig.evPct == null ? null : +sig.evPct.toFixed(2),
    worstPrice: p ? { decimal: +fairDec.toFixed(3), american: am(fairDec), note: 'Break-even vs the consensus fair price. Anything worse has no edge (before fees).' } : null,
    predictionMarket: p ? { contract: `YES on "${sig.label}" (${sig.event})`, maxYesCents: yesCents, note: `Pays $1 if it wins. A YES price under ${yesCents}¢ is better than the consensus fair ${pct(p)} BEFORE fees; check the venue's current fee schedule. Spreads/totals contracts may not exist on every venue or may use different lines; only match the exact same outcome.` } : null,
    stake: { suggestedUsd: stake, pctOfBankroll: +(k.stakePct * 100).toFixed(2), bankrollUsd, kellyFraction, capPct: maxStakePct, note: 'Fractional-Kelly suggestion from the PAPER bankroll setting; size to your own limits.' },
    why: sig.matched.map((m) => `${m.type}: ${m.detail}`),
    checklist: ['Re-check the price now; lines move. Skip it if the price is worse than the worst price above.', 'Confirm the venue lists the exact same outcome (team, line, full game incl. overtime rules).', 'Confirm betting / event contracts are legal for you where you are, and the venue\'s terms.', 'Only stake what you can afford to lose. This is not financial advice.'],
    disclaimer: 'HAWSE is a paper-trading desk. It does not place, route or auto-place bets and has no venue connection. You place this yourself.',
  };
}

function slipText(s) {
  const L = [];
  if (s.simulated) L.push('*** ' + s.watermark + ' ***', '');
  L.push('HAWSE BET SLIP (manual placement)  ' + s.id, `Generated ${s.generatedAt}`, '', `Event:     ${s.event} (${s.sport})`, `Starts:    ${s.startsAt}`, `Market:    ${s.marketName}`, `Selection: ${s.selection}`,
    `Seen at:   ${s.seenAt.book}  ${s.seenAt.american} (dec ${s.seenAt.decimal}, implied ${s.seenAt.impliedPct}%)  ${s.seenAt.at}`);
  if (s.fair) L.push(`Fair:      ${s.fair.american} (dec ${s.fair.decimal}, ${(s.fair.prob * 100).toFixed(1)}%) from ${s.fair.books} books`, `Edge:      ${s.evPct == null ? '—' : s.evPct + '% EV at the seen price'}`, `Worst price with edge: ${s.worstPrice.american} (dec ${s.worstPrice.decimal})`, `Prediction market: ${s.predictionMarket.contract}, YES ≤ ${s.predictionMarket.maxYesCents}¢ before fees`);
  L.push(`Stake idea: $${s.stake.suggestedUsd} (${s.stake.pctOfBankroll}% of $${s.stake.bankrollUsd} paper bankroll, ${s.stake.kellyFraction}× Kelly, cap ${s.stake.capPct}%)`, '', `Rule: ${s.rule.name} (v${s.rule.version})`, ...s.why.map((w) => '  - ' + w), '', 'Before you place it:', ...s.checklist.map((c) => '  [ ] ' + c), '', s.disclaimer);
  return L.join('\n');
}
module.exports = { buildSlip, slipText };
