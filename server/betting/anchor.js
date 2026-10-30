'use strict';
// H1: Pinnacle-anchored fair prices. Pure (no I/O). Pinnacle takes large sharp limits, so its de-vigged line is the best
// free estimate of the true probability. We use it instead of the soft-book consensus when it quotes the exact market+line.
const M = require('./math');
const S = require('./scanner');

const MOCK_ANCHOR = 'mock_sharp'; // the mock feed's Pinnacle-like book (low vig, low noise); MOCK only

/** Age in seconds of a book's market (market last_update if present, else the book's). */
function marketAgeSec(book, market, now) {
  const t = (book.marketUpdates && book.marketUpdates[market]) || book.lastUpdate;
  return t ? Math.max(0, (now - t) / 1000) : null;
}

/**
 * Fair probabilities for one market+line from the anchor book alone.
 * Requires the anchor to quote EVERY side at the SAME line (no point shading).
 * Returns { probs:[{name, point, prob, fairDec}], overround, ageSec, cross:{probs} (multiplicative cross-check), book } or null.
 */
function pinnacleFair(ev, market, line, { anchor = 'pinnacle', method = 'power', now = Date.now() } = {}) {
  const b = (ev.books || []).find((x) => x.key === anchor); if (!b) return null;
  const g = S.bookMarkets(ev, b, [market]).find((x) => x.line === line); if (!g) return null;
  const nv = M.noVig(g.outcomes.map((o) => o.dec), method), mult = M.noVig(g.outcomes.map((o) => o.dec), 'multiplicative');
  return { book: anchor, market, line, overround: nv.overround, ageSec: marketAgeSec(b, market, now),
    probs: g.outcomes.map((o, i) => ({ name: o.name, point: o.point ?? null, prob: nv.probs[i], fairDec: 1 / nv.probs[i] })), cross: { probs: mult.probs } };
}

/** The fair-prob entry for one selection, or null. */
function selectionFair(fair, name, point) {
  if (!fair) return null; return fair.probs.find((p) => p.name === name && (fair.market === 'h2h' || p.point === point)) || null;
}
/** Line key bookMarkets() uses for a selection (spreads: the HOME point). */
const lineOf = (ev, market, name, point) => (market === 'spreads' ? (name === ev.home ? point : -point) : market === 'totals' ? point : '');

/** Minimum EV% for a price: h2h vs spreads/totals, and a higher bar for longshots. */
function minEdgeFor(market, dec, g) { return dec > g.longshotDec ? g.minEdgeLongshotPct : market === 'h2h' ? g.minEdgePct : g.minEdgeSpreadsPct; }

/**
 * Anchored +EV candidates for one event. Every candidate carries the gate results, so the strategy can log named skips.
 * gates: { anchor, method, minEdgePct, minEdgeSpreadsPct, minEdgeLongshotPct, longshotDec, maxPriceAgeSec, maxAgeGapSec,
 *          maxHoldPct, minMinutes, maxHours, maxDecimalOdds, markets, books }
 * Returns { cands:[...], skips:[{reason, detail}] }; cands sorted by evPct. A candidate is { ok, reason?, ...fields }.
 */
function anchoredOpportunities(ev, g, now = Date.now()) {
  const skips = [], cands = [], mins = (ev.commence - now) / 60e3;
  const name = `${ev.away} @ ${ev.home}`;
  if (mins < g.minMinutes) return { cands, skips: [{ reason: 'too close to start', detail: `${name} starts in ${mins.toFixed(0)} min < ${g.minMinutes}` }] };
  if (mins > g.maxHours * 60) return { cands, skips: [{ reason: 'too far from start', detail: `${name} starts in ${(mins / 60).toFixed(1)} h > ${g.maxHours} h` }] };
  if (!(ev.books || []).some((b) => b.key === g.anchor)) return { cands, skips: [{ reason: 'no anchor book', detail: `${g.anchor} has no prices for ${name}` }] };
  const fairCache = {};
  for (const x of S.quotes(ev, { markets: g.markets, books: g.books })) {
    if (x.book === g.anchor || x.dec > g.maxDecimalOdds) continue;
    const line = lineOf(ev, x.market, x.name, x.point), fk = x.market + '|' + line;
    const fair = fk in fairCache ? fairCache[fk] : (fairCache[fk] = pinnacleFair(ev, x.market, line, { anchor: g.anchor, method: g.method, now }));
    const sel = selectionFair(fair, x.name, x.point);
    const base = { type: 'ev', anchor: g.anchor, eventId: ev.id, ...x, label: S.label(ev, x.market, x.name, x.point) };
    if (!sel) { cands.push({ ...base, ok: false, reason: `anchor has no ${x.market} price at this line` }); continue; }
    const book = ev.books.find((b) => b.key === x.book), softAge = marketAgeSec(book, x.market, now), pinAge = fair.ageSec;
    const evPct = (sel.prob * x.dec - 1) * 100, need = minEdgeFor(x.market, x.dec, g);
    const c = { ...base, fairProb: sel.prob, pFair: sel.prob, fairDec: sel.fairDec, evPct, needPct: need, holdPct: fair.overround * 100, priceAgeSec: softAge, anchorAgeSec: pinAge,
      crossProb: fair.cross.probs[fair.probs.indexOf(sel)], ok: true };
    if (fair.overround * 100 > g.maxHoldPct) Object.assign(c, { ok: false, reason: `anchor hold ${(fair.overround * 100).toFixed(1)}% > ${g.maxHoldPct}%` });
    else if (softAge == null || pinAge == null || softAge > g.maxPriceAgeSec || pinAge > g.maxPriceAgeSec) Object.assign(c, { ok: false, reason: `stale price (book ${softAge == null ? '?' : softAge.toFixed(0)} s, anchor ${pinAge == null ? '?' : pinAge.toFixed(0)} s > ${g.maxPriceAgeSec} s)` });
    else if (Math.abs(softAge - pinAge) > g.maxAgeGapSec) Object.assign(c, { ok: false, reason: `book and anchor ${Math.abs(softAge - pinAge).toFixed(0)} s apart > ${g.maxAgeGapSec} s` });
    else if (evPct < need) Object.assign(c, { ok: false, reason: `EV ${evPct.toFixed(2)}% < ${need}%` });
    cands.push(c);
  }
  // best book per selection (prefer passing candidates)
  const best = {}; for (const c of cands) { const k = S.selKey(c.market, c.name, c.point); const b = best[k]; if (!b || (c.ok && !b.ok) || (c.ok === b.ok && c.evPct > b.evPct)) best[k] = c; }
  return { cands: Object.values(best).sort((a, b) => (b.ok - a.ok) || ((b.evPct ?? -1e9) - (a.evPct ?? -1e9))), skips };
}

module.exports = { pinnacleFair, selectionFair, anchoredOpportunities, minEdgeFor, marketAgeSec, lineOf, MOCK_ANCHOR };
