'use strict';
// Deterministic plain-text → strategy-config mapper. No LLM, no network. It recognises a fixed vocabulary
// (strategy type, symbols, timeframe, MA periods, Bollinger settings, stops/targets, sizing, ORB window, grid
// spacing) and reports every clause it could NOT map, so nothing is silently guessed.
const T = require('./templates');

const BET_CONTEXT = /\b(bet|bets|betting|wager\w*|sportsbooks?|bookmakers?|books|odds|moneyline|point spread|over\/under|totals?|NBA|NFL|NHL|MLB|NCAA[FB]?|EPL|premier league|soccer|parlay|vig|juice)\b/i;
const BET_RULES = [
  ['betting_arb', /\b(sure[- ]?bets?|arb(?:itrage)?s?|middl(?:e|es|ing))\b/i],
  ['betting_spread', /\b(point spreads?|spread (?:bet\w*|signal|value)|stale (?:lines?|numbers?)|off[- ](?:market|consensus) (?:lines?|numbers?|spreads?)|key numbers?|better number)\b/i],
  ['betting_ev', /(\+\s?EV\b|\b(positive EV|expected value|value bet\w*|line[- ]shopping|no[- ]vig|de-?vig\w*|fair (?:odds|price|line)|sharp (?:books?|lines?)|beat the closing line|CLV))\b/i],
];
const SPORTS = [['basketball_nba', /\bNBA\b/i], ['americanfootball_nfl', /\bNFL\b/i], ['icehockey_nhl', /\bNHL\b/i], ['baseball_mlb', /\bMLB\b|\bbaseball\b/i], ['americanfootball_ncaaf', /\bNCAAF\b|college football/i], ['basketball_ncaab', /\bNCAAB\b|college basketball/i], ['soccer_epl', /\bEPL\b|premier league/i]];
const BET_UNSUPPORTED = [/\bparlays?\b/i, /\bteasers?\b/i, /\bplayer props?\b|\bprops\b/i, /\blive betting|in[- ]play\b/i, /\bfutures?\b|\boutrights?\b/i, /\bmartingale\b/i, /\bfollow (?:a )?tipster|picks? from\b/i, /\bbonus(?:es)?|promos?\b/i];

/** Betting clauses: sport, markets, edge %, Kelly fraction, caps. Same honesty rules as the trading mapper. */
function bettingClause(c, kind, cfg, mapped, unmapped) {
  let hit = BET_RULES.some(([k, re]) => k === kind && re.test(c)) || BET_CONTEXT.test(c);
  for (const [k, re] of SPORTS) if (re.test(c)) { cfg.market.sport = k; mapped.push(`market.sport = ${k}`); hit = true; break; }
  const mk = []; if (/\b(moneylines?|money lines?|h2h|to win|winners?)\b/i.test(c)) mk.push('h2h'); if (/\bspreads?\b|\bhandicap\b|\bATS\b/i.test(c)) mk.push('spreads'); if (/\btotals?\b|over\/under|\bO\/U\b/i.test(c)) mk.push('totals');
  if (mk.length && kind !== 'betting_spread') { cfg.market.betMarkets = [...new Set(mk)]; mapped.push(`market.betMarkets = ${cfg.market.betMarkets.join(',')}`); hit = true; }
  const kf = c.match(/\b(quarter|half|third|full|eighth|tenth)[- ]kelly\b/i) || c.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?kelly\b/i) || c.match(/\bkelly\s*(?:fraction|multiplier)?\s*(?:of|=|:)?\s*(0?\.\d+)/i);
  if (kf) { const w = { quarter: 0.25, half: 0.5, third: 1 / 3, full: 1, eighth: 0.125, tenth: 0.1 }[String(kf[1]).toLowerCase()]; const f = w ?? (+kf[1] > 1 ? +kf[1] / 100 : +kf[1]); if (f > 0 && f <= 1) { cfg.risk.kellyFraction = +f.toFixed(4); mapped.push(`risk.kellyFraction = ${cfg.risk.kellyFraction}`); hit = true; } }
  else if (/\bkelly\b/i.test(c)) { mapped.push(`risk.kellyFraction = ${cfg.risk.kellyFraction} (Kelly mentioned without a fraction; template default kept)`); hit = true; }
  const ed = c.match(/\b(?:edge|EV|expected value|value)\s*(?:is\s*|must be\s*)?(?:of|>=?|≥|above|over|at least|=|:)?\s*(\d+(?:\.\d+)?)\s*%/i) || c.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:\+?EV|edge)\b/i);
  if (ed && kind !== 'betting_arb') { cfg.params.minEdgePct = +ed[1]; mapped.push(`params.minEdgePct = ${ed[1]}`); hit = true; }
  const am = c.match(/\b(?:arb|margin|profit)\s*(?:of|>=?|≥|above|over|at least)\s*(\d+(?:\.\d+)?)\s*%/i) || c.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:arb|margin)\b/i);
  if (am && kind === 'betting_arb') { cfg.params.minMarginPct = +am[1]; mapped.push(`params.minMarginPct = ${am[1]}`); hit = true; }
  const pe = c.match(/\b(\d+(?:\.\d+)?)\s*(?:points?|pts?)\s*(?:better|off|above|from)/i) || c.match(/\b(half|one|two)[- ]points?\s*(?:better|off)/i);
  if (pe && kind === 'betting_spread') { const v = { half: 0.5, one: 1, two: 2 }[String(pe[1]).toLowerCase()] ?? +pe[1]; cfg.params.minPointEdge = Math.max(0.5, v); mapped.push(`params.minPointEdge = ${cfg.params.minPointEdge}`); hit = true; }
  const mb = c.match(/\b(?:at least|min(?:imum)?|across)\s*(\d{1,2})\s*(?:books|sportsbooks|bookmakers)\b/i); if (mb && kind !== 'betting_arb') { cfg.params.minBooks = Math.max(2, +mb[1]); mapped.push(`params.minBooks = ${cfg.params.minBooks}`); hit = true; }
  const ms = c.match(/\b(?:max(?:imum)?|never (?:bet|risk|stake)(?: more than)?|cap(?:ped)?(?: at)?)\s*(?:bet|stake)?\s*(?:of|at)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:of\s*(?:the\s*)?(?:bankroll|roll|account))?\s*(per (game|event|match)|a (game|match))?/i);
  if (ms) { const v = +ms[1]; if (ms[2]) { cfg.risk.maxEventPct = Math.min(25, v); mapped.push(`risk.maxEventPct = ${cfg.risk.maxEventPct}`); } else { cfg.risk.maxStakePct = Math.min(10, v); mapped.push(`risk.maxStakePct = ${cfg.risk.maxStakePct}`); } hit = true; }
  if (/\bmiddl/i.test(c) && kind === 'betting_arb') { cfg.params.includeMiddles = true; mapped.push('params.includeMiddles = true (alerts only)'); hit = true; }
  const bk = c.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:bank\s?roll|roll)?/i); if (bk) { const v = +bk[1].replace(/,/g, '') * (bk[2] ? 1000 : 1); if (v >= 100) { cfg.risk.capitalUsd = v; mapped.push(`risk.capitalUsd = ${v}`); hit = true; } }
  for (const re of BET_UNSUPPORTED) { const m = c.match(re); if (m) { unmapped.push(`"${m[0]}" is not supported (${kind} covers h2h/spreads/totals pre-game singles only)`); hit = true; } }
  if (/\b(auto(?:matically)?[- ]?(?:place|bet)|place (?:real|the) bets?|real money|bot that bets)\b/i.test(c)) { unmapped.push(`"${c}": automated real-money betting is not available (paper + alerts only)`); hit = true; }
  return hit;
}

const KIND_RULES = [
  ['basis_carry', /\b(cash[- ]and[- ]carry|basis (trade|arb|carry)|spot[- ]?(vs|versus|and)[- ]?perp|perp(etual)? premium)\b/i],
  ['funding_arb', /\bfunding[- ]?(rate)?[- ]?(arb|arbitrage|harvest|spread)\b|\bfunding rates?\b/i],
  ['orb', /\b(opening[- ]range|ORB)\b/i],
  ['dca_grid', /\b(grid|DCA|dollar[- ]cost[- ]averag\w*)\b/i],
  ['bollinger_revert', /\b(bollinger|mean[- ]reversion|revert\w*|oversold bounce)\b/i],
  ['volatility_breakout', /\b(volatility breakout|breakout|donchian|range expansion|ATR breakout)\b/i],
  ['ma_cross', /\b(moving[- ]average|MA cross\w*|EMA cross\w*|SMA cross\w*|golden cross|death cross|trend[- ]follow\w*|crossover)\b|\b\d+\s*(\/|and|&)\s*\d+\s*(EMA|SMA|MA)\b/i],
];
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ADA', 'AVAX', 'LINK', 'ARB', 'OP', 'SUI', 'LTC'];
const ALIASES = { bitcoin: 'BTC', ether: 'ETH', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE' };
const UNSUPPORTED = [/\bRSI\b/i, /\bMACD\b/i, /\bstochastic\b/i, /\bfibonacci|fib\b/i, /\bVWAP\b/i, /\bvolume profile\b/i, /\btrailing stop\b/i, /\bichimoku\b/i, /\bleverage\b|\b\d+x\b/i, /\bsupport|resistance\b/i, /\bnews|sentiment|twitter|tweet\b/i, /\bscale (in|out)|pyramid\w*\b/i];

function barFrom(s) {
  const m = s.match(/\b(\d+)\s*[- ]?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|daily)\b(?:\s*(?:chart|candles?|bars?|timeframe|tf))?/i) || s.match(/\b(hourly|daily|four[- ]hour)\b/i);
  if (!m) return null;
  if (!m[2]) return { hourly: '1H', daily: '1D', 'four-hour': '4H', 'four hour': '4H' }[m[1].toLowerCase()] || null;
  const n = +m[1], u = m[2][0].toLowerCase();
  const map = u === 'm' ? { 1: '1m', 5: '5m', 15: '15m', 60: '1H', 240: '4H' } : u === 'h' ? { 1: '1H', 4: '4H', 24: '1D' } : { 1: '1D' };
  return map[n] || { unsupported: `${m[0].trim()} (supported bars: 1m 5m 15m 1H 4H 1D)` };
}

function textToConfig(text) {
  const src = String(text || '').slice(0, 5000); const mapped = [], unmapped = [], warnings = [];
  if (!src.trim()) return { ok: false, error: 'empty description', mapped, unmapped };
  const betCtx = BET_CONTEXT.test(src) && !/\bfunding\b/i.test(src);
  let kind = betCtx ? (BET_RULES.find(([, re]) => re.test(src)) || [])[0] : null;
  if (!kind) kind = (KIND_RULES.find(([, re]) => re.test(src)) || [])[0];
  if (!kind && betCtx) kind = 'betting_ev';
  if (!kind) return { ok: false, error: 'could not determine the strategy type. Mention one of: +EV / value betting, sports arbitrage / middles, spread signal (betting), moving-average crossover / trend following, Bollinger / mean reversion, opening-range breakout, volatility breakout, DCA / grid, funding-rate arbitrage, cash-and-carry basis.', mapped, unmapped: [src.trim()] };
  const cfg = JSON.parse(JSON.stringify(T.get(kind)));
  delete cfg.id; cfg.name = 'Imported: ' + cfg.name; cfg.status = 'unverified'; cfg.source = { type: 'import-text', note: src.slice(0, 500) }; cfg.description = src.slice(0, 2000);
  cfg.riskNotes = [...cfg.riskNotes, 'Imported from a plain-text description by deterministic heuristics; review every field before trusting it.'];
  mapped.push(`kind = ${kind}`);
  if (/^betting_/.test(kind)) {
    if (!BET_RULES.some(([k, re]) => k === kind && re.test(src))) warnings.push('betting context found but no specific approach (+EV, spread signal, arb); defaulted to betting_ev');
    for (const c of src.split(/(?<=[.;!?\n])\s+|,\s+(?=[a-z])/i).map((x) => x.trim()).filter(Boolean)) {
      let hit = bettingClause(c, kind, cfg, mapped, unmapped);
      const claim = /\b(guaranteed|can'?t lose|risk[- ]free|lock of the|100% win|always wins?|sure thing)\b/i.test(c) && !/sure[- ]?bets?/i.test(c) || /\b(made|won|gained|returned|returns?|earned|profited|profits|win ?rate|hit rate|roi|yield)\b[^.]*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*(?:returns?|roi|yield|win ?rate|hit rate|per (?:month|year|week|season)|(?:last|this) (?:month|year|week|season))|\b\d+\s*-\s*\d+\s*(?:record|run|streak)\b|\b\d+(?:\.\d+)?\s*units?\s*(?:up|profit|won)\b/i.test(c);
      if (claim) { warnings.push(`ignored performance claim: "${c}" — imports carry no performance; betting configs stay unverified (no historical odds backtest) until judged by paper CLV`); hit = true; }
      if (!hit) unmapped.push(c);
    }
    if (cfg.risk.maxStakePct > cfg.risk.maxEventPct) { cfg.risk.maxEventPct = cfg.risk.maxStakePct; mapped.push(`risk.maxEventPct raised to ${cfg.risk.maxEventPct} (must be ≥ maxStakePct)`); }
    return { ok: true, config: cfg, mapped: [...new Set(mapped)], unmapped: [...new Set(unmapped)], warnings };
  }
  const clauses = src.split(/(?<=[.;!?\n])\s+|,\s+(?=[a-z])/i).map((c) => c.trim()).filter(Boolean);
  for (const c of clauses) {
    let hit = KIND_RULES.some(([k, re]) => k === kind && re.test(c));
    // symbol
    const sym = SYMBOLS.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(c)) || Object.entries(ALIASES).find(([a]) => new RegExp(`\\b${a}\\b`, 'i').test(c))?.[1];
    if (sym) { cfg.market.symbol = sym; mapped.push(`market.symbol = ${sym}`); hit = true; }
    const bar = barFrom(c.replace(/\b(first|for|within|after|hold(?:ing)?(?:\s+for)?)\s+\d+\s*(?:m|min|mins|minutes?|h|hrs?|hours?|d|days?|bars?|candles?)\b/gi, ' '));
    if (bar && bar.unsupported) { unmapped.push('timeframe ' + bar.unsupported); hit = true; } else if (bar && !/\bfirst\b/i.test(c)) { cfg.market.bar = bar; mapped.push(`market.bar = ${bar}`); hit = true; }
    if (/\bspot\b/i.test(c) && kind !== 'basis_carry') { cfg.market.instrument = 'spot'; mapped.push('market.instrument = spot'); hit = true; }
    if (/\b(perp|perpetual|futures|swap)\b/i.test(c) && kind !== 'dca_grid' && kind !== 'basis_carry') { cfg.market.instrument = 'swap'; mapped.push('market.instrument = swap'); hit = true; }
    if (/\b(short|go short|sell short|both directions|long and short)\b/i.test(c) && !/\bshort[- ]term\b/i.test(c) && !['dca_grid', 'basis_carry', 'funding_arb'].includes(kind)) { cfg.entry.allowShort = true; mapped.push('entry.allowShort = true'); hit = true; }
    if (/\blong[- ]only|no short/i.test(c)) { cfg.entry.allowShort = false; mapped.push('entry.allowShort = false'); hit = true; }
    if (kind === 'ma_cross') {
      const m = c.match(/\b(\d{1,3})\s*(?:\/|and|&|over|-)\s*(\d{1,3})\b(?:[- ]?(?:period|day|bar))?\s*(EMA|SMA|MA|moving)?/i) || c.match(/\b(\d{1,3})\s*(EMA|SMA)\b.*?\b(\d{1,3})\s*(EMA|SMA)\b/i);
      if (m) { const a = +m[1], b = +(m[2] && /^\d+$/.test(m[2]) ? m[2] : m[3]); if (a && b && a !== b) { cfg.params.fast = Math.min(a, b); cfg.params.slow = Math.max(a, b); mapped.push(`params.fast/slow = ${cfg.params.fast}/${cfg.params.slow}`); hit = true; } }
      if (/\bSMA|simple moving\b/i.test(c)) { cfg.params.maType = 'sma'; mapped.push('params.maType = sma'); hit = true; } else if (/\bEMA|exponential\b/i.test(c)) { cfg.params.maType = 'ema'; mapped.push('params.maType = ema'); hit = true; }
      if (/golden cross|death cross/i.test(c) && !m) { cfg.params.fast = 50; cfg.params.slow = 200; cfg.params.maType = 'sma'; mapped.push('params = 50/200 SMA (golden/death cross convention)'); hit = true; }
    }
    if (kind === 'bollinger_revert') {
      const per = c.match(/\b(\d{1,3})[- ]?(?:period|bar|day)?\s*(?:bollinger|BB|bands?|SMA|average)/i) || c.match(/\b(\d{1,3})[- ]?(?:period|length)\b/i) || c.match(/bollinger\w*\s*(?:bands?)?\s*\(?\s*(\d{1,3})/i); if (per) { cfg.params.period = +per[1]; mapped.push(`params.period = ${per[1]}`); hit = true; }
      const sd = c.match(/\b(\d(?:\.\d+)?)\s*(?:std|standard deviations?|sd|sigma|σ)\b/i) || c.match(/bollinger\w*\s*(?:bands?)?\s*\(?\s*\d{1,3}\s*,\s*(\d(?:\.\d+)?)/i); if (sd) { cfg.params.mult = +sd[1]; mapped.push(`params.mult = ${sd[1]}`); hit = true; }
    }
    if (kind === 'volatility_breakout') {
      const lb = c.match(/\b(\d{1,3})[- ]?(?:bar|day|period|candle)s?\s*(?:high|low|range|channel|donchian|breakout)/i); if (lb) { cfg.params.lookback = +lb[1]; mapped.push(`params.lookback = ${lb[1]}`); hit = true; }
      const am = c.match(/\b(\d(?:\.\d+)?)\s*(?:x|×)?\s*ATR\b/i); if (am) { cfg.params.atrMult = +am[1]; mapped.push(`params.atrMult = ${am[1]}`); hit = true; }
    }
    if (kind === 'orb') {
      const fm = c.match(/\bfirst\s+(\d{1,3})\s*(?:min|minutes|m)\b/i) || c.match(/\b(\d{1,3})[- ]?min(?:ute)?s?\s+(?:opening )?range\b/i); if (fm) { cfg.params.rangeMinutes = +fm[1]; mapped.push(`params.rangeMinutes = ${fm[1]}`); hit = true; }
      const at = c.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*UTC\b/i); if (at) { cfg.params.sessionStartUtc = `${at[1].padStart(2, '0')}:${at[2]}`; mapped.push(`params.sessionStartUtc = ${cfg.params.sessionStartUtc}`); hit = true; }
      else if (/\b(\d{1,2}(:\d\d)?\s*(am|pm)|ET|EST|PST|New York|London)\b/i.test(c)) { unmapped.push(`session time "${c}" (give it as HH:MM UTC)`); hit = true; }
    }
    if (kind === 'dca_grid') {
      const g = c.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:apart|spacing|steps?|grid|intervals?|below)/i) || c.match(/(?:every|spacing of|spaced)\s+(\d+(?:\.\d+)?)\s*%/i); if (g) { cfg.params.spacingPct = +g[1]; mapped.push(`params.spacingPct = ${g[1]}`); hit = true; }
      const lv = c.match(/\b(\d{1,2})\s*(?:levels|orders|grids|rungs|steps)\b/i); if (lv) { cfg.params.levels = +lv[1]; mapped.push(`params.levels = ${lv[1]}`); hit = true; }
    }
    const st = c.match(/\bstop(?:[- ]loss)?\s*(?:at|of|=|:)?\s*(\d+(?:\.\d+)?)\s*%/i) || c.match(/\b(\d+(?:\.\d+)?)\s*%\s*stop/i); if (st) { cfg.exit.stopPct = +st[1]; mapped.push(`exit.stopPct = ${st[1]}`); hit = true; }
    const tp = c.match(/\b(?:take[- ]profit|target|TP)\s*(?:at|of|=|:)?\s*(\d+(?:\.\d+)?)\s*%/i) || c.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:take[- ]profit|target|profit)/i); if (tp) { cfg.exit.takePct = +tp[1]; mapped.push(`exit.takePct = ${tp[1]}`); hit = true; }
    const hb = c.match(/\b(?:max(?:imum)?\s*hold|hold(?:ing)?\s*(?:for)?|exit after|time stop(?: of| after)?)\s*(?:up to\s*)?(\d{1,4})\s*(bars?|candles?)\b/i); if (hb) { cfg.exit.maxHoldBars = +hb[1]; mapped.push(`exit.maxHoldBars = ${hb[1]}`); hit = true; }
    const rk = c.match(/\b(?:risk|position size|size|allocate|use)\s*(?:of|=|:)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:of\s*(?:the\s*)?(?:account|capital|equity|portfolio))?/i); if (rk && !st && !tp) { cfg.risk.positionPct = Math.min(100, +rk[1]); mapped.push(`risk.positionPct = ${cfg.risk.positionPct}`); hit = true; }
    const capm = c.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i); if (capm) { const v = +capm[1].replace(/,/g, '') * (capm[2] ? 1000 : 1); if (v >= 100) { cfg.risk.capitalUsd = v; mapped.push(`risk.capitalUsd = ${v}`); hit = true; } }
    for (const re of UNSUPPORTED) { const m = c.match(re); if (m) { unmapped.push(`"${m[0]}" is not part of the schema (${kind} has no field for it)`); hit = true; } }
    const claim = /\b(guaranteed|can'?t lose|risk[- ]free|100% win|always wins?)\b/i.test(c) || /\b(made|gained|returned|returns?|earned|profited|profits|win ?rate|roi|apy|apr)\b[^.]*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*(?:returns?|gains?|profit|roi|apy|apr|win ?rate|per (?:month|year|week|day)|a (?:month|year|week|day)|(?:last|this) (?:month|year|week))/i.test(c);
    if (claim) { warnings.push(`ignored performance claim: "${c}" — imports carry no performance; backtest it here`); hit = true; }
    else if (/\b(\d+(?:\.\d+)?)\s*%/.test(c) && !/stop|target|take|profit|risk|size|allocate|use|apart|spacing|grid|step|interval|below|every/i.test(c)) { unmapped.push(`percentage with unclear meaning: "${c}"`); hit = true; }
    if (!hit) unmapped.push(c);
  }
  return { ok: true, config: cfg, mapped: [...new Set(mapped)], unmapped: [...new Set(unmapped)], warnings };
}
module.exports = { textToConfig };
