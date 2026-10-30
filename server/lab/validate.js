'use strict';
// Zero-dependency validator for the subset of JSON Schema used by schema/strategy.schema.json:
// type, const, enum, required, properties, additionalProperties:false, items, minItems, maxItems, minimum, maximum,
// exclusiveMinimum, minLength, maxLength, pattern, allOf, if/then, local $ref. Unknown keywords are rejected at load
// time so the schema cannot silently drift beyond what is enforced.
const fs = require('fs');
const path = require('path');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'strategy.schema.json'), 'utf8'));
const KNOWN = new Set(['$schema', '$id', 'title', 'description', '$defs', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength', 'pattern', 'allOf', 'if', 'then', '$ref']);
(function check(s, at) {
  if (!s || typeof s !== 'object') return;
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema keyword "${k}" at ${at} is not supported by validate.js`);
  for (const k of ['items', 'if', 'then']) if (s[k]) check(s[k], at + '/' + k);
  for (const k of ['properties', '$defs']) if (s[k]) for (const [n, v] of Object.entries(s[k])) check(v, `${at}/${k}/${n}`);
  if (s.allOf) s.allOf.forEach((v, i) => check(v, `${at}/allOf/${i}`));
})(SCHEMA, '#');

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const resolve = (ref) => ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], SCHEMA);

function walk(s, v, at, errs) {
  if (s.$ref) s = resolve(s.$ref);
  const t = typeOf(v);
  if (s.type && !(s.type === t || (s.type === 'number' && t === 'integer'))) { errs.push(`${at}: expected ${s.type}, got ${t}`); return; }
  if ('const' in s && v !== s.const) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: must be one of ${s.enum.join(', ')}`);
  if (t === 'integer' || t === 'number') {
    if (s.minimum != null && v < s.minimum) errs.push(`${at}: must be ≥ ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) errs.push(`${at}: must be ≤ ${s.maximum}`);
    if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) errs.push(`${at}: must be > ${s.exclusiveMinimum}`);
    if (!Number.isFinite(v)) errs.push(`${at}: must be finite`);
  }
  if (t === 'string') {
    if (s.minLength != null && v.length < s.minLength) errs.push(`${at}: too short`);
    if (s.maxLength != null && v.length > s.maxLength) errs.push(`${at}: too long (max ${s.maxLength})`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${at}: does not match ${s.pattern}`);
  }
  if (t === 'array') {
    if (s.minItems != null && v.length < s.minItems) errs.push(`${at}: needs ≥ ${s.minItems} items`);
    if (s.maxItems != null && v.length > s.maxItems) errs.push(`${at}: max ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => walk(s.items, x, `${at}[${i}]`, errs));
  }
  if (t === 'object') {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}: missing required "${r}"`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && s.properties[k]) walk(s.properties[k], x, `${at}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${at}: unknown field "${k}"`);
    }
  }
  for (const sub of s.allOf || []) {
    if (sub.if) { const e = []; walk(sub.if, v, at, e); if (!e.length && sub.then) walk(sub.then, v, at, errs); } else walk(sub, v, at, errs);
  }
}
function validate(cfg) { const errs = []; walk(SCHEMA, cfg, '$', errs); return { ok: errs.length === 0, errors: errs }; }
module.exports = { validate, SCHEMA };
