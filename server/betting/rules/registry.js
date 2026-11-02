'use strict';
// Signal-type registry. Built-in condition types (types.js) plus CUSTOM types that are pure DATA: a named composition of
// existing types with "$param" placeholders. No code is ever imported, so a signal-type pack (e.g. extracted from
// ReelRipper transcripts) is safe to load:
//   { schema: 'hawse.signalTypes/1', source: { type: 'reelripper', note }, types: [
//       { id: 'fade_b2b_road_dog', label, description, scope,
//         params: { side: { type: 'enum', values: ['favorite','underdog'], default: 'underdog' } },
//         conditions: [ { type: 'back_to_back', params: { team: 'opponent' } }, { type: 'side_is', params: { side: '$side' } } ] } ] }
const { BUILTIN } = require('./types');

const ID_RE = /^[a-z][a-z0-9_.-]{1,47}$/;
const PARAM_TYPES = new Set(['number', 'integer', 'string', 'enum', 'list', 'bool']);
const MAX_DEPTH = 4;

/** Coerce + validate one params object against a spec. Returns { params, errors }. */
function checkParams(spec, given = {}, at = '') {
  const errors = [], out = {};
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return { params: {}, errors: [`${at}params must be an object`] };
  for (const k of Object.keys(given)) if (!spec[k]) errors.push(`${at}unknown param "${k}" (allowed: ${Object.keys(spec).join(', ') || 'none'})`);
  for (const [k, s] of Object.entries(spec)) {
    let v = given[k];
    if (v === undefined) { if (s.required) errors.push(`${at}param "${k}" is required`); else if (s.default !== undefined) out[k] = s.default; continue; }
    if (typeof v === 'string' && v.startsWith('$')) { out[k] = v; continue; } // placeholder inside a custom type definition
    if (s.type === 'number' || s.type === 'integer') {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) v = +v;
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${at}param "${k}" must be a number`); continue; }
      if (s.type === 'integer' && !Number.isInteger(v)) { errors.push(`${at}param "${k}" must be an integer`); continue; }
      if (s.min != null && v < s.min) errors.push(`${at}param "${k}" must be ≥ ${s.min}`);
      if (s.max != null && v > s.max) errors.push(`${at}param "${k}" must be ≤ ${s.max}`);
    } else if (s.type === 'bool') { if (typeof v !== 'boolean') { errors.push(`${at}param "${k}" must be true/false`); continue; } }
    else if (s.type === 'enum') { if (!s.values.includes(v)) { errors.push(`${at}param "${k}" must be one of ${s.values.join('|')}`); continue; } }
    else if (s.type === 'list') {
      if (typeof v === 'string') v = v.split(',').map((x) => x.trim()).filter(Boolean);
      if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) { errors.push(`${at}param "${k}" must be a non-empty list`); continue; }
      v = v.map(String); if (s.values) for (const x of v) if (!s.values.includes(x)) errors.push(`${at}param "${k}": "${x}" not in ${s.values.join('|')}`);
    } else if (typeof v !== 'string' || !v.trim() || v.length > 80) { errors.push(`${at}param "${k}" must be a short string`); continue; }
    out[k] = v;
  }
  return { params: out, errors };
}

class SignalTypeRegistry {
  constructor() { this.types = new Map(); for (const t of BUILTIN) this.types.set(t.id, { ...t, builtin: true }); }
  has(id) { return this.types.has(id); }
  get(id) { return this.types.get(id); }
  list() { return [...this.types.values()]; }
  /** JSON-safe description (no evaluator functions) for the UI and for authors of signal-type packs. */
  describe() { return this.list().map((t) => ({ id: t.id, label: t.label, scope: t.scope, needs: t.needs, description: t.description, params: t.params, builtin: !!t.builtin, conditions: t.conditions, source: t.source })); }

  /** Validate a custom type definition (does not register). */
  checkCustom(def, seen = new Set()) {
    const errors = [];
    if (!def || typeof def !== 'object') return ['type must be an object'];
    if (!ID_RE.test(def.id || '')) errors.push(`type id "${def.id}" must match ${ID_RE}`);
    else if (this.types.get(def.id) && this.types.get(def.id).builtin) errors.push(`type id "${def.id}" is a built-in and cannot be replaced`);
    if (!def.label || typeof def.label !== 'string') errors.push(`type ${def.id}: label required`);
    const params = def.params || {};
    for (const [k, s] of Object.entries(params)) { if (!s || !PARAM_TYPES.has(s.type)) errors.push(`type ${def.id}: param "${k}" needs a type in ${[...PARAM_TYPES].join('|')}`); if (s && s.type === 'enum' && !(Array.isArray(s.values) && s.values.length)) errors.push(`type ${def.id}: enum param "${k}" needs values`); }
    if (!Array.isArray(def.conditions) || !def.conditions.length || def.conditions.length > 12) errors.push(`type ${def.id}: conditions must be a list of 1–12 conditions`);
    else for (const [i, c] of def.conditions.entries()) {
      const t = c && this.types.get(c.type);
      if (!t) { errors.push(`type ${def.id}: condition ${i + 1} uses unknown type "${c && c.type}"`); continue; }
      if (c.type === def.id || seen.has(c.type)) { errors.push(`type ${def.id}: recursive reference to "${c.type}"`); continue; }
      const r = checkParams(t.params, c.params || {}, `type ${def.id} condition ${i + 1} (${c.type}): `); errors.push(...r.errors);
      for (const v of Object.values(c.params || {})) if (typeof v === 'string' && v.startsWith('$') && !params[v.slice(1)]) errors.push(`type ${def.id}: placeholder ${v} has no matching param`);
    }
    return errors;
  }
  addCustom(def, source) {
    const errors = this.checkCustom(def); if (errors.length) return { ok: false, errors };
    const t = { id: def.id, label: String(def.label).slice(0, 80), description: String(def.description || '').slice(0, 600), scope: def.scope || 'line', params: def.params || {}, conditions: def.conditions.map((c) => ({ type: c.type, params: c.params || {}, negate: !!c.negate })), builtin: false, source: source || def.source || { type: 'import' } };
    t.needs = [...new Set(t.conditions.flatMap((c) => this.types.get(c.type).needs))];
    this.types.set(t.id, t); return { ok: true, type: t };
  }
  removeCustom(id) { const t = this.types.get(id); if (!t || t.builtin) return false; return this.types.delete(id); }
  /** Import a pack { schema:'hawse.signalTypes/1', types:[...] }. Types are added in order so later ones can use earlier ones. */
  importPack(pack) {
    if (!pack || pack.schema !== 'hawse.signalTypes/1' || !Array.isArray(pack.types)) return { ok: false, errors: ['expected { schema: "hawse.signalTypes/1", types: [...] }'] };
    const added = [], errors = [], src = { type: (pack.source && pack.source.type) || 'import', note: pack.source && pack.source.note ? String(pack.source.note).slice(0, 400) : undefined };
    for (const d of pack.types) { const r = this.addCustom(d, src); if (r.ok) added.push(r.type.id); else errors.push(...r.errors); }
    return { ok: errors.length === 0, added, errors };
  }
  exportPack() { return { schema: 'hawse.signalTypes/1', types: this.list().filter((t) => !t.builtin).map(({ id, label, description, scope, params, conditions, source }) => ({ id, label, description, scope, params, conditions, source })) }; }

  /** Validate a condition {type, params, negate} → {condition, errors}. */
  checkCondition(c, at = '') {
    const t = c && this.types.get(c.type); if (!t) return { errors: [`${at}unknown condition type "${c && c.type}" (see GET /api/betting/registry)`] };
    const r = checkParams(t.params, c.params || {}, `${at}${c.type}: `);
    return { condition: { type: c.type, params: r.params, negate: !!c.negate }, errors: r.errors };
  }
  /** Evaluate one condition on a candidate. Custom types expand recursively (AND of their conditions). */
  evaluate(c, ctx, depth = 0) {
    const t = this.types.get(c.type); if (!t) return { ok: false, unknown: true, detail: `unknown type ${c.type}` };
    let r;
    if (t.builtin) r = t.evaluate(ctx, c.params);
    else {
      if (depth >= MAX_DEPTH) return { ok: false, unknown: true, detail: 'custom type nesting too deep' };
      const sub = t.conditions.map((x) => { const p = {}; for (const [k, v] of Object.entries(x.params)) p[k] = typeof v === 'string' && v.startsWith('$') ? c.params[v.slice(1)] : v; return this.evaluate({ ...x, params: this.checkCondition({ type: x.type, params: p }).condition.params }, ctx, depth + 1); });
      r = { ok: sub.every((x) => x.ok), unknown: sub.some((x) => x.unknown), detail: sub.map((x) => x.detail).join('; '), simulated: sub.some((x) => x.simulated) };
    }
    return c.negate ? { ...r, ok: !r.ok && !r.unknown, detail: 'NOT ' + r.detail } : r;
  }
}

module.exports = { SignalTypeRegistry, checkParams };
