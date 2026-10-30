'use strict';
// H4 calldata decoders against hand-encoded ABI calldata (one test per selector family).
const test = require('node:test');
const assert = require('node:assert');
const { decodeTx, decodeData, v3Path, CONTRACT_BALANCE } = require('../server/mev/decode');

const W = (x) => BigInt(x).toString(16).padStart(64, '0');
const A = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
// Tiny ABI encoder: items are {s: staticWord} or {d: dynamicTailHex}; returns head+tail.
function enc(items) {
  let head = '', tail = ''; const headLen = items.length * 32;
  for (const it of items) { if (it.s !== undefined) head += it.s; else { head += W(headLen + tail.length / 2); tail += it.d; } }
  return head + tail;
}
const addrArr = (xs) => W(xs.length) + xs.map(A).join('');
const bytes = (h) => { h = h.replace(/^0x/, ''); const pad = h.length % 64 ? '0'.repeat(64 - (h.length % 64)) : ''; return W(h.length / 2) + h + pad; };
const bytesArr = (xs) => { let heads = '', tails = ''; for (const x of xs) { heads += W(xs.length * 32 + tails.length / 2); tails += bytes(x); } return W(xs.length) + heads + tails; };

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const ME = '0x1111111111111111111111111111111111111111';
const V2R = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', SR02 = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', UR = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad';
const path3 = (fee) => WETH.slice(2) + fee.toString(16).padStart(6, '0') + USDC.slice(2);

test('V2 Router02 swapExactTokensForTokens (38ed1739) and fee-on-transfer flag (5c11d795)', () => {
  const args = enc([{ s: W(10n ** 21n) }, { s: W(2500n * 10n ** 6n) }, { d: addrArr([WETH, USDC]) }, { s: A(ME) }, { s: W(9999999999) }]);
  const d = decodeTx({ to: V2R, input: '0x38ed1739' + args });
  assert.equal(d.router, 'UniswapV2Router02'); assert.equal(d.v, 'v2'); assert.equal(d.exactIn, true); assert.equal(d.hops, 1);
  assert.equal(d.amountIn, 10n ** 21n); assert.equal(d.amountOutMin, 2500000000n); assert.equal(d.tokenIn, WETH.toLowerCase()); assert.equal(d.tokenOut, USDC.toLowerCase());
  assert.equal(decodeTx({ to: V2R, input: '0x5c11d795' + args }).feeOnTransfer, true);
});
test('V2 swapExactETHForTokens (7ff36ab5) takes amountIn from tx.value; multihop counted', () => {
  const args = enc([{ s: W(1) }, { d: addrArr([WETH, USDC, DAI]) }, { s: A(ME) }, { s: W(1) }]);
  const d = decodeTx({ to: V2R, input: '0x7ff36ab5' + args, value: '0x' + (5n * 10n ** 18n).toString(16) });
  assert.equal(d.amountIn, 5n * 10n ** 18n); assert.equal(d.hops, 2); assert.equal(d.tokenOut, DAI.toLowerCase());
});
test('V2 exact-out (8803dbee) is decoded and flagged exactIn=false', () => {
  const args = enc([{ s: W(100) }, { s: W(200) }, { d: addrArr([USDC, WETH]) }, { s: A(ME) }, { s: W(1) }]);
  const d = decodeTx({ to: V2R, input: '0x8803dbee' + args }); assert.equal(d.exactIn, false);
});
test('SwapRouter02 exactInputSingle (04e45aaf) static struct', () => {
  const args = W(0).slice(0, 0) + A(USDC) + A(WETH) + W(500) + A(ME) + W(50000n * 10n ** 6n) + W(19n * 10n ** 18n) + W(0);
  const d = decodeTx({ to: SR02, input: '0x04e45aaf' + args });
  assert.equal(d.v, 'v3'); assert.deepEqual(d.fees, [500]); assert.equal(d.amountIn, 50000000000n); assert.equal(d.tokenIn, USDC.toLowerCase()); assert.equal(d.hops, 1);
});
test('SwapRouter02 exactInput (b858183f) with packed path, and via multicall (5ae401dc)', () => {
  const tuple = enc([{ d: bytes(path3(3000)) }, { s: A(ME) }, { s: W(7n * 10n ** 18n) }, { s: W(1) }]);
  const call = 'b858183f' + W(32) + tuple;
  const d = decodeTx({ to: SR02, input: '0x' + call });
  assert.equal(d.fn, 'exactInput'); assert.deepEqual(d.fees, [3000]); assert.equal(d.amountIn, 7n * 10n ** 18n); assert.equal(d.tokenOut, USDC.toLowerCase());
  const m = decodeTx({ to: SR02, input: '0x5ae401dc' + enc([{ s: W(1) }, { d: bytesArr([call]) }]) });
  assert.equal(m.wrapped, 'multicall'); assert.equal(m.amountIn, 7n * 10n ** 18n);
});
test('Universal Router execute (3593564c): V3_SWAP_EXACT_IN after WRAP_ETH, CONTRACT_BALANCE → tx.value', () => {
  const wrap = A(ME) + W(1); // WRAP_ETH(recipient, amountMin) (skipped by the decoder)
  const v3in = enc([{ s: A(ME) }, { s: W(CONTRACT_BALANCE) }, { s: W(123) }, { d: bytes(path3(500)) }, { s: W(0) }]);
  const data = enc([{ d: bytes('0b00') }, { d: bytesArr([wrap, v3in]) }, { s: W(9999999999) }]);
  const d = decodeTx({ to: UR, input: '0x3593564c' + data, value: '0x' + (3n * 10n ** 18n).toString(16) });
  assert.equal(d.fn, 'UR.V3_SWAP_EXACT_IN'); assert.equal(d.amountIn, 3n * 10n ** 18n); assert.equal(d.amountOutMin, 123n); assert.deepEqual(d.fees, [500]);
});
test('Universal Router V2_SWAP_EXACT_IN (0x08) and V4 (0x10) flagged unsupported; non-router and junk → null/undecoded', () => {
  const v2in = enc([{ s: A(ME) }, { s: W(1000) }, { s: W(900) }, { d: addrArr([USDC, WETH]) }, { s: W(1) }]);
  const d = decodeTx({ to: UR, input: '0x24856bc3' + enc([{ d: bytes('08') }, { d: bytesArr([v2in]) }]) });
  assert.equal(d.fn, 'UR.V2_SWAP_EXACT_IN'); assert.equal(d.amountIn, 1000n);
  const v4 = decodeTx({ to: UR, input: '0x24856bc3' + enc([{ d: bytes('10') }, { d: bytesArr(['00']) }]) }); assert.ok(v4.unsupported);
  assert.equal(decodeTx({ to: ME, input: '0x38ed1739' }), null);
  assert.equal(decodeTx({ to: V2R, input: '0xdeadbeef' }).undecoded, true);
  assert.equal(decodeData('0x38ed1739zz'), null);
});
test('v3Path parses multi-hop packed paths', () => {
  const p = v3Path(path3(500) + '000bb8' + DAI.slice(2).toLowerCase());
  assert.equal(p.tokens.length, 3); assert.deepEqual(p.fees, [500, 3000]);
});
