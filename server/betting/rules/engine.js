'use strict';
// Rules engine: user-defined RULES (conditions over lines, upcoming games and player/team stats) are evaluated by the
// scanner against every selection of every upcoming game at its best available price. A match raises a SIGNAL for the
// user to review. Rules never place, stake or book anything.
//   Rule: { schema:'hawse.betRule/1', id, name, description, enabled, match:'all'|'any', cooldownMin,
//           conditions: [ { type, params, negate } ], notes, source:{type, note}, version, updatedAt }
const S = require('../scanner');
const M = require('../math');
const { consensusPoint } = require('../data/lines');
const { slug } = require('../util');

const FORBIDDEN = ['autoPlace', 'autoBet', 'placeOrders', 'live', 'execute', 'venue', 'orderSize'];
const DROPPED = ['performance', 'winRate', 'roi', 'record', 'results', 'pnl', 'units'];

/** Validate + normalise a rule. Returns { ok, rule, errors, warnings }. */
function validateRule(reg, input, { existing } = {}) {
  const errors = [], warnings = [];
  let r = input; if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return { ok: false, errors: ['invalid JSON: ' + e.message] }; } }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, errors: ['expected one rule object'] };
  if (r.schema && r.schema !== 'hawse.betRule/1') errors.push(`unsupported schema "${r.schema}" (expected hawse.betRule/1)`);
  for (const k of FORBIDDEN) if (r[k]) errors.push(`"${k}" is not supported: rules only raise signals for review; placing a bet is always manual (paper desk, no auto-placing)`);
  const dropped = DROPPED.filter((k) => k in r); if (dropped.length) warnings.push(`ignored fields (rules carry no performance claims): ${dropped.join(', ')}`);
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : ''; if (!name) errors.push('name is required');
  const match = r.match === undefined ? 'all' : r.match; if (!['all', 'any'].includes(match)) errors.push('match must be "all" or "any"');
  const cooldownMin = r.cooldownMin === undefined ? 30 : +r.cooldownMin; if (!Number.isFinite(cooldownMin) || cooldownMin < 0 || cooldownMin > 1440) errors.push('cooldownMin must be 0–1440');
  const conds = [];
  if (!Array.isArray(r.conditions) || !r.conditions.length) errors.push('conditions must be a non-empty list');
  else if (r.conditions.length > 16) errors.push('at most 16 conditions');
  else r.conditions.forEach((c, i) => { const x = reg.checkCondition(c, `condition ${i + 1}: `); errors.push(...x.errors); if (x.condition) conds.push(x.condition); });
  if (errors.length) return { ok: false, errors, warnings };
  const rule = { schema: 'hawse.betRule/1', id: (existing && existing.id) || (typeof r.id === 'string' && /^[a-z0-9-]{1,60}$/.test(r.id) ? r.id : 'rule-' + slug(name)), name,
    description: String(r.description || '').slice(0, 600), enabled: r.enabled !== false, match, cooldownMin, conditions: conds, notes: String(r.notes || '').slice(0, 1000),
    source: r.source && typeof r.source === 'object' ? { type: String(r.source.type || 'manual').slice(0, 40), note: r.source.note ? String(r.source.note).slice(0, 400) : undefined } : { type: 'manual' } };
  return { ok: true, rule, errors: [], warnings };
}

/** One candidate per selection of an event (at its best price), with everything conditions may read. */
function candidates(ev, { now, lines, stats, method = 'multiplicative' }) {
  const out = [], best = S.bestPrices(ev), cache = new Map();
  const statsFn = (team) => { if (!stats || !team) return null; if (!cache.has(team)) cache.set(team, stats.teamInfo(ev.sport, team, now)); return cache.get(team); };
  for (const b of Object.values(best)) {
    const team = b.market === 'totals' ? null : b.name, opponent = team ? (team === ev.home ? ev.away : ev.home) : null;
    const fairEx = S.fairProb(ev, b.market, b.name, b.point, { exclude: b.book, method }), fairAll = S.fairProb(ev, b.market, b.name, b.point, { method });
    out.push({ ev, sport: ev.sport, market: b.market, name: b.name, point: b.point, team, opponent, isHome: team ? team === ev.home : null,
      side: b.market === 'totals' ? b.name.toLowerCase() : team === ev.home ? 'home' : 'away', best: { book: b.book, dec: b.dec }, fairEx, fairAll, books: fairAll ? fairAll.books : 0,
      consPoint: consensusPoint(ev, b.market, b.name), minutesToStart: (ev.commence - now) / 60e3, move: lines ? lines.move(ev.id, b.market, b.name) : null, stats: statsFn, statsMode: stats ? stats.mode : 'none' });
  }
  return out;
}

/** Evaluate a rule on one candidate → null | { results, simulatedBy } */
function evaluateRule(reg, rule, ctx) {
  const results = rule.conditions.map((c) => ({ type: c.type, negate: c.negate, ...reg.evaluate(c, ctx) }));
  const hit = rule.match === 'any' ? results.some((x) => x.ok) : results.every((x) => x.ok);
  return hit ? { results, simulatedBy: results.filter((x) => x.ok && x.simulated).map((x) => x.type) } : null;
}

function signalFrom(rule, ctx, m, { now, oddsSimulated }) {
  const evPct = ctx.fairEx ? M.ev(ctx.fairEx.prob, ctx.best.dec) * 100 : null, fair = ctx.fairEx || ctx.fairAll;
  const simReasons = [...(oddsSimulated ? ['odds feed is MOCK'] : []), ...m.simulatedBy.map((t) => `${t} used MOCK stats`)];
  return { key: `${rule.id}|${ctx.ev.id}|${ctx.market}|${ctx.name}`, ruleId: rule.id, ruleName: rule.name, ruleVersion: rule.version || 1,
    eventId: ctx.ev.id, sport: ctx.sport, event: `${ctx.ev.away} @ ${ctx.ev.home}`, home: ctx.ev.home, away: ctx.ev.away, commence: ctx.ev.commence,
    market: ctx.market, name: ctx.name, point: ctx.point, label: S.label(ctx.ev, ctx.market, ctx.name, ctx.point), book: ctx.best.book, dec: ctx.best.dec,
    fairProb: fair ? fair.prob : null, fairBooks: fair ? fair.books : 0, evPct, matched: m.results.filter((x) => x.ok).map((x) => ({ type: x.type, detail: x.detail })),
    simulated: simReasons.length > 0, simReasons, seenAt: now };
}

/** Scan events with every enabled rule. Returns signal drafts (best candidate per rule/event/market/side). */
function scan(reg, rules, events, { now = Date.now(), lines, stats, method, oddsSimulated = false } = {}) {
  const drafts = new Map();
  for (const ev of events) {
    if (!(ev.commence > now)) continue; // upcoming games only
    const cs = candidates(ev, { now, lines, stats, method });
    for (const rule of rules) {
      if (!rule.enabled) continue;
      for (const c of cs) {
        const m = evaluateRule(reg, rule, c); if (!m) continue;
        const s = signalFrom(rule, c, m, { now, oddsSimulated }), prev = drafts.get(s.key);
        if (!prev || (s.evPct ?? -1e9) > (prev.evPct ?? -1e9)) drafts.set(s.key, s);
      }
    }
  }
  return [...drafts.values()];
}

module.exports = { validateRule, candidates, evaluateRule, scan, FORBIDDEN };
