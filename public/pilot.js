// Stage Z: Kalshi LIVE pilot card. REAL MONEY. Display + two buttons:
//   HALT (always visible, works from anywhere): POST /api/live/kalshi-pilot/halt
//   Test key (this machine only): POST /api/live/kalshi-pilot/test-key, signed GETs only, no orders
//   ARM (only shown on this machine; the server refuses it from anywhere else): POST /api/live/kalshi-pilot/arm {phrase}
//   Move cash between pools (this machine only; hidden on the phone, refused by the server and the proxy from anywhere else):
//     transfer-prepare {amount, from, to} -> confirm text + one-time token; transfer-confirm {confirm:true, token, amountCents, from, to}; transfer-cancel
//   From the phone over Tailscale (only when GET /api/live/kalshi-pilot/link says source "phone"; the proxy signs, the desk checks):
//     arm-check -> fresh shard cash read + next trade size + one-time check id; then arm {phrase, checkId}; reset {phrase}; disarm.
// No keys, no exchange calls: the browser only talks to the desk.
(function (root) {
  'use strict';
  const LC = typeof module === 'object' && module.exports ? require('./livechart') : root.HAWSE_LC; // chart math + the interactive live canvas
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = (v) => typeof v === 'number' && isFinite(v);
  const $c = (c) => (fin(c) ? `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}` : '—');
  const $s = (c) => (fin(c) ? `${c > 0 ? '+' : ''}${$c(c)}` : '—');
  const tone = (v) => (!fin(v) || !v ? '' : v > 0 ? 'pos' : 'neg');
  const ct = (c) => (fin(c) ? `${Math.round(c * 100) / 100}¢` : '—');
  const t = (ms, tz) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }) : '—');
  const hm24 = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
  const hms24 = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
  const ARM_CHECK_MS = 120000;
  const srcName = (x) => (x && x.source === 'phone' ? 'phone' : 'desk PC');
  /** Who armed (shown to everyone): "armed from phone at 14:05 (bryan@…)". */
  function controlLine(P) {
    const k = P.control && P.control.armed; if (!k) return '';
    return `<div class="pl-ctl sm">armed from ${esc(srcName(k))} at ${esc(hm24(k.at))}${k.login ? ` <span class="dim">(${esc(k.login)})</span>` : ''}</div>`;
  }
  /** Phone over Tailscale: two-step arm (fresh cash read, then the phrase), reset after a halt, disarm. Big tap targets. */
  function phoneBlock(P, o, chip, c) {
    const L = o.link; if (o.local || !L || L.source !== 'phone') return '';
    const can = new Set(L.can || []), xi = c.balanceExchangeIndex != null ? c.balanceExchangeIndex : 2, who = `from phone over Tailscale${L.login ? ` (${esc(L.login)})` : ''}`;
    const checkBtn = (label) => `<button type="button" class="pl-btn pl-big" data-pilot="arm-check">${label}</button>`;
    if (chip === 'ARMED') return can.has('disarm') ? `<div class="pl-phone"><button type="button" class="pl-btn pl-big" data-pilot="disarm">DISARM (back to shadow)</button><p class="sm dim">${who}. HALT above also stops it.</p>${actRes(o, 'disarm')}</div>` : '';
    if (chip === 'HALTED' && can.has('reset')) return `<div class="pl-phone pl-reset"><div class="pl-reset-h"><b class="neg">Pilot is HALTED: ${esc(P.haltReason || 'stopped')}</b></div><p class="sm">Nothing trades while HALTED. Type <code>${esc(c.resetPhrase || '')}</code> and press RESET; it comes back <b>DISARMED</b> (shadow, no money). Source: ${who}.${P.killFile ? ' <b class="neg">Remove the KILL file on the PC first.</b>' : ''}</p><input type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" data-pilot="reset-phrase" aria-label="reset phrase" placeholder="type ${esc(c.resetPhrase || '')}"><button type="button" class="pl-btn pl-big" data-pilot="reset">RESET</button>${actRes(o, 'reset')}</div>`;
    if (chip !== 'DISARMED-SHADOW' || !can.has('arm')) return '';
    const k = o.armCheck, now = o.now || Date.now();
    const intro = `<p class="sm">Step 1: read shard ${esc(xi)} cash now. Step 2: check the numbers and type <code>${esc(c.armPhrase)}</code>. No loss limit: it trades until HALT or a safety stop.</p>`;
    let body;
    if (!k) body = intro + checkBtn(`Check shard ${esc(xi)} cash (step 1 of 2)`);
    else if (!k.ok) body = `<p class="neg sm">Can't arm: ${esc(k.error || 'refused')}</p>` + checkBtn('Check again');
    else if (!fin(k.readAt) || now - k.readAt > ARM_CHECK_MS) body = `<p class="sm neg">That cash read is older than 2 min: check again before arming.</p>` + checkBtn('Check again');
    else body = `<dl class="pl-confirm"><dt>shard ${esc(k.exchangeIndex != null ? k.exchangeIndex : xi)} available cash</dt><dd><b>${$c(k.balanceCents)}</b> <span class="dim">read at ${esc(hms24(k.readAt))}</span></dd>`
      + `<dt>next trade (7% target)</dt><dd><b>${$c(k.perTradeCents)}</b> <span class="dim">or less if a cap binds</span></dd><dt>sizing</dt><dd class="sm">${esc(k.sizing)}</dd><dt>source</dt><dd>${esc(k.source || 'from phone over Tailscale')}</dd></dl>`
      + `<p class="sm">Type <code>${esc(c.armPhrase)}</code> to arm. A fresh preflight read runs again on ARM.</p><input type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" data-pilot="phrase" aria-label="arm phrase" placeholder="type ${esc(c.armPhrase)}">`
      + `<button type="button" class="pl-btn pl-big pl-armbtn" data-pilot="arm-phone">ARM (real money)</button><button type="button" class="pl-btn pl-big" data-pilot="arm-cancel">Cancel</button>`;
    return `<div class="pl-phone pl-arm"><div class="pl-reset-h"><b>Arm from phone</b></div>${body}${actRes(o, 'arm')}</div>`;
  }
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
  /** Chart marker colour by tx tone: buys/transfers neutral (white), settles green/red by their P&L (gray at $0), rejects/halts red. */
  const MK = { neutral: '#e6edf3', pos: '#3dffb0', neg: '#ff3d5a', zero: '#8b98a5', '': '#8b98a5' };
  const mkLabel = (e) => e.label || (e.kind === 'fill' ? 'buy' : e.kind);
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
  /** Inline result of the last ARM / RESET press (o.act = {what, ok, text}), shown in the card instead of only an alert. */
  const actRes = (o, what) => (o.act && o.act.what === what ? `<div class="pl-actres ${o.act.ok ? 'pos' : 'neg'}" role="status">${esc(o.act.text)}</div>` : '');
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
    const series = [], byT = (a, b) => a[0] - b[0];
    if (acct.length) series.push({ name: 'account value (all pools + open positions)', col: COL.acct, pts: acct.sort(byT) });
    if (pilot.length) series.push({ name: `pilot pool cash · ${pool(xi)}`, col: COL.pilot, pts: pilot.sort(byT) });
    [...other.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, v], i) => { if (v.some((x) => x[1] !== 0)) series.push({ name: `${pool(k)} cash`, col: COL.other[i % COL.other.length], pts: v.sort(byT), dash: 1 }); });
    // every chart marker the feed sent (compact rows), else the newest transactions (older feeds)
    const chrono = Array.isArray(L.marks), tx = chrono ? L.marks.map(LC.unpackMark) : Array.isArray(L.tx) ? L.tx : []; // marks: oldest first; tx: newest first
    let x0 = null, x1 = null; for (const s of series) for (const q of s.pts) { if (x0 == null || q[0] < x0) x0 = q[0]; if (x1 == null || q[0] > x1) x1 = q[0]; }
    if (x1 != null) for (const e of tx) if (fin(e.at) && e.at > x1) x1 = e.at;
    // y = the pilot pool's cash at the first real balance read AFTER the event (the read that shows its effect), else the last one before it
    const ps = pilot;
    const yAt = (at) => { let lo = 0, hi = ps.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ps[m][0] < at) lo = m + 1; else hi = m; } return lo < ps.length ? ps[lo][1] : ps.length ? ps[ps.length - 1][1] : 0; };
    const marks = x0 == null ? [] : tx.filter((e) => fin(e.at) && e.at >= x0 && /^(fill|settle|transfer|not_sent|stop)$/.test(e.kind)).map((e, i) => {
      const tn = e.kind === 'fill' ? 'neutral' : e.tone || '', label = mkLabel(e);
      return { x: e.at, y: yAt(e.at), loss: tn === 'neg', tone: tn, col: MK[tn] || MK[''], label, showLabel: e.kind === 'settle' || e.kind === 'stop', tk: e.tk || null,
        title: `${e.kind}${e.tk ? ' ' + e.tk : ''}: ${label}${fin(e.amountCents) && e.kind !== 'settle' ? ' · ' + $c(e.amountCents) : ''}`, key: 'live|' + i, kind: e.kind, i };
    }).sort((a, b) => a.x - b.x || (chrono ? a.i - b.i : b.i - a.i));
    const R = L.realized && fin(L.realized.cents) && L.realized.settled ? L.realized : null;
    const times = series.length ? series[series.length > 1 ? 1 : 0].pts.map((q) => q[0]) : [];
    return { series, marks, realized: R, x0, x1, n: L.count || 0, tf: LC.defaultTf(times), ok: (L.count || 0) >= 2 && x1 > x0 && series.some((x) => x.pts.length >= 2) };
  }
  const PERIODS = ['all', 'week', 'month', 'year'], PERIOD_NAME = { all: 'all time', week: 'this week', month: 'this month', year: 'this year' }, PERIOD_SHORT = { all: 'all time', week: 'week', month: 'month', year: 'year' };
  const nextPeriod = (k) => PERIODS[(PERIODS.indexOf(k) + 1) % PERIODS.length] || 'all';
  /** Per-asset per-trade ceilings straight from the frozen config (p6: $5,000 each). */
  const assetCaps = (c) => { const e = c && c.perAssetCapCents && Object.entries(c.perAssetCapCents); if (!e || !e.length) return 'asset caps —';
    return 'asset caps ' + e.map(([a, v]) => esc(a) + ' $' + (v / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })).join(' / '); };
  const dayName = (k) => new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  /**
   * Big REAL MONEY P&L header (above the live chart): realized total and today (America/Los_Angeles day), from the ledger's settle lines
   * (fees included, computed on the desk). "—" when there is no settle behind a number: never a made-up $0.00.
   */
  function pnlHeader(P, period) {
    const L = (P && P.live) || {}, S = L.pnl || {}, m = (P && P.money) || {}, num = (c, tag = 'div') => `<${tag} class="pl-pnl-num${tone(c) ? ' ' + tone(c) : ''}">${esc($s(c))}</${tag}>`;
    // the TOTAL number cycles all time -> week -> month -> year (PT calendar, computed on the desk); an older feed without periods = all time only
    const PS = S.periods && typeof S.periods === 'object' ? S.periods : null, k = PS && PS[period] ? period : 'all';
    const A = (PS && PS[k]) || { key: 'all', label: 'all time', cents: S.totalCents, settled: S.settled, wins: S.wins, losses: S.losses, fills: S.fills, winRate: S.winRate };
    const nx = PS ? nextPeriod(k) : 'all', lbl = k === 'all' ? 'all time' : String(A.label || k) + ' PT', pre = k === 'all' ? '' : PERIOD_NAME[k] + ': ';
    const rec = pre + (A.settled ? `${esc(A.wins)}W–${esc(A.losses)}L · ${fin(A.winRate) ? Math.round(A.winRate * 100) + '% win rate' : '—'} · ${esc(A.settled)} settled` : 'no settled trades yet');
    const total = `<button type="button" class="pl-pnl-box pl-pnl-cyc" data-pilot="pnl-period" data-period="${k}" data-next="${nx}" aria-label="TOTAL P&amp;L ${esc(lbl)}: ${esc($s(A.cents))}. Tap to show ${esc(PERIOD_NAME[nx])}">` +
      `<span class="pl-pnl-lbl">TOTAL P&amp;L <span class="dim">· ${esc(lbl)}</span></span>${num(A.cents, 'span')}<span class="pl-pnl-hint dim">${PS ? `tap to change · next: ${esc(PERIOD_SHORT[nx])}` : 'all time'}</span></button>`;
    const days = (Array.isArray(S.daily) ? S.daily : []).slice().reverse().map((d) => `<tr data-pl-day="${esc(d.day)}"><td>${esc(dayName(d.day))}${d.day === S.today ? ' <span class="dim">today</span>' : ''}</td><td>${esc(d.trades)}</td><td>${d.trades ? `${esc(d.wins)}–${esc(d.losses)}` : '—'}</td><td class="${tone(d.pnlCents)}">${esc($s(d.pnlCents))}</td></tr>`).join('');
    return `<div class="pl-pnl" data-pl-pnl="1" role="group" aria-label="real money realized P&amp;L"><div class="pl-pnl-tag">REAL MONEY (Kalshi) <span class="dim">· realized from settled trades, fees included</span></div>` +
      `<div class="pl-pnl-row">${total}` +
      `<div class="pl-pnl-box"><div class="pl-pnl-lbl">TODAY <span class="dim">${S.today ? esc(dayName(S.today)) + ' PT' : 'PT'}</span></div>${num(S.todayCents)}<div class="pl-pnl-sub dim">${esc(S.todaySettled || 0)} settled today</div></div></div>` +
      `<div class="pl-pnl-rec mono">${rec} · ${fin(A.fills) ? esc(A.fills) : '—'} fills${fin(m.openRiskCents) && m.openRiskCents > 0 ? ` · <span class="pl-pnl-risk">open risk now <b>${esc($c(m.openRiskCents))}</b></span>` : ''}</div>` +
      (days ? `<div class="pl-scroll"><table class="pl-t mono pl-days"><caption class="dim sm">last 7 days (PT)</caption><thead><tr><th>date</th><th>trades</th><th>W–L</th><th>P&amp;L</th></tr></thead><tbody>${days}</tbody></table></div>` : '') + '</div>';
  }
  /** Same look as the paper cards: CME (interactive canvas, public/livechart.js) or Classic (inline SVG step lines), per the chart-style toggle. */
  function liveChart(P, o) {
    const L = (P && P.live) || {}, d = liveData(P);
    const head = `<h3 class="pl-h3">Live money <span class="dim">(real Kalshi balance reads${L.count ? ` · ${esc(L.count)} read${L.count === 1 ? '' : 's'} since ${esc(t(L.first, o.tz))}` : ''} · recorded from the pilot's own reads, no extra polling)</span></h3>`;
    if (!d.ok) return head + `<div class="pl-empty mono sm">collecting live data: ${esc(L.count || 0)} balance read${L.count === 1 ? '' : 's'} so far. The chart starts after the pilot's next reads of your Kalshi balance (no mock data is ever shown).</div>`;
    const legend = `<div class="dim sm mono pl-legend">${d.series.map((x) => `<span style="color:${x.col}">■ ${esc(x.name)} ${esc($c(Math.round(x.pts[x.pts.length - 1][1] * 100)))}</span>`).join(' ')}${d.realized ? ` <span class="${tone(d.realized.cents)}">realized P&amp;L ${esc($s(d.realized.cents))} (${esc(d.realized.wins)}W / ${esc(d.realized.losses)}L)</span>` : ''}${d.marks.length ? ' <span><span style="color:#e6edf3">●</span> buys &amp; transfers (neutral)</span> <span><span class="pos">●</span>/<span class="neg">●</span> settles, green win / red loss, labeled with P&amp;L</span> <span><span class="neg">◉</span> rejects &amp; halts</span>' : ''}</div>`;
    const recent = d.marks.slice(-20), tip = recent.map((m) => m.title).join(' · ');
    if (o.cme) { const tf = LC.TFS.includes(o.tf) ? o.tf : d.tf;
      const bar = `<div class="pl-tf" role="group" aria-label="chart time frame">${LC.TFS.map((k) => `<button type="button" data-pilot="tf" data-tf="${k}" class="pl-tfb${k === tf ? ' on' : ''}" aria-pressed="${k === tf}">${k}</button>`).join('')}</div>`;
      return head + bar + `<div class="pl-lc"><canvas class="orb orb-big pl-livechart" data-pilot-chart="1" role="img" title="${esc(tip)}" aria-label="live Kalshi account value and pool cash over time${tip ? '; ' + esc(tip) : ''}"></canvas></div>` + legend +
        `<div class="dim sm pl-lchint">scroll or pinch to zoom · drag to pan · double-click / double-tap to reset · hover or tap for exact time (PT), balance and trade</div>`; }
    const W = 900, Hh = 260, pad = 22, ys = d.series.flatMap((x) => x.pts.map((q) => q[1])), y0 = Math.min(0, ...ys), y1 = Math.max(y0 + 1, ...ys);
    const X = (v) => pad + ((v - d.x0) / Math.max(1, d.x1 - d.x0)) * (W - 2 * pad), Y = (v) => Hh - pad - ((v - y0) / (y1 - y0)) * (Hh - 2 * pad);
    const paths = d.series.map((x) => { let p = `M${X(x.pts[0][0]).toFixed(1)},${Y(x.pts[0][1]).toFixed(1)}`; for (const q of x.pts.slice(1)) p += ` H${X(q[0]).toFixed(1)} V${Y(q[1]).toFixed(1)}`; p += ` H${X(d.x1).toFixed(1)}`;
      return `<path d="${p}" fill="none" stroke="${x.col}" stroke-width="1.6"${x.dash ? ' stroke-dasharray="4 3"' : ''}/>`; }).join('') +
      `<text x="${W - pad}" y="16" text-anchor="end" fill="#8b98a5" font-size="12" class="mono">${esc($c(Math.round(y1 * 100)))}</text><text x="${W - pad}" y="${Hh - 10}" text-anchor="end" fill="#8b98a5" font-size="12" class="mono">${esc($c(Math.round(y0 * 100)))}</text>`;
    const mk = d.marks.map((m) => { const cx = X(m.x), cy = Y(m.y), up = cy > 40;
      return `<g class="pl-mk pl-mk-${esc(m.kind)}" data-tone="${esc(m.tone)}"><title>${esc(m.title)}</title>${m.loss ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" fill="none" stroke="${m.col}" stroke-width="2"/>` : ''}` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${m.kind === 'settle' ? 5 : m.loss ? 5 : 3.5}" fill="${m.col}"${m.kind === 'fill' ? ' stroke="#5b8def" stroke-width="1.2"' : ''}/>` +
        (m.showLabel ? `<text x="${cx.toFixed(1)}" y="${(up ? cy - 10 : cy + 18).toFixed(1)}" text-anchor="${cx > W - 80 ? 'end' : 'middle'}" fill="${m.col}" font-size="12" font-weight="700" class="mono">${esc(m.label)}</text>` : '') + '</g>'; }).join('');
    return head + `<svg class="pl-livechart" viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.08)" role="img" aria-label="live Kalshi account value and pool cash over time">` +
      `<line x1="${pad}" x2="${W - pad}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="rgba(255,255,255,.25)" stroke-dasharray="3 3"/>${paths}${mk}</svg>` + legend +
      `<div class="dim sm pl-lchint">switch the chart style to CME for time frames, zoom, pan and the crosshair</div>`;
  }
  /** Spec for the live canvas (public/livechart.js; the shared paper renderer HAWSE.charts.draw also accepts it). */
  function liveSpec(P) {
    const d = liveData(P); if (!d.ok) return null;
    return { title: 'live · real Kalshi balance reads', aria: 'live Kalshi account value and pool cash', base: 0, x0: d.x0, x1: d.x1, fmt: (v) => '$' + v.toFixed(2), tf: d.tf, names: d.series.map((x) => x.name),
      series: d.series.map((x, i) => ({ pts: x.pts, step: 1, extendTo: d.x1, band: i === 0, col: x.col, dash: x.dash ? [4, 3] : undefined })), marks: d.marks };
  }
  function txList(P, o) {
    const L = (P && P.live) || {}, tx = Array.isArray(L.tx) ? L.tx : [];
    const rows = tx.map((e) => `<tr><td>${esc(t(e.at, o.tz))}</td><td>${esc(e.kind)}</td><td>${esc(e.tk || '')}</td><td class="${e.kind === 'settle' ? tone(e.amountCents) : e.tone === 'neg' ? 'neg' : ''}">${fin(e.amountCents) ? esc(e.kind === 'settle' ? $s(e.amountCents) : $c(e.amountCents)) : ''}</td><td class="${e.tone === 'pos' || e.tone === 'neg' ? e.tone : ''}">${esc(e.text)}</td></tr>`).join('');
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
      `<div><span class="dim">per trade</span> ${fin(c.perTradePct) ? Math.round(c.perTradePct * 100) + '%' : '—'} of shard cash${fin(m.perTradeCents) ? ' = <b>' + $c(m.perTradeCents) + '</b>' : ''} · ≤10% of volume · ${assetCaps(c)} (compounds)</div>` +
      `<div>${esc(daily)}</div><div><span class="dim">limit</span> ≤ ask+1¢, ≤ ${esc(c.maxPriceCents)}¢, IOC, ${esc(c.maxSlices)} slices</div></div>` + poolsBlock(m, c, o);
    const e = P.env || {}, kt = P.keyTest;
    const env = `<div class="pl-env mono sm dim">Kalshi key: <b>${e.keySet ? 'set' : 'not set'}</b>${e.keySource ? ' (' + esc(e.keySource) + ')' : ''} · LIVE_PILOT_ENABLED ${e.enabledFlag ? '✓' : '✗'} · ${P.mainAccount ? 'main account (other positions and orders never touched)' : 'subaccount'} · config sha256 ${esc(String(P.hash || '').slice(0, 12))}…${P.killFile ? ' · <b class="neg">KILL file present</b>' : ''}</div>`;
    const ktest = o.local ? `<div class="pl-keytest sm"><button type="button" class="pl-btn" data-pilot="test-key" title="Signed GET of the balance only. Places no order.">Test key (read-only balance check)</button> ${kt ? (kt.ok ? `<b class="pos">OK</b> · shard ${esc(fin(kt.exchangeIndex) ? kt.exchangeIndex : xi)} ${$c(kt.balanceCents)} (sizing) · all shards ${$c(kt.aggregateCents)}${Array.isArray(kt.shards) && kt.shards.length ? ' (' + kt.shards.map((x) => `shard ${esc(x.exchangeIndex)} ${$c(x.cents)}`).join(', ') + ')' : ''} · ${esc(kt.scopeNote || '')}` : `<b class="neg">not OK</b> · ${esc(kt.error || '')}`) + (kt.warn ? ` · <span class="dim">${esc(kt.warn)}</span>` : '') : '<span class="dim">not run yet</span>'}</div>` : '';
    const arm = o.local && chip === 'DISARMED-SHADOW' ? `<details class="pl-arm" open><summary>Arm (this computer only)</summary><p class="sm">Type <code>${esc(c.armPhrase)}</code> to arm. A read-only preflight (balance covers one trade, clock, key scope if Kalshi shows it) runs first. Each trade is 7% of shard ${esc(xi)} available cash${esc(shardWhy)} (it compounds); cash on other shards is not used. No loss limit: it trades until HALT or a safety stop; the balance can go to zero.</p><input type="text" autocomplete="off" spellcheck="false" data-pilot="phrase" aria-label="arm phrase" placeholder="type ${esc(c.armPhrase)}"><button type="button" data-pilot="arm">ARM</button>${actRes(o, 'arm')}</details>` : '';
    const resetBox = o.local && chip === 'HALTED' ? `<div class="pl-reset"><div class="pl-reset-h"><b class="neg">Pilot is HALTED: ${esc(P.haltReason || 'stopped')}</b></div><p class="sm">Nothing trades while HALTED. Type <code>${esc(c.resetPhrase || '')}</code> and press RESET to clear the halt; the pilot comes back <b>DISARMED</b> (shadow only, no money) and you can ARM it again from here.${P.killFile ? ' <b class="neg">Remove the KILL file first.</b>' : ''}</p><input type="text" autocomplete="off" spellcheck="false" data-pilot="reset-phrase" aria-label="reset phrase" placeholder="type ${esc(c.resetPhrase || '')}"><button type="button" data-pilot="reset">RESET</button>${actRes(o, 'reset')}</div>` : '';
    const cc = (m) => (m == null || !Number.isFinite(m) ? '?' : (Math.round(m / 100) / 100) + '¢'); // micros -> cents
    const R = P.reconcile, OL = R && R.orderLookup, recBox = chip === 'HALTED' && R && /unreconciled/.test(P.haltReason || '') ? `<div class="pl-recon"><b>Fills check for ${esc(R.coid || R.tk)}</b> (after ${esc(R.retries)} fills retries)<ul class="sm">
<li>ack: <b>${esc(R.ack && R.ack.count)}</b> filled @ ${cc(R.ack && R.ack.avgPriceMicros)}${R.ack && R.ack.feeEachMicros != null ? ' · fee ' + cc(R.ack.feeEachMicros * R.ack.count) : ''}</li>
<li>fills read: <b>${esc(R.fills && R.fills.count)}</b> filled</li>
<li>order lookup: ${!OL || OL.error ? 'unavailable (' + esc(OL ? OL.error : 'no answer') + ')' : `<b>${esc(OL.count)}</b> filled @ ${cc(OL.avgPriceMicros)} · ${esc(OL.status || 'status ?')}${OL.feeMicros != null ? ' · fee ' + cc(OL.feeMicros) : ''}`}</li></ul></div>` : '';
    const rv = P.recovery, recover = o.local && chip !== 'DISABLED' ? `<div class="pl-recover sm"><button type="button" data-pilot="recover">Recover missed trades (read-only)</button> <span class="dim">reads Kalshi's order, fills and settlements for any acked order the ledger is missing; never trades, never arms, never clears a HALT</span>${actRes(o, 'recover')}${rv ? `<div class="dim">last run ${esc(t(rv.at, o.tz))} (${esc(rv.why)}): ${rv.ok ? '' : 'stopped: ' + esc(rv.error) + ' · '}checked ${esc(rv.checked)}, fills booked ${esc(rv.fillsBooked)}, settled ${esc(rv.settled)}, waiting for settlement ${esc(rv.unsettled)}</div>` : ''}</div>` : '';
    const phone = phoneBlock(P, o, chip, c), ctl = controlLine(P);
    const deskOnly = !o.local && !phone && (chip === 'HALTED' || chip === 'DISARMED-SHADOW') ? `<div class="pl-deskonly sm dim">Arm and reset only on the desk PC; this link can HALT only.</div>` : '';
    const lastAct = (o.local || (o.link && o.link.source === 'phone')) && o.act && !phone.includes('pl-actres') && !((o.act.what === 'arm' && arm) || (o.act.what === 'reset' && resetBox) || (o.act.what === 'recover' && recover)) ? `<div class="pl-actline">${actRes(o, o.act.what)}</div>` : '';
    const rows = (P.trades || []).map((r) => `<tr><td>${esc(t(r.at, o.tz))}</td><td>${esc(r.tk)}${r.source ? ` <span class="pl-src">source ${esc(r.source)}</span>` : ''}<div class="pl-szm">${sz(r.sizing)}</div></td><td>${ct(r.limit)}</td><td>${ct(r.fillPx)}</td><td>${r.contracts}/${r.requested}</td><td>${ct(r.feeCents)}</td><td>${r.result == null ? 'open' : esc(r.result)}</td><td class="${tone(r.pnlCents)}">${$s(r.pnlCents)}</td><td>${$c(r.balanceBeforeCents)} → ${$c(r.balanceAfterCents)}</td><td class="pl-szc">${sz(r.sizing)}${(r.sliceSizing || []).length > 1 ? ` <span class="dim">(+${r.sliceSizing.length - 1} slice${r.sliceSizing.length > 2 ? 's' : ''})</span>` : ''}</td></tr>`).join('');
    const trades = `<h3 class="pl-h3">Live trades <span class="dim">(real money)</span></h3><div class="pl-scroll"><table class="pl-t mono"><thead><tr><th>time</th><th>market</th><th>limit</th><th>fill</th><th>size</th><th>fee</th><th>result</th><th>P&amp;L</th><th>balance</th><th>sizing (bankroll × % → order $)</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="dim">no live trades yet</td></tr>'}</tbody></table></div>`;
    const cmp = (P.compare || []).map((r) => `<tr${r.shadow && !r.live ? ' class="pl-shadowrow"' : ''}><td>${esc(r.tk)}<div class="pl-szm">${sz(r.sizing)}</div></td><td>${ct(r.decisionAsk)}</td><td>${r.paper ? `${r.paper.filled} @ ${ct(r.paper.vwapCents)}` : '—'}</td><td>${r.live ? `${r.live.filled} @ ${ct(r.live.vwapCents)}` : r.shadow ? `<span class="pl-nomoney">SHADOW · NO MONEY</span> ${r.shadow.skipped ? esc(r.shadow.skipped) : `${r.shadow.contracts} @ ≤${ct(r.shadow.limit)}`}` : '—'}</td><td>${ct(r.slippageCents)}</td><td>${r.unfilled == null ? '—' : r.unfilled}</td><td class="pl-szc">${sz(r.sizing)}</td></tr>`).join('');
    const compare = `<h3 class="pl-h3">Paper v3 7% vs live <span class="dim">(fill, slippage, unfilled)</span></h3><div class="pl-scroll"><table class="pl-t mono"><thead><tr><th>market</th><th>ask</th><th>paper fill</th><th>live fill</th><th>slip</th><th>unfilled</th><th>sizing (bankroll × % → order $)</th></tr></thead><tbody>${cmp || '<tr><td colspan="7" class="dim">no v3 takes yet</td></tr>'}</tbody></table></div>`;
    return head + banner + why + ctl + recBox + resetBox + phone + deskOnly + lastAct + oom + facts + env + ktest + arm + recover + xferBlock(P, o) + (chip === 'DISABLED' ? '' : pnlHeader(P, o.pnlPeriod) + liveChart(P, o) + txList(P, o)) + trades + compare;
  }
  const API = { render, POOLS, liveData, liveSpec, pnlHeader, nextPeriod };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }
  const H = (root.HAWSE = root.HAWSE || { onState: [] }); H.onState = H.onState || [];
  const local = /^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);
  let link = null, armCheck = null; // phone only: what the desk says this link may do (signed by the proxy), and the confirm-step read
  if (!local) fetch('/api/live/kalshi-pilot/link', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((j) => { link = j; paint(true); }).catch(() => {});
  setInterval(() => { if (armCheck) paint(false); }, 5000); // the confirm step goes stale after 2 min
  // after an ARM/RESET the server answers with the new state: show it at once (the next stream push replaces this copy)
  const confirmed = (r) => { if (r && r.ok && r.state && lastP) lastP = Object.assign({}, lastP, { state: r.state, statusChip: r.state === 'DISARMED' ? 'DISARMED-SHADOW' : r.state, haltReason: r.state === 'HALTED' ? lastP.haltReason : null }); };
  let pnlPeriod = 'all'; try { pnlPeriod = localStorage.getItem('hawse.pilot.pnlPeriod') || 'all'; } catch (_) { /* private mode: all time */ }
  let last = '', lastP = null, act = null; const xf = { form: { amount: '', from: 0, to: 2 }, confirm: null, retry: null };
  const paint = (force) => { const el = document.getElementById('pilotBody'); if (!el) return;
    const a = document.activeElement; if (!force && a && a.dataset && /^(phrase|reset-phrase|xfer-amount|xfer-from|xfer-to)$/.test(a.dataset.pilot || '')) return; // do not repaint while typing
    const C = H.charts, cme = !C || !C.isCme || C.isCme();
    const h = render(lastP, { local, link, armCheck, cme, act, tf: lc.tfSel, pnlPeriod, xferForm: xf.form, xferConfirm: xf.confirm, xferRetry: xf.retry }); if (h !== last) { last = h; el.innerHTML = h; } drawLive(); };
  // the live chart: public/livechart.js (time frames, zoom, pan, crosshair). lc keeps the chosen time frame and zoom window across repaints.
  const lc = { tfSel: null, tf: 'All', view: null, follow: false, hover: null }; let spP = null, spC = null;
  const spec = () => (spP === lastP ? spC : ((spP = lastP), (spC = liveSpec(lastP))));
  const drawLive = () => { const c = document.querySelector('#pilotBody canvas[data-pilot-chart]'); if (!c) return; const sp = spec(); if (!sp) return;
    if (LC && LC.draw) { lc.tf = lc.tfSel || sp.tf; LC.bind(c, spec, lc); requestAnimationFrame(() => LC.draw(c, spec(), lc)); return; }
    const C = H.charts; if (C && C.draw) requestAnimationFrame(() => C.draw(c, sp)); };
  addEventListener('hawse:chartstyle', () => paint(true)); addEventListener('resize', drawLive); addEventListener('orientationchange', () => setTimeout(drawLive, 150)); document.addEventListener('toggle', drawLive, true);
  H.onState.push((S) => { lastP = S && S.feeds && S.feeds.kalshiPilot; paint(false); });
  document.addEventListener('input', (e) => { const d = e.target && e.target.dataset && e.target.dataset.pilot; if (d === 'xfer-amount') xf.form.amount = e.target.value; });
  document.addEventListener('change', (e) => { const d = e.target && e.target.dataset && e.target.dataset.pilot; if (d === 'xfer-from') xf.form.from = +e.target.value; if (d === 'xfer-to') xf.form.to = +e.target.value; });
  const post = (what, body) => fetch('/api/live/kalshi-pilot/' + what, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  document.addEventListener('keydown', (e) => { const d = e.key === 'Enter' && e.target && e.target.dataset && e.target.dataset.pilot; const btn = d === 'phrase' ? 'arm' : d === 'reset-phrase' ? 'reset' : null;
    if (btn) { const b = e.target.parentNode.querySelector(btn === 'arm' ? '[data-pilot="arm"],[data-pilot="arm-phone"]' : `[data-pilot="${btn}"]`); if (b) { e.preventDefault(); b.click(); } } });
  document.addEventListener('click', async (e) => { const b = e.target.closest && e.target.closest('[data-pilot]'); if (!b || !b.closest('#pilotBody')) return;
    if (b.dataset.pilot === 'pnl-period') { pnlPeriod = b.dataset.next || 'all'; try { localStorage.setItem('hawse.pilot.pnlPeriod', pnlPeriod); } catch (_) { /* not saved */ }
      paint(true); const nb = document.querySelector('#pilotBody [data-pilot="pnl-period"]'); if (nb && nb.focus) nb.focus({ preventScroll: true }); return; }
    if (b.dataset.pilot === 'tf') { lc.tfSel = b.dataset.tf; lc.view = null; lc.follow = false; lc.hover = null; paint(true); return; }
    if (b.dataset.pilot === 'halt') { b.disabled = true; const r = await post('halt'); b.disabled = false; if (!r.ok) alert('HALT: ' + (r.error || 'failed')); }
    if (b.dataset.pilot === 'test-key') { b.disabled = true; await post('test-key'); b.disabled = false; }
    if (b.dataset.pilot === 'xfer-prepare') { xf.retry = null; b.disabled = true; const r = await post('transfer-prepare', { amount: xf.form.amount, from: xf.form.from, to: xf.form.to }); b.disabled = false;
      if (r.ok) xf.confirm = r.confirm; else alert('Not moved: ' + (r.error || 'refused')); paint(true); }
    if (b.dataset.pilot === 'xfer-cancel') { xf.confirm = null; await post('transfer-cancel'); paint(true); }
    if (b.dataset.pilot === 'xfer-confirm' || b.dataset.pilot === 'xfer-retry') { const x = b.dataset.pilot === 'xfer-retry' ? xf.retry : xf.confirm; if (!x) return; b.disabled = true;
      const r = await post('transfer-confirm', { confirm: true, token: x.token, amountCents: x.amountCents, from: x.from, to: x.to });
      xf.confirm = null; xf.retry = r.retryToken ? { ...x, token: r.retryToken } : null; if (r.ok) xf.form.amount = ''; paint(true); }
    if (b.dataset.pilot === 'arm') { const i = b.parentNode.querySelector('[data-pilot="phrase"]'); b.disabled = true; const r = await post('arm', { phrase: i ? i.value : '' }); b.disabled = false; if (i) i.value = '';
      confirmed(r); act = { what: 'arm', ok: !!r.ok, text: r.ok ? 'ARMED: the pilot is now sending real orders.' : 'Not armed: ' + (r.error || 'refused') }; paint(true); }
    if (b.dataset.pilot === 'arm-check') { b.disabled = true; armCheck = await post('arm-check'); b.disabled = false; act = null; paint(true); }
    if (b.dataset.pilot === 'arm-cancel') { armCheck = null; paint(true); }
    if (b.dataset.pilot === 'arm-phone') { const i = b.parentNode.querySelector('[data-pilot="phrase"]'); const k = armCheck; b.disabled = true;
      const r = await post('arm', { phrase: i ? i.value : '', checkId: k && k.checkId }); b.disabled = false; if (i) i.value = ''; armCheck = null;
      confirmed(r); act = { what: 'arm', ok: !!r.ok, text: r.ok ? 'ARMED from phone: the pilot is now sending real orders.' : 'Not armed: ' + (r.error || 'refused') }; paint(true); }
    if (b.dataset.pilot === 'disarm') { b.disabled = true; const r = await post('disarm'); b.disabled = false; confirmed(r); act = { what: 'disarm', ok: !!r.ok, text: r.ok ? 'Disarmed: shadow only, no money.' : 'Not disarmed: ' + (r.error || 'refused') }; paint(true); }
    if (b.dataset.pilot === 'recover') { b.disabled = true; const r = await post('recover', {}); b.disabled = false;
      act = { what: 'recover', ok: !!r.ok, text: r.ok ? `Recovery done: fills booked ${r.fillsBooked || 0}, settled ${r.settled || 0}${r.unsettled ? `, ${r.unsettled} not settled by Kalshi yet` : ''}.` : 'Recovery stopped: ' + (r.error || 'refused') }; paint(true); }
    if (b.dataset.pilot === 'reset') { const i = b.parentNode.querySelector('[data-pilot="reset-phrase"]'); b.disabled = true; const r = await post('reset', { phrase: i ? i.value : '' }); b.disabled = false; if (i) i.value = '';
      confirmed(r); act = { what: 'reset', ok: !!r.ok, text: r.ok ? `Reset: the pilot is now ${r.state === 'DISARMED' ? 'DISARMED-SHADOW (no money)' : r.state || 'reset'}.` : 'Not reset: ' + (r.error || 'refused') }; paint(true); }
  });
})(typeof window !== 'undefined' ? window : globalThis);
