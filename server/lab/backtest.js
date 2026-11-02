'use strict';
// Deterministic bar-replay backtester shared by historical backtests and forward paper runs.
// Semantics (conservative): signal on bar close i → fill at open of bar i+1 with slippage; fee on every fill;
// stop & target checked on each bar's high/low (stop wins if both touch; gaps fill at the open);
// perp funding accrued at each settlement while a swap position is open (if funding history is supplied).
// It cannot model queue position, partial fills, latency, liquidations or spread beyond `slippageBps`.

const sma = (xs, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += xs[k]; return s / n; };
const emaArr = (xs, n) => { const k = 2 / (n + 1); const o = []; let e = xs[0]; xs.forEach((x, i) => { e = i ? x * k + e * (1 - k) : x; o.push(i >= n - 1 ? e : null); }); return o; };
const smaArr = (xs, n) => xs.map((_, i) => sma(xs, n, i));
const stdArr = (xs, n) => xs.map((_, i) => { const m = sma(xs, n, i); if (m == null) return null; let v = 0; for (let k = i - n + 1; k <= i; k++) v += (xs[k] - m) ** 2; return Math.sqrt(v / n); });
const atrArr = (bars, n) => { const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l)); return smaArr(tr, n); };
const BAR_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1H': 3600e3, '4H': 14400e3, '1D': 86400e3 };

const isBetting = (k) => /^betting_/.test(k);
function semanticErrors(cfg) {
  if (isBetting(cfg.kind)) {
    const e = [], m = cfg.market || {}, r = cfg.risk || {};
    for (const k of ['symbol', 'bar', 'venue', 'instrument']) if (k in m) e.push(`betting kinds use market.sport, not market.${k}`);
    if (r.maxStakePct > (r.maxEventPct ?? Infinity)) e.push('risk.maxStakePct cannot exceed risk.maxEventPct');
    if ((r.maxEventPct ?? 0) > (r.maxOpenPct ?? Infinity)) e.push('risk.maxEventPct cannot exceed risk.maxOpenPct');
    if (cfg.kind === 'betting_spread' && m.betMarkets && !m.betMarkets.includes('spreads')) e.push('betting_spread needs "spreads" in market.betMarkets');
    if (cfg.exit || cfg.costs) e.push('betting kinds have no exit/costs block (the vig is inside the price)');
    return e;
  }
  if (cfg.market && 'sport' in cfg.market) return ['market.sport is only for betting_* kinds'];
  const e = []; const p = cfg.params || {};
  if (cfg.kind === 'ma_cross' && p.fast >= p.slow) e.push('params.fast must be smaller than params.slow');
  if (cfg.kind === 'orb' && !['1m', '5m', '15m'].includes(cfg.market.bar)) e.push('orb needs an intraday bar (1m, 5m or 15m)');
  if (cfg.kind === 'orb' && p.rangeMinutes % (BAR_MS[cfg.market.bar] / 60e3)) e.push('orb rangeMinutes must be a multiple of the bar length');
  if (cfg.kind === 'dca_grid' && cfg.market.instrument === 'swap') e.push('dca_grid is long-only spot inventory; set market.instrument to "spot"');
  if (cfg.kind === 'basis_carry' && cfg.entry && cfg.entry.allowShort) e.push('basis_carry is long-spot/short-perp only');
  return e;
}

/** Build per-bar signals: +1 enter long, -1 enter short, 0 exit-to-flat, null nothing. */
function signals(cfg, bars) {
  const p = cfg.params, c = bars.map((b) => b.c), out = new Array(bars.length).fill(null), short = !!(cfg.entry && cfg.entry.allowShort);
  if (cfg.kind === 'ma_cross') {
    const f = p.maType === 'sma' ? smaArr(c, p.fast) : emaArr(c, p.fast), s = p.maType === 'sma' ? smaArr(c, p.slow) : emaArr(c, p.slow);
    for (let i = 1; i < bars.length; i++) { if (f[i - 1] == null || s[i - 1] == null) continue; if (f[i - 1] <= s[i - 1] && f[i] > s[i]) out[i] = 1; else if (f[i - 1] >= s[i - 1] && f[i] < s[i]) out[i] = short ? -1 : 0; }
  } else if (cfg.kind === 'bollinger_revert') {
    const m = smaArr(c, p.period), sd = stdArr(c, p.period);
    for (let i = 0; i < bars.length; i++) { if (m[i] == null) continue; const lo = m[i] - p.mult * sd[i], hi = m[i] + p.mult * sd[i];
      if (c[i] < lo) out[i] = 1; else if (c[i] > hi) out[i] = short ? -1 : 'exitLong'; else if (Math.abs(c[i] - m[i]) <= sd[i] * 0.1) out[i] = 'mid'; }
  } else if (cfg.kind === 'volatility_breakout') {
    const a = atrArr(bars, p.atrPeriod || 14), aAvg = smaArr(a.map((x) => x || 0), p.lookback);
    for (let i = p.lookback + 1; i < bars.length; i++) { if (a[i - 1] == null) continue;
      const prior = bars.slice(i - p.lookback, i), hi = Math.max(...prior.map((b) => b.h)), lo = Math.min(...prior.map((b) => b.l));
      const expanding = !p.expansion || (aAvg[i] && a[i] >= p.expansion * aAvg[i]);
      if (!expanding) continue;
      if (c[i] > hi && c[i] - c[i - 1] > p.atrMult * a[i - 1]) out[i] = 1; else if (short && c[i] < lo && c[i - 1] - c[i] > p.atrMult * a[i - 1]) out[i] = -1; }
  }
  return out;
}

function run(cfg, data, { entryFrom = 0 } = {}) {
  const bars = (data.bars || []).filter((b) => b.closed !== false);
  const notes = [];
  const res = (extra) => ({ kind: cfg.kind, symbol: cfg.market.symbol, bar: cfg.market.bar, bars: bars.length, from: bars[0] && bars[0].t, to: bars.length ? bars[bars.length - 1].t : null, notes, ...extra });
  if (isBetting(cfg.kind)) return { kind: cfg.kind, sport: cfg.market && cfg.market.sport, bars: 0, notes, supported: false, reason: 'Betting configs cannot be backtested here: no free historical odds feed (The Odds API documents historical odds snapshots as paid-plan only; check current pricing with the provider). Evaluate them as live paper runs on the desk (Sports +EV / spread / arb strategies) and judge by closing-line value, not short-run PnL.' };
  if (cfg.kind === 'funding_arb') return res({ supported: false, reason: 'Historical replay of cross-venue funding arb is not supported: there is no single public multi-venue funding history. Evaluate it as a live paper run (Funding Arb strategy on the desk).' });
  const se = semanticErrors(cfg); if (se.length) return res({ supported: false, reason: se.join('; ') });
  if (bars.length < 30) return res({ supported: false, reason: `not enough closed bars (${bars.length})` });
  const cap0 = (cfg.risk && cfg.risk.capitalUsd) || 10000, posFrac = cfg.risk.positionPct / 100, fee = cfg.costs.feeRate, slip = cfg.costs.slippageBps / 1e4;
  const isSwap = (cfg.market.instrument || 'swap') === 'swap';
  const funding = (data.funding || []).slice().sort((a, b) => a.t - b.t);
  if (isSwap && cfg.kind !== 'dca_grid' && !funding.length) notes.push('funding not modeled (no funding history supplied)');
  let cash = cap0, pos = null, peak = cap0, maxDD = 0, fees = 0, slipCost = 0, fundingPnl = 0, exposed = 0; const trades = [], equity = [];
  const mtm = (b) => (pos ? pos.qty * (pos.side > 0 ? b.c - pos.entry : pos.entry - b.c) : 0);
  const open = (side, px, i, why) => { const fill = px * (1 + side * slip), notional = (cash + 0) * posFrac, qty = notional / fill, f = notional * fee;
    cash -= f; fees += f; slipCost += Math.abs(fill - px) * qty; pos = { side, entry: fill, qty, i, t: bars[i].t, why, fees: f, funding: 0 }; };
  const close = (px, i, why) => { const fill = px * (1 - pos.side * slip), gross = pos.qty * (pos.side > 0 ? fill - pos.entry : pos.entry - fill), f = fill * pos.qty * fee;
    cash += gross - f; fees += f; slipCost += Math.abs(fill - px) * pos.qty;
    trades.push({ side: pos.side > 0 ? 'long' : 'short', entryT: pos.t, exitT: bars[i].t, entry: pos.entry, exit: fill, pnl: gross - f - pos.fees + pos.funding, fees: f + pos.fees, funding: pos.funding, why: pos.why + ' → ' + why }); pos = null; };
  let fi = 0;
  const step = (i) => { const b = bars[i]; equity.push({ t: b.t, eq: cash + mtm(b) }); const eq = cash + mtm(b); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); if (pos) exposed++; };

  if (cfg.kind === 'dca_grid') return res(grid(cfg, bars, { cap0, posFrac, fee, slip, entryFrom }));
  if (cfg.kind === 'basis_carry') return res(basis(cfg, bars, data, { cap0, posFrac, fee, slip, funding, entryFrom, notes }));

  const sig = cfg.kind === 'orb' ? null : signals(cfg, bars);
  const orb = cfg.kind === 'orb' ? orbState(cfg) : null;
  let pending = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (funding.length && isSwap) { for (; fi < funding.length && funding[fi].t <= b.t; fi++) { const fr = funding[fi]; if (pos && fr.t > pos.t) { const pay = -pos.side * fr.rate * pos.qty * (fr.mark || b.o); pos.funding += pay; cash += pay; fundingPnl += pay; } } }
    if (pending) { // fill at this bar's open
      if (pending.exit && pos) close(b.o, i, pending.exit);
      if (pending.side && !pos && i >= entryFrom) open(pending.side, b.o, i, pending.why);
      pending = null;
    }
    if (pos) { // intrabar stops / targets
      const stopPx = pos.stopPx || (cfg.exit.stopPct ? pos.entry * (1 - pos.side * cfg.exit.stopPct / 100) : null);
      const tpPx = cfg.exit.takePct ? pos.entry * (1 + pos.side * cfg.exit.takePct / 100) : null;
      const hitStop = stopPx && (pos.side > 0 ? b.l <= stopPx : b.h >= stopPx), hitTp = tpPx && (pos.side > 0 ? b.h >= tpPx : b.l <= tpPx);
      if (hitStop) close(pos.side > 0 ? Math.min(b.o, stopPx) : Math.max(b.o, stopPx), i, 'stop');
      else if (hitTp) close(pos.side > 0 ? Math.max(b.o, tpPx) : Math.min(b.o, tpPx), i, 'target');
      else if (cfg.exit.maxHoldBars && i - pos.i >= cfg.exit.maxHoldBars) close(b.c, i, 'time stop');
    }
    if (orb) { const o = orb(b, pos); if (o) { if (o.exitNow && pos) close(b.c, i, o.exitNow); else pending = o; } }
    else {
      const s = sig[i];
      if (s === 1 || s === -1) { const side = s; if (pos && pos.side !== side) pending = { exit: 'reverse signal', side, why: side > 0 ? 'long signal' : 'short signal' }; else if (!pos) pending = { side, why: side > 0 ? 'long signal' : 'short signal' }; }
      else if (s === 0 && pos) pending = { exit: 'exit signal' };
      else if (s === 'exitLong' && pos && pos.side > 0) pending = { exit: 'upper band' };
      else if (s === 'mid' && pos) pending = { exit: 'mean reached' };
    }
    if (pos && orb && pos.stopPx == null && orb.stopFor) pos.stopPx = orb.stopFor(pos.side);
    step(i);
  }
  if (pos) close(bars[bars.length - 1].c, bars.length - 1, 'end of data');
  return res(summary({ cap0, cash, trades, equity, maxDD, fees, slipCost, fundingPnl, exposed, bars }));
}

function orbState(cfg) {
  const p = cfg.params, [hh, mm] = p.sessionStartUtc.split(':').map(Number), rangeMs = p.rangeMinutes * 60e3, sessMs = (p.sessionMinutes || 390) * 60e3, barMs = BAR_MS[cfg.market.bar];
  let day = null, hi = -Infinity, lo = Infinity, traded = false;
  const f = (b, pos) => {
    const d = new Date(b.t); const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
    const sinceOpen = b.t - start;
    if (sinceOpen < 0 || sinceOpen >= sessMs) { if (pos && day === start - 0 && sinceOpen >= sessMs) return { exitNow: 'session end' }; if (pos && sinceOpen < 0 && day !== null) return { exitNow: 'session end' }; return null; }
    if (day !== start) { day = start; hi = -Infinity; lo = Infinity; traded = false; f.range = null; }
    if (sinceOpen + barMs <= rangeMs) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); return null; }
    f.range = { hi, lo };
    if (traded || pos || !isFinite(hi)) return null;
    if (b.c > hi) { traded = true; f.stopFor = () => lo; return { side: 1, why: `ORB break ↑ ${hi.toFixed(2)}` }; }
    if (b.c < lo && cfg.entry && cfg.entry.allowShort) { traded = true; f.stopFor = () => hi; return { side: -1, why: `ORB break ↓ ${lo.toFixed(2)}` }; }
    return null;
  };
  return f;
}

function grid(cfg, bars, { cap0, posFrac, fee, slip, entryFrom }) {
  const p = cfg.params, sp = p.spacingPct / 100, lot = (cap0 * posFrac) / p.levels;
  let cash = cap0, anchor = bars[0].c, lots = [], fees = 0, slipCost = 0, peak = cap0, maxDD = 0, exposed = 0; const trades = [], equity = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    for (const L of [...lots]) { const target = L.buy * (1 + sp); if (b.h >= target) { const fill = target * (1 - slip), f = fill * L.qty * fee; cash += fill * L.qty - f; fees += f; slipCost += (target - fill) * L.qty;
      trades.push({ side: 'long', entryT: L.t, exitT: b.t, entry: L.buy, exit: fill, pnl: (fill - L.buy) * L.qty - f - L.fee, fees: f + L.fee, funding: 0, why: `grid L${L.k} take` }); lots.splice(lots.indexOf(L), 1); } }
    if (i >= entryFrom) for (let k = 1; k <= p.levels; k++) { const lvl = anchor * (1 - k * sp); if (b.l <= lvl && !lots.some((L) => L.k === k) && cash >= lot) {
      const fill = Math.min(b.o, lvl) * (1 + slip), qty = lot / fill, f = lot * fee; cash -= lot + f; fees += f; slipCost += (fill - Math.min(b.o, lvl)) * qty; lots.push({ k, buy: fill, qty, t: b.t, fee: f }); } }
    if (!lots.length && b.c > anchor * (1 + sp)) anchor = b.c;
    const eq = cash + lots.reduce((a, L) => a + L.qty * b.c, 0); equity.push({ t: b.t, eq }); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); if (lots.length) exposed++;
  }
  const last = bars[bars.length - 1]; const inv = lots.reduce((a, L) => a + L.qty * last.c, 0);
  const s = summary({ cap0, cash: cash + inv, trades, equity, maxDD, fees, slipCost, fundingPnl: 0, exposed, bars });
  s.openLots = lots.length; s.inventoryUsd = inv; return s;
}

function basis(cfg, bars, data, { cap0, posFrac, fee, slip, funding, entryFrom, notes }) {
  const spot = new Map((data.spotBars || []).map((b) => [b.t, b])); const p = cfg.params;
  if (!spot.size) return { supported: false, reason: 'basis backtest needs spot candles (spotBars)' };
  notes.push('uses candle closes for both legs (no bid/ask); slippageBps should cover spreads');
  const avgRate = funding.length ? funding.slice(-21).reduce((a, f) => a + f.rate, 0) / Math.min(21, funding.length) : 0;
  const perHour = avgRate / 8; let cash = cap0, pos = null, fees = 0, slipCost = 0, fundingPnl = 0, peak = cap0, maxDD = 0, exposed = 0, fi = 0; const trades = [], equity = [];
  const costBps = 4 * fee * 1e4 + 4 * slip * 1e4;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], s = spot.get(b.t); if (!s) continue;
    for (; fi < funding.length && funding[fi].t <= b.t; fi++) if (pos && funding[fi].t > pos.t) { const pay = funding[fi].rate * pos.qty * b.o; pos.funding += pay; cash += pay; fundingPnl += pay; }
    const basisBps = (b.c / s.c - 1) * 1e4;
    if (pos) {
      const held = i - pos.i;
      if (basisBps <= (p.exitBps ?? 0) || (cfg.exit.maxHoldBars && held >= cfg.exit.maxHoldBars) || i === bars.length - 1) {
        const sx = s.c * (1 - slip), px = b.c * (1 + slip), f = (sx + px) * pos.qty * fee, pnl = (sx - pos.spot) * pos.qty + (pos.perp - px) * pos.qty - f;
        cash += pnl; fees += f; slipCost += (s.c - sx + px - b.c) * pos.qty;
        trades.push({ side: 'carry', entryT: pos.t, exitT: b.t, entry: pos.basis, exit: basisBps, pnl: pnl - pos.fees + pos.funding, fees: f + pos.fees, funding: pos.funding, why: basisBps <= (p.exitBps ?? 0) ? 'converged' : 'time/end' }); pos = null;
      }
    } else if (i >= entryFrom && i < bars.length - 1) {
      const fundBps = perHour * (p.holdHours || 72) * 1e4, net = basisBps - (p.exitBps ?? 0) + fundBps - costBps;
      if (net >= p.minNetBps) { const notional = cap0 * posFrac / 2, sp = s.c * (1 + slip), pp = b.c * (1 - slip), qty = notional / sp, f = (sp + pp) * qty * fee;
        cash -= f; fees += f; slipCost += (sp - s.c + b.c - pp) * qty; pos = { i, t: b.t, qty, spot: sp, perp: pp, basis: basisBps, fees: f, funding: 0 }; }
    }
    const eq = cash + (pos ? (s.c - pos.spot) * pos.qty + (pos.perp - b.c) * pos.qty : 0); equity.push({ t: b.t, eq }); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); if (pos) exposed++;
  }
  const s = summary({ cap0, cash, trades, equity, maxDD, fees, slipCost, fundingPnl, exposed, bars }); s.costBps = costBps; return s;
}

function summary({ cap0, cash, trades, equity, maxDD, fees, slipCost, fundingPnl, exposed, bars }) {
  const wins = trades.filter((t) => t.pnl > 0).length, first = bars[0].c, last = bars[bars.length - 1].c;
  const step = Math.max(1, Math.floor(equity.length / 200));
  return { supported: true, trades: trades.length, wins, losses: trades.length - wins, winRate: trades.length ? wins / trades.length : null,
    netUsd: cash - cap0, returnPct: ((cash - cap0) / cap0) * 100, feesUsd: fees, slippageUsd: slipCost, fundingUsd: fundingPnl, maxDrawdownPct: maxDD * 100,
    exposurePct: (exposed / bars.length) * 100, buyHoldPct: ((last - first) / first) * 100, capitalUsd: cap0,
    equity: equity.filter((_, i) => i % step === 0 || i === equity.length - 1), tradeLog: trades.slice(-50) };
}

module.exports = { run, signals, semanticErrors, isBetting, BAR_MS };
