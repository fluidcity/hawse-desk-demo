// Stage Z: Kalshi LIVE pilot card. REAL MONEY. Display + two buttons:
//   HALT (always visible, works from anywhere): POST /api/live/kalshi-pilot/halt
//   ARM (only shown on this machine; the server refuses it from anywhere else): POST /api/live/kalshi-pilot/arm {phrase}
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
  function render(P, o = {}) {
    if (!P) return '<div class="dim mono sm">live pilot not loaded</div>';
    const c = P.config || {}, m = P.money || {}, chip = P.statusChip || P.state;
    const banner = `<div class="pl-banner"><b>REAL MONEY</b> · this card places real Kalshi orders when ARMED. Paper v1/v2/v3 are unaffected and never mixed in.</div>`;
    const head = `<div class="pl-top"><span class="pl-chip ${CHIP[chip] || ''}">${esc(chip)}</span><button type="button" class="pl-halt" data-pilot="halt" title="Stop the pilot now and cancel its resting orders">HALT</button></div>`;
    const why = chip === 'DISABLED' ? `<div class="pl-why">Inert: ${esc((P.inert || []).join('; ') || 'disabled')}. Nothing is sent and nothing is logged.</div>`
      : chip === 'HALTED' ? `<div class="pl-why neg">HALTED: ${esc(P.haltReason || '')}${P.totalStop ? ' · total-loss stop: needs the manual reset file' : ''}</div>`
      : chip === 'DISARMED-SHADOW' ? `<div class="pl-why">SHADOW: every v3 take is logged as a would-be order. <b>No money.</b></div>` : `<div class="pl-why neg"><b>ARMED: sending real orders.</b></div>`;
    const daily = c.dailyLossStopCents == null ? 'Daily stop: OFF (paper arms have none)' : `Daily stop: ${$c(c.dailyLossStopCents)}${c.shrinkToDailyBudget ? ' · shrink-to-budget on' : ''}`;
    const facts = `<div class="pl-facts mono"><div><span class="dim">bankroll</span> <b>${$c(m.bankrollCents)}</b></div><div><span class="dim">Kalshi balance</span> ${$c(m.balanceCents)}</div>` +
      `<div><span class="dim">real P&amp;L</span> <b class="${tone(m.realizedCents)}">${$s(m.realizedCents)}</b></div><div><span class="dim">open risk</span> ${$c(m.openRiskCents)} / ${$c(c.maxOpenRiskCents)}</div>` +
      `<div><span class="dim">per trade</span> ${fin(c.perTradePct) ? Math.round(c.perTradePct * 100) + '%' : '—'} of bankroll · ≤10% of volume · asset caps</div>` +
      `<div><span class="dim">total-loss stop</span> ${$c(c.totalLossStopCents)} (permanent)</div><div>${esc(daily)}</div><div><span class="dim">limit</span> ≤ ask+1¢, ≤ ${esc(c.maxPriceCents)}¢, IOC, ${esc(c.maxSlices)} slices</div></div>`;
    const env = P.env ? `<div class="pl-env mono sm dim">env (set? only): ${Object.entries(P.env).map(([k, v]) => `${esc(k)} ${v ? '✓' : '✗'}`).join(' · ')} · config sha256 ${esc(String(P.hash || '').slice(0, 12))}…${P.killFile ? ' · <b class="neg">KILL file present</b>' : ''}</div>` : '';
    const arm = o.local && chip === 'DISARMED-SHADOW' ? `<details class="pl-arm"><summary>Arm (this computer only)</summary><p class="sm">Type <code>${esc(c.armPhrase)}</code> to arm. A read-only preflight (balance, key scope, subaccount) runs first.</p><input type="text" autocomplete="off" spellcheck="false" data-pilot="phrase" aria-label="arm phrase"><button type="button" data-pilot="arm">ARM</button></details>` : '';
    const rows = (P.trades || []).map((r) => `<tr><td>${esc(t(r.at, o.tz))}</td><td>${esc(r.tk)}</td><td>${ct(r.limit)}</td><td>${ct(r.fillPx)}</td><td>${r.contracts}/${r.requested}</td><td>${ct(r.feeCents)}</td><td>${r.result == null ? 'open' : esc(r.result)}</td><td class="${tone(r.pnlCents)}">${$s(r.pnlCents)}</td><td>${$c(r.balanceBeforeCents)} → ${$c(r.balanceAfterCents)}</td></tr>`).join('');
    const trades = `<h3 class="pl-h3">Live trades <span class="dim">(real money)</span></h3><div class="pl-scroll"><table class="pl-t mono"><thead><tr><th>time</th><th>market</th><th>limit</th><th>fill</th><th>size</th><th>fee</th><th>result</th><th>P&amp;L</th><th>balance</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="dim">no live trades yet</td></tr>'}</tbody></table></div>`;
    const cmp = (P.compare || []).map((r) => `<tr${r.shadow && !r.live ? ' class="pl-shadowrow"' : ''}><td>${esc(r.tk)}</td><td>${ct(r.decisionAsk)}</td><td>${r.paper ? `${r.paper.filled} @ ${ct(r.paper.vwapCents)}` : '—'}</td><td>${r.live ? `${r.live.filled} @ ${ct(r.live.vwapCents)}` : r.shadow ? `<span class="pl-nomoney">SHADOW · NO MONEY</span> ${r.shadow.contracts} @ ≤${ct(r.shadow.limit)}` : '—'}</td><td>${ct(r.slippageCents)}</td><td>${r.unfilled == null ? '—' : r.unfilled}</td></tr>`).join('');
    const compare = `<h3 class="pl-h3">Paper v3 7% vs live <span class="dim">(fill, slippage, unfilled)</span></h3><div class="pl-scroll"><table class="pl-t mono"><thead><tr><th>market</th><th>ask</th><th>paper fill</th><th>live fill</th><th>slip</th><th>unfilled</th></tr></thead><tbody>${cmp || '<tr><td colspan="6" class="dim">no v3 takes yet</td></tr>'}</tbody></table></div>`;
    return banner + head + why + facts + env + arm + trades + compare;
  }
  const API = { render };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }
  const H = (root.HAWSE = root.HAWSE || { onState: [] }); H.onState = H.onState || [];
  const local = /^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);
  let last = '';
  H.onState.push((S) => { const el = document.getElementById('pilotBody'); if (!el) return; const P = S && S.feeds && S.feeds.kalshiPilot;
    if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.pilot === 'phrase') return; // do not repaint while typing the phrase
    const h = render(P, { local }); if (h !== last) { last = h; el.innerHTML = h; } });
  const post = (what, body) => fetch('/api/live/kalshi-pilot/' + what, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  document.addEventListener('click', async (e) => { const b = e.target.closest && e.target.closest('[data-pilot]'); if (!b || !b.closest('#pilotBody')) return;
    if (b.dataset.pilot === 'halt') { b.disabled = true; const r = await post('halt'); b.disabled = false; if (!r.ok) alert('HALT: ' + (r.error || 'failed')); }
    if (b.dataset.pilot === 'arm') { const i = b.parentNode.querySelector('[data-pilot="phrase"]'); const r = await post('arm', { phrase: i ? i.value : '' }); if (i) i.value = ''; alert(r.ok ? 'ARMED' : 'Not armed: ' + (r.error || 'refused')); }
  });
})(typeof window !== 'undefined' ? window : globalThis);
