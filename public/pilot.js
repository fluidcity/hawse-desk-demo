// Stage Z: Kalshi LIVE pilot card. REAL MONEY. Display + two buttons:
//   HALT (always visible, works from anywhere): POST /api/live/kalshi-pilot/halt
//   Test key (this machine only): POST /api/live/kalshi-pilot/test-key, signed GETs only, no orders
//   ARM (only shown on this machine; the server refuses it from anywhere else): POST /api/live/kalshi-pilot/arm {phrase}
//   Move cash between pools (this machine only; hidden on the phone, refused by the server and the proxy from anywhere else):
//     transfer-prepare {amount, from, to} -> confirm text + one-time token; transfer-confirm {confirm:true, token, amountCents, from, to}; transfer-cancel
// No keys, no exchange calls: the browser only talks to the desk.
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = (v) => typeof v === 'number' && isFinite(v);
  const $c = (c) => (fin(c) ? `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}` : '—');
  const $s = (c) => (fin(c) ? `${c > 0 ? '+' : ''}${$c(c)}` : '—');
  const tone = (v) => (!fin(v) || !v ? '' : v > 0 ? 'pos' : 'neg');
  const ct = (c) => (fin(c) ? `${Math.round(c * 100) / 100}¢` : '—');
  const t = (ms, tz) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }) : '—');
  const CHIP = { DISABLED: 'pl-off', 'DISARMED-SHADOW': 'pl-shadow', ARMED: 'pl-armed', HALTED: 'pl-halted' };
  /** Sizing cell: bankroll used × percent → contracts × limit = order dollars; the 7% target and the cap that bound, if any. */
  function sz(z) {
    if (!z) return '<span class="dim">—</span>';
    if (z.bankrollCents == null) return `<span class="dim">skipped: ${esc(z.capBound || 'no balance')}</span>`;
    const order = `${esc(z.contracts)} × ${ct(z.limitCents)} = <b>${$c(z.sizeCents)}</b>`;
    return `<span class="pl-sz">${esc(z.pct)}% × ${$c(z.bankrollCents)} = ${$c(z.targetCents)} → ${order}${z.capBound ? ` · <span class="${z.capped ? 'pl-cap' : 'dim'}">${z.capped ? 'capped by ' : 'bound: '}${esc(z.capBound)}</span>` : ''}</span>`;
  }
  const bs0 = (m) => (m && m.balanceSource) || {};
  const POOLS = { 0: 'Default', 1: 'Combos', 2: 'Crypto & Commodities', 3: 'Sports' };
  const pool = (i) => `${POOLS[i] || '?'} (shard ${i})`;
  /** "Move cash between pools" block: desk PC only. f = the typed form, x = the confirm step handed back by the server (with its token). */
  function xferBlock(P, o) {
    const T = P.transfer; if (!o.local || !T) return '';
    const f = o.xferForm || {}, x = o.xferConfirm, L = T.last, from = f.from != null ? +f.from : 0, to = f.to != null ? +f.to : 2;
    const opts = (sel) => Object.keys(POOLS).map((k) => `<option value="${k}"${+k === sel ? ' selected' : ''}>${esc(pool(+k))}</option>`).join('');
    const form = `<div class="pl-xrow"><label>amount $ <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-pilot="xfer-amount" aria-label="amount in dollars" placeholder="70.00" value="${esc(f.amount || '')}"></label>` +
      `<label>from <select data-pilot="xfer-from" aria-label="source pool">${opts(from)}</select></label><label>to <select data-pilot="xfer-to" aria-label="destination pool">${opts(to)}</select></label>` +
      `<button type="button" class="pl-btn" data-pilot="xfer-prepare"${T.busy || x ? ' disabled' : ''}>Move cash between pools</button></div>`;
    const conf = x ? `<div class="pl-xconfirm"><b>${esc(x.text)}</b> <span class="dim">(${esc(pool(x.from))} has ${$c(x.availableCents)} available)</span> <button type="button" class="pl-btn pl-xok" data-pilot="xfer-confirm"${T.busy ? ' disabled' : ''}>Confirm</button> <button type="button" class="pl-btn" data-pilot="xfer-cancel"${T.busy ? ' disabled' : ''}>Cancel</button></div>` : '';
    const busy = T.busy ? '<div class="pl-xstat"><b>transfer in progress…</b> (one at a time; checking status every 1.5 s)</div>' : '';
    const last = L ? `<div class="pl-xstat"><span class="dim">last transfer ${esc(t(L.at, o.tz))}</span> <b class="${L.outcome === 'accepted' ? 'pos' : 'neg'}">${esc(L.text)}</b>${L.retry && o.xferRetry ? ' <button type="button" class="pl-btn" data-pilot="xfer-retry">Retry (same transfer id)</button>' : ''}` +
      (Array.isArray(L.shards) && L.shards.length ? `<div class="mono sm">pools now: ${L.shards.map((s) => `${esc(pool(s.exchangeIndex))} ${$c(s.cents)}`).join(' · ')}</div>` : '') + '</div>' : '';
    return `<div class="pl-xfer"><div class="pl-xhead"><b>Move cash between pools</b> <span class="dim">(this computer only · your own pools in your main account · whole cents · asks to confirm · never automatic)</span></div>${form}${conf}${busy}${last}</div>`;
  }
  // ---- Live money chart + transaction history (REAL data only: the pilot's own Kalshi balance reads + its ledger) ----------------------
  const COL = { acct: '#3dffb0', pilot: '#5b8def', other: ['#c9a227', '#b07cff', '#ff9f43', '#6b7a89'] };
  const hm = (ms, tz) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }) : '—');
  /**
   * Bankroll by pool, straight from Kalshi's balance reads (money.pools from the server: balance_breakdown + the pilot pool's own read).
   * Nothing hardcoded or simulated: a pool Kalshi hasn't reported shows "not read yet"; with no read at all the whole block says so.
   */
  function poolsBlock(m, c, o) {
    const B = m.pools; if (!B || !Array.isArray(B.list)) return '';
    const nr = '<span class="dim">not read yet</span>', pilotName = `${esc(B.pilotPoolName || 'pool')} (shard ${esc(B.pilotPool)})`;
    const head = `<div class="pl-pools-h"><b>Bankroll by pool</b> <span class="dim">${B.readAt ? `Kalshi balance, read at ${esc(hm(B.readAt, o.tz))}` : 'Kalshi balance: not read yet'}</span></div>`;
    const rows = B.list.map((x) => `<tr class="${x.pilot ? 'pl-poolpilot' : ''}"><td>${esc(x.name)} <span class="dim">(shard ${esc(x.exchangeIndex)})</span></td><td class="r"><b>${fin(x.cents) ? $c(x.cents) : nr}</b></td><td class="dim pl-poolread">${x.at ? esc(hm(x.at, o.tz)) : ''}</td><td>${x.pilot ? '<b class="pl-poolmark">← pilot trades from here</b>' : '<span class="dim">not used by the pilot</span>'}</td></tr>`).join('');
    const pct = fin(c.perTradePct) ? Math.round(c.perTradePct * 100) : null, per = fin(m.perTradeCents) ? ` · ${pct}% per trade = ${$c(m.perTradeCents)}` : '';
    const dep = B.pendingUnknown ? 'unknown (read failed)' : fin(B.pendingDepositsCents) ? $c(B.pendingDepositsCents) : nr;
    const sum = [
      `<div><span class="dim">available for pilot trades</span> <b class="pl-poolavail">${fin(B.availableForPilotCents) ? $c(B.availableForPilotCents) : nr}</b> <span class="dim">${pilotName} available cash${B.availableAt ? ', read at ' + esc(hm(B.availableAt, o.tz)) : ''}${B.availableStale ? ' <b class="neg">stale</b>' : ''}${esc(per)}</span></div>`,
      `<div><span class="dim">open positions</span> ${fin(B.openPositionsCents) ? $c(B.openPositionsCents) : nr} <span class="dim">(not used for sizing)</span></div>`,
      `<div><span class="dim">pending deposits</span> ${dep} <span class="dim">(not in any pool yet, not used for sizing)</span></div>`,
      `<div><span class="dim">total</span> <b>${fin(B.totalCents) ? $c(B.totalCents) : fin(B.cashCents) ? $c(B.cashCents) + ' <span class="dim">(pool cash only; open positions not read yet)</span>' : nr}</b>${fin(B.totalCents) ? ` <span class="dim">= pool cash ${$c(B.cashCents)}${B.allRead ? '' : ' (pools read so far)'} + open positions ${$c(B.openPositionsCents)}; pending deposits not included</span>` : ''}</div>`,
    ].join('');
    return `<div class="pl-pools">${head}<div class="pl-scroll"><table class="pl-t mono pl-poolt"><thead><tr><th>pool</th><th class="r">available cash</th><th class="pl-poolread">read</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` +
      `<div class="pl-facts mono pl-poolsum">${sum}</div><div class="dim sm">Only the pilot's pool is used for sizing. Kalshi's app/web (or the Move cash box on the desk PC) move cash between pools; API orders don't.</div></div>`;
  }
  /** Series from P.live.points: account value (all pools cash + open positions, from the all-pools read), the pilot's pool cash, other pools' cash. */
  function liveData(P) {
    const L = (P && P.live) || {}, pts = Array.isArray(L.points) ? L.points : [], xi = P && P.config ? P.config.balanceExchangeIndex : 2;
    const pilot = [], acct = [], other = new Map();
    for (const q of pts) {
      if (!fin(q.at)) continue;
      if (q.kind === 'shard' && q.exchangeIndex === xi && fin(q.cashCents)) pilot.push([q.at, q.cashCents / 100]);
      if (q.kind === 'all' && Array.isArray(q.shards)) {
        for (const s of q.shards) { if (s.exchangeIndex === xi) pilot.push([q.at, s.cents / 100]); else { if (!other.has(s.exchangeIndex)) other.set(s.exchangeIndex, []); other.get(s.exchangeIndex).push([q.at, s.cents / 100]); } }
        if (fin(q.pvCents) && fin(q.cashCents)) acct.push([q.at, (q.cashCents + q.pvCents) / 100]);
      }
    }
    const series = [];
    if (acct.length) series.push({ name: 'account value (all pools + open positions)', col: COL.acct, pts: acct });
    if (pilot.length) series.push({ name: `pilot pool cash · ${pool(xi)}`, col: COL.pilot, pts: pilot });
    [...other.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, v], i) => { if (v.some((x) => x[1] !== 0)) series.push({ name: `${pool(k)} cash`, col: COL.other[i % COL.other.length], pts: v, dash: 1 }); });
    const xs = series.flatMap((x) => x.pts.map((q) => q[0])), tx = Array.isArray(L.tx) ? L.tx : [];
    const x0 = xs.length ? Math.min(...xs) : null, x1 = xs.length ? Math.max(...xs, ...tx.map((e) => e.at).filter(fin)) : null;
    const yAt = (at) => { let y = pilot.length ? pilot[0][1] : 0; for (const q of pilot) if (q[0] <= at) y = q[1]; return y; };
    const marks = x0 == null ? [] : tx.filter((e) => fin(e.at) && e.at >= x0 && /^(fill|settle|transfer|not_sent|stop)$/.test(e.kind)).map((e, i) => ({ x: e.at, y: yAt(e.at), loss: e.tone === 'neg', key: 'live|' + i, kind: e.kind, i })).sort((a, b) => a.x - b.x || b.i - a.i);
    return { series, marks, x0, x1, n: L.count || 0, ok: (L.count || 0) >= 2 && x1 > x0 && series.some((x) => x.pts.length >= 2) };
  }
  /** Same look as the paper cards: CME (canvas, drawn by HAWSE.charts after paint) or Classic (inline SVG step lines), per the chart-style toggle. */
  function liveChart(P, o) {
    const L = (P && P.live) || {}, d = liveData(P);
    const head = `<h3 class="pl-h3">Live money <span class="dim">(real Kalshi balance reads${L.count ? ` · ${esc(L.count)} read${L.count === 1 ? '' : 's'} since ${esc(t(L.first, o.tz))}` : ''} · recorded from the pilot's own reads, no extra polling)</span></h3>`;
    if (!d.ok) return head + `<div class="pl-empty mono sm">collecting live data: ${esc(L.count || 0)} balance read${L.count === 1 ? '' : 's'} so far. The chart starts after the pilot's next reads of your Kalshi balance (no mock data is ever shown).</div>`;
    const legend = `<div class="dim sm mono pl-legend">${d.series.map((x) => `<span style="color:${x.col}">■ ${esc(x.name)} ${esc($c(Math.round(x.pts[x.pts.length - 1][1] * 100)))}</span>`).join(' ')}${d.marks.length ? ' · ● fills/transfers/settles (red = loss, reject or halt)' : ''}</div>`;
    if (o.cme) return head + legend + `<canvas class="orb orb-big pl-livechart" data-pilot-chart="1" role="img" aria-label="live Kalshi account value and pool cash over time"></canvas>`;
    const W = 900, Hh = 260, pad = 22, ys = d.series.flatMap((x) => x.pts.map((q) => q[1])), y0 = Math.min(0, ...ys), y1 = Math.max(y0 + 1, ...ys);
    const X = (v) => pad + ((v - d.x0) / Math.max(1, d.x1 - d.x0)) * (W - 2 * pad), Y = (v) => Hh - pad - ((v - y0) / (y1 - y0)) * (Hh - 2 * pad);
    const paths = d.series.map((x) => { let p = `M${X(x.pts[0][0]).toFixed(1)},${Y(x.pts[0][1]).toFixed(1)}`; for (const q of x.pts.slice(1)) p += ` H${X(q[0]).toFixed(1)} V${Y(q[1]).toFixed(1)}`; p += ` H${X(d.x1).toFixed(1)}`;
      return `<path d="${p}" fill="none" stroke="${x.col}" stroke-width="1.6"${x.dash ? ' stroke-dasharray="4 3"' : ''}/>`; }).join('') +
      `<text x="${W - pad}" y="16" text-anchor="end" fill="#8b98a5" font-size="12" class="mono">${esc($c(Math.round(y1 * 100)))}</text><text x="${W - pad}" y="${Hh - 10}" text-anchor="end" fill="#8b98a5" font-size="12" class="mono">${esc($c(Math.round(y0 * 100)))}</text>`;
    const mk = d.marks.map((m) => `<circle cx="${X(m.x).toFixed(1)}" cy="${Y(m.y).toFixed(1)}" r="${m.loss ? 5 : 3.5}" fill="${m.loss ? '#ff3d5a' : '#3dffb0'}"/>`).join('');
    return head + legend + `<svg class="pl-livechart" viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.08)" role="img" aria-label="live Kalshi account value and pool cash over time">` +
      `<line x1="${pad}" x2="${W - pad}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="rgba(255,255,255,.25)" stroke-dasharray="3 3"/>${paths}${mk}</svg>`;
  }
  /** CME spec for HAWSE.charts.draw (same renderer as the paper cards). */
  function liveSpec(P) {
    const d = liveData(P); if (!d.ok) return null;
    return { title: 'live · real Kalshi balance reads', aria: 'live Kalshi account value and pool cash', base: 0, x0: d.x0, x1: d.x1, fmt: (v) => '$' + v.toFixed(2),
      series: d.series.map((x, i) => ({ pts: x.pts, step: 1, extendTo: d.x1, band: i === 0, col: x.col, dash: x.dash ? [4, 3] : undefined })), marks: d.marks };
  }
  function txList(P, o) {
    const L = (P && P.live) || {}, tx = Array.isArray(L.tx) ? L.tx : [];
    const rows = tx.map((e) => `<tr><td>${esc(t(e.at, o.tz))}</td><td>${esc(e.kind)}</td><td>${esc(e.tk || '')}</td><td class="${tone(e.amountCents)}">${fin(e.amountCents) ? esc($c(e.amountCents)) : ''}</td><td class="${esc(e.tone || '')}">${esc(e.text)}</td></tr>`).join('');
    return `<h3 class="pl-h3">Transaction history <span class="dim">(pilot ledger: orders, fills, rejects, settlements, transfers, arm/disarm/halt · newest first${L.txCount > tx.length ? ` · last ${tx.length} of ${esc(L.txCount)}` : ''})</span></h3>` +
      `<div class="pl-scroll"><table class="pl-t mono pl-tx"><thead><tr><th>time</th><th>what</th><th>market</th><th>amount</th><th>detail</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="dim">no live transactions yet</td></tr>'}</tbody></table></div>`;
  }
  function render(P, o = {}) {
    if (!P) return '<div class="dim mono sm">live pilot not loaded</div>';
    const c = P.config || {}, m = P.money || {}, chip = P.statusChip || P.state;
    const banner = `<div class="pl-banner"><b>REAL MONEY</b> · this card places real Kalshi orders when ARMED. Paper v1/v2/v3 are unaffected and never mixed in.</div>`;
    // status chip + HALT come first in the panel: on a phone they are visible at the very top without scrolling
    const head = `<div class="pl-top"><span class="pl-chip ${CHIP[chip] || ''}">${esc(chip)}</span><button type="button" class="pl-halt" data-pilot="halt" title="Stop the pilot now and cancel its resting orders">HALT</button></div>`;
    const why = chip === 'DISABLED' ? `<div class="pl-why">Inert: ${esc((P.inert || []).join('; ') || 'disabled')}. Nothing is sent and nothing is logged.</div>`
      : chip === 'HALTED' ? `<div class="pl-why neg">HALTED: ${esc(P.haltReason || '')}</div>`
      : chip === 'DISARMED-SHADOW' ? `<div class="pl-why">SHADOW: every v3 take is logged as a would-be order. <b>No money.</b></div>` : `<div class="pl-why neg"><b>ARMED: sending real orders.</b></div>`;
    const oom = (m.outOfMoney && chip !== 'DISABLED' ? `<div class="pl-why pl-oom">${esc(m.outOfMoney)}</div>` : '') + (m.shardMismatch && chip !== 'DISABLED' ? `<div class="pl-why neg pl-oom">${esc(m.shardMismatch)}</div>` : '');
    const xi = fin(bs0(m).exchangeIndex) ? bs0(m).exchangeIndex : c.balanceExchangeIndex;
    const shardWhy = xi === 2 ? ' (the shard the 15-minute crypto markets trade on)' : '';
    const bs = bs0(m);
    const daily = c.dailyLossStopCents == null ? 'Daily stop: OFF (paper arms have none)' : `Daily stop: ${$c(c.dailyLossStopCents)}${c.shrinkToDailyBudget ? ' · shrink-to-budget on' : ''}`;
    const facts = `<div class="pl-nolimit"><b>No loss limit: the pilot trades until you press HALT or a safety stop trips; the balance can go to zero.</b></div>` +
      `<div class="pl-facts mono"><div><span class="dim">bankroll (shard ${esc(xi)} cash)</span> <b>${$c(m.bankrollCents)}</b></div>` +
      `<div><span class="dim">source</span> shard ${esc(xi)} available cash${esc(shardWhy)}, read at ${esc(t(bs.at, o.tz))}${m.balanceStale ? ' <b class="neg">stale</b>' : ''}${m.backoffMs ? ` <span class="dim">(rate-limited, retry in ${Math.round(m.backoffMs / 1000)}s)</span>` : ''}</div>` +
      `<div><span class="dim">realized P&amp;L</span> <b class="${tone(m.realizedCents)}">${$s(m.realizedCents)}</b> <span class="dim">(info only, not a limit)</span></div><div><span class="dim">open risk</span> ${$c(m.openRiskCents)} / ${$c(m.bankrollCents)} <span class="dim">(≤ bankroll)</span></div>` +
      `<div><span class="dim">per trade</span> ${fin(c.perTradePct) ? Math.round(c.perTradePct * 100) + '%' : '—'} of shard cash${fin(m.perTradeCents) ? ' = <b>' + $c(m.perTradeCents) + '</b>' : ''} · ≤10% of volume · asset caps (compounds)</div>` +
      `<div>${esc(daily)}</div><div><span class="dim">limit</span> ≤ ask+1¢, ≤ ${esc(c.maxPriceCents)}¢, IOC, ${esc(c.maxSlices)} slices</div></div>` + poolsBlock(m, c, o);
    const e = P.env || {}, kt = P.keyTest;
    const env = `<div class="pl-env mono sm dim">Kalshi key: <b>${e.keySet ? 'set' : 'not set'}</b>${e.keySource ? ' (' + esc(e.keySource) + ')' : ''} · LIVE_PILOT_ENABLED ${e.enabledFlag ? '✓' : '✗'} · ${P.mainAccount ? 'main account (other positions and orders never touched)' : 'subaccount'} · config sha256 ${esc(String(P.hash || '').slice(0, 12))}…${P.killFile ? ' · <b class="neg">KILL file present</b>' : ''}</div>`;
    const ktest = o.local ? `<div class="pl-keytest sm"><button type="button" class="pl-btn" data-pilot="test-key" title="Signed GET of the balance only. Places no order.">Test key (read-only balance check)</button> ${kt ? (kt.ok ? `<b class="pos">OK</b> · shard ${esc(fin(kt.exchangeIndex) ? kt.exchangeIndex : xi)} ${$c(kt.balanceCents)} (sizing) · all shards ${$c(kt.aggregateCents)}${Array.isArray(kt.shards) && kt.shards.length ? ' (' + kt.shards.map((x) => `shard ${esc(x.exchangeIndex)} ${$c(x.cents)}`).join(', ') + ')' : ''} · ${esc(kt.scopeNote || '')}` : `<b class="neg">not OK</b> · ${esc(kt.error || '')}`) + (kt.warn ? ` · <span class="dim">${esc(kt.warn)}</span>` : '') : '<span class="dim">not run yet</span>'}</div>` : '';
    const arm = o.local && chip === 'DISARMED-SHADOW' ? `<details class="pl-arm"><summary>Arm (this computer only)</summary><p class="sm">Type <code>${esc(c.armPhrase)}</code> to arm. A read-only preflight (balance covers one trade, clock, key scope if Kalshi shows it) runs first. Each trade is 7% of shard ${esc(xi)} available cash${esc(shardWhy)} (it compounds); cash on other shards is not used. No loss limit: it trades until HALT or a safety stop; the balance can go to zero.</p><input type="text" autocomplete="off" spellcheck="false" data-pilot="phrase" aria-label="arm phrase"><button type="button" data-pilot="arm">ARM</button></details>` : '';
    const rows = (P.trades || []).map((r) => `<tr><td>${esc(t(r.at, o.tz))}</td><td>${esc(r.tk)}<div class="pl-szm">${sz(r.sizing)}</div></td><td>${ct(r.limit)}</td><td>${ct(r.fillPx)}</td><td>${r.contracts}/${r.requested}</td><td>${ct(r.feeCents)}</td><td>${r.result == null ? 'open' : esc(r.result)}</td><td class="${tone(r.pnlCents)}">${$s(r.pnlCents)}</td><td>${$c(r.balanceBeforeCents)} → ${$c(r.balanceAfterCents)}</td><td class="pl-szc">${sz(r.sizing)}${(r.sliceSizing || []).length > 1 ? ` <span class="dim">(+${r.sliceSizing.length - 1} slice${r.sliceSizing.length > 2 ? 's' : ''})</span>` : ''}</td></tr>`).join('');
    const trades = `<h3 class="pl-h3">Live trades <span class="dim">(real money)</span></h3><div class="pl-scroll"><table class="pl-t mono"><thead><tr><th>time</th><th>market</th><th>limit</th><th>fill</th><th>size</th><th>fee</th><th>result</th><th>P&amp;L</th><th>balance</th><th>sizing (bankroll × % → order $)</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="dim">no live trades yet</td></tr>'}</tbody></table></div>`;
    const cmp = (P.compare || []).map((r) => `<tr${r.shadow && !r.live ? ' class="pl-shadowrow"' : ''}><td>${esc(r.tk)}<div class="pl-szm">${sz(r.sizing)}</div></td><td>${ct(r.decisionAsk)}</td><td>${r.paper ? `${r.paper.filled} @ ${ct(r.paper.vwapCents)}` : '—'}</td><td>${r.live ? `${r.live.filled} @ ${ct(r.live.vwapCents)}` : r.shadow ? `<span class="pl-nomoney">SHADOW · NO MONEY</span> ${r.shadow.skipped ? esc(r.shadow.skipped) : `${r.shadow.contracts} @ ≤${ct(r.shadow.limit)}`}` : '—'}</td><td>${ct(r.slippageCents)}</td><td>${r.unfilled == null ? '—' : r.unfilled}</td><td class="pl-szc">${sz(r.sizing)}</td></tr>`).join('');
    const compare = `<h3 class="pl-h3">Paper v3 7% vs live <span class="dim">(fill, slippage, unfilled)</span></h3><div class="pl-scroll"><table class="pl-t mono"><thead><tr><th>market</th><th>ask</th><th>paper fill</th><th>live fill</th><th>slip</th><th>unfilled</th><th>sizing (bankroll × % → order $)</th></tr></thead><tbody>${cmp || '<tr><td colspan="7" class="dim">no v3 takes yet</td></tr>'}</tbody></table></div>`;
    return head + banner + why + oom + facts + env + ktest + arm + xferBlock(P, o) + (chip === 'DISABLED' ? '' : liveChart(P, o) + txList(P, o)) + trades + compare;
  }
  const API = { render, POOLS, liveData, liveSpec };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }
  const H = (root.HAWSE = root.HAWSE || { onState: [] }); H.onState = H.onState || [];
  const local = /^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);
  let last = '', lastP = null; const xf = { form: { amount: '', from: 0, to: 2 }, confirm: null, retry: null };
  const paint = (force) => { const el = document.getElementById('pilotBody'); if (!el) return;
    const a = document.activeElement; if (!force && a && a.dataset && /^(phrase|xfer-amount|xfer-from|xfer-to)$/.test(a.dataset.pilot || '')) return; // do not repaint while typing
    const C = H.charts, cme = !C || !C.isCme || C.isCme();
    const h = render(lastP, { local, cme, xferForm: xf.form, xferConfirm: xf.confirm, xferRetry: xf.retry }); if (h !== last) { last = h; el.innerHTML = h; } drawLive(); };
  // the live chart canvas is drawn by the shared chart code (public/app.js loads after this file, so look it up at paint time)
  const drawLive = () => { const c = document.querySelector('#pilotBody canvas[data-pilot-chart]'), C = H.charts; if (!c || !C || !C.draw) return; const sp = liveSpec(lastP); if (sp) requestAnimationFrame(() => C.draw(c, sp)); };
  addEventListener('hawse:chartstyle', () => paint(true)); addEventListener('resize', drawLive); document.addEventListener('toggle', drawLive, true);
  H.onState.push((S) => { lastP = S && S.feeds && S.feeds.kalshiPilot; paint(false); });
  document.addEventListener('input', (e) => { const d = e.target && e.target.dataset && e.target.dataset.pilot; if (d === 'xfer-amount') xf.form.amount = e.target.value; });
  document.addEventListener('change', (e) => { const d = e.target && e.target.dataset && e.target.dataset.pilot; if (d === 'xfer-from') xf.form.from = +e.target.value; if (d === 'xfer-to') xf.form.to = +e.target.value; });
  const post = (what, body) => fetch('/api/live/kalshi-pilot/' + what, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  document.addEventListener('click', async (e) => { const b = e.target.closest && e.target.closest('[data-pilot]'); if (!b || !b.closest('#pilotBody')) return;
    if (b.dataset.pilot === 'halt') { b.disabled = true; const r = await post('halt'); b.disabled = false; if (!r.ok) alert('HALT: ' + (r.error || 'failed')); }
    if (b.dataset.pilot === 'test-key') { b.disabled = true; await post('test-key'); b.disabled = false; }
    if (b.dataset.pilot === 'xfer-prepare') { xf.retry = null; b.disabled = true; const r = await post('transfer-prepare', { amount: xf.form.amount, from: xf.form.from, to: xf.form.to }); b.disabled = false;
      if (r.ok) xf.confirm = r.confirm; else alert('Not moved: ' + (r.error || 'refused')); paint(true); }
    if (b.dataset.pilot === 'xfer-cancel') { xf.confirm = null; await post('transfer-cancel'); paint(true); }
    if (b.dataset.pilot === 'xfer-confirm' || b.dataset.pilot === 'xfer-retry') { const x = b.dataset.pilot === 'xfer-retry' ? xf.retry : xf.confirm; if (!x) return; b.disabled = true;
      const r = await post('transfer-confirm', { confirm: true, token: x.token, amountCents: x.amountCents, from: x.from, to: x.to });
      xf.confirm = null; xf.retry = r.retryToken ? { ...x, token: r.retryToken } : null; if (r.ok) xf.form.amount = ''; paint(true); }
    if (b.dataset.pilot === 'arm') { const i = b.parentNode.querySelector('[data-pilot="phrase"]'); const r = await post('arm', { phrase: i ? i.value : '' }); if (i) i.value = ''; alert(r.ok ? 'ARMED' : 'Not armed: ' + (r.error || 'refused')); }
  });
})(typeof window !== 'undefined' ? window : globalThis);
