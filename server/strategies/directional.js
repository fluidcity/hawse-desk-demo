'use strict';
// Shared paper position helper for single-leg directional strategies (whale-follow, 1% mode).
// Entry fee is charged at the open; unrealized always nets the modeled exit fee + slippage.
const F = require('../lib/fees');

function openPos(s, { symbol, side, notional, quote, feeRate, slipBps, tp, sl, maxHoldMs, simulated, reason, now = Date.now(), extra = {} }) {
  const qty = notional / quote.mark;
  const f = s.e.broker.fill({ strategy: s.id, venue: quote.venue, symbol, side: side === 'long' ? 'buy' : 'sell', qty, price: quote.mark, feeRate, slipBps, simulated });
  s.e.ledger.charge(s.id, { amount: f.fee, simulated });
  const p = { id: f.id, symbol, side, qty, entry: f.price, venue: quote.venue, openedAt: now, notional, feeRate, slipBps, tp, sl, maxHoldMs, simulated, entryFee: f.fee, reason, ...extra };
  s.positions.push(p);
  s.fillLog(`OPEN ${side.toUpperCase()} ${symbol} ${qty.toFixed(4)} @ ${f.price.toFixed(4)} on ${quote.venue} · ${reason}`, -f.fee, simulated);
  return p;
}

/** Mark positions, close on TP/SL/time; returns nothing. markFn(symbol) -> price|null */
function managePos(s, markFn, now = Date.now(), { onClose } = {}) {
  let ur = 0, us = 0;
  for (const p of [...s.positions]) {
    const px = markFn(p.symbol); if (!px) { p.stale = true; continue; } p.stale = false; p.mark = px;
    const exitPx = F.applySlippage(px, p.side === 'long' ? 'sell' : 'buy', p.slipBps);
    const gross = p.side === 'long' ? (exitPx - p.entry) * p.qty : (p.entry - exitPx) * p.qty;
    const exitFee = F.fee(exitPx * p.qty, p.feeRate);
    p.upnl = gross - exitFee; // entry fee already booked
    const move = p.side === 'long' ? px / p.entry - 1 : p.entry / px - 1;
    let why = null;
    if (p.tp != null && move >= p.tp) why = 'take-profit';
    else if (p.sl != null && move <= -p.sl) why = 'stop-loss';
    else if (p.maxHoldMs && now - p.openedAt >= p.maxHoldMs) why = 'time stop';
    if (why) {
      s.positions.splice(s.positions.indexOf(p), 1);
      const rec = s.e.ledger.close(s.id, { pnl: p.upnl, total: p.upnl - p.entryFee, fees: p.entryFee + exitFee, simulated: p.simulated, meta: { symbol: p.symbol, side: p.side, why } });
      s.fillLog(`CLOSE ${p.side.toUpperCase()} ${p.symbol} @ ${exitPx.toFixed(4)} (${why}) · net ${(rec.pnl >= 0 ? '+' : '')}${rec.pnl.toFixed(2)} after fees`, p.upnl, p.simulated);
      if (onClose) onClose(p, rec, why);
    } else if (p.simulated) us += p.upnl; else ur += p.upnl;
  }
  s.e.ledger.setUnrealized(s.id, { real: ur, sim: us });
}
module.exports = { openPos, managePos };
