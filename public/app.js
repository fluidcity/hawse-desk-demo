/* HAWSE paper desk client. Renders server state (SSE). Holds no secrets and places no orders. */
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
  $('riskForm').onsubmit = (e) => { e.preventDefault(); post('/api/risk', { dailyLossPct: +$('dailyIn').value, maxDrawdownPct: +$('ddIn').value }); };
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
    renderWhales(); renderGaps(); renderOnePct(); renderPerps(); renderFutures(); renderBetting();
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
  function renderStrats() {
    const attr = Object.fromEntries(S.attribution.map((a) => [a.id, a]));
    $('strats').innerHTML = S.strategies.map((s) => {
      const a = attr[s.id] || { real: 0, sim: 0, realStats: {}, simStats: {} };
      const st = s.dataMode === 'mock' || s.dataMode === 'sim' ? a.simStats : a.realStats;
      const tr = (st.trades || 0); const wr = tr ? Math.round((st.wins || 0) / tr * 100) + '%' : '—';
      const skip = s.lastSkip ? `<div class="skip">⟂ ${esc(s.lastSkip.reason)}${s.lastSkip.detail ? ' — ' + esc(s.lastSkip.detail) : ''}</div>` : `<div class="skip" style="border-color:var(--line2)">${s.armed ? 'evaluating…' : 'disarmed · scanning only, no paper entries'}</div>`;
      return `<div class="strat ${s.armed ? 'armed' : ''}">
        <div class="strat-top"><span class="strat-name">${esc(s.name)}</span><button type="button" class="toggle ${s.armed ? 'on' : ''}" data-arm="${esc(s.id)}" aria-pressed="${s.armed}">${s.armed ? 'ARMED' : 'DISARMED'}</button></div>
        <div class="badges">${badge(s.dataMode)}${(s.chains || []).map((c) => `<span class="badge">${esc(c)}</span>`).join('')}</div>
        <div class="strat-desc">${esc(s.desc)}</div>
        <div class="stats"><div><small>real PnL</small>${signed(a.real)}</div><div><small>sim PnL</small>${signed(a.sim)}</div><div><small>trades · win</small>${tr} · ${wr}</div></div>
        ${skip}
      </div>`;
    }).join('');
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
    const best = (fs && fs.view.best) || [];
    $('fundBest').innerHTML = `<div class="row head" style="grid-template-columns:50px 1fr 70px 70px 70px"><span>sym</span><span>long / short</span><span>spread APR</span><span>net/${fs ? fs.view.holdHours : 24}h</span><span>status</span></div>` +
      best.map((b) => `<div class="row ${b.ok ? 'ok' : ''}" style="grid-template-columns:50px 1fr 70px 70px 70px"><span>${esc(b.symbol)}</span><span>${b.long ? esc(b.long) + ' / ' + esc(b.short) : '<span class="dim">' + esc(b.reason) + '</span>'}</span><span>${b.spreadApr == null ? '—' : b.spreadApr.toFixed(1) + '%'}</span><span class="${b.netBps > 0 ? 'pos' : 'neg'}">${b.netBps == null ? '—' : b.netBps.toFixed(1) + 'bp'}</span><span class="${b.ok ? 'pos' : 'dim'}">${b.ok ? 'QUALIFIES' : 'skip'}</span></div>`).join('');
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
  function renderHealth() {
    const h = S.health; const cnt = (st) => h.filter((x) => x.status === st).length;
    $('healthSum').innerHTML = `<span class="pos">${cnt('live')} live</span> · <span class="warn">${cnt('stale')} stale</span> · <span class="warn">${cnt('mock')} mock</span> · <span class="neg">${cnt('down')} down</span>`;
    const cols = 'grid-template-columns:1.4fr 44px 62px 56px 48px';
    $('health').innerHTML = `<div class="row head" style="${cols}"><span>feed</span><span>via</span><span>status</span><span>latency</span><span>age</span></div>` +
      h.map((x) => { const st = x.status === 'stale' ? 'stale' : x.kind === 'mock' ? 'mock' : x.status === 'live' ? 'live' : x.status === 'down' ? 'down' : 'pending';
        return `<div class="row" style="${cols}" title="${esc(x.error || x.note || '')}"><span>${esc(x.label)}<br><span class="dim sm">${esc(x.error ? x.error.slice(0, 70) : x.note || x.group)}</span></span><span class="dim">${esc(x.transport || 'rest')}</span><span>${badge(st)}</span><span>${x.latencyMs == null ? '—' : x.latencyMs + 'ms'}</span><span>${ago(x.ageMs)}</span></div>`; }).join('');
    renderProviders();
  }
  function renderProviders() {
    const P = S.providers || []; if (!P.length) { $('providers').innerHTML = '<div class="dim">provider registry unavailable</div>'; return; }
    const cols = 'grid-template-columns:1.5fr 92px 56px 1.6fr 78px';
    $('providers').innerHTML = `<div class="row head" style="${cols}"><span>provider</span><span>status</span><span>latency</span><span>unlocks</span><span></span></div>` + P.map((p) => {
      const vars = p.env.length ? p.env.map((v) => `<code class="${v.set ? 'pos' : v.required ? 'warn' : 'dim'}">${esc(v.name)}</code> ${v.set ? '✓ set' : v.required ? 'not set' : 'optional'}`).join('<br>') : '<span class="dim">no env vars</span>';
      const how = p.keyless ? 'Works without a key.' : p.connect.anyOf ? 'Set any one of these env vars (server-side .env), then restart:' : 'Set these env vars (server-side .env), then restart:';
      const open = openConnect.has(p.id);
      return `<div class="row prov" style="${cols}"><span>${esc(p.name)}<br><span class="dim sm">${esc(p.category)}${p.fallback ? ' · fallback: ' + esc(p.fallback) : ''}</span></span><span>${badge(p.status)}</span><span>${p.latencyMs == null ? '—' : Math.round(p.latencyMs) + 'ms'}</span>
        <span class="sm">${p.unlocks.map(esc).join(' · ')}${pythInfo(p)}</span><span><button type="button" class="btn sm" data-connect="${esc(p.id)}">${open ? 'Close' : p.keyless ? 'Details' : 'Connect'}</button></span>
        ${open ? `<div class="connect sm" style="grid-column:1/-1"><div>${how}</div><div class="mono">${vars}</div>${p.connect.signup ? `<div>Sign up / docs: <a href="${esc(p.connect.signup)}" target="_blank" rel="noopener">${esc(p.connect.signup)}</a></div>` : ''}${p.placeholder ? '<div class="warn">Placeholder: no adapter yet. Add one file in server/providers/adapters/ (see README).</div>' : ''}<div class="dim">feeds: ${p.feeds.map((f) => esc(f.id) + ' ' + esc(f.status) + ' via ' + esc(f.transport || 'rest')).join(' · ') || 'none'}</div></div>` : ''}</div>`; }).join('');
    $('providers').querySelectorAll('[data-connect]').forEach((b) => b.onclick = () => { const id = b.dataset.connect; openConnect.has(id) ? openConnect.delete(id) : openConnect.add(id); renderProviders(); });
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
  addEventListener('resize', () => { if (S) renderFutures(); });
})();
