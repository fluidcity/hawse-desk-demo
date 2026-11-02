'use strict';
// Pure odds analytics over normalized events. Event shape (what feeds/odds.js produces):
//   { id, sport, home, away, commence (ms), simulated, books: [{ key, title, lastUpdate,
//       markets: { h2h: [{name, dec}], spreads: [{name, point, dec}], totals: [{name:'Over'|'Under', point, dec}] } }] }
// Selections are identified by market|name|point. "Fair" = no-vig consensus (median across books).
const M = require('./math');

const selKey = (market, name, point) => `${market}|${name}|${point == null ? '' : point}`;
const fmtPt = (p) => (p == null ? '' : (p > 0 ? '+' : '') + p);
const label = (ev, market, name, point) => (market === 'totals' ? `${name} ${point}` : market === 'spreads' ? `${name} ${point === 0 ? "PK" : fmtPt(point)}` : `${name} ML`);

/** Every complete two/three-way market quoted by one book, grouped by line. Returns [{market, line, outcomes:[{name, point, dec}]}]. */
function bookMarkets(ev, b, markets = ['h2h', 'spreads', 'totals']) {
  const out = [];
  for (const mk of markets) {
    const os = (b.markets && b.markets[mk]) || []; if (!os.length) continue;
    if (mk === 'h2h') { if (os.length >= 2 && os.every((o) => o.dec > 1)) out.push({ market: 'h2h', line: '', outcomes: os }); continue; }
    if (mk === 'spreads') { // pair home at p with away at −p
      for (const h of os.filter((o) => o.name === ev.home)) { const a = os.find((o) => o.name === ev.away && o.point === -h.point); if (a && h.dec > 1 && a.dec > 1) out.push({ market: 'spreads', line: h.point, outcomes: [h, a] }); }
      continue;
    }
    for (const o of os.filter((x) => x.name === 'Over')) { const u = os.find((x) => x.name === 'Under' && x.point === o.point); if (u && o.dec > 1 && u.dec > 1) out.push({ market: 'totals', line: o.point, outcomes: [o, u] }); }
  }
  return out;
}

/**
 * No-vig fair probability for one selection from the books that quote that exact market+line.
 * exclude: a book key to leave out (so a book's own price is never judged against itself).
 */
function fairProb(ev, market, name, point, { exclude, method = 'multiplicative', books } = {}) {
  const ps = []; const line = market === 'spreads' ? (name === ev.home ? point : -point) : market === 'totals' ? point : '';
  for (const b of ev.books) {
    if (b.key === exclude || (books && books.length && !books.includes(b.key))) continue;
    const g = bookMarkets(ev, b, [market]).find((x) => x.line === line); if (!g) continue;
    const nv = M.noVig(g.outcomes.map((o) => o.dec), method); const i = g.outcomes.findIndex((o) => o.name === name && (market === 'h2h' || o.point === point));
    if (i >= 0) ps.push(nv.probs[i]);
  }
  return ps.length ? { prob: M.median(ps), books: ps.length } : null;
}

/** Every (book, selection, price) quote of an event. */
function quotes(ev, { markets = ['h2h', 'spreads', 'totals'], books } = {}) {
  const q = [];
  for (const b of ev.books) { if (books && books.length && !books.includes(b.key)) continue; for (const mk of markets) for (const o of (b.markets && b.markets[mk]) || []) if (o.dec > 1) q.push({ book: b.key, market: mk, name: o.name, point: mk === 'h2h' ? null : o.point, dec: o.dec }); }
  return q;
}

/** Best price per selection across books (line shopping). */
function bestPrices(ev, opts = {}) {
  const best = {};
  for (const x of quotes(ev, opts)) { const k = selKey(x.market, x.name, x.point); if (!best[k] || x.dec > best[k].dec) best[k] = { ...x, key: k, alt: best[k] ? best[k].dec : null }; }
  return best;
}

/** +EV: each book's price vs the no-vig consensus of the OTHER books at the same line. */
function evOpportunities(ev, { minEdgePct = 2, minBooks = 3, maxDecimalOdds = 6, method = 'multiplicative', markets, books } = {}) {
  const out = [];
  for (const x of quotes(ev, { markets, books })) {
    if (x.dec > maxDecimalOdds) continue;
    const f = fairProb(ev, x.market, x.name, x.point, { exclude: x.book, method, books }); if (!f || f.books < minBooks - 1) continue;
    const e = M.ev(f.prob, x.dec) * 100; if (e < minEdgePct) continue;
    out.push({ type: 'ev', eventId: ev.id, ...x, label: label(ev, x.market, x.name, x.point), fairProb: f.prob, fairDec: 1 / f.prob, evPct: e, consensusBooks: f.books });
  }
  // keep the best book per selection
  const best = {}; for (const o of out) { const k = selKey(o.market, o.name, o.point); if (!best[k] || o.evPct > best[k].evPct) best[k] = o; }
  return Object.values(best).sort((a, b) => b.evPct - a.evPct);
}

/** Arbitrage: best price per outcome of the same market+line across different books. */
function arbOpportunities(ev, { minMarginPct = 0, markets = ['h2h', 'spreads', 'totals'], books } = {}) {
  const groups = {};
  for (const b of ev.books) { if (books && books.length && !books.includes(b.key)) continue; for (const g of bookMarkets(ev, b, markets)) { const k = g.market + '|' + g.line; const G = (groups[k] = groups[k] || { market: g.market, line: g.line, best: {} });
    for (const o of g.outcomes) { const ok = o.name + '|' + (o.point ?? ''); if (!G.best[ok] || o.dec > G.best[ok].dec) G.best[ok] = { ...o, book: b.key }; } } }
  const out = [];
  for (const G of Object.values(groups)) {
    const legs = Object.values(G.best); if (legs.length < 2 || (G.market === 'h2h' && legs.length !== maxOutcomes(ev, 'h2h'))) continue;
    if (new Set(legs.map((l) => l.book)).size < 2) continue; // a single book never offers a true arb
    const a = M.arb(legs.map((l) => l.dec), 100); if (!a || a.marginPct < minMarginPct) continue;
    out.push({ type: 'arb', eventId: ev.id, market: G.market, line: G.line, legs: legs.map((l, i) => ({ book: l.book, name: l.name, point: G.market === 'h2h' ? null : l.point, dec: l.dec, label: label(ev, G.market, l.name, l.point), weight: a.stakes[i] / 100 })), marginPct: a.marginPct, sumImplied: a.sumImplied });
  }
  return out.sort((a, b) => b.marginPct - a.marginPct);
}
const maxOutcomes = (ev, mk) => Math.max(0, ...ev.books.map((b) => ((b.markets && b.markets[mk]) || []).length));

/** Middles across different lines (totals: Over L + Under H, H > L; spreads: home +a with away +b, a + b > 0). */
function middleOpportunities(ev, { maxCostPct = 3, books } = {}) {
  const q = quotes(ev, { markets: ['spreads', 'totals'], books }); const out = [];
  const overs = q.filter((x) => x.market === 'totals' && x.name === 'Over'), unders = q.filter((x) => x.market === 'totals' && x.name === 'Under');
  for (const o of overs) for (const u of unders) { if (o.book === u.book || !(u.point > o.point)) continue; const m = M.middle({ kind: 'totals', a: { point: o.point, dec: o.dec }, b: { point: u.point, dec: u.dec } }); if (m && -m.ifOneWins <= maxCostPct) out.push({ type: 'middle', eventId: ev.id, market: 'totals', legs: [o, u].map((x) => ({ ...x, label: label(ev, 'totals', x.name, x.point) })), ...m }); }
  const hs = q.filter((x) => x.market === 'spreads' && x.name === ev.home), as = q.filter((x) => x.market === 'spreads' && x.name === ev.away);
  for (const h of hs) for (const a of as) { if (h.book === a.book) continue; const m = M.middle({ kind: 'spreads', a: { point: h.point, dec: h.dec }, b: { point: a.point, dec: a.dec } }); if (m && -m.ifOneWins <= maxCostPct) out.push({ type: 'middle', eventId: ev.id, market: 'spreads', legs: [h, a].map((x) => ({ ...x, label: label(ev, 'spreads', x.name, x.point) })), ...m }); }
  const best = {}; for (const m of out) { const k = m.market + m.legs.map((l) => l.name + l.point).join(); if (!best[k] || m.ifOneWins > best[k].ifOneWins) best[k] = m; }
  return Object.values(best).sort((a, b) => b.width - a.width || b.ifOneWins - a.ifOneWins);
}

/**
 * Spread signal: a book hanging a better NUMBER than the consensus line (e.g. +4 when the market is +3).
 * The edge in probability per point is an ASSUMPTION (pointValuePct), not something the app estimates;
 * it differs by sport and around key numbers.
 */
function spreadSignals(ev, { minPointEdge = 1, pointValuePct = 2.5, minEdgePct = 1, minBooks = 3, method = 'multiplicative', books } = {}) {
  const homeLines = ev.books.filter((b) => !books || !books.length || books.includes(b.key)).flatMap((b) => bookMarkets(ev, b, ['spreads']).map((g) => g.line));
  if (homeLines.length < minBooks) return [];
  const cnt = {}; for (const l of homeLines) cnt[l] = (cnt[l] || 0) + 1; const top = Math.max(...Object.values(cnt));
  const cons = M.median(Object.keys(cnt).filter((k) => cnt[k] === top).map(Number)); const out = []; // consensus = most-quoted line
  for (const x of quotes(ev, { markets: ['spreads'], books })) {
    const consPt = x.name === ev.home ? cons : -cons, delta = x.point - consPt; if (delta < minPointEdge) continue;
    const f = fairProb(ev, 'spreads', x.name, consPt, { method, books }) || { prob: 0.5, books: 0 };
    const p = Math.min(0.95, f.prob + (delta * pointValuePct) / 100), e = M.ev(p, x.dec) * 100; if (e < minEdgePct) continue;
    out.push({ type: 'spread', eventId: ev.id, ...x, label: label(ev, 'spreads', x.name, x.point), consensusPoint: consPt, pointEdge: delta, fairProb: p, fairDec: 1 / p, evPct: e, assumption: `${pointValuePct}% win prob per point (assumed)` });
  }
  const best = {}; for (const o of out) if (!best[o.name] || o.evPct > best[o.name].evPct) best[o.name] = o;
  return Object.values(best);
}

/** Grade one bet against a final score. Returns 'won' | 'lost' | 'push'. */
function grade(bet, ev, score) {
  const { home, away } = score; if (!Number.isFinite(home) || !Number.isFinite(away)) throw new Error('bad score');
  if (bet.market === 'h2h') { if (home === away) return bet.name === 'Draw' ? 'won' : 'push'; const w = home > away ? ev.home : ev.away; return bet.name === w ? 'won' : 'lost'; }
  if (bet.market === 'spreads') { const m = (bet.name === ev.home ? home - away : away - home) + bet.point; return m > 0 ? 'won' : m < 0 ? 'lost' : 'push'; }
  if (bet.market === 'totals') { const d = home + away - bet.point; if (d === 0) return 'push'; return (bet.name === 'Over') === d > 0 ? 'won' : 'lost'; }
  throw new Error('unknown market');
}
const payout = (status, stake, dec) => (status === 'won' ? stake * (dec - 1) : status === 'lost' ? -stake : 0);

module.exports = { selKey, label, bookMarkets, fairProb, quotes, bestPrices, evOpportunities, arbOpportunities, middleOpportunities, spreadSignals, grade, payout };
