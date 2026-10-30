'use strict';
// Strategy lab UI: templates, versioned configs, JSON editor, backtests and side-by-side paper runs.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mkt = (m) => (m && m.sport ? `${esc(m.sport)} · ${esc((m.betMarkets || []).join('/'))}` : `${esc(m.symbol)} ${esc(m.bar)} ${esc(m.instrument || '')}`);
  const api = async (url, body) => { const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); };
  const pct = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%');
  const usd = (x) => (x == null ? '—' : (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2));
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—');
  const statusBadge = (s) => `<span class="badge ${s === 'backtested' ? 'backtested' : 'unverified'}">${esc(s || 'unverified')}</span>`;
  let L = null, cur = null;
  const XH = (x, id, label) => (window.HAWSE && window.HAWSE.explain ? window.HAWSE.explain.html(x, id, label) : '');
  const XS = (el, html) => (window.HAWSE && window.HAWSE.explain ? window.HAWSE.explain.swap(el, html) : (el.innerHTML = html));

  async function load() { L = await api('/api/lab'); render(); }
  function render() {
    if (!L) return;
    XS($('labLibrary'), `<div class="lab-grid">` + L.templates.map((t) => `<div class="tpl"><h3>${esc(t.name)}</h3><div class="meta">${esc(t.kind)} · ${mkt(t.market)} · ${statusBadge('unverified')}</div><p>${esc(t.description)}</p>${XH(t.explain, 'tpl:' + t.id)}<div class="subh" style="margin:2px 0">Risks</div><ul>${t.riskNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul><div><button type="button" class="btn sm" data-use="${esc(t.id)}">Use template →</button></div></div>`).join('') + '</div>');
    const G = 'grid-template-columns:1.4fr 120px 60px 92px 1.3fr 150px';
    XS($('labMine'), L.configs.length ? `<div class="tbl"><div class="row head" style="${G}"><span>strategy</span><span>kind</span><span>ver</span><span>status</span><span>last backtest</span><span></span></div>` + L.configs.map((c) => {
      const b = c.lastBacktest; return `<div class="row" style="${G}"><span>${esc(c.name)}<br><span class="dim sm">${mkt(c.market)} · ${esc(c.source && c.source.type)}</span></span><span>${esc(c.kind)}</span><span>v${c.version}</span><span>${statusBadge(c.status)}${c.running ? ' <span class="badge live">running</span>' : ''}</span><span>${b ? `${pct(b.returnPct)} · DD ${b.maxDrawdownPct.toFixed(1)}% · ${b.trades} trades<br><span class="dim sm">v${b.version} · buy&amp;hold ${pct(b.buyHoldPct)}</span>` : '<span class="dim">not backtested</span>'}</span><span><button type="button" class="btn sm" data-edit="${esc(c.id)}">Open</button></span></div>${XH(c.explain, 'cfg:' + c.id + ':' + c.version) ? `<div class="row x-under">${XH(c.explain, 'cfg:' + c.id + ':' + c.version, 'How it works · v' + c.version)}</div>` : ''}`; }).join('') + '</div>'
      : '<div class="dim mono sm">No saved strategies yet. Use a template or import one.</div>');
    const R = 'grid-template-columns:1.4fr 110px 70px 90px 90px 1fr';
    $('labRuns').innerHTML = L.runs.length ? `<p class="dim sm keynote">Forward paper runs replay each config bar by bar on <b>new</b> closed OKX bars since start, using the same rules as the backtest. They run side by side in their own books, separate from desk equity.</p><div class="tbl"><div class="row head" style="${R}"><span>strategy</span><span>started</span><span>trades</span><span>net</span><span>max DD</span><span>source</span></div>` +
      L.runs.map((r) => { const x = r.result || {}; return `<div class="row" style="${R}"><span>${esc(r.name)} v${r.version} ${statusBadge(r.status)}</span><span class="sm">${day(r.startedAt)}</span><span>${x.supported === false ? '—' : x.trades ?? '…'}</span><span class="${(x.netUsd || 0) >= 0 ? 'pos' : 'neg'}">${x.supported === false ? '—' : usd(x.netUsd)}</span><span>${x.maxDrawdownPct != null ? x.maxDrawdownPct.toFixed(1) + '%' : '—'}</span><span class="dim sm">${esc(x.supported === false ? x.reason : x.source || 'waiting for data')}</span></div>`; }).join('') + '</div>'
      : '<div class="dim mono sm">No paper runs. Open a strategy and press “Start paper run”; run several to compare side by side.</div>';
  }
  async function open(id) {
    const r = await api('/api/lab/configs/' + id); if (!r.config) return;
    cur = r.config; $('labEditor').hidden = false; $('labEdTitle').textContent = 'Edit · ' + cur.name;
    $('labEdMeta').innerHTML = `${esc(cur.id)} · v${cur.version} of ${r.versions.length} · ${statusBadge(cur.status)}`;
    const shown = { ...cur }; for (const k of ['id', 'version', 'status', 'source', 'savedAt', 'lastBacktest']) delete shown[k];
    $('labEdText').value = JSON.stringify(shown, null, 2); $('labEdOut').innerHTML = ''; $('labBt').innerHTML = '';
    $('labRun').textContent = L && L.configs.find((c) => c.id === id && c.running) ? 'Stop paper run' : 'Start paper run';
    $('labEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const errs = (r) => `<div class="lab-err">${(r.errors || [r.error || 'failed']).map(esc).join('<br>')}</div>`;
  function drawEquity(canvas, pts, cap) {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight; canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); if (pts.length < 2) return;
    const ys = pts.map((p) => p.eq), lo = Math.min(cap, ...ys), hi = Math.max(cap, ...ys), Y = (v) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (h - 16), X = (i) => (i / (pts.length - 1)) * (w - 8) + 4;
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, Y(cap)); ctx.lineTo(w, Y(cap)); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = ys[ys.length - 1] >= cap ? '#3dffb0' : '#ff3d5a'; ctx.lineWidth = 1.5; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.eq)) : ctx.moveTo(X(i), Y(p.eq)))); ctx.stroke();
    ctx.fillStyle = '#6b7a89'; ctx.font = '10px IBM Plex Mono'; ctx.fillText('$' + hi.toFixed(0), 6, 14); ctx.fillText('$' + lo.toFixed(0), 6, h - 6);
  }
  function showBacktest(r) {
    if (!r.supported) { $('labBt').innerHTML = `<div class="warn mono sm">Backtest not supported: ${esc(r.reason)}</div>`; return; }
    const m = (l, v, c = '') => `<div class="meter"><div class="label">${l}</div><div class="v mono ${c}">${v}</div></div>`;
    $('labBt').innerHTML = `<div class="subh">Backtest · ${esc(r.source)} · ${day(r.from)} → ${day(r.to)} · ${r.bars} bars · hypothetical</div><div class="stats">` +
      m('net', usd(r.netUsd), r.netUsd >= 0 ? 'pos' : 'neg') + m('return', pct(r.returnPct), r.returnPct >= 0 ? 'pos' : 'neg') + m('buy &amp; hold', pct(r.buyHoldPct)) + m('max drawdown', r.maxDrawdownPct.toFixed(2) + '%') +
      m('trades', `${r.trades} <span class="dim sm">${r.wins}W/${r.losses}L</span>`) + m('fees', '$' + r.feesUsd.toFixed(2)) + m('slippage', '$' + r.slippageUsd.toFixed(2)) + m('funding', usd(r.fundingUsd)) + m('exposure', r.exposurePct.toFixed(0) + '%') +
      `</div><canvas class="eq" id="labEq"></canvas>${(r.notes || []).length ? `<div class="dim sm mono" style="margin-top:6px">notes: ${r.notes.map(esc).join(' · ')}</div>` : ''}` +
      `<div class="subh">Last trades</div><div class="tbl">${(r.tradeLog || []).slice(-8).reverse().map((t) => `<div class="row" style="grid-template-columns:52px 1fr 1fr 80px"><span>${esc(t.side)}</span><span class="sm">${day(t.entryT)} → ${day(t.exitT)}</span><span class="dim sm">${esc(t.why)}</span><span class="${t.pnl >= 0 ? 'pos' : 'neg'}">${usd(t.pnl)}</span></div>`).join('') || '<div class="dim sm">no trades: the rules never triggered in this window</div>'}</div>`;
    drawEquity($('labEq'), r.equity || [], r.capitalUsd);
  }
  const parseEditor = () => { try { return { cfg: JSON.parse($('labEdText').value) }; } catch (e) { return { err: 'JSON parse error: ' + e.message }; } };

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ltab],[data-use],[data-edit]'); if (!t) return;
    if (t.dataset.ltab) { document.querySelectorAll('[data-ltab]').forEach((b) => b.classList.toggle('on', b === t)); for (const [k, id] of [['library', 'labLibrary'], ['mine', 'labMine'], ['import', 'labImport'], ['runs', 'labRuns']]) $(id).hidden = t.dataset.ltab !== k; return load(); }
    if (t.dataset.use) { const r = await api('/api/lab/configs', { fromTemplate: t.dataset.use }); await load(); if (r.ok) open(r.config.id); }
    if (t.dataset.edit) open(t.dataset.edit);
  });
  $('labSave').onclick = async () => { const p = parseEditor(); if (p.err) return ($('labEdOut').innerHTML = `<div class="lab-err">${esc(p.err)}</div>`); const r = await api('/api/lab/configs', { config: { ...p.cfg, id: cur.id } }); if (!r.ok) return ($('labEdOut').innerHTML = errs(r)); await load(); await open(r.config.id); $('labEdOut').innerHTML = `<div class="lab-ok">Saved v${r.config.version}; status reset to unverified until backtested.</div>`; };
  $('labDup').onclick = async () => { const r = await api(`/api/lab/configs/${cur.id}/duplicate`, { version: cur.version }); await load(); if (r.ok) open(r.config.id); };
  $('labBacktest').onclick = async () => { $('labBt').innerHTML = '<div class="dim mono sm">fetching public OKX history and replaying…</div>'; const r = await api(`/api/lab/configs/${cur.id}/backtest`, { version: cur.version }); if (!r.ok) return ($('labBt').innerHTML = errs(r)); showBacktest(r.result); await load(); $('labEdMeta').innerHTML = `${esc(cur.id)} · v${cur.version} · ${statusBadge(r.config.status)}`; };
  $('labRun').onclick = async () => { const on = $('labRun').textContent.startsWith('Start'); await api(`/api/lab/configs/${cur.id}/run`, { on, version: cur.version }); $('labRun').textContent = on ? 'Stop paper run' : 'Start paper run'; await load(); };
  $('labExport').onclick = async () => { const j = await api(`/api/lab/configs/${cur.id}/export?v=${cur.version}`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' })); a.download = `${cur.id}-v${cur.version}.json`; a.click(); };
  $('labClose').onclick = () => { $('labEditor').hidden = true; cur = null; };
  const showImport = (r) => { $('labImportOut').innerHTML = (r.routedTo === 'betting' ? (r.ok ? `<div class="lab-ok">Routed to the betting module as ${esc(r.kind)}${r.rule ? ` “${esc(r.rule.name)}” (disabled draft)` : r.rules ? `: ${r.rules.length} rule(s), disabled` : r.added ? `: ${r.added.map(esc).join(', ')}` : ''}. Review it in <b>Bet rules → Rules</b>.</div>` : errs(r)) : r.ok ? `<div class="lab-ok">Imported as “${esc(r.config.name)}” (${esc(r.config.id)} v${r.config.version}) · ${statusBadge('unverified')} until backtested.</div>` : errs(r)) +
    (r.mapped && r.mapped.length ? `<div class="subh">Mapped</div>${r.mapped.map((x) => `<div class="pos">✓ ${esc(x)}</div>`).join('')}` : '') +
    (r.unmapped && r.unmapped.length ? `<div class="subh">Could not map (left at template defaults)</div>${r.unmapped.map((x) => `<div class="warn">✗ ${esc(x)}</div>`).join('')}` : '') +
    ((r.warnings || []).length ? `<div class="subh">Warnings</div>${r.warnings.map((x) => `<div class="warn">! ${esc(x)}</div>`).join('')}` : '') +
    (r.ok && r.config ? `<div class="lab-actions"><button type="button" class="btn sm" data-edit="${esc(r.config.id)}">Open in editor</button></div>` : ''); load(); };
  $('labImportJson').onclick = async () => showImport(await api('/api/lab/import', { json: $('labImportText').value }));
  $('labImportBet').onclick = async () => showImport(await api('/api/lab/import', { text: $('labImportText').value, as: 'bet_rule' }));
  $('labImportPlain').onclick = async () => showImport(await api('/api/lab/import', { text: $('labImportText').value }));
  load(); setInterval(() => { if (!$('labRuns').hidden) load(); }, 15000);
})();
