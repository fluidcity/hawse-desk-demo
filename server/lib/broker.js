'use strict';
// Paper broker: computes fills from real (or labeled-mock) prices with fees and slippage.
// There is NO live order path in this build. LiveBroker exists only as a disabled stub.
const { applySlippage, fee } = require('./fees');

let seq = 0;
class PaperBroker {
  fill({ strategy, venue, symbol, side, qty, price, feeRate, slipBps, simulated = false, note = '' }) {
    if (!(qty > 0) || !(price > 0)) throw new RangeError('PaperBroker.fill: qty and price must be > 0');
    const px = applySlippage(price, side, slipBps);
    const notional = qty * px;
    return { id: 'P' + (++seq), t: Date.now(), strategy, venue, symbol, side, qty, refPrice: price, price: px,
      notional, fee: fee(notional, feeRate), slipBps, slipUsd: Math.abs(px - price) * qty, simulated: !!simulated, note, paper: true };
  }
}

class LiveTradingDisabledError extends Error {
  constructor() { super('Live trading is disabled in this build (paper mode only).'); this.code = 'LIVE_DISABLED'; }
}
class LiveBroker {
  // Intentionally unusable. Do not implement without a separate review.
  placeOrder() { throw new LiveTradingDisabledError(); }
  cancelOrder() { throw new LiveTradingDisabledError(); }
}

module.exports = { PaperBroker, LiveBroker, LiveTradingDisabledError };
