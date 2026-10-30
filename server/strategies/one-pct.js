'use strict';
// Strategy 3: "1% mode" — disciplined compounding. Target ~1% NET per completed cycle on spot,
// only from top-quality trend-pullback setups on real 15m candles. If nothing qualifies, it waits and logs why.
// No forced trades, no martingale, no averaging down. Fees (0.1% taker/side) + slippage are inside the target.
const { Strategy } = require('./base');
const F = require('../lib/fees');
const { openPos, managePos } = require('./directional');
const X = require('../lib/explain');

// Setup rules, read by scoreSetup AND by explain() so the explainer cannot drift.
const SETUP = Object.freeze({ minBars: 60, emaFast: 20, emaSlow: 50, slopeBars: 8, pullbackAtr: 0.6, touchBars: 3, rsiMin: 45, rsiMax: 65, atrMinPct: 0.25, atrMaxPct: 1.5,
  volRatio: 0.8, minRR: 1.5, swingBars: 10, stopBufferAtr: 0.2, minStopAtr: 0.5,
  weights: Object.freeze({ trend: 25, pullback: 20, momentum: 15, volatility: 15, volume: 10, rr: 15 }) });
const RULES = Object.freeze({ evalMs: 30000, sizePct: 0.98, maxHoldH: 24 });

const ema = (xs, n) => { const k = 2 / (n + 1); const out = []; let e = xs[0]; for (const x of xs) { e = x * k + e * (1 - k); out.push(e); } return out; };
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-12)); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-12));
  }
  return out;
}
function atr(bars, n = 14) { const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l); return ema(tr, n); }

/** Score a long trend-pullback setup on closed bars. Pure; tested. */
function scoreSetup(bars, { feeRate = 0.001, slipBps = 2, netTarget = 0.01 } = {}) {
  const S = SETUP;
  if (!bars || bars.length < S.minBars) return { pass: false, score: 0, reason: 'not enough closed bars' };
  const c = bars.map((b) => b.c), e20 = ema(c, S.emaFast), e50 = ema(c, S.emaSlow), r = rsi(c), a = atr(bars);
  const i = bars.length - 1, px = c[i], A = a[i];
  const ratio = F.grossMoveForNet({ netTarget, feeRate, slipBps });
  const target = px * ratio;
  const swingLow = Math.min(...bars.slice(-S.swingBars).map((b) => b.l));
  const stop = Math.min(swingLow - S.stopBufferAtr * A, px - S.minStopAtr * A); // below the recent swing low, never tighter than minStopAtr
  const rr = (target - px) / Math.max(px - stop, 1e-12);
  const vol20 = bars.slice(-23, -3).reduce((s, b) => s + b.v, 0) / 20, vol3 = bars.slice(-3).reduce((s, b) => s + b.v, 0) / 3;
  const checks = {
    trend: e20[i] > e50[i] && e50[i] > e50[i - S.slopeBars],
    pullback: Math.abs(px - e20[i]) <= S.pullbackAtr * A && bars.slice(-S.touchBars).some((b) => b.l <= e20[i] * 1.0005) && px > e50[i],
    momentum: r[i] >= S.rsiMin && r[i] <= S.rsiMax && r[i] > r[i - 2],
    volatility: A / px >= S.atrMinPct / 100 && A / px <= S.atrMaxPct / 100,
    volume: vol3 >= S.volRatio * vol20,
    rr: rr >= S.minRR,
  };
  const w = S.weights;
  const score = Object.entries(checks).reduce((s, [k, v]) => s + (v ? w[k] : 0), 0);
  const hard = checks.trend && checks.pullback && checks.rr;
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { pass: hard && failed.length === 0, score, checks, price: px, target, stop, rr, ratio, atrPct: A / px * 100, rsi: r[i],
    reason: failed.length ? 'fails: ' + failed.join(', ') : 'ok' };
}

class OnePct extends Strategy {
  constructor(engine, feed) {
    super(engine, { id: 'onepct', name: '1% Mode', desc: 'Disciplined ~1% net per completed cycle · top-quality trend pullbacks only · skips when nothing qualifies', allocPct: 0.13, chains: ['BTC', 'ETH', 'SOL'] });
    this.feed = feed; this.c = engine.cfg.onepct; this.setups = [];
  }
  dataMode() { return this.c.symbols.some((s) => this.feed.closed(s)) ? 'live' : 'down'; }
  tick(now) {
    managePos(this, (s) => { const q = this.feed.quote(s); return q ? q.mark : null; }, now);
    if (now - this.lastEval < RULES.evalMs) return; this.lastEval = now;
    const feeRate = F.TAKER_FEES.spot;
    this.setups = this.c.symbols.map((s) => {
      const q = this.feed.quote(s); const notional = this.sleeve(false);
      const slipBps = F.slippageBps({ halfSpreadBps: q ? q.halfSpreadBps : 1, notional, depthUsd: q && q.vol24Usd ? q.vol24Usd * 0.0005 : 1e6 });
      const sc = scoreSetup(this.feed.closed(s), { feeRate, slipBps, netTarget: this.c.targetNetPct / 100 });
      const pass = sc.pass && sc.score >= this.c.minScore;
      return { symbol: s, ...sc, pass, slipBps, quote: q, reason: sc.pass && !pass ? `score ${sc.score} < ${this.c.minScore}` : sc.reason };
    }).sort((a, b) => b.score - a.score);
    if (!this.armed) return;
    if (this.positions.length) return; // one cycle at a time: full-sleeve compounding
    const best = this.setups.find((x) => x.pass);
    if (!best) { const t = this.setups[0]; return this.skip('no top-quality setup', t ? `best ${t.symbol} score ${t.score}: ${t.reason}` : 'no data'); }
    if (!best.quote) return this.skip(`${best.symbol}: no fresh spot quote`);
    const g = this.gate(false); if (!g.ok) return this.skip('risk gate: ' + g.reason);
    openPos(this, { symbol: best.symbol, side: 'long', notional: this.sleeve(false) * RULES.sizePct, quote: best.quote, feeRate, slipBps: best.slipBps,
      tp: best.ratio - 1, sl: 1 - best.stop / best.price, maxHoldMs: RULES.maxHoldH * 3600e3, simulated: false, reason: `score ${best.score} · R:R ${best.rr.toFixed(2)} · target +${((best.ratio - 1) * 100).toFixed(2)}% gross for ${this.c.targetNetPct}% net`, now });
  }
  view() {
    const b = this.e.ledger.book(this.id).real;
    return { cycles: b.trades, wins: b.wins, losses: b.losses, targetPct: this.c.targetNetPct, growthPct: (this.sleeve(false) / this.alloc - 1) * 100,
      source: Object.entries(this.feed.src).map(([k, v]) => `${k}:${v}`).join(' '),
      setups: this.setups.map((x) => ({ symbol: x.symbol, score: x.score, pass: x.pass, reason: x.reason, price: x.price, rr: x.rr, rsi: x.rsi, atrPct: x.atrPct })) };
  }
  explain() {
    const S = SETUP, R = RULES, c = this.c, w = S.weights;
    return X.explanation(`Aims for about ${X.pct(c.targetNetPct)} net profit per completed cycle on spot coins, after fees and slippage. It only buys
      a clean pullback inside an established uptrend on closed 15-minute candles, puts the whole sleeve into one trade at a time, and simply
      waits (logging why) when nothing qualifies. No forced trades, no averaging down.`, {
      Markets: [`Spot, long only: ${X.list(c.symbols)}`, 'Closed 15-minute candles (OKX, with public fallbacks)'],
      Signal: [`Trend (${w.trend} pts): EMA${S.emaFast} above EMA${S.emaSlow}, and EMA${S.emaSlow} higher than ${S.slopeBars} bars ago`,
        `Pullback (${w.pullback} pts): price within ${S.pullbackAtr} ATR of EMA${S.emaFast}, touched it in the last ${S.touchBars} bars, still above EMA${S.emaSlow}`,
        `Momentum (${w.momentum} pts): RSI between ${S.rsiMin} and ${S.rsiMax} and rising`,
        `Volatility (${w.volatility} pts): ATR between ${X.pct(S.atrMinPct)} and ${X.pct(S.atrMaxPct)} of price`,
        `Volume (${w.volume} pts): last 3 bars average ≥ ${S.volRatio}× the prior 20-bar average`,
        `Reward:risk (${w.rr} pts): target distance ≥ ${S.minRR}× stop distance`],
      Entry: [`All six checks must pass, and the score must be ≥ ${c.minScore}`, `Best-scoring coin only; one cycle at a time using ${X.pct(R.sizePct * 100, 0)} of the sleeve`,
        `Re-scored every ${X.num(R.evalMs / 1000, 0)} s`],
      Exit: [`Target: the gross move that nets ${X.pct(c.targetNetPct)} after spot taker fees (${X.pct(F.TAKER_FEES.spot * 100, 2)}/side) and modeled slippage`,
        `Stop: ${S.stopBufferAtr} ATR below the ${S.swingBars}-bar swing low, never closer than ${S.minStopAtr} ATR`, `Time stop after ${R.maxHoldH} h`],
      Risk: X.deskRisk(this) });
  }
}
module.exports = { OnePct, scoreSetup, ema, rsi, atr, SETUP };
