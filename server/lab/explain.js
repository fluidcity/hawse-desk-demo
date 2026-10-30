'use strict';
// Lab explainer: turns ANY strategy config (template, saved, or imported) into a plain-English "what it does" paragraph
// plus a compact rules list, read straight from cfg.kind / market / params / entry / exit / risk / costs, the same fields
// backtest.js evaluates, so the text cannot drift from what the backtest actually does. Shape matches server/lib/explain.js.
const X = require('../lib/explain');

const BAR = { '1m': '1-minute', '5m': '5-minute', '15m': '15-minute', '1H': '1-hour', '4H': '4-hour', '1D': 'daily' };
const barTxt = (b) => BAR[b] || b || '?';
const bars = (n, b) => `${n} ${barTxt(b)} bar${n === 1 ? '' : 's'}`;

function crypto(cfg) {
  const m = cfg.market || {};
  return [`${m.symbol || '?'} ${m.instrument === 'spot' ? 'spot' : 'perpetual swap'} on ${(m.venue || 'okx').toUpperCase()}, ${barTxt(m.bar)} candles`];
}
function exitRules(cfg, extra = []) {
  const e = cfg.exit || {}, m = cfg.market || {};
  return [...extra, e.stopPct ? `Stop loss ${X.pct(e.stopPct)} from entry` : null, e.takePct ? `Take profit ${X.pct(e.takePct)} from entry` : null,
    e.maxHoldBars ? `Time stop after ${bars(e.maxHoldBars, m.bar)}` : null, 'Any position still open at the end of the data is closed there'];
}
function riskRules(cfg) {
  const r = cfg.risk || {};
  return [r.capitalUsd ? `Paper capital ${X.usd(r.capitalUsd)}` : null, r.positionPct ? `Position size ${X.pct(r.positionPct, 1)} of capital` : null,
    r.maxDrawdownPct ? `Declared max drawdown ${X.pct(r.maxDrawdownPct, 1)}: reported against, NOT enforced (the backtest does not stop trading at it)` : null,
    r.kellyFraction != null && cfg.kind !== 'betting_arb' ? `Stake ${r.kellyFraction}× Kelly` : null, r.maxStakePct ? `≤ ${X.pct(r.maxStakePct, 1)} per bet` : null,
    r.maxEventPct ? `≤ ${X.pct(r.maxEventPct, 1)} per game` : null, r.maxOpenPct ? `≤ ${X.pct(r.maxOpenPct, 1)} open in total` : null];
}
function costRules(cfg) {
  const c = cfg.costs; if (!c) return [];
  return [`Fee ${X.pct(c.feeRate * 100, 3)} per side, slippage ${X.num(c.slippageBps)} bp per fill`];
}
const short = (cfg) => !!(cfg.entry && cfg.entry.allowShort);
const fills = 'Signals are taken on a closed bar and filled at the next bar\'s open';

const KINDS = {
  ma_cross: (cfg, p) => ({
    what: `Trend following with two moving averages: it buys when the faster ${p.fast}-bar ${String(p.maType || 'ema').toUpperCase()} crosses above the slower ${p.slow}-bar one, and gets out${short(cfg) ? ' and flips short' : ''} when it crosses back below.`,
    Signal: [`Fast ${String(p.maType || 'ema').toUpperCase()}(${p.fast}) vs slow ${String(p.maType || 'ema').toUpperCase()}(${p.slow}) on closing prices`],
    Entry: ['Long when fast crosses above slow', short(cfg) ? 'Short when fast crosses below slow' : 'Long only (no shorts)', fills],
    Exit: exitRules(cfg, [short(cfg) ? 'Reverses on the opposite cross' : 'Exit when fast crosses back below slow']) }),
  bollinger_revert: (cfg, p) => ({
    what: `Mean reversion: it buys when price closes below the lower Bollinger band (${p.period}-bar average minus ${p.mult} standard deviations), expecting a snap back, and exits when price returns to the average${short(cfg) ? '; it also shorts closes above the upper band' : ''}.`,
    Signal: [`Bands = SMA(${p.period}) ± ${p.mult} × standard deviation`],
    Entry: ['Long on a close below the lower band', short(cfg) ? 'Short on a close above the upper band' : 'Long only; a close above the upper band exits a long', fills],
    Exit: exitRules(cfg, ['Exit when price is back within 0.1 SD of the average']) }),
  volatility_breakout: (cfg, p) => ({
    what: `Breakout on expanding volatility: it enters when price closes beyond its ${p.lookback}-bar range with a bar move larger than ${p.atrMult}× the ATR${p.expansion ? `, and only while ATR is at least ${p.expansion}× its own recent average` : ''}.`,
    Signal: [`ATR(${p.atrPeriod || 14}); range = prior ${p.lookback}-bar high/low`, p.expansion ? `Volatility must be expanding: ATR ≥ ${p.expansion}× its ${p.lookback}-bar average` : null],
    Entry: [`Long: close above the range high and the bar's move > ${p.atrMult}× ATR`, short(cfg) ? 'Short: the mirror image below the range low' : 'Long only (no shorts)', fills],
    Exit: exitRules(cfg, short(cfg) ? ['Reverses on an opposite signal'] : ['No signal exit: only the stop / target / time stop below']) }),
  orb: (cfg, p) => ({
    what: `Opening-range breakout on a 24/7 crypto market using a fixed daily "session": it records the high and low of the first ${p.rangeMinutes} minutes after ${p.sessionStartUtc} UTC, then trades the first close outside that range, one trade per session.`,
    Signal: [`Session starts ${p.sessionStartUtc} UTC and lasts ${p.sessionMinutes || 390} min; range = first ${p.rangeMinutes} min`],
    Entry: ['Long on the first close above the range high', short(cfg) ? 'Short on the first close below the range low' : 'Long only (no shorts)', 'One trade per session', fills],
    Exit: exitRules(cfg, ['Stop at the opposite side of the range', 'Flat at the end of the session']) }),
  dca_grid: (cfg, p) => ({
    what: `A buy-the-dip grid on spot: it places ${p.levels} buy levels every ${X.pct(p.spacingPct)} below an anchor price, buys a lot each time a level is hit, and sells each lot ${X.pct(p.spacingPct)} above its buy price. It accumulates inventory in a falling market.`,
    Signal: [`${p.levels} levels spaced ${X.pct(p.spacingPct)} below the anchor; the anchor moves up when flat and price rises a full step`],
    Entry: [`Buy one lot (capital × position % ÷ ${p.levels}) when a level is touched and not already held`, 'Long-only spot inventory'],
    Exit: [`Sell each lot at +${X.pct(p.spacingPct)} from its own buy`, 'Unsold lots are marked to market at the end (no stop)'] }),
  basis_carry: (cfg, p) => ({
    Markets: [`${cfg.market && cfg.market.symbol} spot + perpetual swap on ${((cfg.market && cfg.market.venue) || 'okx').toUpperCase()}, ${barTxt(cfg.market && cfg.market.bar)} candles and funding history`],
    what: `Cash-and-carry on ${cfg.market && cfg.market.symbol}: long spot and short the perp when the perp's premium plus expected funding beats costs, collecting the premium as it converges.`,
    Signal: [`Net = basis − exit level ${X.num(p.exitBps ?? 0)} bp + funding over ${X.hours(p.holdHours || 72)} − costs`],
    Entry: [`Open when net ≥ ${X.num(p.minNetBps)} bp`, 'Long spot + short perp only (half the position notional per leg)'],
    Exit: exitRules(cfg, [`Close when the basis converges to ≤ ${X.num(p.exitBps ?? 0)} bp`]) }),
  funding_arb: (cfg, p) => ({
    what: 'Cross-venue funding arbitrage: long the perp where funding is cheapest and short it where funding is richest, earning the funding difference while price moves cancel.',
    Markets: [`${cfg.market && cfg.market.symbol} perps on ${X.list(p.venues)}`],
    Signal: [`Net funding spread after fees ≥ ${X.num(p.minNetBps)} bp`],
    Entry: ['Not backtestable here: there is no single public multi-venue funding history', 'Evaluate it as a live paper run (the Funding Arb strategy on the desk)'],
    Exit: ['As on the desk: funding spread flips, or max hold'] }),
};
function betting(cfg, p, kind) {
  const m = cfg.market || {};
  const base = { Markets: [`Sport: ${m.sport || '?'}`, `Markets: ${X.list(m.betMarkets)} · regions: ${X.list(m.regions)}`, m.books && m.books.length ? `Books: ${X.list(m.books)}` : 'Books: all returned by the feed',
    p.minMinutesToStart != null ? `Only games starting more than ${p.minMinutesToStart} min from now` : null] };
  const settle = ['Held to settlement; graded from final scores'];
  if (kind === 'betting_ev') return { ...base, what: 'Line shopping: bet a sportsbook\'s price when it beats the no-vig consensus of the other books by enough expected value, sized by fractional Kelly.',
    Signal: [`Fair price = no-vig consensus (${p.fairMethod || 'multiplicative'}), ≥ ${p.minBooks ?? '?'} books`, `EV ≥ ${X.pct(p.minEdgePct)}`, p.maxDecimalOdds ? `Ignore odds longer than ${p.maxDecimalOdds} decimal` : null],
    Entry: ['Paper bet at the best book price'], Exit: settle };
  if (kind === 'betting_spread') return { ...base, what: 'Bets point spreads that are off the market consensus by at least a point, converting each point into win probability with a fixed ASSUMPTION.',
    Signal: [`≥ ${X.num(p.minPointEdge)} pt better than consensus`, `Assumed ${X.pct(p.pointValuePct)} win probability per point`, `Edge ≥ ${X.pct(p.minEdgePct)}`, p.minBooks ? `≥ ${p.minBooks} books` : null],
    Entry: ['Paper bet at the off-consensus line'], Exit: settle };
  return { ...base, what: `Cross-book arbitrage: back every outcome at different books when the prices lock in a margin${p.includeMiddles ? '; middles are flagged as alerts only' : ''}.`,
    Signal: [`Locked margin ≥ ${X.pct(p.minMarginPct)} at quoted prices`, p.includeMiddles ? `Middles costing ≤ ${X.pct(p.maxMiddleCostPct)} if missed: alert only` : null],
    Entry: ['Stakes split so every outcome pays about the same'], Exit: settle };
}

/** Explain a lab strategy config. Never throws: unknown kinds fall back to the config's own description. */
function explainConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return X.explanation('No config.', {});
  const p = cfg.params || {}, kind = cfg.kind;
  const isBet = /^betting_/.test(kind || '');
  const k = isBet ? betting(cfg, p, kind) : KINDS[kind] ? KINDS[kind](cfg, p) : { what: cfg.description || `Unknown strategy kind "${kind}".` };
  const notes = [...(cfg.entry && cfg.entry.note ? [`Entry note: ${cfg.entry.note}`] : []), ...(isBet ? ['Spec only: cannot be backtested (no free historical odds) or forward-run in the lab; the desk\'s paper betting strategies run on the server betting config, not these params', 'No live bet placement anywhere'] : [kind === 'funding_arb' ? 'Not backtestable in the lab' : 'Backtest on public OKX candles; results are hypothetical and kept out of desk PnL'])];
  return X.explanation(k.what, { Markets: k.Markets || (isBet ? [] : crypto(cfg)), Signal: k.Signal, Entry: k.Entry, Exit: k.Exit, Risk: riskRules(cfg), Costs: costRules(cfg), Data: notes });
}

module.exports = { explainConfig };
