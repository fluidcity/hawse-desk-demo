'use strict';
// Strategy explainers: a plain-English "what it does" paragraph plus a compact rules list, generated from the
// same params objects the strategy logic reads, so the text cannot drift from the code. Shape (also used by the
// lab and betting explainers):
//   { what: string, rules: [{ k: 'Markets'|'Signal'|'Entry'|'Exit'|'Risk'|'Costs'|'Data', items: [string] }] }
// Never pass secrets in: callers build items from numeric/text params only (tests assert no secret leaks).
const ORDER = ['Markets', 'Signal', 'Entry', 'Exit', 'Risk', 'Costs', 'Data'];
const num = (x, d = 2) => { const n = Number(x); return Number.isFinite(n) ? String(+n.toFixed(d)) : '?'; };
const pct = (x, d = 2) => `${num(x, d)}%`;
const usd = (x) => { const n = Number(x); return Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '$?'; };
const list = (a) => (a && a.length ? a.join(', ') : 'none');
const hours = (h) => (h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${num(h, 1)} h`);
/** ET clock time for a minute offset from the 09:30 ET cash open. */
const etFromOpen = (m) => { const t = 9 * 60 + 30 + Number(m); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} ET`; };

function explanation(what, sections) {
  const rules = [];
  for (const k of ORDER) { const items = (sections[k] || []).filter(Boolean); if (items.length) rules.push({ k, items }); }
  for (const k of Object.keys(sections)) if (!ORDER.includes(k)) { const items = (sections[k] || []).filter(Boolean); if (items.length) rules.push({ k, items }); }
  return { what: String(what).replace(/\s+/g, ' ').trim(), rules };
}

/** Desk-wide risk lines every desk strategy shares: its paper sleeve and the engine's risk gate. */
function deskRisk(s) {
  const g = s.e.gates && s.e.gates.real;
  return [`Paper sleeve: ${pct(s.allocPct * 100, 1)} of the ${usd(s.e.cfg.paperStartEquity)} paper account (${usd(s.alloc)}) plus its realized PnL`,
    g ? `Desk risk gate: no new entries after a ${pct(g.dailyLossPct, 1)} day loss or a ${pct(g.maxDrawdownPct, 1)} drawdown, or while HALT is on` : null,
    'Paper only: fills are simulated against real quotes; no live order path exists'];
}

module.exports = { explanation, deskRisk, num, pct, usd, list, hours, etFromOpen, ORDER };
