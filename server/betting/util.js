'use strict';
// Tiny helpers kept inside the betting module so it has no imports from the rest of HAWSE.
const redact = (s) => String(s).replace(/(api[-_]?key|apikey|key)=([^&\s]+)/gi, '$1=***');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
const clone = (o) => JSON.parse(JSON.stringify(o));
/** Deterministic 32-bit hash → [0,1). Used by the MOCK stats provider so mock data is stable per team/day. */
function hash01(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1e6) / 1e6; }
module.exports = { redact, slug, clone, hash01 };
