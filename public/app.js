/* HAWSE paper desk client. Renders server state (SSE). Holds no secrets and places no orders. */
window.HAWSE = window.HAWSE || { onState: [] }; // tiny host hook for module UIs

// Strategy explainer boxes ("How it works"): native <details>/<summary>, so they are keyboard (Tab + Enter/Space), screen-reader
// and touch friendly with no JS needed to open them. Text comes from the server explainers (generated from the strategy code's own
// constants/config). Open state and focus survive the desk's periodic innerHTML re-renders.
window.HAWSE.explain = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const open = new Set();
  document.addEventListener('toggle', (e) => { const d = e.target; if (d && d.classList && d.classList.contains('explain') && d.dataset.xid) d.open ? open.add(d.dataset.xid) : open.delete(d.dataset.xid); }, true);
  function html(x, id, label = 'How it works') {
    if (!x || !x.what) return '';
    const rules = (x.rules || []).map((r) => `<div class="x-row"><dt>${esc(r.k)}</dt><dd><ul>${r.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></dd></div>`).join('');
    return `<details class="explain" data-xid="${esc(id)}"${open.has(id) ? ' open' : ''}><summary><span class="x-caret" aria-hidden="true"></span>${esc(label)}</summary>` +
      `<div class="x-body"><p class="x-what">${esc(x.what)}</p>${rules ? `<dl class="x-rules">${rules}</dl>` : ''}</div></details>`;
  }
  /** Replace el.innerHTML, then put keyboard focus back on the same explainer summary if it had it. */
  function swap(el, markup) {
    const a = document.activeElement, d = a && a.tagName === 'SUMMARY' && el.contains(a) && a.parentElement.dataset.xid;
    el.innerHTML = markup;
    if (d) { const s = el.querySelector(`details.explain[data-xid="${CSS.escape(d)}"] > summary`); if (s) s.focus({ preventScroll: true }); }
  }
  return { html, swap, isOpen: (id) => open.has(id) };
})();
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n, d = 2) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const signed = (n, d = 2) => n == null || !isFinite(n) ? '<span class="dim">—</span>' : `<span class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(d)}</span>`;
  const pct = (n, d = 2) => n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
  const hhmmss = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false });
  const ago = (ms) => ms == null ? '—' : ms < 1000 ? 'now' : ms < 60e3 ? Math.round(ms / 1000) + 's' : ms < 3600e3 ? Math.round(ms / 60e3) + 'm' : Math.round(ms / 3600e3) + 'h';
  const compact = (n) => Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(0);
  const pxFmt = (p) => p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);
  const BADGE_CLASS = { 'missing key': 'missing', 'mocked (missing key)': 'mock', mocked: 'mock', stale: 'stale', 'not implemented': 'pending', idle: 'pending' };
  const badge = (mode) => `<span class="badge ${esc(BADGE_CLASS[mode] || mode)}">${esc({ live: 'LIVE', mock: 'MOCK', sim: 'SIMULATED', mixed: 'MIXED', down: 'NO DATA', indicative: 'INDICATIVE', pending: 'PENDING', stale: 'STALE' }[mode] || String(mode).toUpperCase())}</span>`;
  const heatColor = (v, scale) => {
    if (v == null || !isFinite(v)) return 'transparent';
    const a = Math.min(1, Math.abs(v) / scale);
    return v >= 0 ? `rgba(61,255,176,${0.08 + a * 0.55})` : `rgba(255,61,90,${0.08 + a * 0.55})`;
  };
  const post = (url, body = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

  let S = null, tapeFilter = 'all', lastTapeId = 0;

  // ---------- mode switch ----------
  document.querySelectorAll('.mode').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  function setMode(m) {
    document.querySelectorAll('.mode').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    $('liveView').hidden = m !== 'live'; $('demoView').hidden = m !== 'demo';
    if (m === 'demo' && $('demoFrame').src === 'about:blank') $('demoFrame').src = 'demo/index.html';
    try { localStorage.setItem('hawse.mode', m); } catch {}
    if (m === 'live') requestAnimationFrame(() => { sizeCanvas($('curve')); });
  }
  const qMode = new URLSearchParams(location.search).get('mode');
  if (qMode === 'demo' || (!qMode && (() => { try { return localStorage.getItem('hawse.mode') === 'demo'; } catch { return false; } })())) setMode('demo');

  // ---------- controls ----------
  $('haltBtn').onclick = () => post('/api/halt');
  $('resumeBtn').onclick = () => post('/api/resume');
  $('resetBrk').onclick = () => post('/api/reset-breaker');
  $('riskForm').onsubmit = (e) => { e.preventDefault(); post('/api/risk', { dailyLossPct: +$('dailyIn').value, maxDrawdownPct: +$('ddIn').value }).then(loadExplain); }; // explainers quote the risk gate
  $('tapeChips').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; tapeFilter = b.dataset.f; document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b)); renderTape(true); };
  $('strats').onclick = (e) => {
    const b = e.target.closest('[data-arm]'); if (!b) return;
    const s = S && S.strategies.find((x) => x.id === b.dataset.arm); if (!s) return;
    post(`/api/strategy/${encodeURIComponent(s.id)}/arm`, { armed: !s.armed }).then(() => { s.armed = !s.armed; renderStrats(); });
  };

  // ---------- stream ----------
  function connect() {
    const es = new EventSource('/api/stream');
    es.onopen = () => { $('conn').className = 'conn ok'; $('conn').querySelector('b').textContent = 'stream live'; };
    es.onmessage = (ev) => { S = JSON.parse(ev.data); render(); };
    es.onerror = () => { $('conn').className = 'conn bad'; $('conn').querySelector('b').textContent = 'reconnecting'; };
  }
  connect();
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false, timeZoneName: 'short' }); }, 1000);

  function render() {
    renderHero(); renderTicker(); renderStrats(); renderRisk(); renderFunding(); renderAttr(); renderHealth(); renderTape();
    renderWhales(); renderFollow(); renderMev(); renderGaps(); renderOnePct(); renderPerps(); renderFutures(); (window.HAWSE.onState || []).forEach((f) => { try { f(S); } catch (e) { console.error(e); } }); // module UIs (public/betting/)
  }

  // ---------- hero + animated curve ----------
  let shownEq = null;
  function renderHero() {
    const t = S.totals, r = S.risk.real;
    const target = t.realEquity;
    if (shownEq == null) shownEq = target;
    const from = shownEq, t0 = performance.now();
    const anim = (now) => { const k = Math.min(1, (now - t0) / 700); shownEq = from + (target - from) * (1 - Math.pow(1 - k, 3)); $('equity').textContent = money(shownEq); if (k < 1) requestAnimationFrame(anim); };
    requestAnimationFrame(anim);
    $('pnlTotal').innerHTML = signed(t.realPnl);
    $('pnlDay').innerHTML = signed(r.dayPnl);
    $('ddNow').innerHTML = `<span class="${r.drawdownPct > 0 ? 'neg' : 'dim'}">${r.drawdownPct.toFixed(2)}%</span>`;
    $('simBook').innerHTML = `SIM BOOK (mock/simulated inputs, separate) · ${signed(t.simPnl)}`;
    const gate = S.risk.real.ok && S.risk.sim.ok;
    $('gateChip').className = 'gatechip ' + (gate ? 'ok' : 'bad');
    $('gateChip').textContent = gate ? 'GATE OPEN' : 'GATE HALTED';
    renderStaleChip();
    curveTarget = S.curve;
    if (S.curve.length) $('curveSpan').textContent = `· ${S.curve.length} samples · ${ago(S.now - S.curve[0].t)} window`;
  }
  let curveTarget = [], curvePhase = 0;
  function sizeCanvas(c) { const dpr = devicePixelRatio || 1; const w = c.clientWidth, h = c.clientHeight; if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; } const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, w, h }; }
  let hoverX = null;
  $('curve').addEventListener('pointermove', (e) => { const r = e.target.getBoundingClientRect(); hoverX = e.clientX - r.left; });
  $('curve').addEventListener('pointerleave', () => { hoverX = null; $('curveTip').hidden = true; });
  function drawCurve(ts) {
    requestAnimationFrame(drawCurve);
    const c = $('curve'); if (!c.clientWidth || $('liveView').hidden) return;
    const { ctx, w, h } = sizeCanvas(c);
    ctx.clearRect(0, 0, w, h);
    const data = curveTarget; const padL = 8, padR = 64, padT = 10, padB = 18;
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = padT + (h - padT - padB) * i / 4; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); }
    if (!data || data.length < 2) { ctx.fillStyle = '#6b7a89'; ctx.font = '11px IBM Plex Mono'; ctx.fillText('collecting equity samples…', padL + 6, h / 2); return; }
    const vals = data.flatMap((d) => [d.real, d.sim]);
    let min = Math.min(...vals), max = Math.max(...vals);
    const span = Math.max(max - min, S.totals.start * 0.002); const mid = (max + min) / 2; min = mid - span * 0.6; max = mid + span * 0.6;
    const X = (i) => padL + (i / (data.length - 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
    // baseline (start equity)
    const yb = Y(S.totals.start); ctx.setLineDash([2, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(padL, yb); ctx.lineTo(w - padR, yb); ctx.stroke(); ctx.setLineDash([]);
    // axis labels
    ctx.fillStyle = '#6b7a89'; ctx.font = '10px IBM Plex Mono';
    for (let i = 0; i <= 4; i++) { const v = max - (max - min) * i / 4; ctx.fillText(money(v, 0), w - padR + 6, padT + (h - padT - padB) * i / 4 + 3); }
    // sim line (dashed cyan)
    ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(79,216,255,0.75)'; ctx.lineWidth = 1.4; ctx.beginPath();
    data.forEach((d, i) => i ? ctx.lineTo(X(i), Y(d.sim)) : ctx.moveTo(X(i), Y(d.sim))); ctx.stroke(); ctx.setLineDash([]);
    // real area + line with glow
    const up = data[data.length - 1].real >= S.totals.start;
    const col = up ? '61,255,176' : '255,61,90';
    const g = ctx.createLinearGradient(0, padT, 0, h); g.addColorStop(0, `rgba(${col},0.28)`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); data.forEach((d, i) => i ? ctx.lineTo(X(i), Y(d.real)) : ctx.moveTo(X(i), Y(d.real)));
    ctx.lineTo(X(data.length - 1), h - padB); ctx.lineTo(X(0), h - padB); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); data.forEach((d, i) => i ? ctx.lineTo(X(i), Y(d.real)) : ctx.moveTo(X(i), Y(d.real)));
    ctx.strokeStyle = `rgb(${col})`; ctx.lineWidth = 2; ctx.shadowColor = `rgba(${col},0.6)`; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
    // scanning sweep + pulsing head
    curvePhase = (ts / 1000) % 1;
    const lx = X(data.length - 1), ly = Y(data[data.length - 1].real);
    ctx.beginPath(); ctx.arc(lx, ly, 3 + 5 * curvePhase, 0, Math.PI * 2); ctx.strokeStyle = `rgba(${col},${1 - curvePhase})`; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fillStyle = `rgb(${col})`; ctx.fill();
    const sx = padL + ((ts / 4000) % 1) * (w - padL - padR); const sg = ctx.createLinearGradient(sx - 40, 0, sx, 0); sg.addColorStop(0, 'rgba(61,255,176,0)'); sg.addColorStop(1, 'rgba(61,255,176,0.06)');
    ctx.fillStyle = sg; ctx.fillRect(sx - 40, padT, 40, h - padT - padB);
    // hover
    if (hoverX != null) {
      const i = Math.max(0, Math.min(data.length - 1, Math.round((hoverX - padL) / (w - padL - padR) * (data.length - 1))));
      const d = data[i]; ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), h - padB); ctx.stroke();
      const tip = $('curveTip'); tip.hidden = false; tip.style.left = Math.min(X(i) + 10, w - 190) + 'px'; tip.style.top = '24px';
      tip.innerHTML = `${hhmmss(d.t)}<br>real ${money(d.real)}<br><span style="color:var(--cyan)">sim ${money(d.sim)}</span>`;
    }
  }
  requestAnimationFrame(drawCurve);

  function renderTicker() {
    const items = Object.entries(S.prices).sort();
    const extra = (S.feeds.dex && S.feeds.dex.ticker) || [];
    const html = items.map(([s, p]) => `<span><b>${esc(s)}</b>${pxFmt(p.px)}<i>${esc(p.venue)}</i></span>`).concat(extra.map((x) => `<span><b>${esc(x.label)}</b>${pxFmt(x.px)}<i>${esc(x.src)}</i></span>`)).join('');
    const tr = $('ticker'); const next = html + html; if (tr.dataset.h !== html) { tr.innerHTML = next || '<span class="dim">waiting for prices…</span>'; tr.dataset.h = html; }
  }

  // ---------- strategies ----------
  // Explainers are fetched once (they derive from server config, not ticks) and re-fetched rarely.
  let XP = {}, xpAt = 0;
  const loadExplain = () => { xpAt = Date.now(); fetch('/api/explain').then((r) => r.json()).then((j) => { XP = Object.fromEntries((j.strategies || []).map((x) => [x.id, x])); renderStrats(); }).catch(() => { xpAt = 0; }); };
  function renderStrats() {
    if (!xpAt || Date.now() - xpAt > 300e3) loadExplain();
    const attr = Object.fromEntries(S.attribution.map((a) => [a.id, a]));
    const root = $('strats');
    // Keyed cards: the live part re-renders each tick; the explainer <details> is only rebuilt when its text changes,
    // so an open box stays open and keeps keyboard focus.
    const want = S.strategies.map((s) => s.id);
    for (const el of [...root.children]) if (!want.includes(el.dataset.sid)) el.remove();
    S.strategies.forEach((s, i) => {
      let card = root.querySelector(`:scope > .strat[data-sid="${CSS.escape(s.id)}"]`);
      if (!card) { card = document.createElement('div'); card.className = 'strat'; card.dataset.sid = s.id; card.innerHTML = '<div class="strat-live"></div><div class="strat-x"></div><div class="strat-skip"></div>'; }
      if (root.children[i] !== card) root.insertBefore(card, root.children[i] || null);
      const a = attr[s.id] || { real: 0, sim: 0, realStats: {}, simStats: {} };
      const st = s.dataMode === 'mock' || s.dataMode === 'sim' ? a.simStats : a.realStats;
      const tr = (st.trades || 0); const wr = tr ? Math.round((st.wins || 0) / tr * 100) + '%' : '—';
      const skip = s.lastSkip ? `<div class="skip">⟂ ${esc(s.lastSkip.reason)}${s.lastSkip.detail ? ' — ' + esc(s.lastSkip.detail) : ''}</div>` : `<div class="skip" style="border-color:var(--line2)">${s.armed ? 'evaluating…' : 'disarmed · scanning only, no paper entries'}</div>`;
      card.classList.toggle('armed', !!s.armed);
      const live = `<div class="strat-top"><span class="strat-name">${esc(s.name)}</span><button type="button" class="toggle ${s.armed ? 'on' : ''}" data-arm="${esc(s.id)}" aria-pressed="${s.armed}">${s.armed ? 'ARMED' : 'DISARMED'}</button></div>
        <div class="badges">${badge(s.dataMode)}${(s.chains || []).map((c) => `<span class="badge">${esc(c)}</span>`).join('')}</div>
        <div class="strat-desc">${esc(s.desc)}</div>
        <div class="stats"><div><small>real PnL</small>${signed(a.real)}</div><div><small>sim PnL</small>${signed(a.sim)}</div><div><small>trades · win</small>${tr} · ${wr}</div></div>`;
      const L = card.children[0]; if (L.dataset.h !== live) { L.innerHTML = live; L.dataset.h = live; }
      const xh = window.HAWSE.explain.html(XP[s.id], 'desk:' + s.id); const XE = card.children[1]; if (XE.dataset.h !== xh) { window.HAWSE.explain.swap(XE, xh); XE.dataset.h = xh; }
      const K = card.children[2]; if (K.dataset.h !== skip) { K.innerHTML = skip; K.dataset.h = skip; }
    });
  }

  // ---------- risk ----------
  function renderRisk() {
    const r = S.risk.real, sm = S.risk.sim;
    const meter = (label, v, lim, unit = '%') => { const k = Math.min(1, Math.max(0, v / lim)); const col = k > 0.8 ? 'var(--hot)' : k > 0.5 ? 'var(--amber)' : 'var(--mint)';
      return `<div class="meter"><div class="label">${label}</div><div class="v mono">${v.toFixed(2)}${unit} <span class="dim sm">/ ${lim}${unit}</span></div><div class="bar"><i style="left:0;width:${k * 100}%;background:${col}"></i></div></div>`; };
    const dayLoss = Math.max(0, -r.dayPnl / r.dayStart * 100);
    $('riskBody').innerHTML = `<div class="riskgrid">${meter('Day loss (real)', dayLoss, r.dailyLossPct)}${meter('Drawdown (real)', r.drawdownPct, r.maxDrawdownPct)}</div>
      <div class="tbl" style="margin-bottom:10px">
        <div class="row" style="grid-template-columns:90px 1fr"><span class="dim">real book</span><span class="${r.ok ? 'pos' : 'neg'}">${r.ok ? 'OPEN · new risk allowed' : 'HALTED · ' + esc(r.reason)}</span></div>
        <div class="row" style="grid-template-columns:90px 1fr"><span class="dim">sim book</span><span class="${sm.ok ? 'pos' : 'neg'}">${sm.ok ? 'OPEN' : 'HALTED · ' + esc(sm.reason)}</span></div>
        <div class="row" style="grid-template-columns:90px 1fr"><span class="dim">live orders</span><span class="neg">DISABLED (stub refuses)</span></div>
      </div>`;
    if (document.activeElement !== $('dailyIn')) $('dailyIn').value = r.dailyLossPct;
    if (document.activeElement !== $('ddIn')) $('ddIn').value = r.maxDrawdownPct;
    $('riskTs').textContent = 'peak ' + money(r.peak, 0);
  }

  // ---------- funding ----------
  function renderFunding() {
    const f = S.funding; const by = {};
    for (const r of f.rows) by[r.symbol + '|' + r.venue] = r;
    const cols = f.venues.length + 1;
    let h = `<div class="heat" style="grid-template-columns:64px repeat(${f.venues.length},minmax(84px,1fr))"><div class="h"></div>` + f.venues.map((v) => `<div class="h">${esc(v)}</div>`).join('');
    for (const s of f.symbols) {
      h += `<div class="rh">${esc(s)}</div>`;
      for (const v of f.venues) {
        const r = by[s + '|' + v];
        if (!r) { h += `<div class="c na">n/a</div>`; continue; }
        const apr = r.hourly * 24 * 365 * 100;
        h += `<div class="c" style="background:${heatColor(apr, 30)}" title="${esc(v)} ${esc(s)} rate ${(r.rate * 100).toFixed(4)}% per ${r.intervalH}h · mark ${r.mark}">${apr.toFixed(1)}%<br><span class="dim" style="font-size:9px">${r.intervalH}h · ${(r.rate * 100).toFixed(4)}%</span></div>`;
      }
    }
    $('fundHeat').innerHTML = h + '</div>';
    void cols;
    const fs = S.strategies.find((x) => x.id === 'funding');
    const v = (fs && fs.view) || {}, best = v.best || [], g = v.gates || {};
    const G = 'grid-template-columns:44px 1fr 58px 50px 62px 62px 62px 66px';
    const pct = (x, d = 1) => (x == null ? '—' : x.toFixed(d) + '%');
    const fundRow = (b) => `<div class="row ${b.ok ? 'ok' : ''}" style="${G}" title="${esc(b.reason || 'passes every v2 gate')}${b.predSrc ? ' · forecast: ' + esc(b.predSrc) : ''}${b.liqCapped ? ' · size cut by liquidity rule' : ''}"><span>${esc(b.symbol)}</span><span>${b.long ? esc(b.long) + ' / ' + esc(b.short) : '<span class="dim">' + esc(b.reason) + '</span>'}</span><span>${pct(b.spreadApr)}</span><span class="${b.persistCount >= (g.persistPrints || 3) ? 'pos' : 'dim'}">${b.persistCount == null ? '—' : b.persistCount + '/' + (g.persistPrints || 3)}</span><span class="${b.predictedApr > 0 ? 'pos' : b.predictedApr == null ? 'dim' : 'neg'}">${pct(b.predictedApr)}</span><span class="${b.netBps > 0 ? 'pos' : 'neg'}">${b.netBps == null ? '—' : b.netBps.toFixed(1) + 'bp'}</span><span class="${b.aprPct > 0 ? 'pos' : 'neg'}">${pct(b.aprPct)}</span><span class="${b.ok ? 'pos' : 'dim'}">${b.ok ? 'QUALIFIES' : 'skip'}</span></div>`;
    const head = (first) => `<div class="row head" style="${G}"><span>sym</span><span>${first}</span><span>spread APR</span><span>persist</span><span>pred APR</span><span>net</span><span>net APR</span><span>status</span></div>`;
    $('fundGates').textContent = `Perp↔perp v2 · net ≥ ${v.minNetBps ?? 8}bp/${v.holdHours ?? 24}h · APR ≥ ${g.minApr ?? 10}% · basis ≤ ${g.maxEntryBasisBps ?? 15}bp · ${g.persistPrints ?? 3} positive obs (1 per ${Math.round((g.obsSec || 900) / 60)} min) · forecast ${g.usePredicted === false ? 'off' : 'on'}`;
    $('fundBest').innerHTML = head('long / short') + (best.map(fundRow).join('') || '<div class="dim mono sm">waiting for 2+ live venues…</div>');
    const carry = v.carry || [];
    $('fundCarry').innerHTML = g.carry && g.carry.enabled ? `<div class="subh">Cash &amp; carry v2 · long spot / short perp on one venue · net ≥ ${g.carry.minNetBps}bp/${g.carry.holdHours}h</div>` + head('spot / perp') + (carry.map(fundRow).join('') || '<div class="dim mono sm">no fresh spot + perp book on the same venue yet</div>') : '<div class="dim mono sm">carry mode off (CARRY_ENABLED=false)</div>';
    const sc = v.score;
    if (sc) {
      const P = sc.plan, cell = (m, k, f) => (m && m[k] != null ? f(m[k]) : '—');
      const line = (label, m, tag) => !m ? '' : `<div class="row" style="grid-template-columns:1.4fr .6fr .8fr .8fr .8fr .8fr .7fr 1fr"><span>${label} ${tag}</span><span>${m.n}</span><span>${(m.n ? signed(m.realized) : '—')}</span><span>${cell(m, 'ratio', (x) => x.toFixed(2))}</span><span>${cell(m, 'netApr', (x) => x.toFixed(1) + '%')}</span><span>${cell(m, 'maxDdPct', (x) => x.toFixed(2) + '%')}</span><span>${cell(m, 'stopPct', (x) => x.toFixed(0) + '%')}</span><span class="${m.verdict === 'pass' ? 'pos' : m.verdict === 'fail' ? 'neg' : 'dim'}">${esc(m.verdict)}<br><span class="dim sm">${esc(m.progress)}</span></span></div>`;
      $('fundScore').innerHTML = `<div class="subh">Realized vs expected scoreboard · pass: ratio ≥ ${P.passRatio}, APR ≥ ${P.passApr}%, pair loss ≤ ${P.maxPairLossPct}%, DD &lt; ${P.maxDdPct}% after ${P.minClosed} pairs / ${P.minDays} days</div>` +
        `<div class="row head" style="grid-template-columns:1.4fr .6fr .8fr .8fr .8fr .8fr .7fr 1fr"><span>book</span><span>closed</span><span>realized</span><span>real/exp</span><span>net APR</span><span>max DD</span><span>stops</span><span>verdict</span></div>` +
        line('v2 booked', sc.booked, '<span class="badge live">LIVE DATA · PAPER</span>') + line('v2 shadow', sc.shadowV2, '<span class="badge">not booked</span>') + line('naive v1 shadow', sc.shadowV1, '<span class="badge">control · not booked</span>') +
        `<div class="dim sm">Shadows open now: v2 ${sc.shadowOpen.v2} · v1 ${sc.shadowOpen.v1}. Shadows use the same real quotes and accrue funding continuously (an approximation); they never touch desk equity.</div>`;
    }
    const live = S.health.filter((x) => x.id.startsWith('funding.') && x.status === 'live').length;
    $('fundTs').textContent = `${live}/${f.venues.length} venues live`;
  }

  // ---------- attribution + positions ----------
  function renderAttr() {
    const rows = S.attribution; const names = Object.fromEntries(S.strategies.map((s) => [s.id, s.name]));
    const max = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.real), Math.abs(r.sim))));
    $('attr').innerHTML = rows.map((r) => {
      const w = (v) => Math.abs(v) / max * 50;
      const bar = (v, col) => `<div class="bar"><i style="${v >= 0 ? 'left:50%' : 'right:50%'};width:${w(v)}%;background:${col}"></i></div>`;
      return `<div class="attr-row"><span>${esc(names[r.id] || r.id)}</span><div>${bar(r.real, r.real >= 0 ? 'var(--mint)' : 'var(--hot)')}<div style="height:3px"></div>${bar(r.sim, 'rgba(79,216,255,.7)')}</div><span style="text-align:right">${signed(r.real)}<br><span class="sm" style="color:var(--cyan)">sim ${r.sim >= 0 ? '+' : '-'}$${Math.abs(r.sim).toFixed(2)}</span></span></div>`;
    }).join('');
    const pos = S.strategies.flatMap((s) => s.positions.map((p) => ({ s, p })));
    $('positions').innerHTML = pos.length ? pos.map(({ s, p }) => `<div class="row" style="grid-template-columns:90px 1fr auto"><span>${esc(s.name)}</span><span>${esc(describePos(p))}</span><span>${signed(p.upnl ?? (p.mtm != null ? p.mtm + (p.funding || 0) - (p.exitCost || 0) : null))}</span></div>`).join('') : '<div class="dim mono sm">no open paper positions</div>';
  }
  function describePos(p) {
    if (p.legs) return `${p.symbol} ${p.legs.map((l) => l.side + ' ' + l.venue).join(' / ')} · $${p.notional.toFixed(0)}/leg${p.stale ? ' · STALE' : ''}`;
    return `${p.symbol || ''} ${p.side || ''} ${p.qty ? p.qty.toFixed(4) : ''} @ ${p.entry ? pxFmt(p.entry) : ''}${p.simulated ? ' · SIM' : ''}`;
  }

  // ---------- health ----------
  let dtab = 'providers';
  document.querySelectorAll('[data-dtab]').forEach((b) => b.onclick = () => { dtab = b.dataset.dtab; document.querySelectorAll('[data-dtab]').forEach((x) => x.classList.toggle('on', x === b)); $('providers').hidden = dtab !== 'providers'; $('health').hidden = dtab !== 'feeds'; });
  const sb = $('settingsBtn'); if (sb) sb.onclick = () => $('dataSources').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const openConnect = new Set();
  // Top-bar warning: any source that delivered before but not within its staleMs (watchdog restarts it; see Data sources → Feeds).
  function renderStaleChip() {
    const el = $('staleChip'); if (!el) return; const st = S.stale || [];
    el.hidden = !st.length; if (!st.length) return;
    const worst = st.reduce((a, b) => (b.ageMs > a.ageMs ? b : a));
    el.textContent = `⚠ ${st.length} STALE · ${ago(worst.ageMs)}`;
    el.title = 'Stale feeds (no update within their window):\n' + st.map((x) => `${x.label}${x.mock ? ' [MOCK]' : ''}: last update ${ago(x.ageMs)} ago (window ${Math.round(x.staleMs / 1000)}s)`).join('\n');
    el.onclick = () => { const b = document.querySelector('[data-dtab="feeds"]'); if (b) b.click(); $('dataSources').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  }
  function renderHealth() {
    const h = S.health; const cnt = (st) => h.filter((x) => x.status === st).length;
    const wd = S.watchdog; const wdTxt = wd ? ` · watchdog ${wd.restarts} restart(s)${wd.clockJumps && wd.clockJumps.length ? ` · last clock jump +${Math.round(wd.clockJumps[wd.clockJumps.length - 1].ms / 1000)}s` : ''}` : '';
    $('healthSum').innerHTML = `<span class="pos">${cnt('live')} live</span> · <span class="warn">${cnt('stale')} stale</span> · <span class="warn">${cnt('mock')} mock</span> · <span class="neg">${cnt('down')} down</span>${esc(wdTxt)}`;
    const cols = 'grid-template-columns:1.4fr 44px 62px 56px 48px';
    $('health').innerHTML = `<div class="row head" style="${cols}"><span>feed</span><span>via</span><span>status</span><span>latency</span><span>age</span></div>` +
      h.map((x) => { const st = x.status === 'stale' ? 'stale' : x.kind === 'mock' ? 'mock' : x.status === 'live' ? 'live' : x.status === 'down' ? 'down' : 'pending';
        return `<div class="row${st === 'stale' ? ' stale-row' : ''}" style="${cols}" title="${esc(x.error || x.note || '')}"><span>${esc(x.label)}<br><span class="dim sm">${esc(x.error ? x.error.slice(0, 70) : x.note || x.group)}</span></span><span class="dim">${esc(x.transport || 'rest')}</span><span>${badge(st)}${st === 'stale' && x.kind === 'mock' ? ' ' + badge('mock') : ''}</span><span>${x.latencyMs == null ? '—' : x.latencyMs + 'ms'}</span><span class="${st === 'stale' ? 'warn' : ''}">${ago(x.ageMs)}</span></div>`; }).join('');
    renderProviders();
  }
  const staleFeeds = (p) => { const rows = (p.feeds || []).map((f) => (S.health || []).find((h) => h.id === f.id)).filter((h) => h && h.status === 'stale');
    return rows.length ? `<br><span class="warn">⚠ STALE: ${rows.map((h) => esc(h.id) + ' ' + esc(ago(h.ageMs))).join(' · ')}</span>` : ''; };
  function renderProviders() {
    const P = S.providers || []; if (!P.length) { $('providers').innerHTML = '<div class="dim">provider registry unavailable</div>'; return; }
    const cols = 'grid-template-columns:1.5fr 92px 56px 1.6fr 78px';
    $('providers').innerHTML = `<div class="row head" style="${cols}"><span>provider</span><span>status</span><span>latency</span><span>unlocks</span><span></span></div>` + P.map((p) => {
      const vars = p.env.length ? p.env.map((v) => `<code class="${v.set ? 'pos' : v.required ? 'warn' : 'dim'}">${esc(v.name)}</code> ${v.set ? '✓ set' : v.required ? 'not set' : 'optional'}`).join('<br>') : '<span class="dim">no env vars</span>';
      const how = p.keyless ? 'Works without a key.' : p.connect.anyOf ? 'Set any one of these env vars (server-side .env), then restart:' : 'Set these env vars (server-side .env), then restart:';
      const open = openConnect.has(p.id);
      return `<div class="row prov" style="${cols}"><span>${esc(p.name)}<br><span class="dim sm">${esc(p.category)}${p.fallback ? ' · fallback: ' + esc(p.fallback) : ''}</span></span><span>${badge(p.status)}</span><span>${p.latencyMs == null ? '—' : Math.round(p.latencyMs) + 'ms'}</span>
        <span class="sm">${p.unlocks.map(esc).join(' · ')}${pythInfo(p)}${creditInfo(p)}${staleFeeds(p)}</span><span><button type="button" class="btn sm" data-connect="${esc(p.id)}">${open ? 'Close' : p.keyless ? 'Details' : 'Connect'}</button></span>
        ${open ? `<div class="connect sm" style="grid-column:1/-1"><div>${how}</div><div class="mono">${vars}</div>${p.connect.signup ? `<div>Sign up / docs: <a href="${esc(p.connect.signup)}" target="_blank" rel="noopener">${esc(p.connect.signup)}</a></div>` : ''}${p.placeholder ? '<div class="warn">Placeholder: no adapter yet. Add one file in server/providers/adapters/ (see README).</div>' : ''}<div class="dim">feeds: ${p.feeds.map((f) => esc(f.id) + ' ' + esc(f.status) + ' via ' + esc(f.transport || 'rest')).join(' · ') || 'none'}</div></div>` : ''}</div>`; }).join('');
    $('providers').querySelectorAll('[data-connect]').forEach((b) => b.onclick = () => { const id = b.dataset.connect; openConnect.has(id) ? openConnect.delete(id) : openConnect.add(id); renderProviders(); });
  }
  // Credit-usage estimate + budget guard (Helius, The Odds API). Numbers are local counters / estimates, not provider invoices.
  function creditInfo(p) {
    const c = p.extra && p.extra.credits; if (!c) return '';
    const n = (x) => (x == null ? '—' : Math.round(x).toLocaleString());
    const pct = c.budget ? Math.min(100, (100 * (c.used || 0)) / c.budget) : 0;
    const over = c.overBudget || (c.estMonthly != null && c.planMonthly && c.estMonthly > c.planMonthly);
    const bits = [`<b>Credits ${esc(c.month || '')}</b>: ${n(c.used)} / ${n(c.budget)} budget used (guard)`, `free plan ${n(c.planMonthly)}/mo`,
      `est. ${n(c.estMonthly)}/mo${c.estBasis ? ` (${esc(c.estBasis)})` : ''}`];
    if (c.mode) bits.unshift(`mode <b>${esc(c.mode)}</b>`);
    if (c.enabled === false) bits.unshift('<span class="warn">DEMO: WHALES_ENABLED=false, no Helius calls</span>');
    if (c.dailyBudget != null) bits.splice(1, 0, `<b>today</b> ${n(c.usedToday)} / ${n(c.dailyBudget)} daily cap (auto-pause at ${n(c.pauseAtPct)}%)`);
    if (c.paused) bits.push(`<span class="neg">AUTO-PAUSED${c.autoPaused && c.autoPaused.remote ? ': ' + esc(c.autoPaused.remote) : ''}</span>`);
    if (c.mode === 'inbox') bits.push(`watching ${n(c.watching)} accounts${c.watchConfigured ? '' : ' (proposed list)'}`);
    if (c.inbox) bits.push(inboxInfo(c.inbox, c.delivery));
    if (c.schedule) bits.unshift(`schedule <b>${esc(c.schedule)}</b> · ${n(c.costPerCall)} cr/call`);
    if (c.legacyPerDay) bits.push(`<span class="dim">old default ≈ ${n(c.legacyPerDay)}/day</span>`);
    if (c.apiRemaining != null) bits.push(`API reports ${n(c.apiRemaining)} left`);
    if (c.next24h != null && c.schedule === 'snapshots') bits.push(`${c.next24h} snapshot(s) next 24h`);
    if (c.refused) bits.push(`<span class="warn">${n(c.refused)} call(s) refused by guard</span>`);
    if (c.closingOnly) bits.push('<span class="warn">closing-only throttle</span>');
    if (over) bits.push('<span class="neg">estimate exceeds free plan</span>');
    const dpct = c.dailyBudget ? Math.min(100, (100 * (c.usedToday || 0)) / c.dailyBudget) : null;
    return `<br><span class="sm mono credits" data-credits="${esc(p.id)}">${bits.join(' · ')}</span><span class="credit-bar" title="month"><i style="width:${pct.toFixed(1)}%"></i></span>` +
      (dpct == null ? '' : `<span class="credit-bar daily${c.paused ? ' paused' : ''}" title="today"><i style="width:${dpct.toFixed(1)}%"></i></span>`);
  }
  // HAWSE webhook inbox health (counters only; the URL and token never reach the browser).
  function inboxInfo(x, d) {
    if (!x.configured) return '<span class="warn">inbox not configured (HAWSE_WEBHOOK_URL / HAWSE_READ_TOKEN missing): MOCK events</span>';
    const ago = (ms) => (ms == null ? 'never' : ms < 90e3 ? Math.round(ms / 1000) + 's ago' : ms < 5400e3 ? Math.round(ms / 60e3) + 'm ago' : (ms / 3.6e6).toFixed(1) + 'h ago');
    const b = [`<b>inbox</b> ${x.lastOkAt ? (x.stale ? '<span class="warn">STALE</span>' : '<span class="pos">ok</span>') : 'pending'} · last poll ${ago(x.lastOkAgoMs)} every ${x.pollSec}s`,
      `cursor ${x.cursor}`, `rtt ${x.lastRttMs == null ? '—' : x.lastRttMs + 'ms'}`, `${x.txs} tx in ${x.events} deliveries · ${x.dupes} dupes`];
    b.push(`last delivery ${ago(x.lastEventAgoMs)}`);
    if (d && d.lastLagMs != null) b.push(`chain→inbox ${Math.round(d.lastLagMs / 1000)}s`);
    if (d && d.test) b.push(`<span class="dim">${d.test} test payload(s), not billed</span>`);
    if (x.backoffMs) b.push(`<span class="warn">backing off ${Math.round(x.backoffMs / 1000)}s</span>`);
    if (x.lastError && (!x.lastOkAt || x.lastError.at > x.lastOkAt)) b.push(`<span class="neg">${esc(x.lastError.msg)}</span>`);
    if (x.gapCount) b.push(`<span class="neg">${x.gapCount} GAP(s): offline &gt; 24 h, deliveries may be missing (last ${esc(String(x.gaps[x.gaps.length - 1].hours))} h)</span>`);
    return b.join(' · ');
  }
  function pythInfo(p) {
    if (!p.extra || !p.extra.checks) return '';
    return '<br>' + p.extra.checks.map((c) => `<span class="dim mono">${esc(c.symbol)} ${fmtPx(c.pyth)}${c.devBps == null ? '' : ` · ${esc(c.venue)} ${c.devBps >= 0 ? '+' : ''}${c.devBps.toFixed(1)}bp`}</span>`).join(' ');
  }
  const fmtPx = (v) => (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(v >= 10 ? 2 : 4));

  // ---------- tape ----------
  function renderTape(force) {
    const rows = S.tape.filter((r) => tapeFilter === 'all' || r.kind === tapeFilter).slice(0, 120);
    const top = rows[0] ? rows[0].id : 0; if (!force && top === lastTapeId) return; lastTapeId = top;
    const names = Object.fromEntries(S.strategies.map((s) => [s.id, s.name]));
    $('tape').innerHTML = rows.map((r) => `<div class="tape-row"><span class="dim">${hhmmss(r.t)}</span><span class="k k-${esc(r.kind)} s">${esc(r.kind)}${r.simulated ? ' · sim' : ''}</span><span>${r.strategy ? '<span class="dim">' + esc(names[r.strategy] || r.strategy) + ' · </span>' : ''}${esc(r.msg)}</span><span>${r.pnl == null ? '' : signed(r.pnl)}</span></div>`).join('') || '<div class="dim">no events</div>';
  }

  // ---------- stage panels (render only when the server provides them) ----------
  function renderWhales() {
    const s = S.strategies.find((x) => x.id === 'whale'); $('whaleCard').hidden = !s; if (!s) return;
    const v = s.view; $('whaleMode').innerHTML = Object.entries(v.modes || {}).map(([k, m]) => `${esc(k)} ${badge(m)}`).join(' ');
    $('whaleNet').innerHTML = (v.net || []).map((n) => `<div class="meter"><div class="label">${esc(n.chain)} · ${esc(n.window)}</div><div class="v mono ${n.netUsd >= 0 ? 'pos' : 'neg'}">${n.netUsd >= 0 ? '+' : '-'}$${compact(Math.abs(n.netUsd))}</div><div class="dim sm mono">${n.count} tx · ${n.mock ? 'MOCK' : 'live'}</div></div>`).join('');
    $('whales').innerHTML = (v.flows || []).slice(0, 40).map((f) => `<div class="row" style="grid-template-columns:58px 70px 1fr 80px"><span class="dim">${hhmmss(f.t)}</span><span>${esc(f.chain)}${f.mock ? ' <span class="badge mock">mock</span>' : ''}</span><span>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(f.desc)}</a>` : esc(f.desc)}</span><span class="${f.dir === 'buy' ? 'pos' : f.dir === 'sell' ? 'neg' : ''}">$${compact(f.usd)}</span></div>`).join('') || '<div class="dim mono sm">waiting for large transactions…</div>';
  }
  function renderFollow() {
    const s = S.strategies.find((x) => x.id === 'wfollow'); $('followCard').hidden = !s; if (!s) return;
    const v = s.view || {}, hl = v.hl || {}, r = v.rules || {}, sc = v.score || {};
    const sw = (a) => (a ? esc(a.slice(0, 6) + '…' + a.slice(-4)) : '?');
    $('followMode').innerHTML = `HL ${badge(hl.mode === 'live' ? 'live' : 'down')} ${(hl.wallets || []).length} wallet(s) · SOL ${badge(v.sol && v.sol.mode === 'mock' ? 'mock' : v.sol && v.sol.wallets ? 'live' : 'down')}`;
    const fp = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%');
    const G = 'grid-template-columns:58px 70px 86px 1fr 70px';
    const pos = (s.positions || []).filter((p) => p.kind === 'follow');
    $('followSig').innerHTML = `<div class="subh">Rules: ≥ $${compact(r.minUsdHl || 0)} HL / $${compact(r.minUsdSol || 0)} SOL · delay ${r.delaySecHl}s / ${r.delaySecSol}s · chase ≤ ${r.maxChasePct}% · TP ${(r.tp * 100).toFixed(1)}% · SL ${(r.sl * 100).toFixed(1)}% · ${r.maxHoldHHl}h / ${r.maxHoldHSol}h · <span class="badge live">REAL FILLS · PAPER</span></div>` +
      (pos.length ? `<div class="subh">Open follows (controls are SIM)</div>` + pos.map((p) => `<div class="row" style="${G}"><span>${esc(p.symbol)}</span><span class="${p.side === 'long' ? 'pos' : 'neg'}">${esc(p.side)}</span><span>${sw(p.wallet)}</span><span class="dim">${esc(p.chain)} · delay ${p.delaySec}s · chase ${(p.chasePct || 0).toFixed(2)}% · ${p.controlId ? p.controlId.filter(Boolean).length : 0} controls</span><span class="${(p.upnl || 0) >= 0 ? 'pos' : 'neg'}">${signed(p.upnl || 0)}</span></div>`).join('') : '') +
      ((v.pending || []).length ? `<div class="dim sm mono">queued (latency delay): ${(v.pending || []).map((q) => `${esc(q.asset)} ${esc(q.side)} in ${q.dueInSec}s`).join(' · ')}</div>` : '') +
      `<div class="subh">Wallet signals (public fills; history before add date ignored)</div><div class="row head" style="${G}"><span>time</span><span>asset</span><span>wallet</span><span>kind</span><span>size</span></div>` +
      ((v.signals || []).slice(0, 12).map((x) => `<div class="row" style="${G}"><span class="dim">${hhmmss(x.t)}</span><span>${esc(x.asset)}</span><span>${sw(x.wallet)}</span><span class="${x.kind === 'reduce' ? 'neg' : 'pos'}">${esc(x.kind)} ${esc(x.side)}${x.frac != null ? ' ' + (x.frac * 100).toFixed(0) + '%' : ''}</span><span>$${compact(x.usd)}</span></div>`).join('') || `<div class="dim mono sm">${hl.mode === 'live' ? 'waiting for a tracked wallet to trade…' : 'no wallets configured: set FOLLOW_WALLETS_HL or run scripts/score-wallets.js'}</div>`);
    const o = sc.overall, P = sc.plan || {}, W = 'grid-template-columns:1.2fr .5fr .8fr 1.2fr .6fr .8fr .8fr .9fr 1fr';
    const line = (label, m) => `<div class="row" style="${W}"><span>${label}</span><span>${m.n}</span><span>${fp(m.mean)}</span><span>${m.ci ? fp(m.ci[0]) + ' … ' + fp(m.ci[1]) : '—'}</span><span>${m.hitPct == null ? '—' : m.hitPct.toFixed(0) + '%'}</span><span>${fp(m.meanRandom)}</span><span>${fp(m.meanHold)}</span><span>${fp(m.mean0)} / ${fp(m.mean60)}</span><span class="${m.verdict.status === 'pass' ? 'pos' : m.verdict.status === 'fail' ? 'neg' : 'dim'}">${esc(m.verdict.status)}<br><span class="dim sm">${esc(m.verdict.text)}</span></span></div>`;
    $('followScore').innerHTML = o ? `<div class="subh">Scoreboard · net % per follow after 2× taker + slippage · pass after ${P.minSignals}: CI &gt; 0 and ≥ ${P.passEdgeVsRandomPct}%/trade over random</div>` +
      `<div class="row head" style="${W}"><span>wallet</span><span>n</span><span>mean</span><span>95% CI</span><span>hit</span><span>random <span class="badge">SIM</span></span><span>hold <span class="badge">SIM</span></span><span>0s / 60s delay</span><span>verdict</span></div>` +
      line('<b>all wallets</b>', o) + (sc.wallets || []).slice(0, 10).map((w) => line(`${sw(w.wallet)} <span class="dim sm">${esc(w.chain)}</span>`, w)).join('') : '';
  }
  function renderMev() {
    const s = S.strategies.find((x) => x.id === 'mevlab'); $('mevCard').hidden = !s; if (!s) return;
    const v = s.view || {}, f = v.feed || {}, st = f.stats || {}, m = v.metrics || {}, c = v.counts || {}, r = v.rules || {}, P = v.plan || {};
    const d = (x, k = 0, suf = '%') => (x == null ? '—' : x.toFixed(k) + suf), $u = (x) => (x == null ? '—' : (x < 0 ? '-' : '') + '$' + compact(Math.abs(x)));
    $('mevMode').innerHTML = v.mode === 'off' ? `${badge('down')} MEMPOOL_ENABLED=false · not connected` : `${badge(v.mode === 'live' ? 'live' : 'down')} ${esc(f.label || '')} · block ${v.head || '—'} · base ${v.baseFeeGwei == null ? '—' : v.baseFeeGwei.toFixed(2)} gwei`;
    const meter = (label, val, sub) => `<div class="meter"><div class="label">${label}</div><div class="v mono">${val}</div><div class="dim sm mono">${sub}</div></div>`;
    const vd = m.verdict || { status: 'collecting', text: '' };
    $('mevMetrics').innerHTML = `<div class="subh">Rules: victim ≥ $${compact(r.minUsd || 0)} · gas ${compact(r.gasSandwich || 0)} / ${compact(r.gasBackrun || 0)} units · builder bid ${d((r.bidShare || 0) * 100)} of gross (realistic) · never trades, results are <span class="badge sim">SIMULATED</span></div>` +
      `<div class="riskgrid">` + meter('pending seen', compact(st.pendingSeen || 0), `${st.routerTxs || 0} to routers · ${st.decoded || 0} decoded · ${st.unsupported || 0} v4`) +
      meter('large swaps simulated', `${m.observed || 0}<span class="dim sm"> / ${P.minObserved || 500}</span>`, `${c.small || 0} small · ${c.exactOut || 0} exact-out · ${c.multihop || 0} multihop · ${c.unpriced || 0} unpriced`) +
      meter('inclusion', `${m.included || 0} in`, `${m.dropped || 0} dropped · ${m.replaced || 0} replaced`) +
      meter('coverage', d(m.coverageVictimsPct), `of ${c.victims || 0} heuristic victims in ${c.blocks || 0} blocks · ${d(m.coverageTxsPct)} of all block txs seen`) +
      meter('model vs truth', `P ${d(m.precisionPct)} · R ${d(m.recallPct)}`, `${m.confirmed || 0}/${P.minConfirmed || 50} confirmed · median err ${d(m.medianErrPct)} (${m.matched || 0} matched)`) +
      meter('sim sandwich sum', `${$u(m.ceilSumUsd)} <span class="dim sm">ceil</span>`, `${$u(m.realSumUsd)} realistic · ${d(m.realPositivePct)} of swaps > 0 · back-run > 0: ${d(m.backrunPositivePct)}`) + `</div>` +
      `<div class="subh">Error histogram (|model − attacker gross| ÷ attacker gross): ${(m.errHist || []).map((h) => `${esc(h.label)} <b>${h.n}</b>`).join(' · ')}${m.duneRows ? ` · Dune truth rows: ${m.duneRows}` : ' · no Dune import (heuristic truth only)'}</div>` +
      `<div class="subh">Verdict: <span class="${vd.status === 'pass' ? 'pos' : vd.status === 'fail' ? 'neg' : 'dim'}">${esc(vd.status)}</span> <span class="dim sm">${esc(vd.text)}</span></div>`;
    const G = 'grid-template-columns:58px 1fr 70px 52px 76px 76px 70px 1.1fr';
    const truth = (e) => (e.duneSandwiched ? '<span class="neg">sandwiched (Dune)</span>' : e.observedSandwich ? `<span class="neg">sandwiched</span> <span class="dim sm">${e.attackerGrossUsd != null ? 'atk ' + $u(e.attackerGrossUsd) : ''}</span>` : e.inclusion === 'included' ? 'clean' : esc(e.inclusion || ''));
    $('mevEvents').innerHTML = `<div class="row head" style="${G}"><span>seen</span><span>swap</span><span>size</span><span>slip</span><span>ceil <span class="badge sim">SIM</span></span><span>realistic</span><span>back-run</span><span>truth</span></div>` +
      ((v.events || []).map((e) => `<div class="row ${e.simSandwichRealUsd > 0 ? 'ok' : ''}" style="${G}"><span class="dim">${hhmmss(e.seenAt)}</span><span><a href="https://etherscan.io/tx/${esc(e.hash)}" target="_blank" rel="noopener" style="color:inherit">${esc(e.pair || '')}</a> <span class="dim sm">${esc(e.v || '')} ${esc(e.fn || '')}${e.likelyCrossesTicks ? ' · crosses ticks?' : ''}${e.status !== 'simulated' ? ' · ' + esc(e.status || '') : ''}</span></span><span>$${compact(e.usd || 0)}</span><span>${d(e.slipTolPct, 2)}</span><span class="${(e.simSandwichCeilUsd || 0) > 0 ? 'pos' : 'dim'}">${$u(e.simSandwichCeilUsd)}</span><span class="${(e.simSandwichRealUsd || 0) > 0 ? 'pos' : 'dim'}">${$u(e.simSandwichRealUsd)}</span><span class="${(e.simBackrunUsd || 0) > 0 ? 'pos' : 'dim'}">${$u(e.simBackrunUsd)}</span><span>${truth(e)}</span></div>`).join('') ||
        `<div class="dim mono sm">${v.mode === 'off' ? 'off by default: set MEMPOOL_ENABLED=true to observe the public mempool (free publicnode WebSocket; read-only)' : 'waiting for a large Uniswap swap in the public mempool…'}</div>`);
  }
  function renderGaps() {
    const s = S.strategies.find((x) => x.id === 'gaps'); $('gapCard').hidden = !s; if (!s) return;
    const v = s.view; $('gapMode').innerHTML = Object.entries(v.modes || {}).map(([k, m]) => `${esc(k)} ${badge(m)}`).join(' ');
    $('gapHeat').innerHTML = (v.matrices || []).map((m) => {
      let h = `<div class="subh">${esc(m.title)} <span class="dim">· ${esc(m.source)}</span></div><div class="heat" style="grid-template-columns:96px repeat(${m.labels.length},minmax(58px,1fr))"><div class="h">buy↓ sell→</div>` + m.labels.map((l) => `<div class="h">${esc(l)}</div>`).join('');
      m.labels.forEach((l, i) => { h += `<div class="rh" style="font-size:10px">${esc(l)}</div>` + m.labels.map((_, j) => { const b = m.bps[i] && m.bps[i][j]; return i === j || b == null ? '<div class="c na">·</div>' : `<div class="c" style="background:${heatColor(b, 25)}">${b.toFixed(1)}</div>`; }).join(''); });
      return h + '</div>';
    }).join('');
    $('gapTri').innerHTML = `<div class="subh">Best opportunities after gas · tips · failure risk</div>` + (v.best || []).map((b) => `<div class="row ${b.ok ? 'ok' : ''}" style="grid-template-columns:1fr 66px 70px 70px"><span>${esc(b.label)}<br><span class="dim sm">${esc(b.note || '')}</span></span><span>${b.grossBps.toFixed(1)}bp</span><span>cost $${b.costUsd.toFixed(2)}</span><span class="${b.evUsd > 0 ? 'pos' : 'neg'}">EV ${b.evUsd >= 0 ? '+' : '-'}$${Math.abs(b.evUsd).toFixed(2)}</span></div>`).join('');
  }
  function renderOnePct() {
    const s = S.strategies.find((x) => x.id === 'onepct'); $('onepctCard').hidden = !s; if (!s) return;
    const v = s.view; $('onepctMode').innerHTML = badge(s.dataMode) + ' ' + esc(v.source || '');
    $('onepct').innerHTML = `<div class="riskgrid"><div class="meter"><div class="label">completed cycles</div><div class="v mono">${v.cycles} <span class="dim sm">(${v.wins}W/${v.losses}L)</span></div></div><div class="meter"><div class="label">sleeve compounding</div><div class="v mono ${v.growthPct >= 0 ? 'pos' : 'neg'}">${pct(v.growthPct)}</div><div class="dim sm mono">target ${v.targetPct}% net/cycle</div></div></div>` +
      `<div class="tbl"><div class="row head" style="grid-template-columns:50px 50px 1fr 64px"><span>sym</span><span>score</span><span>gate</span><span>price</span></div>` +
      (v.setups || []).map((x) => `<div class="row ${x.pass ? 'ok' : ''}" style="grid-template-columns:50px 50px 1fr 64px"><span>${esc(x.symbol)}</span><span class="${x.pass ? 'pos' : 'dim'}">${x.score ?? '—'}</span><span class="${x.pass ? 'pos' : 'dim'}">${esc(x.pass ? 'TOP-QUALITY SETUP' : x.reason)}</span><span>${x.price ? pxFmt(x.price) : '—'}</span></div>`).join('') + '</div>';
  }
  function renderPerps() {
    const m = S.strategies.find((x) => x.id === 'perpmom'), b = S.strategies.find((x) => x.id === 'basis'); $('perpCard').hidden = !m && !b; if (!m && !b) return;
    $('perpMode').innerHTML = (m ? 'momentum ' + badge(m.dataMode) : '') + (b ? ' basis ' + badge(b.dataMode) : '');
    const G = 'grid-template-columns:44px 70px 1fr 58px 58px';
    $('perpMom').innerHTML = m ? `<div class="subh">Momentum · ${esc(m.view.bar || '')} OKX swap bars · Donchian + EMA20/50</div><div class="row head" style="${G}"><span>sym</span><span>exec</span><span>signal / skip</span><span>ATR</span><span>cost</span></div>` +
      Object.entries(m.view.signals || {}).map(([k, x]) => `<div class="row ${x.side ? 'ok' : ''}" style="${G}"><span>${esc(k)}</span><span>${esc(x.venue || '')} <span class="dim sm">${esc(x.transport || '')}</span></span><span class="${x.side ? 'pos' : 'dim'}">${esc(x.reason)}</span><span>${x.atrPct != null ? x.atrPct.toFixed(2) + '%' : '—'}</span><span>${x.costPct != null ? x.costPct.toFixed(3) + '%' : '—'}</span></div>`).join('') || '<div class="dim mono sm">waiting for closed bars…</div>' : '';
    const B = 'grid-template-columns:44px 1fr 62px 62px 62px 62px';
    $('perpBasis').innerHTML = b ? `<div class="subh">Cash &amp; carry · long spot / short perp · net after 4 taker fees + slippage</div><div class="row head" style="${B}"><span>sym</span><span>spot / perp</span><span>basis</span><span>funding</span><span>costs</span><span>net</span></div>` +
      (b.view.table || []).slice(0, 8).map((x) => `<div class="row ${x.netBps > 0 ? 'ok' : ''}" style="${B}"><span>${esc(x.symbol)}</span><span>${esc(x.spotVenue)} / ${esc(x.perpVenue)} <span class="dim sm">${esc(x.transport || '')}</span></span><span>${x.basisBps.toFixed(1)}bp</span><span>${x.fundingBps.toFixed(1)}bp</span><span>${x.costsBps.toFixed(1)}bp</span><span class="${x.netBps > 0 ? 'pos' : 'neg'}">${x.netBps.toFixed(1)}bp</span></div>`).join('') || '<div class="dim mono sm">needs fresh WS spot + perp books…</div>' : '';
  }
  function renderFutures() {
    const s = S.strategies.find((x) => x.id === 'orb'); $('futCard').hidden = !s; if (!s) return;
    const v = s.view; $('futMode').innerHTML = badge(s.dataMode) + ' ' + esc(v.session || '');
    $('futBody').innerHTML = `<div class="tbl">` + (v.symbols || []).map((x) => `<div class="row" style="grid-template-columns:70px 1fr 1fr 1fr"><span>${esc(x.symbol)}</span><span>last ${x.last ? x.last.toFixed(2) : '—'}</span><span>OR ${x.orLow ? x.orLow.toFixed(2) + '–' + x.orHigh.toFixed(2) : 'forming'}</span><span>${esc(x.state)}</span></div>`).join('') + '</div>';
    const sym = (v.symbols || [])[0]; const c = $('futChart'); if (!sym || !c.clientWidth) return;
    const { ctx, w, h } = sizeCanvas(c); ctx.clearRect(0, 0, w, h);
    const bars = (sym.bars || []).slice(-120); if (bars.length < 2) return;
    let lo = Math.min(...bars.map((b) => b.l)), hi = Math.max(...bars.map((b) => b.h)); if (sym.orHigh) { hi = Math.max(hi, sym.orHigh); lo = Math.min(lo, sym.orLow); }
    const Y = (p) => 8 + (1 - (p - lo) / (hi - lo || 1)) * (h - 24); const bw = (w - 50) / bars.length;
    if (sym.orHigh) { ctx.fillStyle = 'rgba(169,139,255,0.08)'; ctx.fillRect(0, Y(sym.orHigh), w - 50, Y(sym.orLow) - Y(sym.orHigh)); ctx.strokeStyle = 'rgba(169,139,255,0.5)'; ctx.setLineDash([3, 3]); [sym.orHigh, sym.orLow].forEach((p) => { ctx.beginPath(); ctx.moveTo(0, Y(p)); ctx.lineTo(w - 50, Y(p)); ctx.stroke(); }); ctx.setLineDash([]); }
    bars.forEach((b, i) => { const x = i * bw + bw / 2; const up = b.c >= b.o; ctx.strokeStyle = ctx.fillStyle = up ? '#3dffb0' : '#ff3d5a'; ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke(); ctx.fillRect(x - Math.max(1, bw * 0.35), Math.min(Y(b.o), Y(b.c)), Math.max(2, bw * 0.7), Math.max(1, Math.abs(Y(b.o) - Y(b.c)))); });
    ctx.fillStyle = '#6b7a89'; ctx.font = '10px IBM Plex Mono'; ctx.fillText(hi.toFixed(2), w - 46, 14); ctx.fillText(lo.toFixed(2), w - 46, h - 12); ctx.fillText(sym.symbol, 4, 14);
  }

  addEventListener('resize', () => { if (S) renderFutures(); });
})();
