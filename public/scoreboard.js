// Scoreboard card: every strategy at a glance + every Kalshi H2 trade (display only; this file never talks to the desk
// and never changes a number). Everything is read from the state the other cards already use:
//   desk strategies -> S.strategies (armed, data mode) + S.pnlBoard (trades/wins/losses/net per REAL and SIM book)
//                      + S.closed (the desk's last closed trades, newest first) for the losing-trade lists
//   Kalshi H2 v1    -> feeds.kalshiH2.pnl.curve (every settled fill: settle time, ticker, net ¢, cumulative ¢) + .pnl.unrealized.open
//   Kalshi H2 v2    -> feeds.kalshiH2v2.stats.curve (every settled kept trade) + .signals (fill price)
//   Kalshi H2 v3    -> feeds.kalshiH2v3.stats.lines[].curve (paper balance after each settle) + .stats.compare.table (last 25 signals:
//                      signal time, ask, v2 decision, result, v1 net ¢, v3 size/cost per line)
// REAL-DATA, SIM and PAPER-H2 numbers are never added together. Missing data says "no trades yet" / "not tracked", never $0.
(function (root) {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = (x) => typeof x === 'number' && isFinite(x);
  const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;
  const PLAIN = {
    funding: 'collects funding payments between perp venues', whale: 'trades after large on-chain transfers', wfollow: 'copies tracked wallets',
    mevlab: 'mempool sandwich lab (simulated only)', onepct: 'small daily target, compounding', gaps: 'DEX price gaps between pools',
    orb: 'CME micro futures, opening-range breakout', perpmom: 'perp momentum', basis: 'spot vs perp price gap (cash & carry)',
    bet_ev: 'sports bets priced better than Pinnacle', bet_spread: 'sports spread / total bets', bet_arb: 'sports arbitrage across books',
  };
  const DATA = { live: ['REAL-DATA', 'live'], sim: ['SIM', 'sim'], mock: ['SIM', 'sim'], mixed: ['MIXED', 'mixed'], down: ['DATA DOWN', 'down'] };

  // ---------- formatting (pure) ----------
  function when(t, tz) {
    if (!fin(t)) return '—';
    try { return new Date(t).toLocaleString('en-US', { timeZone: tz || undefined, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }); }
    catch (e) { return new Date(t).toISOString(); }
  }
  const cents = (v, d = 1) => !fin(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}¢`;
  const usd = (v, sign = true) => !fin(v) ? '—' : `${sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const money = (v, unit) => unit === '¢' ? cents(v) : usd(v);
  const level = (v, unit) => unit === '¢' ? (fin(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}¢` : '—') : usd(v, false);
  const tone = (v) => !fin(v) || Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'pos' : 'neg';
  const px = (p) => fin(p) ? `${r4(p <= 1 ? p * 100 : p).toFixed(1)}¢` : '?';
  const pct = (p) => fin(p) ? Math.round(100 * p) + '%' : '—';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---------- Kalshi H2 trades (pure) ----------
  /** -> { arms: [{ id, key, label, unit, levelLabel, rows, skipped, settled, wins, losses, net, open, note }] } rows newest first. */
  function h2Trades(S) {
    const f = (S && S.feeds) || {}, H1 = f.kalshiH2, H2 = f.kalshiH2v2, H3 = f.kalshiH2v3, arms = [];
    const table = (H3 && H3.stats && H3.stats.compare && H3.stats.compare.table) || [];
    const sig = new Map(table.map((x) => [x.tk, x]));
    const fills = new Map(((H2 && H2.signals) || []).filter((x) => fin(x.px)).map((x) => [x.tk, x.px]));
    const entryOf = (tk, px) => fin(px) ? { px, kind: 'fill' } : fills.has(tk) ? { px: fills.get(tk), kind: 'fill' } : sig.has(tk) && fin(sig.get(tk).ya) ? { px: sig.get(tk).ya, kind: 'ask' } : null;
    const at = (tk) => (sig.has(tk) ? sig.get(tk).at : null);
    const res = (tk) => (sig.has(tk) ? sig.get(tk).result : null);
    const status = (p) => (p > 0 ? 'win' : p < 0 ? 'loss' : 'even');
    const newest = (a, b) => ((b.settleAt ?? b.entryAt ?? 0) - (a.settleAt ?? a.entryAt ?? 0));
    const fromCum = (id, cv) => cv.filter((p) => p && p.tk && fin(p.pnlCents) && fin(p.cumCents)).map((p) => ({ key: id + '|' + p.tk, arm: id, tk: p.tk, entryAt: at(p.tk), settleAt: p.at,
      entry: entryOf(p.tk), size: '1 contract', status: status(p.pnlCents), result: res(p.tk), pnl: p.pnlCents, unit: '¢', before: r4(p.cumCents - p.pnlCents), after: p.cumCents }));
    if (H1 && H1.stats) {
      const cv = (H1.pnl && H1.pnl.curve) || [], rows = fromCum('v1', cv), lastCum = cv.length ? cv[cv.length - 1].cumCents : 0;
      const open = ((H1.pnl && H1.pnl.unrealized && H1.pnl.unrealized.open) || []).map((o) => ({ key: 'v1|' + o.tk, arm: 'v1', tk: o.tk, entryAt: o.entryAt, settleAt: null, entry: entryOf(o.tk, o.px),
        size: '1 contract', status: 'open', result: null, pnl: null, unreal: o.unrealizedCents, unit: '¢', before: lastCum, after: null }));
      const st = H1.stats, R = H1.pnl && H1.pnl.realizedCents;
      arms.push({ id: 'v1', label: 'Kalshi H2 v1', unit: '¢', levelLabel: 'cumulative ¢ (1-contract test, not dollars)', rows: [...open, ...rows].sort(newest), skipped: [],
        settled: st.settled, wins: st.wins, losses: st.losses, net: R ? R.total : null, open: open.length, note: `all ${rows.length} settled${open.length ? ` + ${open.length} open` : ''}` });
    }
    if (H2 && H2.stats) {
      const v = H2.stats.v2 || {}, rows = fromCum('v2', H2.stats.curve || []), lastCum = rows.length ? rows.reduce((a, r) => (r.settleAt > a.settleAt ? r : a)).after : 0;
      const open = table.filter((x) => x.decision === 'take' && !x.result).map((x) => ({ key: 'v2|' + x.tk, arm: 'v2', tk: x.tk, entryAt: x.at, settleAt: null, entry: entryOf(x.tk), size: '1 contract',
        status: 'open', result: null, pnl: null, unit: '¢', before: lastCum, after: null }));
      const skipped = table.filter((x) => x.decision === 'skip').map((x) => ({ key: 'v2skip|' + x.tk, arm: 'v2', tk: x.tk, entryAt: x.at, settleAt: null, entry: fin(x.ya) ? { px: x.ya, kind: 'ask' } : null,
        size: '—', status: 'skipped', result: x.result || null, would: fin(x.v1Cents) ? x.v1Cents : null, unit: '¢' }));
      arms.push({ id: 'v2', label: 'Kalshi H2 v2', unit: '¢', levelLabel: 'cumulative ¢ (1-contract test, not dollars)', rows: [...open, ...rows].sort(newest), skipped,
        settled: v.settled, wins: v.wins, losses: v.losses, net: v.totalNetCents, open: open.length,
        note: `all ${rows.length} settled kept trades${open.length ? ` + ${open.length} open` : ''}; skipped signals come from the last ${table.length} signals` });
    }
    if (H3 && H3.stats) {
      for (const L of H3.stats.lines || []) {
        const id = 'v3-' + L.id, rows = []; let prev = null;
        for (const p of L.curve || []) {
          if (!p.tk) { prev = p.balance; continue; }
          const s = sig.get(p.tk), o = s && (s.v3 || []).find((q) => q.id === L.id);
          const before = fin(prev) ? prev : null, pnl = o && fin(o.pnl) ? o.pnl : before != null ? r2(p.balance - before) : null;
          rows.push({ key: id + '|' + p.tk, arm: id, tk: p.tk, entryAt: s ? s.at : null, settleAt: p.at, entry: entryOf(p.tk), size: o && fin(o.filled) ? `${o.filled} contracts${fin(o.dollars) ? ' · ' + usd(o.dollars, false) : ''}` : 'not shown',
            status: status(pnl), result: s ? s.result : null, pnl, unit: '$', before, after: p.balance });
          prev = p.balance;
        }
        const open = table.filter((x) => !x.result).map((x) => [x, (x.v3 || []).find((q) => q.id === L.id)]).filter(([, o]) => o && o.filled > 0 && o.pnl == null)
          .map(([x, o]) => ({ key: id + '|' + x.tk, arm: id, tk: x.tk, entryAt: x.at, settleAt: null, entry: entryOf(x.tk), size: `${o.filled} contracts${fin(o.dollars) ? ' · ' + usd(o.dollars, false) : ''}`,
            status: 'open', result: null, pnl: null, unit: '$', before: L.balance, after: null }));
        const capped = (L.curve || []).length >= 400;
        arms.push({ id, label: `Kalshi H2 v3 · ${L.id} line`, unit: '$', levelLabel: `paper balance (start ${usd(L.start, false)})`, rows: [...open, ...rows].sort(newest), skipped: [],
          settled: L.settled, wins: L.wins, losses: L.losses, net: L.pnl, open: L.open, balance: L.balance, start: L.start,
          note: `${capped ? 'last ' + rows.length : 'all ' + rows.length} settled${open.length ? ` + ${open.length} open` : ''}${L.zeroSize ? ` · ${plural(L.zeroSize, 'signal', 'signals')} got no size (not traded)` : ''}` });
      }
    }
    return { arms, tableN: table.length };
  }

  // ---------- desk strategies (pure) ----------
  function side(x) { if (!x) return null; const n = x.trades || 0; return { trades: n, wins: x.wins || 0, losses: x.losses || 0, net: n ? x.realized : null, unreal: x.unrealized || 0, winRate: n ? (x.wins || 0) / n : null, spark: x.spark || [], lastAt: x.lastAt || null }; }
  function deskTiles(S) {
    const board = new Map((((S && S.pnlBoard) || {}).strategies || []).map((r) => [r.id, r]));
    const closed = ((S && S.closed) || []).filter((c) => c && c.strategy && fin(c.pnl));
    return ((S && S.strategies) || []).map((s) => {
      const b = board.get(s.id), mine = closed.filter((c) => c.strategy === s.id).sort((a, z) => (z.t || 0) - (a.t || 0));
      const trade = (c) => ({ t: c.t, what: c.symbol || c.venue || '—', side: c.side || null, pnl: c.pnl, fees: c.fees, why: c.why || null, sim: !!c.simulated });
      return { id: s.id, name: s.name || s.id, plain: PLAIN[s.id] || s.desc || '', armed: !!s.armed, data: DATA[s.dataMode] || [String(s.dataMode || 'unknown').toUpperCase(), 'stale'],
        tracked: !!b, real: side(b && b.real), sim: side(b && b.sim), losses: mine.filter((c) => !(c.pnl > 0)).map(trade), wins: mine.filter((c) => c.pnl > 0).map(trade), last: mine[0] ? trade(mine[0]) : null };
    });
  }

  /** The whole card model. Pure: same state in -> same model out. */
  function summarize(S) {
    const desk = deskTiles(S), h2 = h2Trades(S);
    const add = (acc, x) => { if (x && x.trades) { acc.trades += x.trades; acc.wins += x.wins; acc.losses += x.losses; acc.net += x.net; acc.n++; } return acc; };
    const real = desk.reduce((a, t) => add(a, t.real), { trades: 0, wins: 0, losses: 0, net: 0, n: 0 });
    const sim = desk.reduce((a, t) => add(a, t.sim), { trades: 0, wins: 0, losses: 0, net: 0, n: 0 });
    real.net = r2(real.net); sim.net = r2(sim.net);
    const c = { up: 0, down: 0, even: 0, none: 0, simOnly: 0, total: 0 };
    const count = (n, net) => { c.total++; if (!n) c.none++; else if (net > 1e-9) c.up++; else if (net < -1e-9) c.down++; else c.even++; };
    for (const t of desk) { if (t.real && t.real.trades) count(t.real.trades, t.real.net); else if (t.sim && t.sim.trades) { c.total++; c.simOnly++; } else count(0, 0); }
    for (const a of h2.arms) count(a.settled, a.net);
    const counted = c.total - c.simOnly, parts = [`${c.up} of ${counted} strategies ${c.up === 1 ? 'is' : 'are'} making money`, `${c.down} ${c.down === 1 ? 'is' : 'are'} losing`];
    if (c.even) parts.push(`${c.even} ${c.even === 1 ? 'is' : 'are'} break-even`);
    parts.push(`${c.none} ${c.none === 1 ? 'has' : 'have'} no trades yet`);
    let sentence = parts.join('; ') + '.';
    if (c.simOnly) sentence += ` ${plural(c.simOnly, 'strategy has', 'strategies have')} SIM-only results (not counted).`;
    return { real, sim, h2, desk, counts: c, sentence };
  }

  // ---------- HTML (pure strings) ----------
  const chip = (txt, cls, title) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(txt)}</span>`;
  const resultCell = (r) => r.status === 'loss' ? '<b class="sb-loss">▼ LOSS</b>' : r.status === 'win' ? '<b class="pos">WIN</b>' : r.status === 'even' ? '<b class="dim">EVEN</b>' : r.status === 'open' ? '<b class="warn">OPEN</b>' :
    `<span class="sb-skip">skipped by v2</span> <span class="${r.would == null ? 'dim' : tone(r.would)}">${r.would == null ? (r.result ? 'result ' + esc(r.result) : 'not settled') : `would have ${r.would > 0 ? 'won' : 'lost'} ${cents(r.would)}`}</span>`;
  function tradeRow(r, unit, o) {
    const entry = r.entry ? `YES @ ${esc(px(r.entry.px))}${r.entry.kind === 'ask' ? ' <span class="dim" title="no paper fill price in the state; this is the YES ask when the signal fired">(ask)</span>' : ''}` : 'YES <span class="dim">(price not shown)</span>';
    const pnl = r.status === 'open' ? (fin(r.unreal) ? `<span class="${tone(r.unreal)}" title="unrealized, not in totals">${cents(r.unreal)} open</span>` : '<span class="dim">open</span>') : r.status === 'skipped' ? '<span class="dim">not traded</span>' : `<b class="${tone(r.pnl)}">${money(r.pnl, unit)}</b>`;
    const bal = r.status === 'skipped' ? '<span class="dim">no change</span>' : `${level(r.before, unit)} → ${r.after == null ? '<span class="dim">waiting</span>' : `<b class="${tone(r.after - r.before)}">${level(r.after, unit)}</b>`}`;
    const cls = ['sb-tr', r.status === 'loss' ? 'is-loss' : '', r.status === 'skipped' ? 'is-skip' : '', o.sel === r.key ? 'tsel' : ''].filter(Boolean).join(' ');
    const outT = r.settleAt ? (sameDay(r.entryAt, r.settleAt, o.tz) ? timeOnly(r.settleAt, o.tz) : when(r.settleAt, o.tz)) : null;
    return `<tr class="${cls}" data-trade="${esc(r.key)}"><td class="c-in" data-m="in">${esc(when(r.entryAt, o.tz))}</td><td class="c-out" data-m="out">${outT ? esc(outT) : '<span class="dim">—</span>'}</td>` +
      `<td class="c-tk">${esc(r.tk)}</td><td class="c-side">${entry}</td><td class="c-size">${esc(r.size)}</td><td class="c-res">${resultCell(r)}</td>` +
      `<td class="c-pnl">${pnl}</td><td class="c-bal" data-m="${unit === '¢' ? 'cum ¢' : 'balance'}">${bal}</td></tr>`;
  }
  const MAX_ROWS = 10;
  const dayKey = (t, tz) => { try { return new Date(t).toLocaleDateString('en-US', { timeZone: tz || undefined }); } catch (e) { return new Date(t).toDateString(); } };
  const sameDay = (a, b, tz) => fin(a) && fin(b) && dayKey(a, tz) === dayKey(b, tz);
  function timeOnly(t, tz) { try { return new Date(t).toLocaleTimeString('en-US', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }); } catch (e) { return when(t, tz); } }
  function tradeTable(rows, unit, o, sid) {
    if (!rows.length) return '';
    const head = `<thead><tr><th>Entered</th><th title="same day as entered unless a date is shown">Settled</th><th>Market</th><th>Side @ entry</th><th>Size</th><th>Result</th><th>P&amp;L after fees</th><th>${unit === '¢' ? 'Cum ¢ before → after' : 'Balance before → after'}</th></tr></thead>`;
    const first = rows.slice(0, MAX_ROWS), rest = rows.slice(MAX_ROWS);
    return `<div class="sb-twrap"><table class="sb-table mono">${head}<tbody>${first.map((r) => tradeRow(r, unit, o)).join('')}</tbody></table></div>` +
      (rest.length ? `<details class="sb-more" data-sid="${esc(sid)}-more"${o.open(sid + '-more', false) ? ' open' : ''}><summary>show the other ${rest.length} older</summary><div class="sb-twrap"><table class="sb-table mono">${head}<tbody>${rest.map((r) => tradeRow(r, unit, o)).join('')}</tbody></table></div></details>` : '');
  }
  function armBlock(a, o) {
    const sid = 'trades-' + a.id, lossN = a.rows.filter((r) => r.status === 'loss').length;
    const head = `<span class="sb-arm">${esc(a.label)}</span> ${chip('PAPER · NOT REAL MONEY', 'paper')} <span class="mono sb-armsum">${a.settled ? `${a.settled} settled · <b class="pos">${a.wins} W</b> / <b class="${a.losses ? 'neg' : 'dim'}">${a.losses} L</b> · net <b class="${tone(a.net)}">${money(a.net, a.unit)}</b>${a.unit === '$' && fin(a.balance) ? ` · balance ${usd(a.balance, false)}` : ''}` : 'no trades yet'}${a.open ? ` · ${a.open} open` : ''}</span>`;
    const body = a.rows.length || a.skipped.length
      ? `<div class="dim sm mono sb-note">Showing ${esc(a.note)}, newest first. P&amp;L is after fees; ${a.unit === '¢' ? 'cents per 1-contract test. The last column is a running <b>cumulative ¢</b> total, not dollars.' : `in dollars on this line's own paper balance; the last column is that ${esc(a.levelLabel)}.`}${lossN ? ` <b class="neg">${plural(lossN, 'loss', 'losses')}</b> marked ▼.` : ''}</div>` +
        tradeTable(a.rows, a.unit, o, sid) +
        (a.skipped.length ? `<div class="sb-subh">Signals skipped by v2 <span class="dim">(not traded; shows what v1's 1-contract fill did · ${a.skipped.length} in the last ${o.tableN} signals)</span></div>` + tradeTable(a.skipped, '¢', o, sid + '-skip') : '')
      : '<div class="dim mono sb-note">no trades yet</div>';
    return `<details class="sb-arm-d" data-sid="${sid}"${o.open(sid, true) ? ' open' : ''}><summary>${head}</summary>${body}</details>`;
  }
  function lossList(items, o, sid, fmt) {
    if (!items.length) return '<div class="dim sm">no losing trades in the data shown</div>';
    const li = (x) => `<li>${fmt(x)}</li>`, first = items.slice(0, 10), rest = items.slice(10);
    return `<ol class="sb-losses mono">${first.map(li).join('')}</ol>` + (rest.length ? `<details class="sb-more" data-sid="${esc(sid)}"${o.open(sid, false) ? ' open' : ''}><summary>show all ${items.length}</summary><ol class="sb-losses mono" start="11">${rest.map(li).join('')}</ol></details>` : '');
  }
  function bigNet(net, unit, n) { return n ? `<div class="sb-big mono ${tone(net)}">${money(net, unit)}</div>` : '<div class="sb-big mono sb-none">no trades yet</div>'; }
  function stats(x) { return x && x.trades ? `<div class="sb-wl mono"><span><b>${x.trades}</b> closed</span><span class="pos"><b>${x.wins}</b> wins</span><span class="${x.losses ? 'neg' : 'dim'}"><b>${x.losses}</b> losses</span><span><b>${pct(x.winRate)}</b> win rate</span></div>` : ''; }
  function deskTile(t, o) {
    const sid = 'tile-' + t.id, R = t.real, Sm = t.sim;
    const chips = chip(t.armed ? 'ARMED' : 'DISARMED', t.armed ? 'live' : 'stale') + chip(t.data[0], t.data[1]);
    const spark = R && R.trades && o.spark ? o.spark(R.spark, `${t.name} cumulative realized P&L`) : '';
    const simLine = Sm && Sm.trades ? `<div class="sb-simline mono">${chip('SIM', 'sim', 'mocked/simulated inputs: never added to the real-data numbers')} ${Sm.trades} closed · ${Sm.wins} W / ${Sm.losses} L · <b class="${tone(Sm.net)}">${usd(Sm.net)}</b></div>` : '';
    const last = t.last ? `<div class="sb-last mono">last: <b class="${tone(t.last.pnl)}">${usd(t.last.pnl)}</b>${t.last.sim ? ' ' + chip('SIM', 'sim') : ''} · ${esc(t.last.what)} · ${esc(when(t.last.t, o.tz))}</div>` : R && R.lastAt ? `<div class="sb-last mono dim">last close ${esc(when(R.lastAt, o.tz))}</div>` : '';
    const main = !t.tracked ? '<div class="sb-big mono sb-none">not tracked</div>' : R && R.trades ? bigNet(R.net, '$', R.trades) : Sm && Sm.trades ? '<div class="sb-big mono sb-none">no real-data trades</div>' : bigNet(null, '$', 0);
    const fmt = (x) => `<span class="dim">${esc(when(x.t, o.tz))}</span> · ${esc(x.what)}${x.side ? ' · ' + esc(x.side) : ''} · <b class="neg">${usd(x.pnl)}</b>${x.sim ? ' ' + chip('SIM', 'sim') : ''}${x.why ? ` <span class="dim">· ${esc(x.why)}</span>` : ''}`;
    const wins = t.wins.slice(0, 3).map((x) => `${esc(x.what)} <b class="pos">${usd(x.pnl)}</b>`).join(' · ');
    const body = `<div class="sb-tbody"><div class="sb-subh">Losing trades <span class="dim">(newest first, from the desk's last ${o.closedN} closed trades across all strategies)</span></div>${lossList(t.losses, o, sid + '-all', fmt)}` +
      (wins ? `<div class="sm mono sb-wins">recent wins: ${wins}</div>` : '') + `</div>`;
    return `<details class="sb-tile" data-sid="${sid}"${o.open(sid, false) ? ' open' : ''}><summary><div class="sb-th"><span class="sb-name">${esc(t.name)}</span>${chips}</div><div class="sb-plain dim">${esc(t.plain)}</div>` +
      `<div class="sb-mid">${main}${spark}</div>${stats(R)}${R && R.unreal ? `<div class="sm mono">open (unrealized, not in net): <b class="${tone(R.unreal)}">${usd(R.unreal)}</b></div>` : ''}${simLine}${last}</summary>${body}</details>`;
  }
  function armTile(a, o) {
    const sid = 'tile-' + a.id, losses = a.rows.filter((r) => r.status === 'loss'), lastR = a.rows.find((r) => r.status !== 'open');
    const fmt = (r) => `<span class="dim">${esc(when(r.settleAt, o.tz))}</span> · <a href="#" data-goto="${esc(r.key)}">${esc(r.tk)}</a> · YES @ ${r.entry ? esc(px(r.entry.px)) : '?'} · <b class="neg">${money(r.pnl, a.unit)}</b>`;
    const x = a.settled ? { trades: a.settled, wins: a.wins, losses: a.losses, winRate: a.wins / a.settled } : null;
    return `<details class="sb-tile" data-sid="${sid}"${o.open(sid, false) ? ' open' : ''}><summary><div class="sb-th"><span class="sb-name">${esc(a.label)}</span>${chip('ARMED', 'live', 'frozen paper test, always on')}${chip('PAPER', 'paper', 'paper test on real Kalshi data, not real money; kept apart from the desk books')}</div>` +
      `<div class="sb-plain dim">${a.unit === '¢' ? 'cents per 1-contract test (not dollars)' : esc(a.levelLabel)}</div><div class="sb-mid">${bigNet(a.net, a.unit, a.settled)}</div>${stats(x)}` +
      (lastR ? `<div class="sb-last mono">last: <b class="${tone(lastR.pnl)}">${money(lastR.pnl, a.unit)}</b> · ${esc(lastR.tk)} · ${esc(when(lastR.settleAt, o.tz))}</div>` : '') + `</summary>` +
      `<div class="sb-tbody"><div class="sb-subh">Losing trades <span class="dim">(newest first; every trade is in the Trades table above)</span></div>${lossList(losses, o, sid + '-all', fmt)}</div></details>`;
  }
  /** opts: { tz, sel, open(sid, dflt) -> bool, spark(pts, label) -> html } */
  function render(m, opts = {}) {
    const o = { tz: opts.tz, sel: opts.sel || null, open: opts.open || ((sid, d) => d), spark: opts.spark || null, tableN: m.h2.tableN, closedN: opts.closedN != null ? opts.closedN : 0 };
    const R = m.real, Sm = m.sim;
    const h2chips = m.h2.arms.map((a) => `<span class="sb-h2chip mono">${esc(a.id)} ${a.settled ? `${a.wins}W/${a.losses}L <b class="${tone(a.net)}">${money(a.net, a.unit)}</b>` : '<span class="dim">no trades</span>'}</span>`).join('');
    const strip = `<div class="sb-strip"><div class="sb-real"><div class="sb-k">REAL-DATA desk <span class="dim">(all strategies, real inputs only)</span></div>` +
      (R.trades ? `<div class="sb-big mono ${tone(R.net)}">${usd(R.net)}</div><div class="sb-wl mono"><span class="pos"><b>${R.wins}</b> wins</span><span class="${R.losses ? 'neg' : 'dim'}"><b>${R.losses}</b> losses</span><span><b>${R.trades}</b> closed</span></div>` : '<div class="sb-big mono sb-none">no trades yet</div>') + `</div>` +
      `<div class="sb-side"><div class="sb-chipbox">${chip('SIM', 'sim', 'mocked/simulated inputs: never added to the real-data total')} ${Sm.trades ? `${Sm.wins}W / ${Sm.losses}L · <b class="${tone(Sm.net)}">${usd(Sm.net)}</b>` : '<span class="dim">no SIM trades</span>'} <span class="dim sm">kept separate</span></div>` +
      `<div class="sb-chipbox">${chip('PAPER · KALSHI H2', 'paper', 'frozen paper tests on real Kalshi data; different units, so never summed')} ${h2chips || '<span class="dim">not running</span>'}</div></div></div>`;
    return strip + `<p class="sb-sentence">${esc(m.sentence)}</p>` +
      (m.h2.arms.length ? `<div class="sb-sec"><h3 class="sb-h3">Kalshi H2 trades <span class="dim">· what was bought, what it made or lost, and the running total</span></h3>${m.h2.arms.map((a) => armBlock(a, o)).join('')}</div>` : '') +
      `<div class="sb-sec"><h3 class="sb-h3">Every strategy <span class="dim">· tap a tile for its losing trades</span></h3><div class="sb-grid">${m.h2.arms.map((a) => armTile(a, o)).join('')}${m.desk.map((t) => deskTile(t, o)).join('')}</div></div>`;
  }
  /** Tooltip lines for a chart marker (same numbers as the table row). */
  function tipLines(r, tz) {
    if (!r) return [];
    return [`${r.status === 'loss' ? '▼ LOSS' : r.status === 'win' ? 'WIN' : r.status.toUpperCase()} · ${r.tk}`, `settled ${when(r.settleAt, tz)}`, `entered ${when(r.entryAt, tz)}`,
      `YES @ ${r.entry ? px(r.entry.px) : '?'} · ${r.size}`, `P&L after fees ${money(r.pnl, r.unit)}`, `${r.unit === '¢' ? 'cum ¢' : 'balance'} ${level(r.before, r.unit)} → ${level(r.after, r.unit)}`];
  }
  const API = { summarize, h2Trades, deskTiles, render, tipLines, when };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }

  // ---------- browser wiring ----------
  const H = (root.HAWSE = root.HAWSE || { onState: [] }); H.onState = H.onState || []; H.score = API;
  const OPEN = 'hawse.scoreboard.open.v1';
  let openState = {}; try { openState = JSON.parse(localStorage.getItem(OPEN) || '{}') || {}; } catch (e) { openState = {}; }
  const isOpen = (sid, d) => (Object.prototype.hasOwnProperty.call(openState, sid) ? !!openState[sid] : d);
  document.addEventListener('toggle', (e) => { const d = e.target; if (!d || !d.dataset || !d.dataset.sid || !d.closest('#scoreBody')) return; openState[d.dataset.sid] = d.open; try { localStorage.setItem(OPEN, JSON.stringify(openState)); } catch (x) {} }, true);
  let lastHtml = '', byKey = new Map(), lastS = null;
  function paint(S) {
    const el = document.getElementById('scoreBody'); if (!el || !S) return; lastS = S;
    const m = summarize(S); byKey = new Map(m.h2.arms.flatMap((a) => a.rows).map((r) => [r.key, r]));
    const html = render(m, { sel: H.tradeSel, open: isOpen, spark: H.sparkSvg, closedN: (S.closed || []).length });
    if (html !== lastHtml) { lastHtml = html; el.innerHTML = html; }
    if (H.tradeHot) cls('thot', H.tradeHot); // charts were just redrawn by app.js; keep the hovered trade lit
  }
  H.onState.push(paint);
  addEventListener('hawse:chartstyle', () => { lastHtml = ''; if (lastS) paint(lastS); });

  // Chart <-> table link. Markers (SVG <g data-trade> in Classic, hit boxes on canvas.orb in CME) and table rows share a key.
  let tip = null;
  function showTip(key, x, y) {
    const r = byKey.get(key); if (!r) return hideTip();
    if (!tip) { tip = document.createElement('div'); tip.className = 'trade-tip mono'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = tipLines(r).map((l, i) => i ? `<div>${esc(l)}</div>` : `<b class="${r.status === 'loss' ? 'neg' : 'pos'}">${esc(l)}</b>`).join('');
    tip.hidden = false; const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(innerWidth - w - 6, x + 12)) + 'px'; tip.style.top = Math.max(6, y - h - 12 < 6 ? y + 16 : y - h - 12) + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }
  function cls(c, key) {
    document.querySelectorAll('.' + c).forEach((n) => { if (n.getAttribute('data-trade') !== key) n.classList.remove(c); });
    if (key) document.querySelectorAll(`[data-trade="${CSS.escape(key)}"]`).forEach((n) => n.classList.add(c));
  }
  function mark(c, key) { cls(c, key); if (H.charts && H.charts.redraw) H.charts.redraw(); }
  function hot(key) { if (H.tradeHot === key) return; H.tradeHot = key; mark('thot', key); }
  function select(key, scrollTo) {
    H.tradeSel = key; mark('tsel', key); lastHtml = '';
    if (!scrollTo) return;
    const row = document.querySelector(`#scoreBody tr[data-trade="${CSS.escape(key)}"]`); if (!row) return;
    for (let d = row.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.remove('tflash'); void row.offsetWidth; row.classList.add('tflash');
  }
  function canvasHit(c, e) {
    const hits = c._hits; if (!hits || !hits.length) return null; const b = c.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    let best = null, bd = e.pointerType === 'touch' ? 24 : 14; for (const h of hits) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } } return best;
  }
  document.addEventListener('pointermove', (e) => {
    const t = e.target; if (!t || !t.closest) return;
    if (t.tagName === 'CANVAS' && t.classList.contains('orb')) { const h = canvasHit(t, e); t.style.cursor = h ? 'pointer' : ''; if (h) { hot(h.key); showTip(h.key, e.clientX, e.clientY); } else { hot(null); hideTip(); } return; }
    const g = t.closest('g[data-trade]'); if (g) { hot(g.getAttribute('data-trade')); showTip(g.getAttribute('data-trade'), e.clientX, e.clientY); return; }
    const tr = t.closest('#scoreBody tr[data-trade]'); if (tr) { hot(tr.getAttribute('data-trade')); hideTip(); return; }
    if (H.tradeHot) { hot(null); hideTip(); }
  }, { passive: true });
  document.addEventListener('click', (e) => {
    const t = e.target; if (!t || !t.closest) return;
    const go = t.closest('a[data-goto]'); if (go) { e.preventDefault(); select(go.getAttribute('data-goto'), true); return; }
    if (t.tagName === 'CANVAS' && t.classList.contains('orb')) { const h = canvasHit(t, e); if (h) { showTip(h.key, e.clientX, e.clientY); select(h.key, true); } return; }
    const g = t.closest('g[data-trade]'); if (g) { const k = g.getAttribute('data-trade'); const b = g.getBoundingClientRect(); showTip(k, b.left + b.width / 2, b.top); select(k, true); return; }
    const tr = t.closest('#scoreBody tr[data-trade]'); if (tr) { const k = tr.getAttribute('data-trade'); select(H.tradeSel === k ? null : k, false); hideTip(); return; }
    hideTip();
  });
  addEventListener('scroll', hideTip, { passive: true });
})(typeof window !== 'undefined' ? window : globalThis);
