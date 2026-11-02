'use strict';
// Per-strategy P&L board for the dashboard (DISPLAY ONLY). Built from the ledger's realized-P&L events, so every
// number here is the same money the ledger already booked: nothing is estimated, extrapolated or back-filled.
// Real-data and SIM books stay separate all the way to the browser. The ledger is in memory, so "since start"
// means since this desk process started; 7d is flagged `covered:false` until the desk has been up 7 days.
const DAY = 86400e3;

function localMidnight(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** Downsample cumulative realized P&L to <= max points [t, cum]; first point is (since, 0), last is exact. */
function spark(events, since, max = 48) {
  if (!events.length) return [];
  const pts = [[Math.min(since, events[0][0]), 0]]; let cum = 0; const step = Math.max(1, Math.ceil(events.length / (max - 1)));
  events.forEach(([t, a], i) => { cum += a; if ((i + 1) % step === 0 || i === events.length - 1) pts.push([t, +cum.toFixed(6)]); });
  return pts;
}

function bookView(events, { realized, unrealized, trades, wins, losses, fees }, { now, since, dayStart }) {
  let today = 0, d7 = 0; const w7 = now - 7 * DAY;
  for (const [t, a] of events) { if (t >= dayStart) today += a; if (t >= w7) d7 += a; }
  return { realized, unrealized, today, d7, d7Covered: since <= w7, events: events.length, trades, wins, losses, fees,
    firstAt: events.length ? events[0][0] : null, lastAt: events.length ? events[events.length - 1][0] : null, spark: spark(events, since) };
}

function pnlBoard(ledger, strategies, { now = Date.now(), since = now } = {}) {
  const dayStart = localMidnight(now), opts = { now, since, dayStart };
  const desk = { real: { realized: 0, unrealized: 0, today: 0, d7: 0, events: 0 }, sim: { realized: 0, unrealized: 0, today: 0, d7: 0, events: 0 } };
  const rows = strategies.map((s) => {
    const b = ledger.book(s.id), out = { id: s.id, alloc: s.alloc || 0 };
    for (const side of ['real', 'sim']) {
      const st = b[side], v = bookView(ledger.flowsOf(s.id, side === 'sim'), { realized: st.realized, unrealized: side === 'sim' ? b.unrealSim : b.unrealReal, trades: st.trades, wins: st.wins, losses: st.losses, fees: st.fees }, opts);
      out[side] = v; for (const k of ['realized', 'unrealized', 'today', 'd7', 'events']) desk[side][k] += v[k];
    }
    return out;
  });
  return { since, dayStart, d7Covered: since <= now - 7 * DAY, desk, strategies: rows };
}
module.exports = { pnlBoard, spark, localMidnight };
