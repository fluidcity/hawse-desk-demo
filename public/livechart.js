// LIVE pilot chart: a small canvas chart with time frames (1H / 6H / 1D / 1W / All), wheel + pinch zoom anchored at the pointer,
// drag to pan (mouse or one finger; vertical page scroll still works: touch-action pan-y), double-click / double-tap to reset, and a
// crosshair tooltip (time in PT, balances, the trade label on a marker). Pure math is exported for node tests; no dependencies, no network.
(function (root) {
  'use strict';
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, TZ = 'America/Los_Angeles';
  const TFS = ['1H', '6H', '1D', '1W', 'All'], TF_MS = { '1H': HOUR, '6H': 6 * HOUR, '1D': DAY, '1W': 7 * DAY, All: null };
  const MIN_SPAN_MS = 2 * MIN, MIN_TICK_PX = 70, MIN_VTICK_PX = 28;
  const fin = (v) => typeof v === 'number' && isFinite(v);
  const F = {}; const fmt = (k, o) => F[k] || (F[k] = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, o)));
  const parts = (k, o, ms) => { const p = {}; for (const x of fmt(k, o).formatToParts(new Date(ms))) p[x.type] = x.value; return p; };
  /** PT offset from UTC at ms (−7 h in PDT, −8 h in PST). */
  function offAt(ms) { const p = parts('off', { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }, ms);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / MIN) * MIN; }
  const ptMidnight = (y, m, d) => { const u = Date.UTC(y, m - 1, d); let t = u + 8 * HOUR; t = u - offAt(t); return u - offAt(t); };
  const md = (ms) => fmt('md', { month: 'short', day: 'numeric' }).format(new Date(ms));
  const hm = (ms) => { const p = parts('hm', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }, ms); return `${p.hour}:${p.minute}`; };
  const hms = (ms) => { const p = parts('hms', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }, ms); return `${p.hour}:${p.minute}:${p.second}`; };
  const usd = (v) => (fin(v) ? `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}` : '—');

  // ---- pure math ------------------------------------------------------------------------------------------------------------
  /** Window for a time frame: ends at the newest data, never starts before the oldest. */
  function tfWindow(tf, x0, x1) { const s = TF_MS[tf]; return { x0: s ? Math.max(x0, x1 - s) : x0, x1 }; }
  /** All when everything fits in one day or the last day has < 2 reads; else 1D (the most recent action, readable). */
  function defaultTf(times) { const ts = (times || []).filter(fin); if (ts.length < 2) return 'All'; const x0 = Math.min(...ts), x1 = Math.max(...ts);
    if (x1 - x0 <= DAY) return 'All'; return ts.filter((t) => t > x1 - DAY).length >= 2 ? '1D' : 'All'; }
  function clampView(v, b) { const span = Math.min(v.x1 - v.x0, b.x1 - b.x0), x0 = Math.max(b.x0, Math.min(v.x0, b.x1 - span)); return { x0, x1: x0 + span }; }
  /** Zoom by factor (< 1 = in) keeping the time under the pointer at the same place. */
  function zoomAt(v, anchor, factor, b, minSpan = MIN_SPAN_MS) {
    const span = v.x1 - v.x0, full = b.x1 - b.x0, ns = Math.max(Math.min(minSpan, full), Math.min(full, span * factor)), k = ns / span;
    return clampView({ x0: anchor - (anchor - v.x0) * k, x1: anchor - (anchor - v.x0) * k + ns }, b);
  }
  function panBy(v, dt, b) { return clampView({ x0: v.x0 + dt, x1: v.x1 + dt }, b); }
  const pxToTime = (px, v, r) => v.x0 + ((px - r.L) / r.W) * (v.x1 - v.x0);
  /** Step value in effect at t (last read at or before t), null before the first read. */
  function valueAt(pts, t) { let lo = 0, hi = pts.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) { r = pts[m][1]; lo = m + 1; } else hi = m - 1; } return r; }
  /** Y range of what is visible in the window (incl. the value carried in from the left), padded; a flat line still gets ±$0.25. */
  function yRange(series, v) { let lo = Infinity, hi = -Infinity; const add = (y) => { if (fin(y)) { if (y < lo) lo = y; if (y > hi) hi = y; } };
    for (const s of series) { add(valueAt(s.pts, v.x0)); for (const q of s.pts) if (q[0] >= v.x0 && q[0] <= v.x1) add(q[1]); }
    if (!fin(lo)) return { lo: 0, hi: 1 }; if (hi - lo < 0.5) { const c = (hi + lo) / 2; lo = c - 0.25; hi = c + 0.25; }
    const pad = (hi - lo) * 0.08; return { lo: lo - pad, hi: hi + pad }; }
  const STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  /** Time axis ticks on PT wall-clock boundaries, spaced >= MIN_TICK_PX at this width (fewer on a phone). Labels: HH:MM, or "Nov 1" on midnight / day steps. */
  function timeTicks(x0, x1, widthPx) {
    if (!(x1 > x0) || !(widthPx > 0)) return []; const ppm = widthPx / (x1 - x0), step = STEPS.find((s) => s * ppm >= MIN_TICK_PX) || STEPS[STEPS.length - 1], out = [];
    if (step >= DAY) { const k = Math.round(step / DAY), p = parts('ymd', { year: 'numeric', month: 'numeric', day: 'numeric' }, x0); let i = 0;
      for (let d = 0; d < 400; d++) { const t = ptMidnight(+p.year, +p.month, +p.day + d); if (t > x1) break; if (t >= x0 && i++ % k === 0) out.push({ t, label: md(t) }); } }
    else { let w = Math.ceil((x0 + offAt(x0)) / step) * step; for (let i = 0; i < 500; i++, w += step) { let t = w - offAt(w); t = w - offAt(t); if (t > x1) break; if (t < x0) continue;
      const mid = hm(t) === '00:00'; out.push({ t, label: mid ? md(t) : hm(t) }); } }
    const keep = []; for (const x of out) if (!keep.length || (x.t - keep[keep.length - 1].t) * ppm >= MIN_TICK_PX) keep.push(x); return keep;
  }
  /** Value ticks: 1 / 2 / 2.5 / 5 steps, spaced >= MIN_VTICK_PX. */
  function valueTicks(lo, hi, heightPx) { const n = Math.max(2, Math.floor(heightPx / MIN_VTICK_PX)), raw = (hi - lo) / n, e = Math.pow(10, Math.floor(Math.log10(raw)));
    const st = [1, 2, 2.5, 5, 10].map((m) => m * e).find((s) => s >= raw) || 10 * e, out = []; for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9 && out.length < 50; v += st) out.push(+v.toFixed(10)); return out; }
  /** Greedy label placement above each marker, kept inside the canvas; a label that would overlap one already placed is dropped. */
  function placeLabels(items, area) { const put = [];
    items.forEach((it, i) => { const bx = Math.max(0, Math.min(area.W - it.w, it.x - it.w / 2)); let by = it.y - it.h - 8; if (by < area.T) by = it.y + 8; if (by + it.h > area.T + area.H) return;
      const b = { i, bx, by, w: it.w, h: it.h }; if (put.some((a) => !(a.bx + a.w <= b.bx || b.bx + b.w <= a.bx || a.by + a.h <= b.by || b.by + b.h <= a.by))) return; put.push(b); });
    return put; }
  function nearestMark(marks, X, Y, px, py, r) { let best = null, bd = r * r; for (const m of marks) { const dx = X(m.x) - px, dy = Y(m.y) - py, d = dx * dx + dy * dy; if (d <= bd) { bd = d; best = m; } } return best; }
  function tipLines(at, vals, mark) { const out = [`${md(at)} ${hms(at)} PT`]; for (const v of vals) out.push(`${v.name} ${usd(v.v)}`); if (mark) out.push(mark.label + (mark.tk ? ' · ' + mark.tk : '')); return out; }
  const unpackMark = (m) => (Array.isArray(m) ? { at: m[0], kind: m[1], tone: m[2], label: m[3], tk: m[4] || null, amountCents: m[5] } : m);

  const API = { TFS, TF_MS, MIN_SPAN_MS, MIN_TICK_PX, tfWindow, defaultTf, clampView, zoomAt, panBy, pxToTime, valueAt, yRange, timeTicks, valueTicks, placeLabels, nearestMark, tipLines, unpackMark, offAt };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }

  // ---- browser renderer ---------------------------------------------------------------------------------------------------
  const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', BFONT = 'bold 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  function layout(c) { const r = c.getBoundingClientRect(), w = Math.max(200, Math.round(r.width)), h = Math.max(140, Math.round(r.height)), dpr = Math.min(3, root.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    return { w, h, dpr }; }
  /** st: { tf, view, follow, hover:{x,y}|null } kept by the caller across repaints. */
  function draw(c, sp, st) {
    if (!c || !sp || !c.getContext) return; const { w, h, dpr } = layout(c), g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const b = { x0: sp.x0, x1: sp.x1 }; let v = st.view ? clampView(st.view, b) : tfWindow(st.tf, b.x0, b.x1);
    if (st.view && st.follow && st.view.x1 < b.x1) v = clampView({ x0: b.x1 - (st.view.x1 - st.view.x0), x1: b.x1 }, b); if (st.view) st.view = v;
    const yr = yRange(sp.series, v); g.font = FONT;
    const lw = Math.ceil(Math.max(g.measureText(usd(yr.hi)).width, g.measureText(usd(yr.lo)).width)) + 12;
    const R = { L: 6, T: 8, W: w - 6 - lw, H: h - 8 - 22 }; st.rect = R; st.v = v;
    const X = (t) => R.L + ((t - v.x0) / Math.max(1, v.x1 - v.x0)) * R.W, Y = (y) => R.T + R.H - ((y - yr.lo) / (yr.hi - yr.lo)) * R.H;
    st.X = X; st.Y = Y;
    g.fillStyle = 'rgba(255,255,255,.02)'; g.fillRect(R.L, R.T, R.W, R.H);
    // value grid + right axis labels
    g.textBaseline = 'middle'; g.textAlign = 'left';
    const pilot = sp.series[sp.series.length > 1 ? 1 : 0], lastV = pilot ? valueAt(pilot.pts, v.x1) : null, lastY = fin(lastV) ? Y(lastV) : null;
    for (const y of valueTicks(yr.lo, yr.hi, R.H)) { const py = Math.round(Y(y)) + 0.5; if (py < R.T + 4 || py > R.T + R.H - 4) continue;
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(R.L, py); g.lineTo(R.L + R.W, py); g.stroke();
      if (lastY == null || Math.abs(py - lastY) > 14) { g.fillStyle = '#8b98a5'; g.fillText(usd(y), R.L + R.W + 6, py); } }
    // time axis (labels centered on ticks, dropped at the edges instead of clipped)
    g.textAlign = 'center'; g.textBaseline = 'top'; let lastR = -1;
    for (const tk of timeTicks(v.x0, v.x1, R.W)) { const px = Math.round(X(tk.t)) + 0.5, tw = g.measureText(tk.label).width;
      g.strokeStyle = 'rgba(255,255,255,.05)'; g.beginPath(); g.moveTo(px, R.T); g.lineTo(px, R.T + R.H); g.stroke();
      if (px - tw / 2 < R.L || px + tw / 2 > R.L + R.W || px - tw / 2 < lastR + 8) continue; g.fillStyle = '#8b98a5'; g.fillText(tk.label, px, R.T + R.H + 5); lastR = px + tw / 2; }
    // series: step lines, extended to the newest read
    g.save(); g.beginPath(); g.rect(R.L, R.T, R.W, R.H); g.clip();
    sp.series.forEach((s) => { const P = s.pts; if (!P.length) return; g.beginPath(); let started = false, py = null;
      const v0 = valueAt(P, v.x0); if (fin(v0)) { g.moveTo(X(v.x0), Y(v0)); started = true; py = v0; }
      for (const q of P) { if (q[0] < v.x0) continue; if (q[0] > v.x1) break; const x = X(q[0]); if (!started) { g.moveTo(x, Y(q[1])); started = true; } else { g.lineTo(x, Y(py)); g.lineTo(x, Y(q[1])); } py = q[1]; }
      if (started) g.lineTo(X(Math.min(v.x1, s.extendTo || v.x1)), Y(py));
      g.strokeStyle = s.col; g.lineWidth = s.band ? 1.4 : 1.8; g.setLineDash(s.dash || []); g.stroke(); g.setLineDash([]); });
    // markers: fills neutral, settles green / red by P&L, rejects / halts ringed red; labels only where they fit
    const vis = (sp.marks || []).filter((m) => m.x >= v.x0 && m.x <= v.x1); st.vis = vis;
    for (const m of vis) { const x = X(m.x), y = Y(m.y);
      if (m.loss && m.kind !== 'settle') { g.beginPath(); g.arc(x, y, 7, 0, 7); g.strokeStyle = m.col; g.lineWidth = 2; g.stroke(); }
      g.beginPath(); g.arc(x, y, m.kind === 'settle' ? 4.5 : 3.2, 0, 7); g.fillStyle = m.col; g.fill(); if (m.kind === 'fill') { g.strokeStyle = '#5b8def'; g.lineWidth = 1.2; g.stroke(); } }
    g.restore();
    g.font = BFONT; const lab = vis.filter((m) => m.showLabel).slice().reverse(), boxes = placeLabels(lab.map((m) => ({ x: X(m.x), y: Y(m.y), w: g.measureText(m.label).width + 4, h: 13 })), { W: R.L + R.W, T: R.T, H: R.H });
    g.textAlign = 'left'; g.textBaseline = 'top'; for (const bx of boxes) { const m = lab[bx.i]; g.fillStyle = 'rgba(11,14,19,.75)'; g.fillRect(bx.bx, bx.by, bx.w, bx.h); g.fillStyle = m.col; g.fillText(m.label, bx.bx + 2, bx.by + 1); }
    // last value tag on the axis
    if (lastY != null && lastY >= R.T && lastY <= R.T + R.H) { g.font = BFONT; const s = usd(lastV), tw = g.measureText(s).width + 8; g.fillStyle = pilot.col; g.fillRect(R.L + R.W + 1, lastY - 8, Math.min(tw, lw - 1), 16); g.fillStyle = '#0b0e13'; g.textBaseline = 'middle'; g.fillText(s, R.L + R.W + 5, lastY); }
    // crosshair + tooltip
    const hv = st.hover; if (hv && hv.x >= R.L && hv.x <= R.L + R.W && hv.y >= R.T - 10 && hv.y <= R.T + R.H + 10) {
      const mk = nearestMark(vis, X, Y, hv.x, hv.y, 14), at = mk ? mk.x : pxToTime(hv.x, v, R), cx = X(at);
      const vals = sp.series.map((s, i) => ({ name: sp.names ? sp.names[i] : 'value', v: valueAt(s.pts, at), col: s.col })).filter((q) => fin(q.v)), cy = mk ? Y(mk.y) : vals.length ? Y(vals[Math.min(1, vals.length - 1)].v) : hv.y;
      g.strokeStyle = 'rgba(230,237,243,.45)'; g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(cx + 0.5, R.T); g.lineTo(cx + 0.5, R.T + R.H); g.moveTo(R.L, cy + 0.5); g.lineTo(R.L + R.W, cy + 0.5); g.stroke(); g.setLineDash([]);
      const lines = tipLines(at, vals, mk && { label: mk.label, tk: mk.tk }); g.font = FONT; const tw = Math.min(R.W - 4, Math.max(...lines.map((l) => g.measureText(l).width)) + 14), th = lines.length * 15 + 8;
      let tx = cx + 12; if (tx + tw > R.L + R.W) tx = cx - 12 - tw; tx = Math.max(R.L + 2, tx); let ty = Math.max(R.T + 2, Math.min(R.T + R.H - th - 2, hv.y - th - 10));
      g.fillStyle = '#11151c'; g.strokeStyle = 'rgba(255,255,255,.18)'; g.fillRect(tx, ty, tw, th); g.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
      g.textAlign = 'left'; g.textBaseline = 'top'; lines.forEach((l, i) => { const q = i ? (i <= vals.length ? vals[i - 1] : null) : null; g.fillStyle = i === 0 ? '#e6edf3' : q ? q.col : mk ? mk.col : '#e6edf3';
        g.font = i === lines.length - 1 && mk ? BFONT : FONT; let s = l; while (g.measureText(s).width > tw - 12 && s.length > 4) s = s.slice(0, -2) + '…'; g.fillText(s, tx + 7, ty + 5 + i * 15); });
      g.fillStyle = '#e6edf3'; g.beginPath(); g.arc(cx, cy, 3, 0, 7); g.fill();
    }
  }
  /** Attach zoom / pan / crosshair handlers once per canvas. get() -> current spec; st survives repaints. */
  let ro = null;
  function bind(c, get, st) {
    if (!c || c._lc) return; c._lc = 1; const ptr = new Map(); let pinch = null, drag = null, lastTap = 0, raf = 0;
    const redraw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; draw(c, get(), st); }); };
    const bounds = () => { const s = get(); return s ? { x0: s.x0, x1: s.x1 } : null; };
    const cur = () => st.v || (bounds() && tfWindow(st.tf, bounds().x0, bounds().x1));
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const set = (v) => { const b = bounds(); if (!b) return; st.view = clampView(v, b); st.follow = st.view.x1 >= b.x1 - 1; redraw(); };
    c.addEventListener('wheel', (e) => { const b = bounds(), v = cur(); if (!b || !v || !st.rect) return; e.preventDefault(); const p = pos(e);
      set(zoomAt(v, pxToTime(p.x, v, st.rect), Math.exp((e.deltaY || 0) * 0.0015), b)); }, { passive: false });
    c.addEventListener('pointerdown', (e) => { const p = pos(e); ptr.set(e.pointerId, p); if (c.setPointerCapture) try { c.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
      if (ptr.size === 2) { const [a, q] = [...ptr.values()], v = cur(); pinch = v && { d: Math.hypot(a.x - q.x, a.y - q.y) || 1, v, at: pxToTime((a.x + q.x) / 2, v, st.rect) }; drag = null; }
      else if (ptr.size === 1) drag = { x: p.x, y: p.y, v: cur(), moved: false, touch: e.pointerType !== 'mouse' }; });
    c.addEventListener('pointermove', (e) => { const p = pos(e); if (ptr.has(e.pointerId)) ptr.set(e.pointerId, p); const b = bounds(); if (!b) return;
      if (pinch && ptr.size === 2) { const [a, q] = [...ptr.values()], d = Math.hypot(a.x - q.x, a.y - q.y) || 1; st.hover = null; set(zoomAt(pinch.v, pinch.at, pinch.d / d, b)); return; }
      if (drag && ptr.size === 1 && drag.v && st.rect) { const dx = p.x - drag.x; if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) { st.hover = null; set(panBy(drag.v, (-dx / st.rect.W) * (drag.v.x1 - drag.v.x0), b)); return; } }
      if (e.pointerType === 'mouse') { st.hover = p; redraw(); } });
    const up = (e) => { const was = drag; ptr.delete(e.pointerId); if (ptr.size < 2) pinch = null; if (!ptr.size) drag = null;
      if (e.type === 'pointerup' && was && !was.moved) { const now = Date.now(); if (was.touch && now - lastTap < 320) { reset(); lastTap = 0; return; } lastTap = now; if (was.touch) { st.hover = pos(e); redraw(); } } };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { st.hover = null; redraw(); } });
    const reset = () => { st.view = null; st.follow = false; st.hover = null; redraw(); };
    c.addEventListener('dblclick', (e) => { e.preventDefault(); reset(); });
    // one observer for the one live canvas: a repaint that replaces the canvas drops the old one (no leak across the 1.5 s pushes);
    // window resize / orientationchange are handled once by public/pilot.js
    if (root.ResizeObserver) { if (ro) ro.disconnect(); ro = new root.ResizeObserver(redraw); ro.observe(c); }
  }
  root.HAWSE_LC = Object.assign(API, { draw, bind });
})(typeof window !== 'undefined' ? window : globalThis);
