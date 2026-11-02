'use strict';
// Offline Hyperliquid wallet scoring for the H3 watchlist (used by scripts/score-wallets.js). Pure; tested.
// Rules (batch-1 H3): last 30 days of fills; ≥ 20 trades; largest single trade < 40% of total PnL (not one lucky bet);
// median hold > 30 min (excludes HFT/market makers); positive realized PnL. Rank by PnL ÷ σ(daily PnL), keep the top 20.
const { parseFill } = require('../feeds/hl-fills');

const RULES = Object.freeze({ days: 30, minTrades: 20, maxTradeShare: 0.4, minMedianHoldMin: 30, top: 20 });
const DAY = 864e5;

function scoreWallet(raw, { now = Date.now(), days = RULES.days } = {}) {
  const from = now - days * DAY;
  const fills = raw.map(parseFill).filter((f) => f && f.time >= from && f.time <= now).sort((a, b) => a.time - b.time);
  const trades = new Map(); let realized = 0; const daily = new Map(); const holds = []; const openAt = new Map();
  for (const f of fills) {
    const pnl = f.closedPnl - f.fee; realized += pnl;
    const d = Math.floor(f.time / DAY); daily.set(d, (daily.get(d) || 0) + pnl);
    if (f.closedPnl !== 0) { const k = f.coin + '|' + f.oid; trades.set(k, (trades.get(k) || 0) + f.closedPnl - f.fee); }
    const after = f.startPos + (f.side === 'buy' ? f.sz : -f.sz), was = f.startPos;
    if (was === 0 && after !== 0) openAt.set(f.coin, f.time);
    else if (was !== 0 && (Math.abs(after) < 1e-12 || Math.sign(after) !== Math.sign(was))) {
      if (openAt.has(f.coin)) holds.push((f.time - openAt.get(f.coin)) / 60e3);
      if (Math.abs(after) < 1e-12) openAt.delete(f.coin); else openAt.set(f.coin, f.time);
    }
  }
  const tp = [...trades.values()], nDays = Math.max(1, Math.round((Math.min(now, fills.length ? fills[fills.length - 1].time : now) - from) / DAY));
  const series = []; for (let i = 0; i < days; i++) series.push(daily.get(Math.floor((from + i * DAY) / DAY)) || 0);
  const mu = series.reduce((a, b) => a + b, 0) / series.length, sigma = Math.sqrt(series.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, series.length - 1));
  holds.sort((a, b) => a - b);
  const medianHoldMin = holds.length ? holds[Math.floor(holds.length / 2)] : null;
  const maxTradeShare = realized > 0 && tp.length ? Math.max(...tp) / realized : null;
  const m = { fills: fills.length, trades: tp.length, realized, sigmaDaily: sigma, score: sigma > 0 ? realized / sigma : null, maxTradeShare, medianHoldMin, days: nDays,
    firstFill: fills.length ? fills[0].time : null, truncated: raw.length >= 2000 };
  const why = [];
  if (m.trades < RULES.minTrades) why.push(`${m.trades} trades < ${RULES.minTrades}`);
  if (!(realized > 0)) why.push('realized PnL ≤ 0');
  if (maxTradeShare != null && maxTradeShare >= RULES.maxTradeShare) why.push(`largest trade ${(maxTradeShare * 100).toFixed(0)}% of PnL ≥ ${RULES.maxTradeShare * 100}%`);
  if (medianHoldMin == null) why.push('no completed open→flat round trip in the window'); else if (medianHoldMin <= RULES.minMedianHoldMin) why.push(`median hold ${medianHoldMin.toFixed(0)} min ≤ ${RULES.minMedianHoldMin} min`);
  return { ...m, pass: !why.length, why };
}

/** Keep the top N passing wallets by score. Wallets already on the list keep their original add date (signals before it never count). */
function buildWatchlist(scored, prev = { wallets: [] }, { now = Date.now(), top = RULES.top } = {}) {
  const prevAt = new Map((prev.wallets || []).map((w) => [w.addr.toLowerCase(), w.addedAt]));
  const keep = scored.filter((s) => s.pass).sort((a, b) => b.score - a.score).slice(0, top);
  return { generatedAt: now, rules: RULES, wallets: keep.map((s) => ({ addr: s.addr, chain: 'hyperliquid', label: s.label || null, addedAt: prevAt.get(s.addr.toLowerCase()) || now,
    metrics: { trades: s.trades, realized: +s.realized.toFixed(2), score: +s.score.toFixed(3), maxTradeShare: s.maxTradeShare, medianHoldMin: s.medianHoldMin } })),
    rejected: scored.filter((s) => !s.pass).map((s) => ({ addr: s.addr, why: s.why })) };
}
module.exports = { scoreWallet, buildWatchlist, RULES };
