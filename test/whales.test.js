'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../server/feeds/whales');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL = 'So11111111111111111111111111111111111111112';

test('solana: stable out + SOL in = buy sized by stables', () => {
  const c = W.classifySolanaTx({ type: 'SWAP', feePayer: 'U', tokenTransfers: [{ mint: USDC, fromUserAccount: 'U', toUserAccount: 'P', tokenAmount: 500000 }, { mint: SOL, fromUserAccount: 'P', toUserAccount: 'U', tokenAmount: 3300 }] }, 150);
  assert.deepEqual(c, { dir: 'buy', usd: 500000, asset: 'SOL' });
});
test('solana: SOL out + stable in = sell', () => {
  const c = W.classifySolanaTx({ type: 'SWAP', feePayer: 'U', tokenTransfers: [{ mint: SOL, fromUserAccount: 'U', toUserAccount: 'P', tokenAmount: 1000 }, { mint: USDC, fromUserAccount: 'P', toUserAccount: 'U', tokenAmount: 149000 }] }, 150);
  assert.equal(c.dir, 'sell'); assert.equal(c.usd, 149000);
});
test('solana: plain native transfer is non-directional and ignores dust', () => {
  const c = W.classifySolanaTx({ type: 'TRANSFER', feePayer: 'U', nativeTransfers: [{ fromUserAccount: 'U', toUserAccount: 'X', amount: 2000e9 }, { fromUserAccount: 'U', toUserAccount: 'Y', amount: 5000 }] }, 100);
  assert.equal(c.dir, 'transfer'); assert.equal(c.usd, 200000);
});
test('uniswap v3 swap decode: pool receives USDC => trader bought ETH', () => {
  const enc = (v) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
  const data = '0x' + enc(250000n * 10n ** 6n) + enc(-(100n * 10n ** 18n)) + '0'.repeat(64 * 3);
  const s = W.decodeV3Swap(data, true);
  assert.equal(s.dir, 'buy'); assert.equal(s.stableUsd, 250000); assert.equal(s.eth, 100);
  const s2 = W.decodeV3Swap('0x' + enc(-(5n * 10n ** 18n)) + enc(12000n * 10n ** 6n), false); // token0 = WETH
  assert.equal(s2.dir, 'buy'); assert.equal(s2.stableUsd, 12000);
});
test('rpc resolution priority and key never in label', () => {
  const base = { rpc: { ethereum: '', base: '', arbitrum: '' }, alchemyKey: '', infuraKey: '', publicFallback: false };
  assert.equal(W.resolveRpc('base', base), null);
  assert.match(W.resolveRpc('base', { ...base, publicFallback: true }).url, /publicnode/);
  const a = W.resolveRpc('arbitrum', { ...base, alchemyKey: 'SECRETKEY123', infuraKey: 'x' });
  assert.equal(a.source, 'Alchemy'); assert.ok(a.url.includes('arb-mainnet')); assert.ok(!a.source.includes('SECRET'));
  assert.equal(W.resolveRpc('ethereum', { ...base, rpc: { ...base.rpc, ethereum: 'https://my' }, alchemyKey: 'k' }).source, 'custom RPC (env)');
});
