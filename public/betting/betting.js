/* Sports-betting module UI (self-contained: loads after app.js and only uses window.HAWSE.onState + /api/betting/*).
   Paper desk + alerts + manual slips only. No bet is ever placed from this UI. */
window.HAWSE = window.HAWSE || { onState: [] };
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n, d = 2) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (n, d = 2) => n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
  const badge = (mode) => `<span class="badge ${esc(mode)}">${esc({ live: 'LIVE', mock: 'MOCK', sim: 'SIMULATED', down: 'NO DATA', pending: 'PENDING' }[mode] || String(mode).toUpperCase())}</span>`;
  const api = async (url, body) => { const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };
  const am = (d) => { if (!(d > 1)) return '—'; const a = d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); return (a > 0 ? '+' : '') + a; };
  const local = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  let S = null;

  // ---------- existing paper betting card (moved from app.js) ----------
  function renderBetting() {
    const ids = ['bet_ev', 'bet_spread', 'bet_arb'], st = ids.map((id) => S.strategies.find((x) => x.id === id)); const [ev, sp, ar] = st;
    $('betCard').hidden = !ev; if (!ev) return;
    const f = ev.view.feed || {}; const odd = (d) => (d ? d.toFixed(2) : '—'); const t = (ms) => { const m = Math.round((ms - S.now) / 60e3); return m > 0 ? `in ${m < 120 ? m + 'm' : Math.round(m / 60) + 'h'}` : 'started'; };
    $('betMode').innerHTML = badge(f.mode === 'live' ? 'live' : f.mode === 'mock' ? 'mock' : 'pending') + (f.mode === 'live' ? ` ${esc(f.provider || '')}` : '') + (f.quota ? ` · quota left ${esc(f.quota.remaining)}` : '') + ` · ${f.upcoming || 0} upcoming`;
    $('betWarn').innerHTML = `PAPER ONLY · alerts only · real-money bet placement is a disabled stub. ${f.simulated ? '<b>MOCK odds:</b> synthetic teams &amp; books; every bet below is SIMULATED and booked to the sim ledger. ' : ''}Paper results ignore stake limits, account restrictions and line movement before acceptance. Sportsbook terms and state laws vary. ${esc(f.note || '')}`;
    const G = 'grid-template-columns:1fr 1fr 54px 54px 54px';
    $('betEv').innerHTML = `<div class="subh">+EV · best book vs no-vig consensus of the others ${badge(ev.dataMode)} ${ev.armed ? '' : '<span class="dim">(disarmed: scanning only)</span>'}</div><div class="row head" style="${G}"><span>event</span><span>pick @ book</span><span>price</span><span>fair</span><span>EV</span></div>` +
      (ev.view.opps || []).slice(0, 7).map((o) => `<div class="row ${o.evPct >= ev.view.params.minEdgePct ? 'ok' : ''}" style="${G}"><span>${esc(o.event)}<br><span class="dim sm">${t(o.commence)}</span></span><span>${esc(o.label)}<br><span class="dim sm">${esc(o.book)} · ${o.consensusBooks} books</span></span><span>${odd(o.dec)}</span><span>${odd(o.fairDec)}</span><span class="${o.evPct > 0 ? 'pos' : 'neg'}">${pct(o.evPct, 1)}</span></div>`).join('') || '<div class="dim mono sm">no comparable multi-book markets yet…</div>';
    $('betSpread').innerHTML = sp ? `<div class="subh">Spread signal · better number than consensus · ${esc(sp.view.params.assumption)}</div>` + ((sp.view.opps || []).slice(0, 4).map((o) => `<div class="row ${o.evPct >= sp.view.params.minEdgePct ? 'ok' : ''}" style="${G}"><span>${esc(o.event)}</span><span>${esc(o.label)} <span class="dim sm">vs ${o.consensusPoint > 0 ? '+' : ''}${o.consensusPoint} @ ${esc(o.book)}</span></span><span>${odd(o.dec)}</span><span>${o.pointEdge}pt</span><span class="${o.evPct > 0 ? 'pos' : 'neg'}">${pct(o.evPct, 1)}</span></div>`).join('') || '<div class="dim mono sm">no off-consensus spread numbers right now</div>') : '';
    const A = 'grid-template-columns:1fr 1.6fr 58px';
    $('betArb').innerHTML = ar ? `<div class="subh">Arbs · Σ implied of best prices across books (&lt; 1 = arb at QUOTED prices)</div><div class="row head" style="${A}"><span>event · market</span><span>legs</span><span>margin</span></div>` + ((ar.view.opps || []).slice(0, 5).map((a) => `<div class="row ${a.marginPct >= ar.view.params.minMarginPct ? 'ok' : ''}" style="${A}"><span>${esc(a.event)}<br><span class="dim sm">${esc(a.market)} ${esc(a.line)}</span></span><span class="sm">${a.legs.map((l) => `${esc(l.label)} @${esc(l.book)} ${odd(l.dec)}`).join('<br>')}</span><span class="${a.marginPct > 0 ? 'pos' : 'neg'}">${pct(a.marginPct, 2)}</span></div>`).join('') || '<div class="dim mono sm">no overlapping markets yet…</div>') : '';
    $('betMid').innerHTML = ar ? `<div class="subh">Middles · ALERTS ONLY (never staked)</div>` + ((ar.view.middles || []).slice(0, 4).map((m) => `<div class="row" style="${A}"><span>${esc(m.event)}<br><span class="dim sm">${esc(m.market)} · width ${m.width}</span></span><span class="sm">${m.legs.map((l) => `${esc(l.label)} @${esc(l.book)} ${odd(l.dec)}`).join('<br>')}</span><span class="${m.ifOneWins >= 0 ? 'pos' : 'neg'}" title="if only one side wins / if both win">${pct(m.ifOneWins, 1)}<br><span class="dim sm">both ${pct(m.ifBothWin - 0, 0)}</span></span></div>`).join('') || '<div class="dim mono sm">no middles</div>') : '';
    const rows = st.filter(Boolean).flatMap((s) => [...s.view.bets.open, ...s.view.bets.settled].map((b) => ({ ...b, sid: s.id }))).sort((a, b) => b.t - a.t).slice(0, 14);
    const stat = st.filter(Boolean).map((s) => { const c = s.view.bets.clv, k = f.simulated ? c.sim : c.real; const a = (S.attribution || []).find((x) => x.id === s.id) || {}; const pnl = f.simulated ? a.sim : a.real;
      return `<span>${esc(s.name)} ${s.armed ? '<span class="badge live">armed</span>' : '<span class="dim">disarmed</span>'} · open <b>${s.view.bets.counts.open}</b> · settled <b>${s.view.bets.counts.settled}</b> · PnL <b class="${pnl >= 0 ? 'pos' : 'neg'}">${money(pnl || 0)}</b>${f.simulated ? ' <span class="dim">(sim)</span>' : ''} · avg CLV <b>${k.n ? pct(k.avgPct, 2) : '—'}</b>${k.n ? ` (${k.n} bets, beat close ${k.beatPct.toFixed(0)}%)` : ''}</span>`; }).join('');
    const L = 'grid-template-columns:62px 1fr 1fr 50px 58px 70px 64px';
    $('betLedger').innerHTML = `<div class="subh">Paper bet ledger · fractional Kelly · caps per bet / event / open · CLV vs no-vig close</div><div class="bet-stats">${stat}</div><div class="row head betrow" style="${L}"><span>strategy</span><span>event</span><span>pick @ book</span><span>price</span><span>stake</span><span>status</span><span>CLV</span></div>` +
      rows.map((b) => `<div class="row betrow" style="${L}"><span class="sm">${esc(b.sid.replace('bet_', ''))}${b.group ? ' (arb)' : ''}</span><span class="sm">${b.simulated ? '<span class="badge sim">SIM</span> ' : ''}${esc(b.event)}${b.score ? ` <span class="dim">${esc(b.score)}</span>` : ''}</span><span class="sm">${esc(b.label)} @${esc(b.book)}</span><span>${odd(b.dec)}</span><span>${money(b.stake)}</span><span class="${b.status === 'open' ? 'dim' : b.pnl > 0 ? 'pos' : b.pnl < 0 ? 'neg' : ''}">${b.status === 'open' ? 'open' : esc(b.result) + ' ' + money(b.pnl)}</span><span class="${b.clvPct > 0 ? 'pos' : b.clvPct < 0 ? 'neg' : 'dim'}" title="${esc(b.closeNote || '')}">${b.clvPct != null ? pct(b.clvPct, 1) : b.closeNote ? 'n/a' : '—'}</span></div>`).join('') || '<div class="dim mono sm">no paper bets yet (arm a betting strategy in the Strategies panel)</div>';
  }
  // ---------- rules → signals → slips desk ----------
  const XH = (x, id) => (window.HAWSE.explain ? window.HAWSE.explain.html(x, id) : '');
  const XS = (el, html) => (window.HAWSE.explain ? window.HAWSE.explain.swap(el, html) : (el.innerHTML = html));
  let D = null, tab = 'signals', filter = 'new', editing = null, reg = null, lastResult = '';
  const params = (p) => Object.entries(p || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' ');
  const SAMPLE_PACK = { schema: 'hawse.signalTypes/1', source: { type: 'reelripper', note: 'example pack; replace with types extracted from transcripts' }, types: [
    { id: 'fade_tired_favorite', label: 'Fade a tired favorite', description: 'Opponent is a favorite on a back-to-back; signal our side.', scope: 'game', params: { minRest: { type: 'integer', default: 1 } },
      conditions: [{ type: 'back_to_back', params: { team: 'opponent' } }, { type: 'side_is', params: { side: 'underdog' } }, { type: 'rest_advantage', params: { minDays: '$minRest' } }] }] };
  const SAMPLE_TEXT = 'Fade NBA road favorites on a back-to-back, moneyline, within 12 hours of tip. Their record is 70% lock.';

  function renderDesk() {
    const el = $('betDesk'); if (!el || !D) return; el.hidden = false;
    $('bdMode').innerHTML = `odds ${badge(D.mode === 'live' ? 'live' : D.mode === 'mock' ? 'mock' : 'pending')} · stats ${badge(D.stats.simulated ? 'mock' : D.stats.mode === 'none' ? 'pending' : 'live')} · ${D.rules.filter((r) => r.enabled).length}/${D.rules.length} rules on · ${D.counts.new} new signals`;
    for (const b of el.querySelectorAll('[data-bdtab]')) b.classList.toggle('on', b.dataset.bdtab === tab);
    const body = $('bdBody');
    if (tab === 'signals') body.innerHTML = signalsHtml();
    else if (tab === 'rules') XS(body, rulesHtml());
    else if (tab === 'import') { if (!$('bdImportText')) body.innerHTML = importHtml(); $('bdImportOut').innerHTML = lastResult; }
    else if (tab === 'venues') body.innerHTML = venuesHtml();
  }
  function signalsHtml() {
    const fs = ['new', 'reviewed', 'slipped', 'dismissed', 'all'];
    const rows = D.signals.filter((s) => filter === 'all' || s.status === filter);
    const G = 'grid-template-columns:1.1fr 1.2fr 1.1fr 62px 62px 58px 1.6fr 168px';
    return `<div class="bd-chips">${fs.map((f) => `<button type="button" class="chip ${f === filter ? 'on' : ''}" data-bdfilter="${f}">${f} ${f === 'all' ? D.signals.length : D.counts[f] || 0}</button>`).join('')}<button type="button" class="btn sm ghost" data-bdscan>Scan now</button></div>
      <div class="tbl bd-list"><div class="row head bdrow" style="${G}"><span>rule</span><span>game</span><span>pick @ book</span><span>price</span><span>fair</span><span>EV</span><span>why it matched</span><span></span></div>` +
      (rows.slice(0, 40).map((s) => `<div class="row bdrow ${s.status === 'new' ? 'ok' : ''} ${s.expired ? 'expired' : ''}" style="${G}"><span>${esc(s.ruleName)}<br><span class="dim sm">${esc(s.status)}${s.expired ? ' · started' : ''}</span></span><span>${s.simulated ? '<span class="badge sim">SIM</span> ' : ''}${esc(s.event)}<br><span class="dim sm">${esc(local(s.commence))}</span></span><span>${esc(s.label)}<br><span class="dim sm">@ ${esc(s.book)}</span></span><span>${am(s.dec)}</span><span>${s.fairProb ? am(1 / s.fairProb) : '—'}</span><span class="${s.evPct > 0 ? 'pos' : 'neg'}">${pct(s.evPct, 1)}</span><span class="sm">${s.matched.map((m) => `<b>${esc(m.type)}</b> ${esc(m.detail)}`).join('<br>')}${s.simulated ? `<br><span class="warn">${esc(s.simReasons.join('; '))}</span>` : ''}</span><span class="bd-act"><button type="button" class="btn sm" data-bdslip="${esc(s.id)}">Slip</button>${s.status === 'new' ? `<button type="button" class="btn sm ghost" data-bdst="reviewed" data-id="${esc(s.id)}">Reviewed</button>` : ''}${s.status !== 'dismissed' ? `<button type="button" class="btn sm ghost" data-bdst="dismissed" data-id="${esc(s.id)}">Dismiss</button>` : ''}</span></div>`).join('') ||
      `<div class="dim mono sm">${D.rules.some((r) => r.enabled) ? 'No signals in this view. Enabled rules are scanning upcoming games.' : 'No rules enabled. Open the Rules tab, add a template or import one, and switch it on.'}</div>`) + '</div>';
  }
  function rulesHtml() {
    return `<div class="bd-chips"><select id="bdTpl" class="inp" aria-label="Rule template"><option value="">Add from template…</option>${(D.templates || []).map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select><button type="button" class="btn sm" data-bdnew>New rule (JSON)</button><a class="btn sm ghost" href="/api/betting/registry" target="_blank" rel="noopener">Signal types (${D.builtinTypes} built-in, ${D.customTypes} custom)</a></div>` +
      (D.rules.map((r) => `<div class="bd-rule ${r.enabled ? 'on' : ''}"><div class="bd-rule-h"><button type="button" class="toggle ${r.enabled ? 'on' : ''}" data-bdon="${esc(r.id)}" aria-pressed="${r.enabled}">${r.enabled ? 'ON' : 'OFF'}</button><b>${esc(r.name)}</b><span class="dim sm">v${r.version} · ${esc(r.match)} · ${esc(r.source && r.source.type)} · ${r.signals} signals</span><span class="bd-act"><button type="button" class="btn sm ghost" data-bdedit="${esc(r.id)}">Edit</button><a class="btn sm ghost" href="/api/betting/rules/${esc(r.id)}/export">Export</a><button type="button" class="btn sm ghost" data-bddel="${esc(r.id)}">Delete</button></span></div>
        ${r.description ? `<div class="dim sm">${esc(r.description)}</div>` : ''}<div class="bd-conds">${r.conditions.map((c) => `<span class="cond">${c.negate ? 'NOT ' : ''}<b>${esc(c.type)}</b> ${esc(params(c.params))}</span>`).join('')}</div>${XH(r.explain, 'rule:' + r.id + ':' + r.version)}</div>`).join('') || '<div class="dim mono sm">No rules yet.</div>') +
      (editing ? `<div class="bd-editor"><div class="subh">${editing.id ? 'Edit rule ' + esc(editing.id) : 'New rule'} · JSON (hawse.betRule/1)</div><textarea id="bdJson" class="inp mono" rows="14" spellcheck="false">${esc(JSON.stringify(editing.rule, null, 2))}</textarea><div class="bd-chips"><button type="button" class="btn sm" data-bdsave>Save rule</button><button type="button" class="btn sm ghost" data-bdcancel>Cancel</button></div><div id="bdErr" class="sm"></div></div>` : '');
  }
  function importHtml() {
    return `<p class="dim sm keynote">Paste a rule (<code>hawse.betRule/1</code>), a list (<code>hawse.betRules/1</code>), a signal-type pack (<code>hawse.signalTypes/1</code>, e.g. types extracted from ReelRipper transcripts), or plain text. Text is mapped by a fixed phrase table into a <b>disabled draft</b>; every mapped and unmapped phrase is shown. The strategy lab's import box accepts the same JSON.</p>
      <textarea id="bdImportText" class="inp mono" rows="9" spellcheck="false" placeholder="JSON or plain text"></textarea>
      <div class="bd-chips"><button type="button" class="btn sm" data-bdimp="json">Import JSON</button><button type="button" class="btn sm" data-bdimp="text">Import text</button><button type="button" class="btn sm ghost" data-bdsample="pack">Sample signal-type pack</button><button type="button" class="btn sm ghost" data-bdsample="text">Sample text</button><a class="btn sm ghost" href="/api/betting/signal-types/export">Export custom types</a></div><div id="bdImportOut" class="sm"></div>`;
  }
  function venuesHtml() {
    return `<p class="dim sm keynote">Direct venue links are <b>disabled</b>. These adapters are an interface for a later, separately reviewed change: your own account, credentials from server env vars only, and a <b>per-order approval</b> you give in the UI for each order. Every method refuses today. Use the slip to place bets yourself.</p><div class="bd-venues">` +
      D.venues.map((v) => `<div class="bd-venue"><div><b>${esc(v.label)}</b> <span class="badge down">DISABLED</span></div><div class="dim sm">${esc(v.auth)}</div><div class="subh">env var names (values never shown)</div>${v.envVars.map((e) => `<div class="sm"><code>${esc(e.name)}</code> <span class="dim">${esc(e.note || '')}</span></div>`).join('')}<div class="subh">methods</div><div class="sm dim">${v.methods.join(' · ')}</div><div class="bd-chips"><button type="button" class="btn sm ghost" data-bdvenue="${esc(v.id)}">Try connect (refuses)</button><a class="btn sm ghost" href="${esc(v.docs)}" target="_blank" rel="noopener">API docs</a></div><div class="sm" id="bdVenue-${esc(v.id)}"></div></div>`).join('') + '</div>';
  }

  // ---------- slip modal (print / copy / download) ----------
  async function openSlip(id) {
    const x = await api(`/api/betting/signals/${encodeURIComponent(id)}/slip`); if (!x.slip) return;
    const s = x.slip, m = $('slipModal');
    $('slipBody').innerHTML = `${s.simulated ? `<div class="slip-wm">${esc(s.watermark)}</div>` : ''}
      <div class="slip-h"><div><div class="label">HAWSE bet slip · manual placement</div><h3>${esc(s.selection)}</h3><div>${esc(s.event)} · ${esc(s.marketName)}</div></div><div class="slip-id mono sm">${esc(s.id)}<br>${esc(local(s.generatedAt))}</div></div>
      <div class="slip-grid mono">
        <div><small>Starts</small>${esc(local(s.startsAt))}</div><div><small>Seen at ${esc(s.seenAt.book)}</small>${esc(s.seenAt.american)} <span class="dim">(${s.seenAt.decimal})</span></div>
        <div><small>Fair (no-vig, ${s.fair ? s.fair.books : 0} books)</small>${s.fair ? `${esc(s.fair.american)} <span class="dim">${(s.fair.prob * 100).toFixed(1)}%</span>` : '—'}</div><div><small>Edge at seen price</small>${s.evPct == null ? '—' : pct(s.evPct, 2)}</div>
        <div><small>Worst price with edge</small>${s.worstPrice ? esc(s.worstPrice.american) : '—'}</div><div><small>Prediction market YES</small>${s.predictionMarket ? '≤ ' + s.predictionMarket.maxYesCents + '¢ before fees' : '—'}</div>
        <div><small>Stake idea</small>${money(s.stake.suggestedUsd, 0)} <span class="dim">${s.stake.pctOfBankroll}% of ${money(s.stake.bankrollUsd, 0)} paper</span></div><div><small>Rule</small>${esc(s.rule.name)} v${s.rule.version}</div>
      </div>
      <div class="subh">Why it matched</div><ul class="sm">${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      ${s.predictionMarket ? `<p class="sm dim">${esc(s.predictionMarket.note)}</p>` : ''}
      <div class="subh">Before you place it</div><ul class="sm slip-check">${s.checklist.map((c) => `<li>☐ ${esc(c)}</li>`).join('')}</ul><p class="sm slip-disc">${esc(s.disclaimer)}</p>`;
    m.dataset.id = id; m.dataset.text = x.text; m.hidden = false; $('slipCopyMsg').textContent = '';
  }
  const markSlipped = (id) => api(`/api/betting/signals/${encodeURIComponent(id)}/status`, { status: 'slipped' }).then(refresh);
  const download = (href) => { const a = document.createElement('a'); a.href = href; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); };

  async function refresh() { D = { ...(await api('/api/betting')), templates: D && D.templates }; if (!D.templates) D.templates = await api('/api/betting/templates'); renderDesk(); }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button,select'); if (!t || !t.closest('#betDesk,#slipModal')) return;
    const d = t.dataset;
    if (d.bdtab) { tab = d.bdtab; editing = tab === 'rules' ? editing : null; $('bdBody').innerHTML = ''; renderDesk(); }
    else if (d.bdfilter) { filter = d.bdfilter; renderDesk(); }
    else if (d.bdscan !== undefined) { await api('/api/betting/scan', {}); refresh(); }
    else if (d.bdst) { await api(`/api/betting/signals/${encodeURIComponent(d.id)}/status`, { status: d.bdst }); refresh(); }
    else if (d.bdslip) openSlip(d.bdslip);
    else if (d.bdon) { const r = D.rules.find((x) => x.id === d.bdon); await api(`/api/betting/rules/${encodeURIComponent(d.bdon)}/enable`, { on: !r.enabled }); refresh(); }
    else if (d.bddel) { if (confirm('Delete this rule? Its signals stay in the list.')) { await api(`/api/betting/rules/${encodeURIComponent(d.bddel)}/delete`, {}); refresh(); } }
    else if (d.bdedit) { const r = (await api('/api/betting')).rulesFull.find((x) => x.id === d.bdedit); const { id, version, updatedAt, ...rule } = r; editing = { id, rule }; renderDesk(); }
    else if (d.bdnew !== undefined) { editing = { rule: { schema: 'hawse.betRule/1', name: 'My rule', enabled: false, match: 'all', cooldownMin: 30, conditions: [{ type: 'ev_at_least', params: { minPct: 2, minBooks: 3 } }] } }; renderDesk(); }
    else if (d.bdcancel !== undefined) { editing = null; renderDesk(); }
    else if (d.bdsave !== undefined) { let rule; try { rule = JSON.parse($('bdJson').value); } catch (err) { $('bdErr').innerHTML = `<span class="neg">invalid JSON: ${esc(err.message)}</span>`; return; }
      const r = await api(editing.id ? `/api/betting/rules/${encodeURIComponent(editing.id)}` : '/api/betting/rules', { rule }); if (!r.ok) { $('bdErr').innerHTML = r.errors.map((x) => `<div class="neg">${esc(x)}</div>`).join(''); return; } editing = null; refresh(); }
    else if (d.bdimp) { const v = $('bdImportText').value; const r = await api('/api/betting/import', d.bdimp === 'json' ? { json: v } : { text: v });
      lastResult = `<div class="${r.ok ? 'pos' : 'neg'}">${r.ok ? `Imported ${esc(r.kind || (r.rule ? "text rule" : "item"))}${r.added ? ': ' + r.added.map(esc).join(', ') : r.rule ? ': ' + esc(r.rule.name) + ' (disabled draft)' : r.rules ? ': ' + r.rules.length + ' rule(s), disabled' : ''}` : 'Import failed'}</div>` +
        ['errors', 'mapped', 'unmapped', 'warnings'].map((k) => (r[k] && r[k].length ? `<div class="subh">${k}</div>${r[k].map((x) => `<div class="${k === 'errors' ? 'neg' : k === 'warnings' || k === 'unmapped' ? 'warn' : 'dim'}">${esc(x)}</div>`).join('')}` : '')).join('');
      refresh(); }
    else if (d.bdsample) { $('bdImportText').value = d.bdsample === 'pack' ? JSON.stringify(SAMPLE_PACK, null, 2) : SAMPLE_TEXT; }
    else if (d.bdvenue) { const r = await api(`/api/betting/venues/${d.bdvenue}/connect`, {}); $('bdVenue-' + d.bdvenue).innerHTML = `<span class="neg">${esc(r.code)}: ${esc(r.error)}</span>`; }
    else if (d.slip) { const m = $('slipModal'), id = m.dataset.id;
      if (d.slip === 'close') m.hidden = true;
      else if (d.slip === 'print') { window.print(); markSlipped(id); }
      else if (d.slip === 'copy') { try { await navigator.clipboard.writeText(m.dataset.text); $('slipCopyMsg').textContent = 'Copied slip text.'; } catch { $('slipCopyMsg').textContent = 'Clipboard blocked; use Download .txt.'; } markSlipped(id); }
      else { download(`/api/betting/signals/${encodeURIComponent(id)}/slip.${d.slip}`); markSlipped(id); } }
  });
  document.addEventListener('change', async (e) => { if (e.target.id === 'bdTpl' && e.target.value !== '') { await api('/api/betting/rules', { fromTemplate: +e.target.value }); refresh(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('slipModal')) $('slipModal').hidden = true; });

  window.HAWSE.onState.push((state) => {
    S = state; renderBetting();
    const snap = state.feeds && state.feeds.betdesk; if (!snap) return;
    const typing = document.activeElement && ['bdJson', 'bdImportText', 'bdTpl'].includes(document.activeElement.id);
    D = { ...snap, templates: D && D.templates }; if (!D.templates) { D.templates = []; api('/api/betting/templates').then((t) => { D.templates = t; renderDesk(); }); }
    if (!typing && !editing) renderDesk(); else if (!typing) { const bar = $('bdMode'); if (bar) renderDeskHeaderOnly(); }
  });
  function renderDeskHeaderOnly() { $('bdMode').innerHTML = `${D.counts.new} new signals`; }
})();
