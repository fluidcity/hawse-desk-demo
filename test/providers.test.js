'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { describe, ENTRIES } = require('../server/providers');
const { Health } = require('../server/lib/health');

test('registry entries are well formed (id, signup URL, unlocks)', () => {
  const ids = new Set();
  for (const e of ENTRIES) {
    assert.ok(e.id && !ids.has(e.id), 'unique id ' + e.id); ids.add(e.id);
    assert.match(e.signup, /^https:\/\//); assert.ok(Array.isArray(e.unlocks) && e.unlocks.length);
    if (e.adapter) assert.doesNotThrow(() => require('../server/providers/adapters/' + e.adapter));
  }
});

test('describe() exposes env var names + set flag, never values', () => {
  const env = { HELIUS_API_KEY: 'super-secret-helius-value', HAWSE_READ_TOKEN: 'inbox-read-secret-abc', HAWSE_WEBHOOK_URL: 'https://inbox-secret-host.example.dev', KAIKO_API_KEY: 'kaiko-secret-xyz' };
  const out = ENTRIES.map((e) => describe(e, env, [], null));
  const json = JSON.stringify(out);
  for (const v of ['super-secret-helius-value', 'kaiko-secret-xyz', 'inbox-read-secret-abc', 'inbox-secret-host']) assert.ok(!json.includes(v), v);
  const hel = out.find((p) => p.id === 'helius');
  assert.deepStrictEqual(hel.env.find((v) => v.name === 'HELIUS_API_KEY'), { name: 'HELIUS_API_KEY', required: false, set: true }, 'only the admin script + auto-pause need the key; the desk reads the inbox');
  assert.deepStrictEqual(hel.env.find((v) => v.name === 'HAWSE_READ_TOKEN'), { name: 'HAWSE_READ_TOKEN', required: true, set: true });
  assert.strictEqual(describe(ENTRIES.find((e) => e.id === 'helius'), { HELIUS_API_KEY: 'k' }, [], null).status, 'missing key', 'inbox URL/token missing');
  assert.strictEqual(out.find((p) => p.id === 'kaiko').status, 'not implemented');
  assert.strictEqual(out.find((p) => p.id === 'amberdata').status, 'missing key');
});

test('status derives from health rows: live, stale, mocked (missing key)', () => {
  const h = new Health();
  h.register('ws.okx', { label: 'x', transport: 'ws', staleMs: 1000 }); h.ok('ws.okx', 12);
  const okx = ENTRIES.find((e) => e.id === 'okx');
  assert.strictEqual(describe(okx, {}, h.list()).status, 'live');
  assert.strictEqual(describe(okx, {}, h.list()).latencyMs, 12);
  assert.strictEqual(describe(okx, {}, h.list(Date.now() + 5000)).status, 'stale');
  h.register('whale.solana', { label: 'y', kind: 'mock' }); h.ok('whale.solana', 0); h.setKind && h.setKind('whale.solana', 'mock');
  const rows = h.list().map((r) => (r.id === 'whale.solana' ? { ...r, status: 'mock' } : r));
  assert.strictEqual(describe(ENTRIES.find((e) => e.id === 'helius'), {}, rows).status, 'mocked (missing key)');
});

test('QuickNode entry is anyOf: one endpoint URL is enough', () => {
  const q = ENTRIES.find((e) => e.id === 'quicknode');
  assert.notStrictEqual(describe(q, { EVM_RPC_URL_BASE: 'https://example.invalid/abc' }, []).status, 'missing key');
  assert.strictEqual(describe(q, {}, []).status, 'missing key');
});
