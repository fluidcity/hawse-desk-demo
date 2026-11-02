'use strict';
// Calldata decoders for public Uniswap swaps seen in the Ethereum mempool (batch-1 H4). Pure functions, no network, no deps.
// READ-ONLY: this file only parses bytes that other people already broadcast. Nothing here builds, signs or sends a transaction.
//
// Supported (exact-in swaps are simulated; exact-out and multi-hop are decoded and flagged, not simulated in v1):
//   Uniswap V2 Router02 0x7a25…488d: swapExactTokensForTokens / ETHForTokens / TokensForETH (+ fee-on-transfer variants),
//     swapTokensForExactTokens / swapETHForExactTokens (exact-out)
//   SwapRouter02 0x68b3…fc45: exactInputSingle, exactInput, V2-style swapExactTokensForTokens, multicall wrappers
//   Universal Router 0x3fc9…7fad / 0x66a9…a8af: execute(commands, inputs[, deadline]) commands V3_SWAP_EXACT_IN (0x00),
//     V2_SWAP_EXACT_IN (0x08); V4 swaps (0x10) are flagged unsupported.
const ROUTERS = Object.freeze({
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'UniswapV2Router02',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'SwapRouter02',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'UniversalRouter',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'UniversalRouterV4',
});
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const CONTRACT_BALANCE = 1n << 255n; // Universal Router "use the router's balance" sentinel

const hex = (s) => (s || '').toLowerCase().replace(/^0x/, '');
const word = (h, i) => h.slice(i * 64, i * 64 + 64);
const u = (h, i) => BigInt('0x' + (word(h, i) || '0'));
const addr = (h, i) => '0x' + word(h, i).slice(24);
const at = (h, byteOff) => h.slice(byteOff * 2); // sub-buffer starting at a byte offset
function addrArray(h, wordIdx) { const off = Number(u(h, wordIdx)); const b = at(h, off); const n = Number(u(b, 0)); const out = []; for (let i = 0; i < n; i++) out.push(addr(b, 1 + i)); return out; }
function bytesAt(h, wordIdx) { const off = Number(u(h, wordIdx)); const b = at(h, off); const n = Number(u(b, 0)); return b.slice(64, 64 + n * 2); }
function bytesArray(h, wordIdx) { const off = Number(u(h, wordIdx)); const b = at(h, off); const n = Number(u(b, 0)); const out = []; for (let i = 0; i < n; i++) { const eo = Number(u(b, 1 + i)); const e = at(b.slice(64), eo); const len = Number(u(e, 0)); out.push(e.slice(64, 64 + len * 2)); } return out; }
/** V3 packed path: token(20) fee(3) token(20) … */
function v3Path(p) { const tokens = [], fees = []; let i = 0; tokens.push('0x' + p.slice(0, 40)); i = 40; while (i + 46 <= p.length) { fees.push(parseInt(p.slice(i, i + 6), 16)); tokens.push('0x' + p.slice(i + 6, i + 46)); i += 46; } return { tokens, fees }; }

const swap = (o) => ({ exactIn: true, hops: o.path.length - 1, tokenIn: o.path[0], tokenOut: o.path[o.path.length - 1], ...o });
const SEL = {
  '38ed1739': (a) => swap({ fn: 'swapExactTokensForTokens', v: 'v2', amountIn: u(a, 0), amountOutMin: u(a, 1), path: addrArray(a, 2) }),
  '5c11d795': (a) => swap({ fn: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', v: 'v2', amountIn: u(a, 0), amountOutMin: u(a, 1), path: addrArray(a, 2), feeOnTransfer: true }),
  '18cbafe5': (a) => swap({ fn: 'swapExactTokensForETH', v: 'v2', amountIn: u(a, 0), amountOutMin: u(a, 1), path: addrArray(a, 2) }),
  '791ac947': (a) => swap({ fn: 'swapExactTokensForETHSupportingFeeOnTransferTokens', v: 'v2', amountIn: u(a, 0), amountOutMin: u(a, 1), path: addrArray(a, 2), feeOnTransfer: true }),
  '7ff36ab5': (a, tx) => swap({ fn: 'swapExactETHForTokens', v: 'v2', amountIn: tx.value, amountOutMin: u(a, 0), path: addrArray(a, 1) }),
  'b6f9de95': (a, tx) => swap({ fn: 'swapExactETHForTokensSupportingFeeOnTransferTokens', v: 'v2', amountIn: tx.value, amountOutMin: u(a, 0), path: addrArray(a, 1), feeOnTransfer: true }),
  '8803dbee': (a) => swap({ fn: 'swapTokensForExactTokens', v: 'v2', exactIn: false, amountOut: u(a, 0), amountInMax: u(a, 1), path: addrArray(a, 2) }),
  'fb3bdb41': (a, tx) => swap({ fn: 'swapETHForExactTokens', v: 'v2', exactIn: false, amountOut: u(a, 0), amountInMax: tx.value, path: addrArray(a, 1) }),
  // SwapRouter02
  '472b43f3': (a) => swap({ fn: 'swapExactTokensForTokens(SR02)', v: 'v2', amountIn: u(a, 0), amountOutMin: u(a, 1), path: addrArray(a, 2) }),
  '04e45aaf': (a) => swap({ fn: 'exactInputSingle', v: 'v3', path: [addr(a, 0), addr(a, 1)], fees: [Number(u(a, 2))], amountIn: u(a, 4), amountOutMin: u(a, 5) }),
  'b858183f': (a) => { const t = at(a, Number(u(a, 0))); const p = v3Path(bytesAt(t, 0)); return swap({ fn: 'exactInput', v: 'v3', path: p.tokens, fees: p.fees, amountIn: u(t, 2), amountOutMin: u(t, 3) }); },
  '5ae401dc': (a, tx) => multi(bytesArray(a, 1), tx), // multicall(uint256 deadline, bytes[])
  'ac9650d8': (a, tx) => multi(bytesArray(a, 0), tx), // multicall(bytes[])
  // Universal Router
  '3593564c': (a, tx) => universal(bytesAt(a, 0), bytesArray(a, 1), tx),
  '24856bc3': (a, tx) => universal(bytesAt(a, 0), bytesArray(a, 1), tx),
};
function multi(calls, tx) { for (const c of calls) { const r = decodeData(c, tx); if (r) return { ...r, wrapped: 'multicall' }; } return null; }
function universal(cmds, inputs, tx) {
  for (let i = 0; i < cmds.length / 2; i++) {
    const cmd = parseInt(cmds.slice(i * 2, i * 2 + 2), 16) & 0x3f, a = inputs[i] || '';
    if (cmd === 0x00) { const p = v3Path(bytesAt(a, 3)); return swap({ fn: 'UR.V3_SWAP_EXACT_IN', v: 'v3', path: p.tokens, fees: p.fees, amountIn: urAmount(u(a, 1), tx), amountOutMin: u(a, 2) }); }
    if (cmd === 0x08) return swap({ fn: 'UR.V2_SWAP_EXACT_IN', v: 'v2', amountIn: urAmount(u(a, 1), tx), amountOutMin: u(a, 2), path: addrArray(a, 3) });
    if (cmd === 0x09) return swap({ fn: 'UR.V2_SWAP_EXACT_OUT', v: 'v2', exactIn: false, amountOut: u(a, 1), amountInMax: u(a, 2), path: addrArray(a, 3) });
    if (cmd === 0x01) { const p = v3Path(bytesAt(a, 3)); return swap({ fn: 'UR.V3_SWAP_EXACT_OUT', v: 'v3', exactIn: false, path: p.tokens.slice().reverse(), fees: p.fees.slice().reverse(), amountOut: u(a, 1), amountInMax: u(a, 2) }); }
    if (cmd === 0x10) return { fn: 'UR.V4_SWAP', v: 'v4', unsupported: 'Uniswap v4 swaps are not decoded in v1' };
  }
  return null;
}
// CONTRACT_BALANCE means "whatever the router holds"; for ETH-in swaps that is the WRAP_ETH amount ≈ tx.value.
const urAmount = (x, tx) => (x === CONTRACT_BALANCE ? (tx.value > 0n ? tx.value : null) : x);

function decodeData(data, tx = { value: 0n }) {
  const h = hex(data); const f = SEL[h.slice(0, 8)]; if (!f) return null;
  try { return f(h.slice(8), tx); } catch { return null; }
}
/** Decode a pending tx object ({to, input|data, value, hash, from, …}). Returns null for non-router or undecodable txs. */
function decodeTx(tx) {
  const to = (tx && tx.to || '').toLowerCase(); const router = ROUTERS[to]; if (!router) return null;
  const value = tx.value ? BigInt(tx.value) : 0n;
  const r = decodeData(tx.input || tx.data, { value }); if (!r) return { router, undecoded: true };
  const norm = (a) => (a ? a.toLowerCase() : a);
  return { router, ...r, path: r.path && r.path.map(norm), tokenIn: norm(r.tokenIn), tokenOut: norm(r.tokenOut) };
}
module.exports = { ROUTERS, WETH, CONTRACT_BALANCE, decodeTx, decodeData, v3Path };
